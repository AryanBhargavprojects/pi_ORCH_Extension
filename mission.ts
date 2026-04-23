import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import { loadOrchConfig, type OrchLoadedConfig } from "./config.js";
import {
	appendCmuxRoleDelta,
	cleanupCmuxMissionStreaming,
	setupCmuxMissionStreaming,
	writeCmuxRoleMarker,
} from "./cmux-streaming.js";
import { ORCH_COMMANDS, ORCH_WIDGET_IDS } from "./constants.js";
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
	type MissionPlan,
	type MissionPromptSharedState,
	type MissionRecord,
	type MissionRunResult,
	type MissionStatus,
	type SteeringResult,
	type ValidationContract,
	type ValidationCriterion,
	type ValidationCriterionType,
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
	pending: "○",
	"in-progress": "◆",
	done: "✓",
	failed: "✗",
};

const FEATURE_STATUS_COLORS: Record<MissionFeatureStateStatus, MissionProgressColor> = {
	pending: "dim",
	"in-progress": "accent",
	done: "success",
	failed: "error",
};

const MILESTONE_STATUS_COLORS: Record<MissionFeatureStateStatus, MissionProgressColor> = {
	pending: "muted",
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
				} catch (error) {
					reportMissionEvent(pi, ctx, "Mission failed", formatErrorMessage(error), "error", "mission");
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
		orchestrator: formatRoleModel(configState, "orchestrator"),
		worker: formatRoleModel(configState, "worker"),
		validator: formatRoleModel(configState, "validator"),
	};

	reportMissionEvent(
		pi,
		ctx,
		"Mission started",
		[`Goal: ${goal}`, `Mission ID: ${missionId}`, `Models: ${models.orchestrator} | ${models.worker} | ${models.validator}`].join(
			"\n",
		),
		"info",
		"plan",
	);
	setMissionStatus(ctx, state, "planning mission");

	writeCmuxRoleMarker(state.activeMission?.cmuxStreaming, "orchestrator", "Mission planning");
	const plan = await generateMissionPlan(goal, ctx.cwd, configState, ctx, state);
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

				setMissionStatus(ctx, state, `validating ${feature.title} (attempt ${attempt})`);
				await syncMissionLiveState({
					phase: `validating ${feature.title}`,
					currentFeatureIndex: featureIndex,
					currentFeatureId: feature.id,
					currentAttempt: attempt,
					currentMilestoneId: milestone.id,
				});
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
				const validationResult = normalizeValidationResult(
					validationExecution.output,
					validationExecution.provider,
					validationExecution.modelId,
				);
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
					const orchestratorSharedState = await buildMissionPromptSharedState(
						missionState,
						"orchestrator",
						milestone.id,
					);
					writeCmuxRoleMarker(
						state.activeMission?.cmuxStreaming,
						"orchestrator",
						`Steering for ${feature.title} • attempt ${attempt}`,
					);
					const steeringExecution = await spawnOrchSubagent({
						role: "orchestrator",
						prompt: buildSteeringPrompt(
							goal,
							plan,
							milestone,
							feature,
							workerResult,
							validationResult,
							orchestratorSharedState,
						),
						cwd: ctx.cwd,
						configState,
						modelRegistry: ctx.modelRegistry,
						signal: state.activeMission?.abortController.signal,
						onStreamEvent: (event) => handleSubagentStreamEvent(ctx, state, event),
					});
					steering = normalizeSteeringResult(
						steeringExecution.output,
						steeringExecution.provider,
						steeringExecution.modelId,
					);
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

async function generateMissionPlan(
	goal: string,
	cwd: string,
	configState: OrchLoadedConfig,
	ctx: ExtensionCommandContext,
	state: OrchRuntimeState,
): Promise<MissionPlan> {
	const execution = await spawnOrchSubagent({
		role: "orchestrator",
		prompt: buildMissionPlanPrompt(goal, cwd),
		cwd,
		configState,
		modelRegistry: ctx.modelRegistry,
		signal: state.activeMission?.abortController.signal,
		onStreamEvent: (event) => handleSubagentStreamEvent(ctx, state, event),
	});

	return normalizeMissionPlan(execution.output, goal);
}

