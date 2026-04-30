import { join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type Component, truncateToWidth, type TUI, visibleWidth } from "@mariozechner/pi-tui";

import { loadOrchConfig, type OrchLoadedConfig } from "./config.js";
import { GLYPHS, ORCH_COMMANDS, ORCH_WIDGET_IDS } from "./constants.js";
import { formatElapsed, SPINNER_FRAME_MS } from "./loading.js";
import { emitOrchEvent, type OrchEventLevel } from "./messages.js";
import type { PlanClarificationResult, PlanPhase, PlanResult } from "./plan-types.js";
import {
	createPlanId,
	initializePlanState,
	readPlanState,
	updatePlanPhase,
	writePlanArtifact,
	type PlanStatePaths,
} from "./plan-state.js";
import { spawnOrchSubagent, type OrchSubagentStreamEvent } from "./role-runner.js";
import { setOrchStatus, type OrchActivePlan, type OrchRuntimeState } from "./runtime.js";
import { formatErrorMessage } from "./utils.js";

const PLAN_STATUS_KEY = "orch-plan";
const PLAN_RESEARCH_TOOLS = ["read", "bash", "grep", "find", "ls"];
const PLAN_BASH_GUARD_REASON = "Plan Mode only allows read-only bash commands. Use read, grep, find, ls, or safe inspection commands.";
type PlanContext = ExtensionCommandContext | ExtensionContext;
type PlanModelRegistry = ExtensionContext["modelRegistry"];
type OrchTheme = ExtensionCommandContext["ui"]["theme"];

export function hasActivePlan(state: OrchRuntimeState): boolean {
	return state.activePlan !== undefined;
}

export function registerPlanCommand(pi: ExtensionAPI, state: OrchRuntimeState): void {
	pi.registerCommand(ORCH_COMMANDS.plan, {
		description: "Orch Plan Mode: analyze a goal and produce a plan without editing the project",
		getArgumentCompletions: (prefix) => getPlanArgumentCompletions(prefix),
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const { rest, token } = consumeToken(args);

			if (token === "status" && rest.trim().length === 0) {
				await handlePlanStatus(ctx, state);
				return;
			}

			if (token === "cancel" && rest.trim().length === 0) {
				await handlePlanCancel(ctx, state);
				return;
			}

			if (state.activePlan) {
				reportPlanEvent(pi, ctx, "Plan already running", `Active plan: ${state.activePlan.goal}\nUse /plan cancel to abort it.`, "warning");
				return;
			}

			if (state.activeMission) {
				reportPlanEvent(pi, ctx, "Mission running", "An autonomous mission is already running. Cancel it before starting a plan.", "warning");
				return;
			}

			const goal = await resolvePlanGoal(args, ctx);
			if (!goal) {
				if (ctx.hasUI) {
					ctx.ui.notify(`Usage: /${ORCH_COMMANDS.plan} <goal>\nOr type a goal in the editor and press Ctrl+\``, "warning");
				} else {
					process.stdout.write(`Usage: /${ORCH_COMMANDS.plan} <goal>\n`);
				}
				return;
			}

			state.configState = await loadOrchConfig(ctx.cwd);

			if (!ctx.hasUI) {
				try {
					const result = await runPlanWorkflow(pi, ctx, goal, state.configState, state);
					reportPlanEvent(pi, ctx, "Plan complete", buildPlanCompletionText(result), "success");
				} catch (error) {
					reportPlanEvent(pi, ctx, "Plan failed", formatErrorMessage(error), "error");
				} finally {
					setPlanStatus(ctx, state, undefined);
					clearPlanWidgets(ctx);
				}
				return;
			}

			startPlanInBackground(pi, ctx, goal, state, state.configState);
			reportPlanEvent(pi, ctx, "Plan running", `Started Plan Mode for: ${goal}\nUse /plan cancel to abort.`, "info");
		},
	});

	// Register Ctrl+` shortcut
	pi.registerShortcut("ctrl+`", {
		description: "Enter Orch Plan Mode using editor text or a prompt",
		handler: async (ctx) => {
			if (!ctx.hasUI) {
				return;
			}
			if (state.activePlan || state.activeMission || !ctx.isIdle()) {
				ctx.ui.notify("An agent turn, mission, or plan is already active. Finish or cancel it first.", "warning");
				return;
			}

			let goal: string | undefined;

			if (ctx.hasUI) {
				const editorText = ctx.ui.getEditorText();
				if (editorText.trim().length > 0) {
					goal = editorText.trim();
					ctx.ui.setEditorText("");
				} else {
					goal = await ctx.ui.input("Plan goal", "Describe what you want to plan");
				}
			}

			if (!goal) {
				return;
			}

			state.configState = await loadOrchConfig(ctx.cwd);
			startPlanInBackground(pi, ctx, goal, state, state.configState);
			reportPlanEvent(pi, ctx, "Plan running", `Started Plan Mode for: ${goal}\nUse /plan cancel to abort.`, "info");
		},
	});
}

