import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

import { loadOrchConfig, type OrchLoadedConfig } from "./config.js";
import {
	appendCmuxRoleDelta,
	cleanupCmuxMissionStreaming,
	setupCmuxMissionStreaming,
	writeCmuxRoleMarker,
} from "./cmux-streaming.js";
import { GLYPHS, ORCH_COMMANDS, ORCH_WIDGET_IDS } from "./constants.js";
import {
	type FeatureAttemptRecord,
	type FeatureRunRecord,
	type MilestoneRunRecord,
	type MissionFeature,
	type MissionFeatureStateStatus,
	type MissionFeaturesStateFile,
	type MissionFixTask,
	type MissionLiveState,
	type MissionMilestone,
	type MissionMilestoneStateEntry,
	type MissionPlan,
	type MissionPromptSharedState,
	type MissionRecord,
	type MissionRunResult,
	type MissionStatus,
	type SteeringResult,
	type ValidationContract,
	type ValidationIssue,
	type ValidationIssueSeverity,
	type ValidationResult,
	type WorkerRun,
} from "./mission-types.js";
import {
	appendMissionGuidelines,
	appendMissionKnowledgeBase,
	buildMissionPromptSharedState,
	buildSharedStatePromptSection,
	initializeMissionState,
	readMissionLiveStateFromFile,
	registerMissionFixTasks,
	setMissionFeatureState,
	setMissionFeatureStates,
	setMissionMilestoneState,
	updateMissionRuntimeState,
} from "./mission-state.js";
import { emitOrchEvent, type OrchEventLevel } from "./messages.js";
import {
	type OrchSubagentStreamEvent,
	runOrchValidatorSubagent,
	runOrchWorkerSubagent,
	spawnOrchSubagent,
} from "./role-runner.js";
import {
	setFooterTransientMood,
	setOrchStatus,
	type OrchActiveMission,
	type OrchPendingTakeoverPrompt,
	type OrchRuntimeState,
} from "./runtime.js";
import { formatErrorMessage, slugifyText } from "./utils.js";

const MAX_FEATURES = 6;
const MAX_FEATURES_PER_MILESTONE = 2;
const MAX_ATTEMPTS_PER_FEATURE = 2;
const MAX_STREAM_CHARS = 6000;
const MAX_MISSION_GOAL_LENGTH = 220;
const MISSION_STATUS_KEY = "orch-mission";

type OrchTheme = ExtensionCommandContext["ui"]["theme"];
type MissionProgressColor = "accent" | "success" | "error" | "dim" | "muted";

const FEATURE_STATUS_SYMBOLS: Record<MissionFeatureStateStatus, string> = {
	pending: GLYPHS.pending,
	"in-progress": GLYPHS.inProgress,
	done: GLYPHS.done,
	failed: GLYPHS.fail,
};

const FEATURE_STATUS_COLORS: Record<MissionFeatureStateStatus, MissionProgressColor> = {
	pending: "dim",
	"in-progress": "accent",
	done: "success",
	failed: "error",
};


export function hasActiveMission(state: OrchRuntimeState): boolean {
	return state.activeMission !== undefined;
}

export function requestMissionTakeover(
	state: OrchRuntimeState,
	pendingTakeover?: OrchPendingTakeoverPrompt,
): boolean {
	const mission = state.activeMission;
	if (!mission) {
		return false;
	}

	mission.takeoverRequested = true;
	if (pendingTakeover) {
		mission.pendingTakeover = pendingTakeover;
	}

	if (!mission.abortController.signal.aborted) {
		mission.abortController.abort();
	}

	return true;
}

export function registerMissionCommand(pi: ExtensionAPI, state: OrchRuntimeState): void {
	pi.registerCommand(ORCH_COMMANDS.mission, {
		description: "Run Orch autonomous mission mode",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			if (state.activeMission) {
				reportMissionEvent(
					pi,
					ctx,
					"Mission already running",
					`Active mission: ${state.activeMission.goal}\nUse /orch takeover or /${ORCH_COMMANDS.takeover} to interrupt it first.`,
					"warning",
					"mission",
				);
				return;
			}

			const goal = await resolveMissionGoal(args, ctx);
			if (!goal) {
				reportMissionEvent(
					pi,
					ctx,
					"Mission usage",
					`Use /${ORCH_COMMANDS.mission} <goal> to start an autonomous mission.`,
					"warning",
					"mission",
				);
				return;
			}

			state.configState = await loadOrchConfig(ctx.cwd);

			if (!ctx.hasUI) {
				try {
					const result = await runAutonomousMission(pi, ctx, goal, state.configState, state);
					reportMissionEvent(
						pi,
						ctx,
						"Mission complete",
						buildMissionCompletionText(result),
						result.record.status === "completed" ? "success" : "warning",
						"mission",
					);
					emitMissionRecap(pi, ctx, `mission ${result.record.status === "completed" ? "completed" : "needs attention"}`);
				} catch (error) {
					reportMissionEvent(pi, ctx, "Mission failed", formatErrorMessage(error), "error", "mission");
					emitMissionRecap(pi, ctx, "mission failed");
				} finally {
					setMissionStatus(ctx, state, undefined);
					clearMissionThinkingWidget(ctx);
				}
				return;
			}

			startMissionInBackground(pi, ctx, goal, state, state.configState);
			reportMissionEvent(
				pi,
				ctx,
				"Mission running",
				`Started autonomous mission for: ${goal}\nUse /orch takeover, /${ORCH_COMMANDS.takeover}, or type a normal prompt to interrupt and take over.`,
				"info",
				"mission",
			);
		},
	});


	pi.on("input", async (event, ctx) => {
		if (!state.activeMission) {
			return { action: "continue" };
		}
		if (event.source === "extension") {
			return { action: "continue" };
		}
		if (event.text.trim().startsWith("/")) {
			return { action: "continue" };
		}
		const takeoverImages = event.images ?? [];
		if (event.text.trim().length === 0 && takeoverImages.length === 0) {
			return { action: "continue" };
		}

		requestMissionTakeover(state, {
			text: event.text,
			images: takeoverImages,
		});
		if (ctx.hasUI) {
			ctx.ui.notify("Interrupting the active Orch mission. Your prompt will be delivered after takeover.", "warning");
		}
		return { action: "handled" };
	});
}