function buildMissionPlanPrompt(goal: string, cwd: string): string {
	return [
		"Plan an autonomous coding mission for the following goal.",
		`Goal: ${goal}`,
		`Working directory: ${cwd}`,
		"You may inspect the repository with read-only tools before planning.",
		"Return strict JSON only. Do not wrap the JSON in markdown fences.",
		"JSON shape:",
		"{",
		'  "missionTitle": "string",',
		'  "summary": "string",',
		'  "guidelines": ["string"],',
		'  "features": [',
		"    {",
		'      "id": "feature-1",',
		'      "title": "string",',
		'      "goal": "string",',
		'      "deliverables": ["string"],',
		'      "dependencies": ["feature-x"],',
		'      "notes": ["string"]',
		"    }",
		"  ],",
		'  "milestones": [',
		"    {",
		'      "id": "milestone-1",',
		'      "title": "string",',
		'      "summary": "string",',
		'      "featureIds": ["feature-1"],',
		'      "validationTrigger": "string",',
		'      "notes": ["string"]',
		"    }",
		"  ],",
		'  "validationContract": {',
		'    "summary": "string",',
		'    "criteria": [',
		"      {",
		'        "id": "criterion-1",',
		'        "title": "string",',
		'        "description": "string",',
		'        "type": "behavior|test|file|review"',
		"      }",
		"    ]",
		"  },",
		'  "notes": ["string"]',
		"}",
		`Rules: 1-${MAX_FEATURES} features, each feature must be independently executable by a fresh worker context. Group features into milestones of at most ${MAX_FEATURES_PER_MILESTONE} planned features where practical. Return concrete mission guidelines and milestone validation triggers.`,
	].join("\n");
}