async function handlePlanStatus(ctx: ExtensionCommandContext, state: OrchRuntimeState): Promise<void> {
	const plan = state.activePlan;
	if (!plan) {
		const msg = "No active plan.";
		if (ctx.hasUI) {
			ctx.ui.notify(msg, "info");
		} else {
			process.stdout.write(`${msg}\n`);
		}
		return;
	}

	let statusText = `Active plan: ${plan.goal}\nPhase: ${plan.phase}\nAgent: ${plan.currentAgent}\nLast activity: ${plan.lastActivity}\nStarted: ${plan.startedAt}`;
	if (plan.stateFilePath) {
		try {
			const planState = await readPlanState(plan.stateFilePath);
			statusText += `\nState: ${planState.phase}`;
			if (planState.refinedGoal) {
				statusText += `\nRefined goal: ${planState.refinedGoal}`;
			}
		} catch {
			// Ignore read errors
		}
	}
	statusText += `\nState dir: ${plan.stateDir ?? "unknown"}`;

	if (ctx.hasUI) {
		ctx.ui.notify(statusText, "info");
	} else {
		process.stdout.write(`${statusText}\n`);
	}
}

async function handlePlanCancel(ctx: ExtensionCommandContext, state: OrchRuntimeState): Promise<void> {
	const plan = state.activePlan;
	if (!plan) {
		const msg = "No active plan to cancel.";
		if (ctx.hasUI) {
			ctx.ui.notify(msg, "warning");
		} else {
			process.stdout.write(`${msg}\n`);
		}
		return;
	}

	plan.phase = "cancelled";
	plan.abortController.abort();
	setPlanStatus(ctx, state, "cancelled");
	updatePlanProgressWidget(ctx, state);

	const msg = "Cancelling active plan...";
	if (ctx.hasUI) {
		ctx.ui.notify(msg, "warning");
	} else {
		process.stdout.write(`${msg}\n`);
	}
}

function startPlanInBackground(
	pi: ExtensionAPI,
	ctx: PlanContext,
	goal: string,
	state: OrchRuntimeState,
	configState: OrchLoadedConfig,
): void {
	const startedAt = new Date().toISOString();
	const planId = createPlanId(goal, startedAt);
	const plansDir = configState.resolvedPaths.plansDir;

	const activePlan: OrchActivePlan = {
		id: planId,
		goal,
		refinedGoal: goal,
		startedAt,
		phase: "clarifying",
		phaseStartedAt: Date.now(),
		currentAgent: PLAN_AGENT_LABELS.clarifying,
		lastActivity: "Starting Plan Mode",
		lastActivityAt: Date.now(),
		abortController: new AbortController(),
		stateDir: join(plansDir, planId),
		stateFilePath: join(plansDir, planId, "state.json"),
		backgroundPromise: undefined,
	};

	state.activePlan = activePlan;
	setPlanStatus(ctx, state, activePlan.phase);
	updatePlanProgressWidget(ctx, state);

	activePlan.backgroundPromise = (async () => {
		try {
			const result = await runPlanWorkflow(pi, ctx, goal, configState, state);
			reportPlanEvent(pi, ctx, "Plan complete", buildPlanCompletionText(result), "success");
		} catch (error) {
			if (activePlan.abortController.signal.aborted) {
				reportPlanEvent(pi, ctx, "Plan cancelled", "Plan Mode was cancelled.", "warning");
			} else {
				reportPlanEvent(pi, ctx, "Plan failed", formatErrorMessage(error), "error");
			}
		} finally {
			if (state.activePlan === activePlan) {
				state.activePlan = undefined;
			}
			setPlanStatus(ctx, state, undefined);
			clearPlanWidgets(ctx);
		}
	})();

	void activePlan.backgroundPromise.catch(() => {
		// Background errors are reported inside the lifecycle.
	});
}