function startMissionInBackground(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	goal: string,
	state: OrchRuntimeState,
	configState: OrchLoadedConfig,
): void {
	const startedAt = new Date().toISOString();
	const mission: OrchActiveMission = {
		id: createMissionId(goal, startedAt),
		goal,
		startedAt,
		abortController: new AbortController(),
		phase: "planning mission",
		orchestratorThinking: "",
		orchestratorText: "",
		takeoverRequested: false,
	};
	state.activeMission = mission;
	setMissionStatus(ctx, state, mission.phase);
	updateMissionThinkingWidget(ctx, mission);

	mission.backgroundPromise = (async () => {
		try {
			try {
				mission.cmuxStreaming = await setupCmuxMissionStreaming(configState.resolvedPaths.missionsDir, mission.id, goal);
			} catch (error) {
				reportMissionEvent(
					pi,
					ctx,
					"cmux streaming unavailable",
					formatErrorMessage(error),
					"warning",
					"mission",
				);
			}
			const result = await runAutonomousMission(pi, ctx, goal, configState, state);
			setFooterTransientMood(state, result.record.status === "completed" ? "success" : "error", 1800);
			reportMissionEvent(
				pi,
				ctx,
				"Mission complete",
				buildMissionCompletionText(result),
				result.record.status === "completed" ? "success" : "warning",
				"mission",
			);
			emitMissionRecap(pi, ctx, `mission ${result.record.status === "completed" ? "completed" : "needs attention"}`);
		} catch (error) {
			if (mission.abortController.signal.aborted) {
				setFooterTransientMood(state, "interrupted", 1800);
				reportMissionEvent(
					pi,
					ctx,
					"Mission interrupted",
					mission.takeoverRequested
						? "Autonomous mission interrupted. Returning control to the user."
						: "Autonomous mission interrupted.",
					"warning",
					"mission",
				);
				emitMissionRecap(pi, ctx, "mission interrupted");
			} else {
				setFooterTransientMood(state, "error", 2200);
				reportMissionEvent(pi, ctx, "Mission failed", formatErrorMessage(error), "error", "mission");
			}
		} finally {
			const pendingTakeover = state.activeMission === mission ? mission.pendingTakeover : undefined;
			await cleanupCmuxMissionStreaming(
				mission.cmuxStreaming,
				mission.takeoverRequested ? "Mission interrupted" : "Mission finished",
			);
			if (state.activeMission === mission) {
				state.activeMission = undefined;
			}
			setMissionStatus(ctx, state, undefined);
			clearMissionThinkingWidget(ctx);
			if (pendingTakeover) {
				deliverPendingTakeover(pi, pendingTakeover);
			}
		}
	})();

	void mission.backgroundPromise.catch(() => {
		// Background errors are reported inside the mission lifecycle.
	});
}