function buildSteeringPrompt(
	goal: string,
	plan: MissionPlan,
	milestone: MissionMilestone,
	feature: MissionFeature,
	workerResult: WorkerRun,
	validationResult: ValidationResult,
	sharedState: MissionPromptSharedState,
): string {
	return [
		"Generate a concrete fix-task plan after a failed validation pass.",
		`Mission goal: ${goal}`,
		`Mission summary: ${plan.summary}`,
		`Milestone: ${milestone.title}`,
		`Feature title: ${feature.title}`,
		`Feature goal: ${feature.goal}`,
		"Worker summary:",
		workerResult.summary,
		"Worker handoff:",
		workerResult.handoff,
		"Validator findings:",
		validationResult.summary,
		...validationResult.issues.map((issue) => `- [${issue.severity}] ${issue.title}: ${issue.details} | action: ${issue.action}`),
		...buildSharedStatePromptSection(sharedState, true),
		"Return strict JSON only with this shape:",
		'{ "summary": "string", "instructions": ["string"], "fixTasks": [{ "id": "fix-task-1", "title": "string", "instructions": ["string"], "deliverables": ["string"], "notes": ["string"] }], "guidelineUpdates": ["string"] }',
		"Generate fix tasks that a fresh worker can execute immediately. Keep the instructions concrete and implementation-focused.",
	].join("\n");
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

function normalizeMissionPlan(output: string, goal: string): MissionPlan {
	const fallbackFeatures: MissionFeature[] = [
		{
			id: "feature-1",
			title: goal.slice(0, 80),
			goal,
			deliverables: [goal],
			dependencies: [],
			notes: [],
		},
	];
	const fallback: MissionPlan = {
		missionTitle: goal.slice(0, 80),
		summary: goal,
		guidelines: [],
		features: fallbackFeatures,
		milestones: createDefaultMilestones(fallbackFeatures),
		validationContract: {
			summary: "Complete the requested goal and verify the changed behavior.",
			criteria: [
				{
					id: "criterion-1",
					title: "Goal satisfied",
					description: "The implemented result should satisfy the user goal.",
					type: "behavior",
				},
			],
		},
		notes: [],
		rawOutput: output,
	};

	const parsed = parseJsonObject(output);
	if (!isRecord(parsed)) {
		return fallback;
	}

	const featuresValue = Array.isArray(parsed.features) ? parsed.features : [];
	const features = featuresValue
		.slice(0, MAX_FEATURES)
		.map((feature, index) => normalizeMissionFeature(feature, index + 1))
		.filter((feature): feature is MissionFeature => feature !== undefined);
	const normalizedFeatures = features.length > 0 ? features : fallback.features;
	const validationContract = normalizeValidationContract(parsed.validationContract);
	const milestones = normalizeMissionMilestones(parsed.milestones, normalizedFeatures);

	return {
		missionTitle: asNonEmptyString(parsed.missionTitle) ?? fallback.missionTitle,
		summary: asNonEmptyString(parsed.summary) ?? fallback.summary,
		guidelines: asStringArray(parsed.guidelines),
		features: normalizedFeatures,
		milestones,
		validationContract: validationContract ?? fallback.validationContract,
		notes: asStringArray(parsed.notes),
		rawOutput: output,
	};
}

function normalizeMissionFeature(value: unknown, index: number): MissionFeature | undefined {
	if (!isRecord(value)) return undefined;
	const title = asNonEmptyString(value.title) ?? `Feature ${index}`;
	return {
		id: asNonEmptyString(value.id) ?? `feature-${index}`,
		title,
		goal: asNonEmptyString(value.goal) ?? title,
		deliverables: asStringArray(value.deliverables),
		dependencies: asStringArray(value.dependencies),
		notes: asStringArray(value.notes),
	};
}

function normalizeMissionMilestones(value: unknown, features: MissionFeature[]): MissionMilestone[] {
	if (!Array.isArray(value)) {
		return createDefaultMilestones(features);
	}

	const featureIdSet = new Set(features.map((feature) => feature.id));
	const milestones = value
		.map((milestone, index) => normalizeMissionMilestone(milestone, index + 1, featureIdSet))
		.filter((milestone): milestone is MissionMilestone => milestone !== undefined);
	const coveredFeatureIds = new Set(milestones.flatMap((milestone) => milestone.featureIds));
	const missingFeatures = features.filter((feature) => !coveredFeatureIds.has(feature.id));
	if (missingFeatures.length === 0 && milestones.length > 0) {
		return milestones;
	}

	return [...milestones, ...createDefaultMilestones(missingFeatures, milestones.length + 1)];
}

function normalizeMissionMilestone(
	value: unknown,
	index: number,
	featureIdSet: Set<string>,
): MissionMilestone | undefined {
	if (!isRecord(value)) return undefined;
	const title = asNonEmptyString(value.title) ?? `Milestone ${index}`;
	const featureIds = asStringArray(value.featureIds).filter((featureId) => featureIdSet.has(featureId));
	if (featureIds.length === 0) {
		return undefined;
	}
	return {
		id: asNonEmptyString(value.id) ?? `milestone-${index}`,
		title,
		summary: asNonEmptyString(value.summary) ?? title,
		featureIds,
		validationTrigger: asNonEmptyString(value.validationTrigger) ?? `Validate ${title} before proceeding.`,
		notes: asStringArray(value.notes),
	};
}

function createDefaultMilestones(features: MissionFeature[], startIndex = 1): MissionMilestone[] {
	const milestones: MissionMilestone[] = [];
	for (let index = 0; index < features.length; index += MAX_FEATURES_PER_MILESTONE) {
		const chunk = features.slice(index, index + MAX_FEATURES_PER_MILESTONE);
		const milestoneIndex = startIndex + milestones.length;
		milestones.push({
			id: `milestone-${milestoneIndex}`,
			title: `Milestone ${milestoneIndex}`,
			summary: chunk.map((feature) => feature.title).join("; "),
			featureIds: chunk.map((feature) => feature.id),
			validationTrigger: `Validate milestone ${milestoneIndex} after completing ${chunk.map((feature) => feature.title).join(", ")}.`,
			notes: [],
		});
	}
	return milestones;
}

function normalizeValidationContract(value: unknown): ValidationContract | undefined {
	if (!isRecord(value)) return undefined;
	const criteria = Array.isArray(value.criteria)
		? value.criteria
				.map((criterion, index) => normalizeValidationCriterion(criterion, index + 1))
				.filter((criterion): criterion is ValidationCriterion => criterion !== undefined)
		: [];
	if (criteria.length === 0) {
		return undefined;
	}
	return {
		summary: asNonEmptyString(value.summary) ?? "Validation contract",
		criteria,
	};
}

function normalizeValidationCriterion(value: unknown, index: number): ValidationCriterion | undefined {
	if (!isRecord(value)) return undefined;
	const type = asValidationCriterionType(value.type) ?? "behavior";
	const title = asNonEmptyString(value.title) ?? `Criterion ${index}`;
	return {
		id: asNonEmptyString(value.id) ?? `criterion-${index}`,
		title,
		description: asNonEmptyString(value.description) ?? title,
		type,
	};
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

function normalizeSteeringResult(output: string, provider: string, modelId: string): SteeringResult {
	const parsed = parseJsonObject(output);
	if (!isRecord(parsed)) {
		return {
			summary: output.trim() || "Provide a focused follow-up implementation pass.",
			instructions: [output.trim() || "Review validator feedback and address the missing requirements."],
			fixTasks: [
				{
					id: "fix-task-1",
					title: "Address validator findings",
					instructions: [output.trim() || "Review validator feedback and address the missing requirements."],
					deliverables: ["All validator findings addressed"],
					notes: [],
				},
			],
			guidelineUpdates: [],
			rawOutput: output,
			provider,
			modelId,
		};
	}
	const instructions = asStringArray(parsed.instructions);
	const fixTasks = Array.isArray(parsed.fixTasks)
		? parsed.fixTasks
				.map((task, index) => normalizeFixTask(task, index + 1))
				.filter((task): task is MissionFixTask => task !== undefined)
		: [];
	return {
		summary: asNonEmptyString(parsed.summary) ?? "Provide a focused follow-up implementation pass.",
		instructions: instructions.length > 0 ? instructions : ["Address the validator issues and re-check the feature."],
		fixTasks:
			fixTasks.length > 0
				? fixTasks
				: [
					{
						id: "fix-task-1",
						title: "Address validator findings",
						instructions:
							instructions.length > 0
								? instructions
								: ["Address the validator issues and re-check the feature."],
						deliverables: ["All validator findings addressed"],
						notes: [],
					},
				],
		guidelineUpdates: asStringArray(parsed.guidelineUpdates),
		rawOutput: output,
		provider,
		modelId,
	};
}

function normalizeFixTask(value: unknown, index: number): MissionFixTask | undefined {
	if (!isRecord(value)) return undefined;
	const title = asNonEmptyString(value.title) ?? `Fix task ${index}`;
	return {
		id: asNonEmptyString(value.id) ?? `fix-task-${index}`,
		title,
		instructions: asStringArray(value.instructions),
		deliverables: asStringArray(value.deliverables),
		notes: asStringArray(value.notes),
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

	ctx.ui.setWidget(ORCH_WIDGET_IDS.missionBlock, (_tui, theme) => {
		return new Text(buildMissionBlockText(theme, mission), 1, 1, (value: string) => theme.bg("toolPendingBg", value));
	});
	ctx.ui.setWidget(ORCH_WIDGET_IDS.missionThinking, undefined);
	ctx.ui.setWidget(ORCH_WIDGET_IDS.missionProgress, undefined);
}

function clearMissionThinkingWidget(ctx: ExtensionCommandContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setWidget(ORCH_WIDGET_IDS.missionBlock, undefined);
	ctx.ui.setWidget(ORCH_WIDGET_IDS.missionThinking, undefined);
	ctx.ui.setWidget(ORCH_WIDGET_IDS.missionProgress, undefined);
}

function buildMissionBlockText(theme: OrchTheme, mission: OrchActiveMission): string {
	const lines = [
		theme.fg("accent", theme.bold("Orch Mission")),
		theme.fg("dim", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"),
		theme.fg("muted", `Goal: ${truncateInlineText(mission.goal, MAX_MISSION_GOAL_LENGTH)}`),
		theme.fg("accent", `Current task: ${describeCurrentMissionTask(mission)}`),
	];

	if (mission.featuresState && mission.liveState) {
		lines.push("");
		lines.push(theme.fg("warning", theme.bold("To-do list")));
		lines.push(...buildMissionChecklistLines(theme, mission.featuresState, mission.liveState));
	}

	lines.push("");
	lines.push(theme.fg("warning", theme.bold("Last orchestrator update")));
	lines.push(theme.fg("dim", truncateInlineText(getLastOrchestratorLine(mission), MAX_MISSION_GOAL_LENGTH)));
	lines.push("");
	lines.push(theme.fg("muted", `Phase: ${mission.phase} • /orch takeover to interrupt`));
	return lines.join("\n");
}

function buildMissionChecklistLines(
	theme: OrchTheme,
	featuresState: MissionFeaturesStateFile,
	liveState: MissionLiveState,
): string[] {
	const completedFeatures = featuresState.features.filter((feature) => feature.status === "done").length;
	const failedFeatures = featuresState.features.filter((feature) => feature.status === "failed").length;
	const completedMilestones = featuresState.milestones.filter((milestone) => milestone.status === "done").length;
	const failedMilestones = featuresState.milestones.filter((milestone) => milestone.status === "failed").length;
	const lines: string[] = [];

	for (let index = 0; index < featuresState.milestones.length; index++) {
		const milestone = featuresState.milestones[index]!;
		lines.push(theme.fg(getMilestoneColor(milestone.status), theme.bold(milestone.title)));
		for (const feature of featuresState.features.filter((entry) => entry.milestoneId === milestone.id)) {
			let featureLine = `${getFeatureSymbol(feature.status)} ${feature.id}: ${feature.title}`;
			if (feature.status === "in-progress" && feature.attempts > 1) {
				featureLine += ` ← attempt ${feature.attempts}`;
			}
			lines.push(`  ${theme.fg(getFeatureColor(feature.status), featureLine)}`);
		}
		if (index < featuresState.milestones.length - 1) {
			lines.push("");
		}
	}

	const progressParts = [
		`${completedFeatures}/${featuresState.features.length} features done`,
		`${completedMilestones}/${featuresState.milestones.length} milestones done`,
	];
	if (failedFeatures > 0) {
		progressParts.push(`${failedFeatures} feature${failedFeatures === 1 ? "" : "s"} failed`);
	}
	if (failedMilestones > 0) {
		progressParts.push(`${failedMilestones} milestone${failedMilestones === 1 ? "" : "s"} failed`);
	}
	lines.push("");
	lines.push(theme.fg("muted", `Progress: ${progressParts.join(" · ")}`));
	lines.push(
		theme.fg(
			"muted",
			`Live phase: ${liveState.phase}${liveState.currentAttempt !== null ? ` · attempt ${liveState.currentAttempt}` : ""}`,
		),
	);

	return lines;
}

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

function getMilestoneColor(status: MissionFeatureStateStatus): MissionProgressColor {
	return MILESTONE_STATUS_COLORS[status];
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
	return `${singleLine.slice(0, maxLength - 3)}...`;
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

function formatRoleModel(configState: OrchLoadedConfig, role: "orchestrator" | "worker" | "validator"): string {
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

function asValidationCriterionType(value: unknown): ValidationCriterionType | undefined {
	if (value === "behavior" || value === "test" || value === "file" || value === "review") {
		return value;
	}
	return undefined;
}

function asValidationIssueSeverity(value: unknown): ValidationIssueSeverity | undefined {
	if (value === "critical" || value === "major" || value === "minor") {
		return value;
	}
	return undefined;
}