async function runPlanWorkflow(
	pi: ExtensionAPI,
	ctx: PlanContext,
	goal: string,
	configState: OrchLoadedConfig,
	state: OrchRuntimeState,
): Promise<PlanResult> {
	const startedAt = state.activePlan?.startedAt ?? new Date().toISOString();
	const planId = state.activePlan?.id ?? createPlanId(goal, startedAt);
	const plansDir = configState.resolvedPaths.plansDir;

	const { paths } = await initializePlanState(plansDir, planId, goal, startedAt);

	if (state.activePlan) {
		state.activePlan.stateDir = paths.planDir;
		state.activePlan.stateFilePath = paths.stateFile;
	}

	const signal = state.activePlan?.abortController.signal;
	let refinedGoal = goal;

	try {
		// Phase 1: Clarifier pass
		await persistPlanPhase(paths, ctx, state, "clarifying");
		await writeBrief(paths, goal, null, [], undefined);
		checkAborted(signal);

		const clarifierResult = await runClarifierPass(goal, ctx.cwd, configState, ctx.modelRegistry, ctx, state, signal);
		let questions: string[] = [];
		let assumptions: string[] = [];

		if (clarifierResult) {
			refinedGoal = clarifierResult.refinedGoal || goal;
			questions = clarifierResult.questions || [];
			assumptions = clarifierResult.assumptions || [];
		}

		let clarificationAnswers: string | undefined;
		if (questions.length > 0 && ctx.hasUI) {
			const answerTemplate = [
				"Answer any questions you can. Leave unknowns blank; Orch will continue with assumptions.",
				"",
				...questions.map((question, index) => `${index + 1}. ${question}`),
				"",
				"Answers:",
			].join("\n");
			const answers = await ctx.ui.editor("Plan clarification", answerTemplate);
			if (answers && answers.trim().length > 0 && answers.trim() !== answerTemplate.trim()) {
				clarificationAnswers = answers.trim();
			}
		}

		await writePlanArtifact(
			paths.questionsFile,
			`${JSON.stringify(
				{
					needsClarification: clarifierResult?.needsClarification ?? questions.length > 0,
					questions,
					assumptions,
					answers: clarificationAnswers ?? (questions.length > 0 ? "not provided" : null),
				},
				null,
				2,
			)}\n`,
		);

		await writeBrief(paths, goal, refinedGoal, assumptions, clarificationAnswers);
		if (state.activePlan) {
			state.activePlan.refinedGoal = refinedGoal;
		}

		const planningContext = buildPlanningContext(refinedGoal, clarificationAnswers);

		// Phase 2: Codebase analysis
		await persistPlanPhase(paths, ctx, state, "researching-codebase", refinedGoal);
		reportPlanEvent(pi, ctx, "Researching codebase", `Analyzing codebase for: ${refinedGoal}`, "info");

		const codebaseAnalysis = await runCodebaseAnalysis(planningContext, ctx.cwd, configState, ctx.modelRegistry, ctx, state, signal);
		await writePlanArtifact(paths.codebaseAnalysisFile, codebaseAnalysis || "# Codebase Analysis\n\nNo structured analysis returned.");
		checkAborted(signal);

		// Phase 3: Docs/web research
		await persistPlanPhase(paths, ctx, state, "researching-docs", refinedGoal);
		reportPlanEvent(pi, ctx, "Researching docs/web", `Researching documentation and web resources for: ${refinedGoal}`, "info");

		const docsResearch = await runDocsResearch(planningContext, codebaseAnalysis, ctx.cwd, configState, ctx.modelRegistry, ctx, state, signal);
		await writePlanArtifact(paths.docsWebResearchFile, docsResearch || "# Docs/Web Research\n\nNo structured research returned.");
		checkAborted(signal);

		// Phase 4: Feasibility assessment
		await persistPlanPhase(paths, ctx, state, "assessing-feasibility", refinedGoal);
		reportPlanEvent(pi, ctx, "Assessing feasibility", `Evaluating feasibility for: ${refinedGoal}`, "info");

		const feasibility = await runFeasibilityPass(planningContext, codebaseAnalysis, docsResearch, ctx.cwd, configState, ctx.modelRegistry, ctx, state, signal);
		await writePlanArtifact(paths.feasibilityFile, feasibility || "# Feasibility\n\nNo feasibility assessment returned.");
		checkAborted(signal);

		// Phase 5: Synthesis
		await persistPlanPhase(paths, ctx, state, "synthesizing", refinedGoal);
		reportPlanEvent(pi, ctx, "Synthesizing plan", `Creating final plan and validation contract for: ${refinedGoal}`, "info");

		const synthesis = await runSynthesisPass(planningContext, codebaseAnalysis, docsResearch, feasibility, ctx.cwd, configState, ctx.modelRegistry, ctx, state, signal);

		const planMd = synthesis.plan || "# Plan\n\nNo structured plan was generated.";
		const validationMd = synthesis.validationContract || "# Validation Contract\n\nNo validation contract was generated.";

		await writePlanArtifact(paths.planFile, planMd);
		await writePlanArtifact(paths.validationContractFile, validationMd);

		await persistPlanPhase(paths, ctx, state, "completed", refinedGoal);

		const shortGoal = refinedGoal.length > 80 ? `${refinedGoal.slice(0, 77)}...` : refinedGoal;

		return {
			id: planId,
			goal,
			refinedGoal,
			feasibility: extractSummary(feasibility),
			planPath: paths.planDir,
			suggestedNextStep: `/mission ${shortGoal}`,
		};
	} catch (error) {
		const terminalPhase: PlanPhase = signal?.aborted ? "cancelled" : "failed";
		await updatePlanPhase(paths, terminalPhase, refinedGoal).catch(() => {
			// Preserve the original failure.
		});
		setPlanPhase(ctx, state, terminalPhase);
		throw error;
	}
}

// ─── Subagent passes ────────────────────────────────────────────────