async function runAutonomousMission(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	goal: string,
	configState: OrchLoadedConfig,
	state: OrchRuntimeState,
): Promise<MissionRunResult> {
	const startedAt = state.activeMission?.startedAt ?? new Date().toISOString();
	const missionId = state.activeMission?.id ?? createMissionId(goal, startedAt);
	const models = {
		orchestrator: "main Pi agent",
		worker: formatRoleModel(configState, "worker"),
		validator: formatRoleModel(configState, "validator"),
	};

	reportMissionEvent(
		pi,
		ctx,
		"Mission started",
		[`Goal: ${goal}`, `Mission ID: ${missionId}`, "Orchestrator: main Pi agent", `Sub-agent models: ${models.worker} | ${models.validator}`].join(
			"\n",
		),
		"info",
		"plan",
	);
	setMissionStatus(ctx, state, "planning mission");

	writeCmuxRoleMarker(state.activeMission?.cmuxStreaming, "orchestrator", "Mission planning");
	const plan = generateMissionPlan(goal);
	const missionState = await initializeMissionState(
		configState.resolvedPaths.missionsDir,
		missionId,
		goal,
		startedAt,
		plan,
	);
	if (state.activeMission) {
		state.activeMission.stateDir = missionState.paths.missionDir;
		state.activeMission.stateFilePath = missionState.paths.stateFile;
	}

	let progressFeaturesState = await readMissionFeaturesStateFromFile(missionState.paths.featuresFile);
	let progressLiveState = await readMissionLiveStateFromFile(missionState.paths.stateFile);
	const renderMissionWidget = (): void => {
		if (!ctx.hasUI) {
			return;
		}
		if (state.activeMission) {
			state.activeMission.featuresState = progressFeaturesState;
			state.activeMission.liveState = progressLiveState;
			updateMissionThinkingWidget(ctx, state.activeMission);
		}
	};
	const syncMissionLiveState = async (patch: Parameters<typeof updateMissionRuntimeState>[1]): Promise<void> => {
		progressLiveState = await updateMissionRuntimeState(missionState, patch);
		renderMissionWidget();
	};
	const syncMissionFeatureState = async (
		featureId: string,
		patch: Parameters<typeof setMissionFeatureState>[2],
	): Promise<void> => {
		progressFeaturesState = await setMissionFeatureState(missionState, featureId, patch);
		renderMissionWidget();
	};
	const syncMissionFeatureStates = async (
		featureIds: string[],
		patch: Parameters<typeof setMissionFeatureStates>[2],
	): Promise<void> => {
		progressFeaturesState = await setMissionFeatureStates(missionState, featureIds, patch);
		renderMissionWidget();
	};
	const syncMissionMilestoneState = async (
		milestoneId: string,
		patch: Parameters<typeof setMissionMilestoneState>[2],
	): Promise<void> => {
		progressFeaturesState = await setMissionMilestoneState(missionState, milestoneId, patch);
		renderMissionWidget();
	};
	const syncMissionFixTasks = async (
		sourceFeatureId: string,
		milestoneId: string,
		attempt: number,
		fixTasks: MissionFixTask[],
	): Promise<string[]> => {
		const fixTaskIds = await registerMissionFixTasks(missionState, sourceFeatureId, milestoneId, attempt, fixTasks);
		progressFeaturesState = await readMissionFeaturesStateFromFile(missionState.paths.featuresFile);
		renderMissionWidget();
		return fixTaskIds;
	};

	renderMissionWidget();
	await syncMissionLiveState({
		phase: "executing mission",
		currentFeatureIndex: null,
		currentFeatureId: null,
		currentAttempt: null,
		currentMilestoneId: plan.milestones[0]?.id ?? null,
	});

	reportMissionEvent(
		pi,
		ctx,
		"Mission plan ready",
		[
			plan.missionTitle,
			plan.summary,
			`Features (${plan.features.length}): ${plan.features.map((feature) => feature.title).join("; ")}`,
			`Milestones (${plan.milestones.length}): ${plan.milestones.map((milestone) => milestone.title).join("; ")}`,
			`Validation criteria: ${plan.validationContract.criteria.length}`,
			`State directory: ${missionState.paths.missionDir}`,
		].join("\n"),
		"success",
		"plan",
	);

	const featureRuns: FeatureRunRecord[] = [];
	const milestoneRuns: MilestoneRunRecord[] = [];
	let missionStatus: MissionStatus = "completed";
	const featureIndexById = new Map(plan.features.map((feature, index) => [feature.id, index]));

	for (let milestoneIndex = 0; milestoneIndex < plan.milestones.length; milestoneIndex++) {
		const milestone = plan.milestones[milestoneIndex];
		const milestoneFeatures = getMilestoneFeatures(plan, milestone);
		await syncMissionMilestoneState(milestone.id, { status: "in-progress" });
		await syncMissionLiveState({
			phase: `executing milestone ${milestone.title}`,
			currentFeatureIndex: null,
			currentFeatureId: null,
			currentAttempt: null,
			currentMilestoneId: milestone.id,
		});
		reportMissionEvent(
			pi,
			ctx,
			`Milestone ${milestoneIndex + 1}/${plan.milestones.length}`,
			[milestone.title, milestone.summary, `Validation trigger: ${milestone.validationTrigger}`].join("\n"),
			"info",
			"plan",
		);

		for (const feature of milestoneFeatures) {
			const featureIndex = featureIndexById.get(feature.id) ?? 0;
			const featureRun: FeatureRunRecord = {
				feature,
				status: "failed",
				attempts: [],
			};
			let steering: SteeringResult | undefined;
			let activeFixTaskIds: string[] = [];
			let passed = false;

			for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_FEATURE; attempt++) {
				setMissionStatus(
					ctx,
					state,
					`milestone ${milestoneIndex + 1}/${plan.milestones.length}: ${feature.title} (attempt ${attempt})`,
				);
				await syncMissionLiveState({
					phase: `executing ${feature.title}`,
					currentFeatureIndex: featureIndex,
					currentFeatureId: feature.id,
					currentAttempt: attempt,
					currentMilestoneId: milestone.id,
				});
				await syncMissionFeatureState(feature.id, {
					status: "in-progress",
					attempts: attempt,
				});
				if (activeFixTaskIds.length > 0) {
					await syncMissionFeatureStates(activeFixTaskIds, {
						status: "in-progress",
						attempts: attempt,
					});
				}

				reportMissionEvent(
					pi,
					ctx,
					`Feature ${featureIndex + 1}/${plan.features.length}`,
					`${feature.title}\nAttempt ${attempt}: delegating to Orch worker`,
					"info",
					"execute",
				);

				const workerSharedState = await buildMissionPromptSharedState(missionState, "worker", milestone.id);
				writeCmuxRoleMarker(
					state.activeMission?.cmuxStreaming,
					"worker",
					`${feature.title} • attempt ${attempt}`,
				);
				const workerExecution = await runOrchWorkerSubagent({
					goal,
					missionSummary: plan.summary,
					feature,
					validationContract: plan.validationContract,
					sharedState: workerSharedState,
					steering,
					cwd: ctx.cwd,
					configState,
					modelRegistry: ctx.modelRegistry,
					signal: state.activeMission?.abortController.signal,
					onStreamEvent: (event) => handleSubagentStreamEvent(ctx, state, event),
				});
				const workerResult = normalizeWorkerRun(workerExecution.output, workerExecution.provider, workerExecution.modelId);
				await syncMissionFeatureState(feature.id, {
					status: "in-progress",
					attempts: attempt,
					workerSummary: workerResult.summary,
					validatorVerdict: null,
				});
				if (activeFixTaskIds.length > 0) {
					await syncMissionFeatureStates(activeFixTaskIds, {
						status: "in-progress",
						attempts: attempt,
						workerSummary: workerResult.summary,
						validatorVerdict: null,
					});
				}
				emitWorkerChanges(pi, ctx, workerResult.changes);

				const shouldValidate = shouldRunConditionalValidation(goal, feature, workerResult, attempt);
				setMissionStatus(ctx, state, `${shouldValidate ? "validating" : "skipping validation for"} ${feature.title} (attempt ${attempt})`);
				await syncMissionLiveState({
					phase: `${shouldValidate ? "validating" : "skipping validation for"} ${feature.title}`,
					currentFeatureIndex: featureIndex,
					currentFeatureId: feature.id,
					currentAttempt: attempt,
					currentMilestoneId: milestone.id,
				});
				let validationResult: ValidationResult;
				if (shouldValidate) {
					const validatorSharedState = await buildMissionPromptSharedState(missionState, "validator", milestone.id);
					writeCmuxRoleMarker(
						state.activeMission?.cmuxStreaming,
						"validator",
						`${feature.title} • attempt ${attempt}`,
					);
					const validationExecution = await runOrchValidatorSubagent({
						goal,
						missionSummary: plan.summary,
						feature,
						validationContract: plan.validationContract,
						sharedState: validatorSharedState,
						workerRun: workerResult,
						cwd: ctx.cwd,
						configState,
						modelRegistry: ctx.modelRegistry,
						signal: state.activeMission?.abortController.signal,
						onStreamEvent: (event) => handleSubagentStreamEvent(ctx, state, event),
					});
					validationResult = normalizeValidationResult(
						validationExecution.output,
						validationExecution.provider,
						validationExecution.modelId,
					);
				} else {
					validationResult = createSkippedValidationResult(feature, workerResult, attempt);
				}
				await appendMissionKnowledgeBase(
					missionState,
					`Feature: ${feature.title} • attempt ${attempt}`,
					buildValidationKnowledgeBaseLines(workerResult, validationResult),
				);

				const attemptRecord: FeatureAttemptRecord = {
					attempt,
					worker: workerResult,
					validation: validationResult,
				};

				if (validationResult.passed) {
					featureRun.status = "passed";
					featureRun.attempts.push(attemptRecord);
					passed = true;
					await syncMissionFeatureState(feature.id, {
						status: "done",
						attempts: attempt,
						workerSummary: workerResult.summary,
						validatorVerdict: "passed",
					});
					if (activeFixTaskIds.length > 0) {
						await syncMissionFeatureStates(activeFixTaskIds, {
							status: "done",
							attempts: attempt,
							workerSummary: workerResult.summary,
							validatorVerdict: "passed",
						});
					}
					reportMissionEvent(
						pi,
						ctx,
						`Feature passed: ${feature.title}`,
						validationResult.summary,
						"success",
						"validate",
					);
					break;
				}

				await syncMissionFeatureState(feature.id, {
					status: attempt < MAX_ATTEMPTS_PER_FEATURE ? "in-progress" : "failed",
					attempts: attempt,
					workerSummary: workerResult.summary,
					validatorVerdict: "failed",
				});
				if (activeFixTaskIds.length > 0) {
					await syncMissionFeatureStates(activeFixTaskIds, {
						status: "failed",
						attempts: attempt,
						workerSummary: workerResult.summary,
						validatorVerdict: "failed",
					});
				}

				if (attempt < MAX_ATTEMPTS_PER_FEATURE) {
					writeCmuxRoleMarker(
						state.activeMission?.cmuxStreaming,
						"orchestrator",
						`Steering for ${feature.title} • attempt ${attempt}`,
					);
					steering = buildDeterministicSteeringResult(feature, validationResult);
					attemptRecord.steering = steering;
					activeFixTaskIds = await syncMissionFixTasks(
						feature.id,
						milestone.id,
						attempt,
						steering.fixTasks,
					);
					await appendMissionKnowledgeBase(
						missionState,
						`Orchestrator fix plan: ${feature.title} • attempt ${attempt}`,
						buildSteeringKnowledgeBaseLines(steering),
					);
					await appendMissionGuidelines(
						missionState,
						`Guideline updates after ${feature.title} • attempt ${attempt}`,
						steering.guidelineUpdates,
					);
					reportMissionEvent(
						pi,
						ctx,
						`Validator requested fixes: ${feature.title}`,
						[validationResult.summary, ...steering.instructions].join("\n"),
						"warning",
						"steer",
					);
				} else {
					reportMissionEvent(
						pi,
						ctx,
						`Feature failed: ${feature.title}`,
						[validationResult.summary, ...validationResult.issues.map((issue) => `- ${issue.title}: ${issue.action}`)].join(
							"\n",
						),
						"error",
						"validate",
					);
				}

				featureRun.attempts.push(attemptRecord);
			}

			featureRuns.push(featureRun);
			emitMissionRecap(
				pi,
				ctx,
				`feature ${feature.title} ${passed ? "passed" : "failed"}${passed ? ` after ${featureRun.attempts.length} attempt${featureRun.attempts.length === 1 ? "" : "s"}` : ""}`,
			);
			if (!passed) {
				missionStatus = "failed";
				await syncMissionMilestoneState(milestone.id, {
					status: "failed",
					validationSummary: `Feature failed: ${feature.title}`,
					lastValidatedAt: new Date().toISOString(),
				});
				break;
			}
		}

		if (missionStatus === "failed") {
			break;
		}

		setMissionStatus(ctx, state, `validating milestone ${milestone.title}`);
		await syncMissionLiveState({
			phase: `validating milestone ${milestone.title}`,
			currentFeatureIndex: null,
			currentFeatureId: null,
			currentAttempt: null,
			currentMilestoneId: milestone.id,
		});
		const milestoneSharedState = await buildMissionPromptSharedState(missionState, "validator", milestone.id);
		writeCmuxRoleMarker(state.activeMission?.cmuxStreaming, "validator", `Milestone validation • ${milestone.title}`);
		const milestoneValidationExecution = await spawnOrchSubagent({
			role: "validator",
			prompt: buildMilestoneValidationPrompt(
				goal,
				plan,
				milestone,
				milestoneFeatures,
				getMilestoneFeatureRuns(featureRuns, milestone),
				milestoneSharedState,
			),
			cwd: ctx.cwd,
			configState,
			modelRegistry: ctx.modelRegistry,
			signal: state.activeMission?.abortController.signal,
			onStreamEvent: (event) => handleSubagentStreamEvent(ctx, state, event),
		});
		const milestoneValidation = normalizeValidationResult(
			milestoneValidationExecution.output,
			milestoneValidationExecution.provider,
			milestoneValidationExecution.modelId,
		);
		milestoneRuns.push({
			milestone,
			status: milestoneValidation.passed ? "passed" : "failed",
			validation: milestoneValidation,
		});
		await appendMissionKnowledgeBase(
			missionState,
			`Milestone validation: ${milestone.title}`,
			buildMilestoneKnowledgeBaseLines(milestoneValidation),
		);
		await syncMissionMilestoneState(milestone.id, {
			status: milestoneValidation.passed ? "done" : "failed",
			validationSummary: milestoneValidation.summary,
			lastValidatedAt: new Date().toISOString(),
		});
		if (!milestoneValidation.passed) {
			missionStatus = "failed";
			reportMissionEvent(
				pi,
				ctx,
				`Milestone failed: ${milestone.title}`,
				milestoneValidation.summary,
				"error",
				"validate",
			);
			emitMissionRecap(pi, ctx, `milestone ${milestone.title} failed`);
			break;
		}
		reportMissionEvent(
			pi,
			ctx,
			`Milestone passed: ${milestone.title}`,
			milestoneValidation.summary,
			"success",
			"validate",
		);
		emitMissionRecap(pi, ctx, `milestone ${milestone.title} passed`);
	}

	let finalValidation: ValidationResult | undefined;
	if (missionStatus !== "failed") {
		setMissionStatus(ctx, state, "running final validation");
		await syncMissionLiveState({
			phase: "running final validation",
			currentFeatureIndex: null,
			currentFeatureId: null,
			currentAttempt: null,
			currentMilestoneId: null,
		});
		const finalValidationSharedState = await buildMissionPromptSharedState(missionState, "validator", null);
		writeCmuxRoleMarker(state.activeMission?.cmuxStreaming, "validator", "Final mission validation");
		const finalValidationExecution = await spawnOrchSubagent({
			role: "validator",
			prompt: buildFinalValidationPrompt(goal, plan, featureRuns, milestoneRuns, finalValidationSharedState),
			cwd: ctx.cwd,
			configState,
			modelRegistry: ctx.modelRegistry,
			signal: state.activeMission?.abortController.signal,
			onStreamEvent: (event) => handleSubagentStreamEvent(ctx, state, event),
		});
		finalValidation = normalizeValidationResult(
			finalValidationExecution.output,
			finalValidationExecution.provider,
			finalValidationExecution.modelId,
		);
		await appendMissionKnowledgeBase(
			missionState,
			"Final mission validation",
			buildMilestoneKnowledgeBaseLines(finalValidation),
		);
		if (!finalValidation.passed) {
			missionStatus = "needs-attention";
		}
	}

	await syncMissionLiveState({
		phase: missionStatus === "completed" ? "completed" : missionStatus,
		currentFeatureIndex: null,
		currentFeatureId: null,
		currentAttempt: null,
		currentMilestoneId: null,
	});

	const completedAt = new Date().toISOString();
	const record: MissionRecord = {
		id: missionId,
		goal,
		status: missionStatus,
		startedAt,
		completedAt,
		stateDir: missionState.paths.missionDir,
		plan,
		featureRuns,
		milestoneRuns,
		finalValidation,
		models,
	};
	const filePath = await persistMissionRecord(configState, record);

	return {
		record,
		filePath,
	};
}