async function runClarifierPass(
	goal: string,
	cwd: string,
	configState: OrchLoadedConfig,
	modelRegistry: PlanModelRegistry,
	ctx: PlanContext,
	state: OrchRuntimeState,
	signal?: AbortSignal,
): Promise<PlanClarificationResult | null> {
	const prompt = [
		"You are Orch's plan clarifier. Analyze the following goal and determine if it needs clarification.",
		`Goal: ${goal}`,
		`Working directory: ${cwd}`,
		"You may inspect the repository with read-only tools if needed.",
		"Return strict JSON only. Do not wrap in markdown fences.",
		"JSON shape:",
		'{ "refinedGoal": "A clear, specific version of the goal", "needsClarification": true/false, "questions": ["question1"], "assumptions": ["assumption1"] }',
		"If the goal is already clear, set needsClarification to false and provide an empty questions array.",
		"If the goal is ambiguous, set needsClarification to true and list specific questions.",
		"Always provide at least one reasonable assumption.",
	].join("\n");

	const result = await spawnOrchSubagent({
		role: "plan_clarifier",
		prompt,
		cwd,
		configState,
		modelRegistry,
		signal,
		toolNames: PLAN_RESEARCH_TOOLS,
		bashCommandGuard: isPlanSafeBashCommand,
		bashGuardReason: PLAN_BASH_GUARD_REASON,
		onStreamEvent: (event) => handlePlanSubagentStreamEvent(ctx, state, event, PLAN_AGENT_LABELS.clarifying),
	});

	return normalizeClarificationResult(result.output);
}

async function runCodebaseAnalysis(
	refinedGoal: string,
	cwd: string,
	configState: OrchLoadedConfig,
	modelRegistry: PlanModelRegistry,
	ctx: PlanContext,
	state: OrchRuntimeState,
	signal?: AbortSignal,
): Promise<string> {
	const prompt = [
		"You are Orch's codebase analyst. Analyze the repository to understand how it relates to the following goal.",
		`Goal: ${refinedGoal}`,
		`Working directory: ${cwd}`,
		"Use read-only tools (read, grep, find, ls) to explore the codebase.",
		"Produce a markdown report with these sections:",
		"## Relevant Files and Modules",
		"## Current Architecture",
		"## Dependencies and Integrations",
		"## Potential Impact Areas",
		"## Existing Patterns to Follow",
		"Keep the analysis focused and actionable. Write in markdown.",
	].join("\n");

	const result = await spawnOrchSubagent({
		role: "plan_codebase",
		prompt,
		cwd,
		configState,
		modelRegistry,
		signal,
		toolNames: PLAN_RESEARCH_TOOLS,
		bashCommandGuard: isPlanSafeBashCommand,
		bashGuardReason: PLAN_BASH_GUARD_REASON,
		onStreamEvent: (event) => handlePlanSubagentStreamEvent(ctx, state, event, PLAN_AGENT_LABELS["researching-codebase"]),
	});

	return result.output;
}

async function runDocsResearch(
	refinedGoal: string,
	codebaseAnalysis: string,
	cwd: string,
	configState: OrchLoadedConfig,
	modelRegistry: PlanModelRegistry,
	ctx: PlanContext,
	state: OrchRuntimeState,
	signal?: AbortSignal,
): Promise<string> {
	const analysisExcerpt = codebaseAnalysis.length > 4000 ? `${codebaseAnalysis.slice(0, 4000)}\n\n[truncated]` : codebaseAnalysis;

	const prompt = [
		"You are Orch's documentation and web research analyst.",
		`Goal: ${refinedGoal}`,
		`Working directory: ${cwd}`,
		"Existing codebase analysis (excerpt):",
		analysisExcerpt,
		"Use read-only tools to inspect any docs, README files, configuration, or comments in the repository.",
		"If safe external documentation lookup is available in this environment, use it for official docs and cite URLs. If not, explicitly state that external web/MCP research was unavailable and rely on repository-local docs.",
		"Never run commands that modify files, install packages, change git state, or alter the system.",
		"Produce a markdown report with these sections:",
		"## Relevant Documentation",
		"## API References and Patterns",
		"## Known Issues or Caveats",
		"## External Resources and Best Practices",
		"## Sources or Research Limitations",
		"## Key Insights for Implementation",
		"Keep the research focused and actionable. Write in markdown.",
	].join("\n");

	const result = await spawnOrchSubagent({
		role: "plan_researcher",
		prompt,
		cwd,
		configState,
		modelRegistry,
		signal,
		toolNames: PLAN_RESEARCH_TOOLS,
		bashCommandGuard: isPlanSafeBashCommand,
		bashGuardReason: PLAN_BASH_GUARD_REASON,
		onStreamEvent: (event) => handlePlanSubagentStreamEvent(ctx, state, event, PLAN_AGENT_LABELS["researching-docs"]),
	});

	return result.output;
}

async function runFeasibilityPass(
	refinedGoal: string,
	codebaseAnalysis: string,
	docsResearch: string,
	cwd: string,
	configState: OrchLoadedConfig,
	modelRegistry: PlanModelRegistry,
	ctx: PlanContext,
	state: OrchRuntimeState,
	signal?: AbortSignal,
): Promise<string> {
	const analysisExcerpt = codebaseAnalysis.length > 4000 ? `${codebaseAnalysis.slice(0, 4000)}\n\n[truncated]` : codebaseAnalysis;
	const docsExcerpt = docsResearch.length > 4000 ? `${docsResearch.slice(0, 4000)}\n\n[truncated]` : docsResearch;

	const prompt = [
		"You are Orch's feasibility assessor.",
		`Goal: ${refinedGoal}`,
		`Working directory: ${cwd}`,
		"Codebase analysis (excerpt):",
		analysisExcerpt,
		"Documentation research (excerpt):",
		docsExcerpt,
		"You may inspect the repository with read-only tools to verify specific claims.",
		"Produce a markdown report with these sections:",
		"## Overall Feasibility (High/Medium/Low)",
		"## Technical Risks",
		"## Estimated Complexity",
		"## Prerequisites and Dependencies",
		"## Recommended Approach",
		"## Potential Blockers",
		"Be honest about risks and blockers. Write in markdown.",
	].join("\n");

	const result = await spawnOrchSubagent({
		role: "plan_feasibility",
		prompt,
		cwd,
		configState,
		modelRegistry,
		signal,
		toolNames: PLAN_RESEARCH_TOOLS,
		bashCommandGuard: isPlanSafeBashCommand,
		bashGuardReason: PLAN_BASH_GUARD_REASON,
		onStreamEvent: (event) => handlePlanSubagentStreamEvent(ctx, state, event, PLAN_AGENT_LABELS["assessing-feasibility"]),
	});

	return result.output;
}

async function runSynthesisPass(
	refinedGoal: string,
	codebaseAnalysis: string,
	docsResearch: string,
	feasibility: string,
	cwd: string,
	configState: OrchLoadedConfig,
	modelRegistry: PlanModelRegistry,
	ctx: PlanContext,
	state: OrchRuntimeState,
	signal?: AbortSignal,
): Promise<{ plan: string; validationContract: string }> {
	const analysisExcerpt = codebaseAnalysis.length > 6000 ? `${codebaseAnalysis.slice(0, 6000)}\n\n[truncated]` : codebaseAnalysis;
	const docsExcerpt = docsResearch.length > 4000 ? `${docsResearch.slice(0, 4000)}\n\n[truncated]` : docsResearch;
	const feasibilityExcerpt = feasibility.length > 3000 ? `${feasibility.slice(0, 3000)}\n\n[truncated]` : feasibility;

	const prompt = [
		"You are Orch's plan synthesizer. Create a concrete implementation plan and validation contract.",
		`Goal: ${refinedGoal}`,
		`Working directory: ${cwd}`,
		"Codebase analysis (excerpt):",
		analysisExcerpt,
		"Documentation research (excerpt):",
		docsExcerpt,
		"Feasibility assessment (excerpt):",
		feasibilityExcerpt,
		"You may inspect the repository with read-only tools to verify specific details.",
		"",
		"Return strict JSON only. Do not wrap in markdown fences.",
		"JSON shape:",
		"{",
		'  "plan": "# Implementation Plan\\n\\n(full markdown plan here with sections: Overview, Architecture Changes, Implementation Steps, File Changes, Testing Strategy, Rollback Plan)",',
		'  "validationContract": "# Validation Contract\\n\\n(full markdown contract here with sections: Acceptance Criteria, Test Cases, Manual Verification Steps, Success Metrics)"',
		"}",
		"The plan should be detailed enough for an autonomous worker agent to execute.",
		"The validation contract should be specific enough for an autonomous validator to verify.",
	].join("\n");

	const result = await spawnOrchSubagent({
		role: "plan_synthesizer",
		prompt,
		cwd,
		configState,
		modelRegistry,
		signal,
		toolNames: PLAN_RESEARCH_TOOLS,
		bashCommandGuard: isPlanSafeBashCommand,
		bashGuardReason: PLAN_BASH_GUARD_REASON,
		onStreamEvent: (event) => handlePlanSubagentStreamEvent(ctx, state, event, PLAN_AGENT_LABELS.synthesizing),
	});

	return normalizeSynthesisResult(result.output);
}

// ─── JSON normalization ─────────────────────────────────────────────

function normalizeClarificationResult(output: string): PlanClarificationResult | null {
	const parsed = parseJsonObject(output);
	if (!isRecord(parsed)) {
		return null;
	}

	return {
		refinedGoal: asNonEmptyString(parsed.refinedGoal) ?? "",
		needsClarification: typeof parsed.needsClarification === "boolean" ? parsed.needsClarification : false,
		questions: asStringArray(parsed.questions),
		assumptions: asStringArray(parsed.assumptions),
	};
}