function generateMissionPlan(goal: string): MissionPlan {
	const missionTitle = goal.length <= 80 ? goal : `${goal.slice(0, 77).trimEnd()}...`;
	return {
		missionTitle,
		summary: goal,
		guidelines: [
			"The main Pi agent is the orchestrator for this mission.",
			"Execute the goal as one focused feature unless validation requires a follow-up pass.",
			"Keep changes scoped to the stated goal and verify with relevant checks when practical.",
		],
		features: [
			{
				id: "feature-1",
				title: missionTitle,
				goal,
				deliverables: [goal],
				dependencies: [],
				notes: [],
			},
		],
		milestones: [
			{
				id: "milestone-1",
				title: missionTitle,
				summary: goal,
				featureIds: ["feature-1"],
				validationTrigger: "Validate when the feature is complete or when conditional validation policy requires it.",
				notes: [],
			},
		],
		validationContract: {
			summary: `Confirm the repository changes satisfy: ${goal}`,
			criteria: [
				{
					id: "criterion-1",
					title: "Goal satisfied",
					description: goal,
					type: "behavior",
				},
				{
					id: "criterion-2",
					title: "Relevant verification recorded",
					description: "Worker reports the checks that were run or clearly states verification limitations.",
					type: "review",
				},
			],
		},
		notes: [],
		rawOutput: JSON.stringify({ goal }),
	};
}

function shouldRunConditionalValidation(
	goal: string,
	feature: MissionFeature,
	workerResult: WorkerRun,
	attempt: number,
): boolean {
	if (attempt > 1) return true;
	if (workerResult.followUps.length > 0 || workerResult.notes.length > 0) return true;
	if (workerResult.testsRun.length === 0) return true;
	if (workerResult.testsRun.some((test) => /\b(fail(?:ed)?|error|not run|skipped|timeout)\b/i.test(test))) return true;
	if (workerResult.changes.length >= 5) return true;
	return hasRiskyValidationContext(goal, feature, workerResult);
}