function normalizeSynthesisResult(output: string): { plan: string; validationContract: string } {
	const parsed = parseJsonObject(output);
	if (!isRecord(parsed)) {
		return {
			plan: output.trim() || "# Plan\n\nNo structured plan was generated.",
			validationContract: "# Validation Contract\n\nNo structured validation contract was generated.",
		};
	}

	return {
		plan: typeof parsed.plan === "string" && parsed.plan.trim().length > 0
			? parsed.plan
			: output.trim() || "# Plan\n\nNo structured plan was generated.",
		validationContract: typeof parsed.validationContract === "string" && parsed.validationContract.trim().length > 0
			? parsed.validationContract
			: "# Validation Contract\n\nNo structured validation contract was generated.",
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

// ─── Artifact writers ────────────────────────────────────────────────

async function writeBrief(
	paths: PlanStatePaths,
	goal: string,
	refinedGoal: string | null,
	assumptions: string[],
	clarificationAnswers: string | undefined,
): Promise<void> {
	const lines = [
		"# Plan Brief",
		"",
		`## Original Goal`,
		goal,
	];

	if (refinedGoal && refinedGoal !== goal) {
		lines.push("", "## Refined Goal", refinedGoal);
	}

	if (clarificationAnswers) {
		lines.push("", "## User Clarifications", clarificationAnswers);
	}

	if (assumptions.length > 0) {
		lines.push("", "## Assumptions");
		for (const a of assumptions) {
			lines.push(`- ${a}`);
		}
	}

	lines.push("");
	await writePlanArtifact(paths.briefFile, lines.join("\n"));
}

function buildPlanningContext(refinedGoal: string, clarificationAnswers: string | undefined): string {
	if (!clarificationAnswers) {
		return refinedGoal;
	}
	return [refinedGoal, "", "User clarification answers:", clarificationAnswers].join("\n");
}

function extractSummary(markdown: string): string {
	const lines = markdown.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		// Look for a line that starts with "Overall Feasibility" or similar
		const match = trimmed.match(/overall\s+feasibility/i);
		if (match) {
			// Return the whole line (which might be a header or a value)
			return trimmed;
		}
	}
	// Fallback: return first meaningful non-heading line
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.length > 0 && !trimmed.startsWith("#")) {
			return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
		}
	}
	return "Unknown";
}

// ─── UI helpers ──────────────────────────────────────────────────────

function handlePlanSubagentStreamEvent(
	ctx: PlanContext,
	state: OrchRuntimeState,
	event: OrchSubagentStreamEvent,
	agentLabel: string,
): void {
	const plan = state.activePlan;
	if (!plan) {
		return;
	}

	plan.currentAgent = agentLabel;
	plan.lastActivityAt = Date.now();

	if (event.type === "status") {
		if (event.status === "starting") {
			plan.lastActivity = `${agentLabel} started`;
		} else if (event.status === "completed") {
			plan.lastActivity = `${agentLabel} completed`;
		} else {
			plan.lastActivity = `${agentLabel} interrupted`;
		}
		updatePlanProgressWidget(ctx, state);
		return;
	}

	if (event.type === "tool_call") {
		plan.lastActivity = `${event.label}: ${event.detail}`;
		updatePlanProgressWidget(ctx, state);
		return;
	}

	if (event.type === "text_delta") {
		const line = getLastMeaningfulLine(event.delta);
		if (line) {
			plan.lastActivity = line;
		}
		updatePlanProgressWidget(ctx, state);
		return;
	}

	if (event.type === "thinking_delta") {
		const line = getLastMeaningfulLine(event.delta);
		plan.lastActivity = line ? `Thinking: ${line}` : `${agentLabel} thinking`;
		updatePlanProgressWidget(ctx, state);
	}
}

async function persistPlanPhase(
	paths: PlanStatePaths,
	ctx: PlanContext,
	state: OrchRuntimeState,
	phase: PlanPhase,
	refinedGoal?: string,
): Promise<void> {
	await updatePlanPhase(paths, phase, refinedGoal);
	setPlanPhase(ctx, state, phase);
}

function setPlanPhase(ctx: PlanContext, state: OrchRuntimeState, phase: PlanPhase): void {
	if (state.activePlan) {
		state.activePlan.phase = phase;
		state.activePlan.phaseStartedAt = Date.now();
		state.activePlan.currentAgent = PLAN_AGENT_LABELS[phase] ?? PHASE_LABELS[phase];
		state.activePlan.lastActivity = `Entering ${PHASE_LABELS[phase]}`;
		state.activePlan.lastActivityAt = Date.now();
	}
	setPlanStatus(ctx, state, phase);
	updatePlanProgressWidget(ctx, state);
}

function setPlanStatus(ctx: PlanContext, state: OrchRuntimeState, text: string | undefined): void {
	if (!ctx.hasUI) return;
	const statusText = text ? `plan: ${text} • /plan cancel` : undefined;
	ctx.ui.setStatus(PLAN_STATUS_KEY, statusText ? ctx.ui.theme.fg("accent", statusText) : undefined);
	setOrchStatus(ctx, state);
}

function updatePlanProgressWidget(ctx: PlanContext, state: OrchRuntimeState): void {
	if (!ctx.hasUI || !state.activePlan) return;

	ctx.ui.setWidget(
		ORCH_WIDGET_IDS.planProgress,
		(tui, theme) => new OrchPlanProgressComponent(tui, theme, state.activePlan!),
	);
}

function clearPlanWidgets(ctx: PlanContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setWidget(ORCH_WIDGET_IDS.planProgress, undefined);
}

class OrchPlanProgressComponent implements Component {
	private readonly intervalId: ReturnType<typeof setInterval>;