function hasRiskyValidationContext(goal: string, feature: MissionFeature, workerResult: WorkerRun): boolean {
	const taskText = [goal, feature.goal, feature.title, ...feature.deliverables, ...feature.notes].join("\n");
	const changeText = workerResult.changes.join("\n");
	const combinedText = `${taskText}\n${changeText}`;

	if (/\b(auth|oauth|security|permission|credential|secret|token|session|payment|payments|billing)\b/i.test(combinedText)) {
		return true;
	}
	if (/\b(migration|schema|database|postgres|mysql|sqlite|sql|prisma|drizzle|supabase)\b/i.test(combinedText)) {
		return true;
	}
	if (workerResult.changes.some(isRiskyChangedPath)) {
		return true;
	}
	return hasRiskyDeleteContext(combinedText);
}

function isRiskyChangedPath(change: string): boolean {
	const pathLike = change.split(":", 1)[0] ?? change;
	if (/\.(md|mdx|txt|rst)$/i.test(pathLike)) {
		return false;
	}
	return /(^|\/)(auth|security|permissions?|payments?|billing|db|database|migrations?|prisma|drizzle|supabase)(\/|$)|\.(sql)$/i.test(pathLike);
}

function hasRiskyDeleteContext(text: string): boolean {
	const deleteVerb = "(?:delete|remove|drop|truncate|destroy)";
	const riskyTarget = "(?:data|database|db|table|record|row|user|account|file|directory|payment|auth|migration|schema)";
	return new RegExp(`\\b${deleteVerb}\\b.{0,50}\\b${riskyTarget}\\b|\\b${riskyTarget}\\b.{0,50}\\b${deleteVerb}\\b`, "i").test(text);
}

function createSkippedValidationResult(feature: MissionFeature, workerResult: WorkerRun, attempt: number): ValidationResult {
	const summary = `Validator skipped by conditional policy for ${feature.title} on attempt ${attempt}; accepting worker handoff without a fresh validator pass.`;
	return {
		passed: true,
		summary,
		issues: [],
		evidence: [
			workerResult.summary,
			...(workerResult.testsRun.length > 0 ? workerResult.testsRun.map((test) => `Worker check: ${test}`) : ["Worker reported no tests."]),
		],
		rawOutput: summary,
		provider: "conditional-policy",
		modelId: "validator-skipped",
	};
}

function buildDeterministicSteeringResult(feature: MissionFeature, validationResult: ValidationResult): SteeringResult {
	const instructions = validationResult.issues.map((issue) => `${issue.title}: ${issue.action}`);
	const fixTasks = validationResult.issues.map((issue, index) => ({
		id: `fix-task-${index + 1}`,
		title: issue.title,
		instructions: [issue.action, issue.details],
		deliverables: [`Resolve validator issue: ${issue.title}`],
		notes: [`Severity: ${issue.severity}`, `Feature: ${feature.title}`],
	}));
	const summary = validationResult.summary.trim().length > 0
		? validationResult.summary
		: `Address ${validationResult.issues.length} validator finding${validationResult.issues.length === 1 ? "" : "s"} for ${feature.title}.`;
	return {
		summary,
		instructions: instructions.length > 0 ? instructions : ["Review the validator summary and address the reported gaps."],
		fixTasks: fixTasks.length > 0
			? fixTasks
			: [{
				id: "fix-task-1",
				title: `Address validator findings for ${feature.title}`,
				instructions: [validationResult.summary || "Review the validator summary and address the reported gaps."],
				deliverables: ["All validator findings addressed"],
				notes: [],
			}],
		guidelineUpdates: [],
		rawOutput: JSON.stringify({ summary, instructions, issueCount: validationResult.issues.length }),
		provider: "deterministic",
		modelId: "orchestrator-steering",
	};
}

function buildMilestoneValidationPrompt(
	goal: string,
	plan: MissionPlan,
	milestone: MissionMilestone,
	milestoneFeatures: MissionFeature[],
	featureRuns: FeatureRunRecord[],
	sharedState: MissionPromptSharedState,
): string {
	const featureSummaries = featureRuns.flatMap((featureRun) => {
		const lastAttempt = featureRun.attempts[featureRun.attempts.length - 1];
		return [
			`- ${featureRun.feature.title}: ${lastAttempt?.worker.summary ?? "no worker summary"}`,
			`  handoff: ${lastAttempt?.worker.handoff ?? "none"}`,
			...(lastAttempt?.worker.testsRun ?? []).map((test) => `  test: ${test}`),
		];
	});

	return [
		"Validate a completed milestone as a grouped deliverable.",
		`Mission goal: ${goal}`,
		`Mission summary: ${plan.summary}`,
		`Milestone: ${milestone.title}`,
		`Milestone summary: ${milestone.summary}`,
		`Milestone validation trigger: ${milestone.validationTrigger}`,
		"Milestone features:",
		...milestoneFeatures.map((feature) => `- ${feature.id}: ${feature.title} — ${feature.goal}`),
		"Milestone feature summaries:",
		...(featureSummaries.length > 0 ? featureSummaries : ["- none"]),
		...buildSharedStatePromptSection(sharedState, false),
		"Inspect the repository and determine whether this milestone is complete as an integrated unit. Never modify project files.",
		"Return strict JSON only with this shape:",
		'{ "passed": true, "summary": "string", "issues": [{ "severity": "critical|major|minor", "title": "string", "details": "string", "action": "string" }], "evidence": ["string"] }',
	].join("\n");
}

function buildFinalValidationPrompt(
	goal: string,
	plan: MissionPlan,
	featureRuns: FeatureRunRecord[],
	milestoneRuns: MilestoneRunRecord[],
	sharedState: MissionPromptSharedState,
): string {
	const featureSummaries = featureRuns.flatMap((featureRun) => {
		const lastAttempt = featureRun.attempts[featureRun.attempts.length - 1];
		return [
			`- ${featureRun.feature.title}: ${lastAttempt?.worker.summary ?? "no worker summary"}`,
			`  handoff: ${lastAttempt?.worker.handoff ?? "none"}`,
			...(lastAttempt?.worker.testsRun ?? []).map((test) => `  test: ${test}`),
		];
	});
	const milestoneSummaries = milestoneRuns.map(
		(milestoneRun) => `- ${milestoneRun.milestone.title}: ${milestoneRun.validation.summary}`,
	);

	return [
		"Perform final validation for the entire mission.",
		`Mission goal: ${goal}`,
		`Mission summary: ${plan.summary}`,
		"Completed feature summaries:",
		...(featureSummaries.length > 0 ? featureSummaries : ["- none"]),
		"Milestone validation summaries:",
		...(milestoneSummaries.length > 0 ? milestoneSummaries : ["- none"]),
		...buildSharedStatePromptSection(sharedState, false),
		"Mission validation contract:",
		...plan.validationContract.criteria.map(
			(criterion) => `- ${criterion.id}: ${criterion.title} (${criterion.type}) — ${criterion.description}`,
		),
		"Inspect the repository and determine whether the overall mission is done. Never modify files.",
		"Return strict JSON only with this shape:",
		'{ "passed": true, "summary": "string", "issues": [{ "severity": "critical|major|minor", "title": "string", "details": "string", "action": "string" }], "evidence": ["string"] }',
	].join("\n");
}