	constructor(
		private readonly tui: TUI,
		private readonly theme: OrchTheme,
		private readonly plan: OrchActivePlan,
	) {
		this.intervalId = setInterval(() => {
			this.tui.requestRender();
		}, SPINNER_FRAME_MS);
	}

	render(width: number): string[] {
		return renderPlanProgressLines(this.theme, this.plan, width);
	}

	handleInput(): void {
		// No-op.
	}

	invalidate(): void {
		// Plan data is read on each render.
	}

	dispose(): void {
		clearInterval(this.intervalId);
	}
}

const PLAN_AGENT_LABELS: Record<PlanPhase, string> = {
	clarifying: "Clarifier agent",
	"researching-codebase": "Codebase analyst",
	"researching-docs": "Docs/web researcher",
	"assessing-feasibility": "Feasibility reviewer",
	synthesizing: "Plan synthesizer",
	completed: "Plan Mode",
	cancelled: "Plan Mode",
	failed: "Plan Mode",
};

const PHASE_LABELS: Record<PlanPhase, string> = {
	clarifying: "Clarifying goal",
	"researching-codebase": "Analyzing codebase",
	"researching-docs": "Researching docs",
	"assessing-feasibility": "Assessing feasibility",
	synthesizing: "Synthesizing plan",
	completed: "Completed",
	cancelled: "Cancelled",
	failed: "Failed",
};

const PHASE_ORDER: PlanPhase[] = [
	"clarifying",
	"researching-codebase",
	"researching-docs",
	"assessing-feasibility",
	"synthesizing",
];

function renderPlanProgressLines(theme: OrchTheme, plan: OrchActivePlan, width: number): string[] {
	const lines: string[] = [];
	const currentPhaseIndex = PHASE_ORDER.indexOf(plan.phase as PlanPhase);
	const isTerminal = plan.phase === "completed" || plan.phase === "cancelled" || plan.phase === "failed";
	const spinner = isTerminal ? GLYPHS.done : GLYPHS.spinner[Math.floor(Date.now() / SPINNER_FRAME_MS) % GLYPHS.spinner.length] ?? GLYPHS.spinner[0];
	const totalElapsed = formatElapsed(Math.max(0, Date.now() - Date.parse(plan.startedAt)));
	const phaseElapsed = formatElapsed(Math.max(0, Date.now() - plan.phaseStartedAt));
	const statusColor = plan.phase === "failed" ? "error" : plan.phase === "cancelled" ? "warning" : plan.phase === "completed" ? "success" : "accent";

	lines.push(formatPlanLine(theme, width, GLYPHS.boxTopLeft, ` ${theme.fg(statusColor, spinner)} ${theme.fg("accent", "Orch Plan Mode")} ${theme.fg("dim", `· ${totalElapsed}`)}`));
	lines.push(formatPlanLine(theme, width, GLYPHS.boxVert, ` Goal: ${truncateInlineText(plan.refinedGoal || plan.goal, 120)}`));
	lines.push(formatPlanLine(theme, width, GLYPHS.boxVert, ` Status: ${theme.fg(statusColor, PHASE_LABELS[plan.phase])}${!isTerminal ? theme.fg("dim", ` · ${phaseElapsed}`) : ""}`));
	lines.push(formatPlanLine(theme, width, GLYPHS.boxVert, ` Agent: ${theme.fg("muted", plan.currentAgent || PLAN_AGENT_LABELS[plan.phase])}`));
	lines.push(formatPlanLine(theme, width, GLYPHS.boxVert, ` Last activity: ${theme.fg("dim", truncateInlineText(plan.lastActivity || "Waiting for sub-agent activity", 110))}`));
	if (plan.stateDir) {
		lines.push(formatPlanLine(theme, width, GLYPHS.boxVert, ` Artifacts: ${theme.fg("dim", truncateInlineText(plan.stateDir, 110))}`));
	}
	lines.push(formatPlanLine(theme, width, GLYPHS.boxVert, ""));
	lines.push(formatPlanLine(theme, width, GLYPHS.boxVert, ` Checklist:`));

	for (let i = 0; i < PHASE_ORDER.length; i++) {
		const phase = PHASE_ORDER[i];
		const label = PHASE_LABELS[phase];
		let glyph: string;
		let color: "dim" | "accent" | "success" | "error" | "warning";

		if (plan.phase === "failed" && i === currentPhaseIndex) {
			glyph = GLYPHS.fail;
			color = "error";
		} else if (plan.phase === "cancelled" && i === currentPhaseIndex) {
			glyph = GLYPHS.fail;
			color = "warning";
		} else if (i < currentPhaseIndex || plan.phase === "completed") {
			glyph = GLYPHS.pass;
			color = "success";
		} else if (i === currentPhaseIndex && !isTerminal) {
			glyph = GLYPHS.inProgress;
			color = "accent";
		} else {
			glyph = GLYPHS.pending;
			color = "dim";
		}

		const phaseText = `${glyph} ${label}${!isTerminal && i === currentPhaseIndex ? " (active)" : ""}`;
		lines.push(formatPlanLine(theme, width, GLYPHS.boxVert, `   ${theme.fg(color, phaseText)}`));
	}

	lines.push(formatPlanLine(theme, width, GLYPHS.boxBottomLeft, " /plan cancel"));

	return lines;
}