function getMilestoneFeatures(plan: MissionPlan, milestone: MissionMilestone): MissionFeature[] {
	const featureById = new Map(plan.features.map((feature) => [feature.id, feature]));
	return milestone.featureIds
		.map((featureId) => featureById.get(featureId))
		.filter((feature): feature is MissionFeature => feature !== undefined);
}

function getMilestoneFeatureRuns(featureRuns: FeatureRunRecord[], milestone: MissionMilestone): FeatureRunRecord[] {
	const featureIdSet = new Set(milestone.featureIds);
	return featureRuns.filter((featureRun) => featureIdSet.has(featureRun.feature.id));
}

function buildValidationKnowledgeBaseLines(workerResult: WorkerRun, validationResult: ValidationResult): string[] {
	return [
		`Worker summary: ${workerResult.summary}`,
		`Validator summary: ${validationResult.summary}`,
		...validationResult.issues.map(
			(issue) => `Validator issue [${issue.severity}] ${issue.title}: ${issue.details} | action: ${issue.action}`,
		),
		...validationResult.evidence.map((evidence) => `Evidence: ${evidence}`),
	];
}

function buildSteeringKnowledgeBaseLines(steering: SteeringResult): string[] {
	return [
		`Steering summary: ${steering.summary}`,
		...steering.instructions.map((instruction) => `Instruction: ${instruction}`),
		...steering.fixTasks.map((task) => `Fix task ${task.id}: ${task.title}`),
		...steering.guidelineUpdates.map((update) => `Guideline update: ${update}`),
	];
}

function buildMilestoneKnowledgeBaseLines(validationResult: ValidationResult): string[] {
	return [
		`Validation summary: ${validationResult.summary}`,
		...validationResult.issues.map(
			(issue) => `Issue [${issue.severity}] ${issue.title}: ${issue.details} | action: ${issue.action}`,
		),
		...validationResult.evidence.map((evidence) => `Evidence: ${evidence}`),
	];
}

function normalizeWorkerRun(output: string, provider: string, modelId: string): WorkerRun {
	const parsed = parseJsonObject(output);
	if (!isRecord(parsed)) {
		const fallbackSummary = output.trim() || "Worker completed without structured output.";
		return {
			summary: fallbackSummary,
			changes: [],
			testsRun: [],
			notes: [],
			followUps: [],
			handoff: fallbackSummary,
			rawOutput: output,
			provider,
			modelId,
		};
	}
	const summary = asNonEmptyString(parsed.summary) ?? (output.trim() || "Worker completed.");
	return {
		summary,
		changes: asStringArray(parsed.changes),
		testsRun: asStringArray(parsed.testsRun),
		notes: asStringArray(parsed.notes),
		followUps: asStringArray(parsed.followUps),
		handoff: asNonEmptyString(parsed.handoff) ?? summary,
		rawOutput: output,
		provider,
		modelId,
	};
}

function normalizeValidationResult(output: string, provider: string, modelId: string): ValidationResult {
	const parsed = parseJsonObject(output);
	if (!isRecord(parsed)) {
		return {
			passed: false,
			summary: output.trim() || "Validator returned unstructured output.",
			issues: [
				{
					severity: "major",
					title: "Unstructured validator output",
					details: output.trim() || "No validator details were returned.",
					action: "Run another validator pass with clearer structured output.",
				},
			],
			evidence: [],
			rawOutput: output,
			provider,
			modelId,
		};
	}

	const issues = Array.isArray(parsed.issues)
		? parsed.issues
				.map((issue, index) => normalizeValidationIssue(issue, index + 1))
				.filter((issue): issue is ValidationIssue => issue !== undefined)
		: [];

	return {
		passed: typeof parsed.passed === "boolean" ? parsed.passed : issues.length === 0,
		summary: asNonEmptyString(parsed.summary) ?? (output.trim() || "Validation completed."),
		issues,
		evidence: asStringArray(parsed.evidence),
		rawOutput: output,
		provider,
		modelId,
	};
}

function normalizeValidationIssue(value: unknown, index: number): ValidationIssue | undefined {
	if (!isRecord(value)) return undefined;
	const title = asNonEmptyString(value.title) ?? `Issue ${index}`;
	return {
		severity: asValidationIssueSeverity(value.severity) ?? "major",
		title,
		details: asNonEmptyString(value.details) ?? title,
		action: asNonEmptyString(value.action) ?? "Investigate and resolve the issue.",
	};
}

function parseJsonObject(output: string): unknown {
	const trimmed = output.trim();
	if (trimmed.length === 0) {
		return undefined;
	}

	const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	const candidates = [fenceMatch?.[1], trimmed, extractBalancedJson(trimmed)].filter(
		(candidate): candidate is string => candidate !== undefined && candidate.length > 0,
	);

	for (const candidate of candidates) {
		try {
			return JSON.parse(candidate);
		} catch {
			// Continue trying fallbacks.
		}
	}

	return undefined;
}

function extractBalancedJson(value: string): string | undefined {
	const start = value.indexOf("{");
	if (start === -1) {
		return undefined;
	}

	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let index = start; index < value.length; index++) {
		const character = value[index];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (character === "\\") {
				escaped = true;
				continue;
			}
			if (character === '"') {
				inString = false;
			}
			continue;
		}

		if (character === '"') {
			inString = true;
			continue;
		}

		if (character === "{") {
			depth++;
		} else if (character === "}") {
			depth--;
			if (depth === 0) {
				return value.slice(start, index + 1);
			}
		}
	}

	return undefined;
}

async function persistMissionRecord(configState: OrchLoadedConfig, record: MissionRecord): Promise<string> {
	const missionsDir = configState.resolvedPaths.missionsDir;
	await mkdir(missionsDir, { recursive: true });
	const fileName = `${record.startedAt.replace(/[:.]/g, "-")}-${slugifyText(record.plan.missionTitle || record.goal, 80, "mission")}.json`;
	const filePath = join(missionsDir, fileName);
	await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
	return filePath;
}

function buildMissionCompletionText(result: MissionRunResult): string {
	const { record } = result;
	const completedFeatures = record.featureRuns.filter((featureRun) => featureRun.status === "passed").length;
	const totalFeatures = record.plan.features.length;
	const finalSummary = record.finalValidation?.summary ?? "Final validation not executed.";

	return [
		`Status: ${record.status}`,
		`Mission: ${record.plan.missionTitle}`,
		`Features completed: ${completedFeatures}/${totalFeatures}`,
		`Milestones validated: ${record.milestoneRuns.filter((run) => run.status === "passed").length}/${record.plan.milestones.length}`,
		`Final validation: ${finalSummary}`,
		`Mission state dir: ${record.stateDir}`,
		`Saved mission log: ${result.filePath}`,
	].join("\n");
}

function deliverPendingTakeover(pi: ExtensionAPI, pendingTakeover: OrchPendingTakeoverPrompt): void {
	if (pendingTakeover.images.length === 0) {
		pi.sendUserMessage(pendingTakeover.text.length > 0 ? pendingTakeover.text : "Continue interactively.");
		return;
	}

	const content = [
		{
			type: "text" as const,
			text:
				pendingTakeover.text.length > 0
					? pendingTakeover.text
					: "The previous autonomous mission was interrupted. Continue interactively with these attachments.",
		},
		...pendingTakeover.images,
	];
	pi.sendUserMessage(content);
}

function handleSubagentStreamEvent(
	ctx: ExtensionCommandContext,
	state: OrchRuntimeState,
	event: OrchSubagentStreamEvent,
): void {
	const mission = state.activeMission;
	if (!mission) {
		return;
	}

	if (event.type === "status") {
		if (event.role === "orchestrator" && event.status === "starting") {
			mission.orchestratorThinking = "";
			mission.orchestratorText = "";
		}
		updateMissionThinkingWidget(ctx, mission);
		return;
	}

	if (event.type === "tool_call") {
		appendCmuxRoleDelta(mission.cmuxStreaming, event.role, `\n[${event.label}] ${event.detail}\n`);
		return;
	}

	appendCmuxRoleDelta(mission.cmuxStreaming, event.role, event.delta);

	if (event.role === "orchestrator") {
		if (event.type === "thinking_delta") {
			mission.orchestratorThinking = appendStreamChunk(mission.orchestratorThinking, event.delta);
		} else if (event.type === "text_delta") {
			mission.orchestratorText = appendStreamChunk(mission.orchestratorText, event.delta);
		}
		updateMissionThinkingWidget(ctx, mission);
	}
}

function updateMissionThinkingWidget(ctx: ExtensionCommandContext, mission: OrchActiveMission): void {
	if (!ctx.hasUI) return;

	ctx.ui.setWidget(
		ORCH_WIDGET_IDS.missionProgress,
		(_tui, theme) => new OrchMissionProgressComponent(theme, mission),
		{ placement: "belowEditor" },
	);
	ctx.ui.setWidget(ORCH_WIDGET_IDS.missionBlock, undefined);
	ctx.ui.setWidget(ORCH_WIDGET_IDS.missionThinking, undefined);
}

function clearMissionThinkingWidget(ctx: ExtensionCommandContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setWidget(ORCH_WIDGET_IDS.missionBlock, undefined);
	ctx.ui.setWidget(ORCH_WIDGET_IDS.missionThinking, undefined);
	ctx.ui.setWidget(ORCH_WIDGET_IDS.missionProgress, undefined);
}

class OrchMissionProgressComponent implements Component {
	constructor(
		private readonly theme: OrchTheme,
		private readonly mission: OrchActiveMission,
	) {}

	render(width: number): string[] {
		return renderMissionProgressLines(this.theme, this.mission, width);
	}

	handleInput(): void {
		// No-op.
	}

	invalidate(): void {
		// Mission data is read on each render.
	}
}

function renderMissionProgressLines(theme: OrchTheme, mission: OrchActiveMission, width: number): string[] {
	const lines: string[] = [];
	const featuresState = mission.featuresState;
	const liveState = mission.liveState;
	const currentMilestone = getCurrentMilestone(mission);

	lines.push(formatMissionLine(theme, width, GLYPHS.boxTopLeft, ` Mission: ${truncateInlineText(mission.goal, 120)}`));
	lines.push(formatMissionLine(theme, width, GLYPHS.boxVert, ` Task: ${describeCurrentMissionTask(mission)}`));

	if (currentMilestone) {
		let milestoneBody = ` Milestone: ${truncateInlineText(currentMilestone.title, 80)}`;
		if (featuresState) {
			milestoneBody += ` · ${getMilestoneProgressText(featuresState, currentMilestone.id)}`;
		}
		milestoneBody += ` · ${getMilestoneStatusText(theme, currentMilestone.status)}`;
		lines.push(formatMissionLine(theme, width, GLYPHS.boxVert, milestoneBody));
	} else if (featuresState) {
		lines.push(formatMissionLine(theme, width, GLYPHS.boxVert, ` Progress: ${getOverallMissionProgressText(featuresState)}`));
	}

	if (featuresState) {
		const visibleFeatures = currentMilestone
			? featuresState.features.filter((feature) => feature.milestoneId === currentMilestone.id)
			: featuresState.features;
		for (const feature of visibleFeatures) {
			lines.push(formatMissionLine(theme, width, GLYPHS.boxVert, ` ${formatFeatureProgress(theme, feature, mission)}`));
		}
	}

	lines.push(formatMissionLine(theme, width, GLYPHS.boxVert, ` Last update: ${truncateInlineText(getLastOrchestratorLine(mission), 90)}`));
	if (liveState) {
		const phaseSuffix = liveState.currentAttempt !== null ? ` · attempt ${liveState.currentAttempt}` : "";
		lines.push(formatMissionLine(theme, width, GLYPHS.boxVert, ` Phase: ${truncateInlineText(liveState.phase, 72)}${phaseSuffix}`));
	}
	lines.push(formatMissionLine(theme, width, GLYPHS.boxBottomLeft, " /orch takeover"));
	return lines;
}

function formatMissionLine(theme: OrchTheme, width: number, leftGlyph: string, body: string): string {
	const styledGlyph = theme.fg("dim", leftGlyph);
	if (width <= visibleWidth(styledGlyph)) {
		return truncateToWidth(styledGlyph, width, "");
	}
	const prefix = `${styledGlyph} `;
	const contentWidth = Math.max(0, width - visibleWidth(prefix));
	const content = truncateToWidth(body, contentWidth, theme.fg("dim", GLYPHS.ellipsis));
	return truncateToWidth(`${prefix}${content}`, width, theme.fg("dim", GLYPHS.ellipsis));
}

function getCurrentMilestone(mission: OrchActiveMission): MissionMilestoneStateEntry | undefined {
	const milestoneId = mission.liveState?.currentMilestoneId;
	if (!milestoneId) {
		return undefined;
	}
	return mission.featuresState?.milestones.find((milestone) => milestone.id === milestoneId);
}

function getMilestoneProgressText(featuresState: MissionFeaturesStateFile, milestoneId: string): string {
	const milestone = featuresState.milestones.find((entry) => entry.id === milestoneId);
	if (!milestone) {
		return "0/0 done";
	}
	const featureIds = new Set(milestone.featureIds);
	const total = milestone.featureIds.length;
	const done = featuresState.features.filter((feature) => featureIds.has(feature.id) && feature.status === "done").length;
	return `${done}/${total} done`;
}

function getOverallMissionProgressText(featuresState: MissionFeaturesStateFile): string {
	const doneFeatures = featuresState.features.filter((feature) => feature.status === "done").length;
	const failedFeatures = featuresState.features.filter((feature) => feature.status === "failed").length;
	const doneMilestones = featuresState.milestones.filter((milestone) => milestone.status === "done").length;
	const failedMilestones = featuresState.milestones.filter((milestone) => milestone.status === "failed").length;
	const parts = [
		`${doneFeatures}/${featuresState.features.length} features done`,
		`${doneMilestones}/${featuresState.milestones.length} milestones done`,
	];
	if (failedFeatures > 0) {
		parts.push(`${failedFeatures} feature${failedFeatures === 1 ? "" : "s"} failed`);
	}
	if (failedMilestones > 0) {
		parts.push(`${failedMilestones} milestone${failedMilestones === 1 ? "" : "s"} failed`);
	}
	return parts.join(" · ");
}