function formatPlanLine(theme: OrchTheme, width: number, leftGlyph: string, body: string): string {
	const styledGlyph = theme.fg("dim", leftGlyph);
	if (width <= visibleWidth(styledGlyph)) {
		return truncateToWidth(styledGlyph, width, "");
	}
	const prefix = `${styledGlyph} `;
	const contentWidth = Math.max(0, width - visibleWidth(prefix));
	const content = truncateToWidth(body, contentWidth, theme.fg("dim", GLYPHS.ellipsis));
	return truncateToWidth(`${prefix}${content}`, width, theme.fg("dim", GLYPHS.ellipsis));
}

function getLastMeaningfulLine(value: string): string | undefined {
	return value
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.at(-1);
}

function truncateInlineText(value: string, maxLength: number): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	if (singleLine.length <= maxLength) {
		return singleLine;
	}
	return `${singleLine.slice(0, maxLength - 3)}${GLYPHS.ellipsis}`;
}

// ─── Utility ─────────────────────────────────────────────────────────

const PLAN_DESTRUCTIVE_BASH_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\btee\b/i,
	/\bfind\b.*\s-delete\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\bcurl\b.*\s(-o|--output|--remote-name|-O)\b/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const PLAN_SAFE_BASH_PATTERNS = [
	/^\s*(cat|head|tail|less|more|grep|find|ls|pwd|echo|printf|wc|sort|uniq|diff|file|stat|du|df|tree|which|whereis|type|env|printenv|uname|whoami|id|date|uptime|ps|jq|awk|rg|fd|bat|eza)\b/i,
	/^\s*sed\s+-n\b/i,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|ls-)\b/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)\b/i,
	/^\s*yarn\s+(list|info|why|audit)\b/i,
	/^\s*pnpm\s+(list|view|info|why|audit|outdated)\b/i,
	/^\s*node\s+--version\b/i,
	/^\s*python\d*\s+--version\b/i,
	/^\s*curl\s+(-[fsSLI]+\s+)?https?:\/\//i,
	/^\s*wget\s+-O\s*-\s+https?:\/\//i,
];

function isPlanSafeBashCommand(command: string): boolean {
	const trimmed = command.trim();
	if (trimmed.length === 0) {
		return false;
	}
	if (PLAN_DESTRUCTIVE_BASH_PATTERNS.some((pattern) => pattern.test(trimmed))) {
		return false;
	}
	return PLAN_SAFE_BASH_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function checkAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error("Plan cancelled.");
	}
}

function getPlanArgumentCompletions(prefix: string): Array<{ label: string; value: string }> | null {
	const trimmed = prefix.trimStart();
	if (trimmed.includes(" ")) {
		return null;
	}
	const items = ["status", "cancel"]
		.filter((value) => value.startsWith(trimmed))
		.map((value) => ({ label: value, value }));
	return items.length > 0 ? items : null;
}

function consumeToken(input: string): { rest: string; token?: string } {
	const trimmed = input.trimStart();
	if (trimmed.length === 0) {
		return { rest: "" };
	}

	const separatorIndex = trimmed.search(/\s/);
	if (separatorIndex === -1) {
		return { token: trimmed, rest: "" };
	}

	return {
		token: trimmed.slice(0, separatorIndex),
		rest: trimmed.slice(separatorIndex + 1),
	};
}

async function resolvePlanGoal(args: string, ctx: ExtensionCommandContext): Promise<string | undefined> {
	const trimmed = args.trim();
	if (trimmed.length > 0) {
		return trimmed;
	}
	if (!ctx.hasUI) {
		return undefined;
	}
	return ctx.ui.input("Plan goal", "Describe what you want Orch to plan");
}

function reportPlanEvent(
	pi: ExtensionAPI,
	ctx: PlanContext,
	title: string,
	body: string,
	level: OrchEventLevel,
): void {
	if (ctx.hasUI) {
		if (shouldDisplayPlanEventInUi(level, title)) {
			emitOrchEvent(pi, ctx, body, { title, level, phase: "plan" });
		}
		return;
	}

	const block = [`[${title}]`, body].filter((value) => value.trim().length > 0).join("\n");
	process.stdout.write(`${block}\n`);
}

function shouldDisplayPlanEventInUi(level: OrchEventLevel, title: string): boolean {
	if (level === "warning" || level === "error" || level === "success") {
		return true;
	}
	return title === "Plan running";
}

function buildPlanCompletionText(result: PlanResult): string {
	return [
		`Plan ID: ${result.id}`,
		`Goal: ${result.refinedGoal}`,
		`Feasibility: ${result.feasibility}`,
		`Plan artifacts: ${result.planPath}`,
		``,
		`Suggested next step: ${result.suggestedNextStep}`,
	].join("\n");
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
		.map((item: unknown) => (typeof item === "string" ? item.trim() : undefined))
		.filter((item): item is string => item !== undefined && item.length > 0);
}