function getMilestoneStatusText(theme: OrchTheme, status: MissionFeatureStateStatus): string {
	switch (status) {
		case "done":
			return `${theme.fg("success", GLYPHS.pass)} ${theme.fg("success", "passed")}`;
		case "failed":
			return `${theme.fg("error", GLYPHS.fail)} ${theme.fg("error", "failed")}`;
		case "in-progress":
			return `${theme.fg("accent", GLYPHS.inProgress)} ${theme.fg("accent", "running")}`;
		default:
			return `${theme.fg("dim", GLYPHS.pending)} ${theme.fg("dim", "pending")}`;
	}
}

function formatFeatureProgress(theme: OrchTheme, feature: MissionFeatureStateEntryLike, mission: OrchActiveMission): string {
	const statusGlyph = getFeatureSymbol(feature.status);
	let statusText = "pending";
	if (feature.status === "done") {
		statusText = `${GLYPHS.pass} passed`;
	} else if (feature.status === "failed") {
		statusText = `${GLYPHS.fail} failed`;
	} else if (feature.status === "in-progress") {
		const liveState = mission.liveState;
		if (liveState?.currentFeatureId === feature.id) {
			statusText = liveState.phase.startsWith("validating ") ? `${GLYPHS.inProgress} validating` : `running worker${GLYPHS.ellipsis}`;
		} else {
			statusText = feature.attempts > 1 ? `running · attempt ${feature.attempts}` : "running";
		}
	}

	const line = `${statusGlyph} ${feature.title} — ${statusText}`;
	return theme.fg(getFeatureColor(feature.status), line);
}

type MissionFeatureStateEntryLike = {
	id: string;
	title: string;
	status: MissionFeatureStateStatus;
	attempts: number;
};

function getLastOrchestratorLine(mission: OrchActiveMission): string {
	const textLine = getLastMeaningfulLine(mission.orchestratorText);
	if (textLine) {
		return textLine;
	}
	const thinkingLine = getLastMeaningfulLine(mission.orchestratorThinking);
	if (thinkingLine) {
		return thinkingLine;
	}
	return "Waiting for the orchestrator to produce an update.";
}

function describeCurrentMissionTask(mission: OrchActiveMission): string {
	const liveState = mission.liveState;
	const featuresState = mission.featuresState;
	if (!liveState) {
		return mission.phase;
	}

	if (liveState.currentFeatureId) {
		const currentFeature = featuresState?.features.find((feature) => feature.id === liveState.currentFeatureId);
		const featureTitle = currentFeature?.title ?? liveState.currentFeatureId;
		const attemptText = liveState.currentAttempt !== null ? ` (attempt ${liveState.currentAttempt})` : "";
		if (liveState.phase.startsWith("validating ")) {
			return `Validator reviewing ${featureTitle}${attemptText}`;
		}
		return `Worker implementing ${featureTitle}${attemptText}`;
	}

	if (liveState.phase === "running final validation") {
		return "Validator running final mission validation";
	}
	if (liveState.phase.startsWith("validating milestone ")) {
		return liveState.phase.replace("validating milestone ", "Validator reviewing milestone ");
	}
	if (liveState.phase.startsWith("executing milestone ")) {
		return liveState.phase.replace("executing milestone ", "Coordinating milestone ");
	}
	return liveState.phase;
}

function getFeatureSymbol(status: MissionFeatureStateStatus): string {
	return FEATURE_STATUS_SYMBOLS[status];
}

function getFeatureColor(status: MissionFeatureStateStatus): MissionProgressColor {
	return FEATURE_STATUS_COLORS[status];
}

function appendStreamChunk(current: string, delta: string): string {
	const next = `${current}${delta}`;
	return next.length <= MAX_STREAM_CHARS ? next : next.slice(next.length - MAX_STREAM_CHARS);
}

function getLastMeaningfulLine(content: string): string | undefined {
	const normalized = content
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	return normalized.at(-1);
}

function truncateInlineText(value: string, maxLength: number): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	if (singleLine.length <= maxLength) {
		return singleLine;
	}
	return `${singleLine.slice(0, maxLength - 3)}${GLYPHS.ellipsis}`;
}

async function readMissionFeaturesStateFromFile(path: string): Promise<MissionFeaturesStateFile> {
	const content = await readFile(path, "utf8");
	return JSON.parse(content) as MissionFeaturesStateFile;
}

async function resolveMissionGoal(args: string, ctx: ExtensionCommandContext): Promise<string | undefined> {
	const trimmed = args.trim();
	if (trimmed.length > 0) {
		return trimmed;
	}
	if (!ctx.hasUI) {
		return undefined;
	}
	return ctx.ui.input("Mission goal", "Describe what Orch should build or change");
}

function reportMissionEvent(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	title: string,
	body: string,
	level: OrchEventLevel,
	phase: string,
): void {
	if (ctx.hasUI) {
		if (!shouldDisplayMissionEventInUi(level, phase)) {
			return;
		}
		emitOrchEvent(pi, ctx, body, { title, level, phase });
		return;
	}

	const block = [`[${title}]`, body].filter((value) => value.trim().length > 0).join("\n");
	process.stdout.write(`${block}\n`);
}

function emitMissionRecap(pi: ExtensionAPI, ctx: ExtensionCommandContext, content: string): void {
	const recapContent = `recap: ${content}`;
	if (ctx.hasUI) {
		emitOrchEvent(pi, ctx, recapContent, { level: "info", recap: true });
		return;
	}
	process.stdout.write(`${GLYPHS.recap} ${recapContent}\n`);
}

function emitWorkerChanges(pi: ExtensionAPI, ctx: ExtensionCommandContext, changes: string[]): void {
	if (changes.length === 0) {
		return;
	}
	if (ctx.hasUI) {
		emitOrchEvent(pi, ctx, "", { level: "info", workerChanges: changes });
		return;
	}
	process.stdout.write(["Worker changes:", ...changes.map((change) => `- ${change}`)].join("\n") + "\n");
}

function shouldDisplayMissionEventInUi(level: OrchEventLevel, phase: string): boolean {
	if (phase === "mission") {
		return true;
	}
	return level === "warning" || level === "error";
}

function setMissionStatus(ctx: ExtensionCommandContext, state: OrchRuntimeState, text: string | undefined): void {
	if (state.activeMission && text) {
		state.activeMission.phase = text;
	}
	if (!ctx.hasUI) return;
	const statusText = text ? `${text} • /orch takeover to interrupt` : undefined;
	ctx.ui.setStatus(MISSION_STATUS_KEY, statusText ? ctx.ui.theme.fg("accent", statusText) : undefined);
	setOrchStatus(ctx, state);
}

function formatRoleModel(configState: OrchLoadedConfig, role: "worker" | "validator"): string {
	const model = configState.merged.roles[role];
	return `${model.provider}/${model.model}`;
}

function createMissionId(goal: string, startedAt: string): string {
	return `${startedAt.replace(/[:.]/g, "-")}-${slugifyText(goal, 80, "mission").slice(0, 48)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => (typeof item === "string" ? item.trim() : undefined))
		.filter((item): item is string => item !== undefined && item.length > 0);
}

function asValidationIssueSeverity(value: unknown): ValidationIssueSeverity | undefined {
	if (value === "critical" || value === "major" || value === "minor") {
		return value;
	}
	return undefined;
}

