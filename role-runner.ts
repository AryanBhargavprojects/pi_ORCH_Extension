import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, AssistantMessage, Model, TextContent } from "@mariozechner/pi-ai";
import {
	createAgentSession,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	DefaultResourceLoader,
	getAgentDir,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@mariozechner/pi-coding-agent";

import { getOrchSubagentTimeoutsForRole, type OrchLoadedConfig, type OrchRoleName } from "./config.js";
import { computeEditPreviewDiff, computeWritePreviewDiff, formatInlineDiffSummary } from "./diff.js";
import type {
	MissionFeature,
	MissionFixTask,
	MissionPromptSharedState,
	SteeringResult,
	ValidationContract,
	WorkerRun,
} from "./mission-types.js";
import { buildSharedStatePromptSection } from "./mission-state.js";
import { loadOrchRolePrompt } from "./prompt-loader.js";
import { createTinyFishToolDefinition, TINYFISH_TOOL_NAME } from "./tinyfish.js";
import {
	createParallelSearchToolDefinition,
	createParallelFetchToolDefinition,
	PARALLEL_SEARCH_TOOL_NAME,
	PARALLEL_FETCH_TOOL_NAME,
} from "./parallel-tools.js";
import {
	createSubagentCmuxHandle,
	writeSubagentCmuxEvent,
	closeSubagentCmuxHandle,
	type OrchSubagentCmuxHandle,
} from "./cmux-visibility.js";

export type OrchSubagentStreamEvent =
	| {
		role: OrchRoleName;
		type: "status";
		status: "starting" | "completed" | "aborted";
	  }
	| {
		role: OrchRoleName;
		type: "thinking_delta" | "text_delta";
		delta: string;
	  }
	| {
		role: OrchRoleName;
		type: "tool_diff";
		label: string;
		detail: string;
		diff?: string;
		diffFilePath?: string;
	  }
	| {
		role: OrchRoleName;
		type: "tool_call";
		label: string;
		detail: string;
		diff?: string;
		diffFilePath?: string;
	  };

export type OrchSubagentToolEvent = {
	label: string;
	detail: string;
	diff?: string;
	diffFilePath?: string;
};

export type OrchSubagentOutputSource = "assistant_text" | "streamed_text" | "recovery_text" | "tool_fallback";

export type OrchSubagentRequest = {
	role: OrchRoleName;
	prompt: string;
	cwd: string;
	configState: OrchLoadedConfig;
	modelRegistry: ModelRegistry;
	signal?: AbortSignal;
	onStreamEvent?: (event: OrchSubagentStreamEvent) => void;
	toolNames?: string[];
	bashCommandGuard?: (command: string) => boolean;
	bashGuardReason?: string;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	/** When true, bypass the per-role session cache and create a fresh session. Required for parallel dispatch. */
	forceFresh?: boolean;
	/** Optional human-readable label for CMUX visibility panes and logs. */
	label?: string;
};

export type OrchSubagentResult = {
	role: OrchRoleName;
	provider: string;
	modelId: string;
	output: string;
	outputSource: OrchSubagentOutputSource;
	emptyFinalText: boolean;
	toolEvents: OrchSubagentToolEvent[];
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		costTotal: number;
	};
	toolCalls: number;
	elapsedMs: number;
};

export type OrchWorkerSubagentRequest = {
	goal: string;
	missionSummary: string;
	feature: MissionFeature;
	validationContract: ValidationContract;
	sharedState: MissionPromptSharedState;
	steering?: SteeringResult;
	cwd: string;
	configState: OrchLoadedConfig;
	modelRegistry: ModelRegistry;
	signal?: AbortSignal;
	onStreamEvent?: (event: OrchSubagentStreamEvent) => void;
	label?: string;
};

export type OrchValidatorSubagentRequest = {
	goal: string;
	missionSummary: string;
	feature: MissionFeature;
	validationContract: ValidationContract;
	sharedState: MissionPromptSharedState;
	workerRun: WorkerRun;
	cwd: string;
	configState: OrchLoadedConfig;
	modelRegistry: ModelRegistry;
	signal?: AbortSignal;
	onStreamEvent?: (event: OrchSubagentStreamEvent) => void;
	label?: string;
};

const ORCHESTRATOR_TOOLS = ["read", "bash", "grep", "find", "ls"];
const WORKER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const VALIDATOR_TOOLS = ["read", "grep", "find", "ls"];
const PLAN_CODEBASE_TOOLS = ["read", "grep", "find", "ls"];
const RESEARCH_TOOLS = ["read", "bash", "grep", "find", "ls", TINYFISH_TOOL_NAME, PARALLEL_SEARCH_TOOL_NAME, PARALLEL_FETCH_TOOL_NAME];
const SMART_FRIEND_TOOLS = ["read", "bash", "grep", "find", "ls"];
const DEFAULT_SUBAGENT_BASH_TIMEOUT_SECONDS = 120;
const VALIDATOR_STREAMS_DIR_NAME = ".streams";
const WORKER_SESSION_RESET_POLICY: CachedSessionResetPolicy = { maxRuns: 5, maxTotalTokens: 60000 };
const NON_WORKER_SESSION_RESET_POLICY: CachedSessionResetPolicy = { maxRuns: 3, maxTotalTokens: 40000 };

type OrchRoleToolDefinition = ToolDefinition<any, any, any>;

type OrchSubagentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];
type CachedOrchSubagentSession = {
	session: OrchSubagentSession;
	boundExtensions: boolean;
	runCount: number;
	totalTokens: number;
};

type CachedSessionResetPolicy = {
	maxRuns: number;
	maxTotalTokens: number;
};

type ToolExecuteParams<T extends { execute: (...args: never[]) => unknown }> = Parameters<T["execute"]>;

const orchSubagentSessionCache = new Map<string, CachedOrchSubagentSession>();

async function runPromptWithTimeout(
	session: OrchSubagentSession,
	prompt: string,
	timeoutMs: number,
	role: OrchRoleName,
	phase: string,
	options: { label?: string; signal?: AbortSignal } = {},
): Promise<void> {
	const agentLabel = options.label ? ` (${options.label})` : "";
	if (options.signal?.aborted) {
		void session.abort().catch(() => {});
		throw new Error(`Orch ${role} sub-agent${agentLabel} aborted during ${phase}.`);
	}

	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	let abortHandler: (() => void) | undefined;
	const timeoutReject = new Promise<never>((_resolve, reject) => {
		timeoutId = setTimeout(() => {
			void session.abort().catch(() => {});
			reject(
				new Error(
					`Orch ${role} sub-agent${agentLabel} timed out after ${Math.round(timeoutMs / 1000)}s during ${phase}.`,
				),
			);
		}, timeoutMs);
	});
	const abortReject = new Promise<never>((_resolve, reject) => {
		if (!options.signal) {
			return;
		}
		abortHandler = () => {
			void session.abort().catch(() => {});
			reject(new Error(`Orch ${role} sub-agent${agentLabel} aborted during ${phase}.`));
		};
		options.signal.addEventListener("abort", abortHandler, { once: true });
	});

	try {
		await Promise.race([session.prompt(prompt), timeoutReject, abortReject]);
	} finally {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId);
		}
		if (abortHandler && options.signal) {
			options.signal.removeEventListener("abort", abortHandler);
		}
	}
}

export async function spawnOrchSubagent(request: OrchSubagentRequest): Promise<OrchSubagentResult> {
	const startedAt = Date.now();
	const modelConfig = request.configState.merged.roles[request.role];
	const model = resolveConfiguredModel(request.modelRegistry, modelConfig.provider, modelConfig.model, request.role);
	const { session, isCached, boundExtensions, cacheKey } = await getOrCreateOrchSubagentSession(request, model);

	// Set up CMUX visibility pane/log before emitting stream events so early events are visible.
	const cmuxLabel = request.label ?? `${request.role}-${Date.now()}`;
	let cmuxHandle: OrchSubagentCmuxHandle | undefined;
	try {
		cmuxHandle = await createSubagentCmuxHandle(
			request.cwd,
			request.role,
			cmuxLabel,
			request.configState.merged.cmuxVisibility === "off" ? "off" : "status",
		);
	} catch {
		cmuxHandle = undefined;
	}

	const toolArgsById = new Map<string, { toolName: string; args: unknown }>();
	const toolEvents: OrchSubagentToolEvent[] = [];
	let streamedText = "";
	let toolCallCount = 0;
	let cmuxCloseSummary = "finished";
	const emitStreamEvent = (event: OrchSubagentStreamEvent) => {
		request.onStreamEvent?.(event);
		if (cmuxHandle) {
			writeSubagentCmuxEvent(cmuxHandle, event);
		}
	};
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			toolArgsById.set(event.toolCallId, { toolName: event.toolName, args: event.args });
			return;
		}

		if (event.type === "tool_execution_end") {
			toolCallCount++;
			const started = toolArgsById.get(event.toolCallId);
			toolArgsById.delete(event.toolCallId);
			const diffInfo = extractSubagentToolDiff(event.toolName, started?.args, event.result);
			const toolEvent: OrchSubagentToolEvent = {
				label: formatSubagentToolLabel(event.toolName),
				detail: formatSubagentToolDetail(event.toolName, started?.args, event.result, event.isError),
				...diffInfo,
			};
			toolEvents.push(toolEvent);
			emitStreamEvent({
				role: request.role,
				type: "tool_call",
				...toolEvent,
			});
			return;
		}

		if (event.type !== "message_update") {
			return;
		}

		if (event.assistantMessageEvent.type === "thinking_delta") {
			emitStreamEvent({
				role: request.role,
				type: "thinking_delta",
				delta: event.assistantMessageEvent.delta,
			});
			return;
		}

		if (event.assistantMessageEvent.type === "text_delta") {
			streamedText += event.assistantMessageEvent.delta;
			emitStreamEvent({
				role: request.role,
				type: "text_delta",
				delta: event.assistantMessageEvent.delta,
			});
		}
	});

	let wasAborted = false;
	const abortHandler = () => {
		wasAborted = true;
		cmuxCloseSummary = "aborted";
		emitStreamEvent({ role: request.role, type: "status", status: "aborted" });
		void session.abort().catch(() => {
			// Ignore abort races.
		});
	};

	if (request.signal) {
		if (request.signal.aborted) {
			abortHandler();
		} else {
			request.signal.addEventListener("abort", abortHandler, { once: true });
		}
	}

	try {
		emitStreamEvent({ role: request.role, type: "status", status: "starting" });
		if (!isCached || !boundExtensions) {
			await session.bindExtensions({});
			if (isCached && cacheKey) {
				const cachedSession = orchSubagentSessionCache.get(cacheKey);
				if (cachedSession?.session === session) {
					cachedSession.boundExtensions = true;
				}
			}
		}

		const runStartMessageCount = session.messages.length;
		const prompt = appendFinalResponseInstruction(request.prompt);
		const timeouts = getOrchSubagentTimeoutsForRole(request.configState.merged, request.role);
		await runPromptWithTimeout(session, prompt, timeouts.promptMs, request.role, "primary prompt", {
			label: cmuxLabel,
			signal: request.signal,
		});
		if (wasAborted || request.signal?.aborted) {
			throw new Error(`Orch ${request.role} sub-agent aborted.`);
		}

		let runMessages = session.messages.slice(runStartMessageCount);
		const assistantOutput = findLastAssistantText(runMessages);
		const streamedOutput = streamedText.trim();
		let output = assistantOutput ?? streamedOutput;
		let outputSource: OrchSubagentOutputSource = assistantOutput ? "assistant_text" : streamedOutput ? "streamed_text" : "tool_fallback";
		let emptyFinalText = !assistantOutput && !streamedOutput;

		if (output.trim().length === 0 && !wasAborted && !request.signal?.aborted) {
			const recovery = await recoverMissingFinalText(session, request, toolEvents, () => streamedText);
			runMessages = session.messages.slice(runStartMessageCount);
			if (recovery.trim().length > 0) {
				output = recovery;
				outputSource = "recovery_text";
				emptyFinalText = true;
			} else {
				output = buildToolFallbackOutput(request.role, toolEvents);
				outputSource = "tool_fallback";
				emptyFinalText = true;
			}
		}

		emitStreamEvent({ role: request.role, type: "status", status: "completed" });
		const assistantMessage = findLastAssistantMessage(runMessages);
		const usage = {
			input: assistantMessage?.usage?.input ?? 0,
			output: assistantMessage?.usage?.output ?? 0,
			cacheRead: assistantMessage?.usage?.cacheRead ?? 0,
			cacheWrite: assistantMessage?.usage?.cacheWrite ?? 0,
			totalTokens: assistantMessage?.usage?.totalTokens ?? 0,
			costTotal: assistantMessage?.usage?.cost?.total ?? 0,
		};

		if (isCached && cacheKey && emptyFinalText) {
			await evictCachedOrchSubagentSession(cacheKey, session);
		} else if (isCached && cacheKey) {
			updateCachedSessionCounters(cacheKey, session, request.role, usage.totalTokens);
		}

		return {
			role: request.role,
			provider: model.provider,
			modelId: model.id,
			output,
			outputSource,
			emptyFinalText,
			toolEvents: [...toolEvents],
			usage,
			toolCalls: toolCallCount,
			elapsedMs: Date.now() - startedAt,
		};
	} catch (error) {
		cmuxCloseSummary = error instanceof Error ? `failed: ${error.message}` : "failed";
		if (isCached && cacheKey) {
			await evictCachedOrchSubagentSession(cacheKey, session);
		}
		throw error;
	} finally {
		unsubscribe();
		if (request.signal) {
			request.signal.removeEventListener("abort", abortHandler);
		}
		if (!isCached) {
			session.dispose();
		}
		await closeSubagentCmuxHandle(cmuxHandle, cmuxCloseSummary).catch(() => {});
	}
}

function appendFinalResponseInstruction(prompt: string): string {
	return [
		prompt,
		"Important final response requirement: after any tool calls finish, always send a non-empty final assistant message. Follow the exact response format requested above (strict JSON, markdown, or plain text as specified). Do not stop after tool calls without a final response.",
	].join("\n\n");
}

async function recoverMissingFinalText(
	session: OrchSubagentSession,
	request: OrchSubagentRequest,
	toolEvents: OrchSubagentToolEvent[],
	getStreamedText: () => string,
): Promise<string> {
	const requestedTools = getRequestedTools(request);
	const recoveryStartMessageCount = session.messages.length;
	const streamStartLength = getStreamedText().length;
	const recoveryPrompt = buildMissingFinalTextRecoveryPrompt(request.role, toolEvents);
	const timeouts = getOrchSubagentTimeoutsForRole(request.configState.merged, request.role);

	session.setActiveToolsByName([]);
	try {
		await runPromptWithTimeout(session, recoveryPrompt, timeouts.recoveryPromptMs, request.role, "missing-text recovery", {
			label: request.label ?? request.role,
			signal: request.signal,
		});
	} finally {
		session.setActiveToolsByName(requestedTools);
	}

	const recoveryMessages = session.messages.slice(recoveryStartMessageCount);
	return findLastAssistantText(recoveryMessages) ?? getStreamedText().slice(streamStartLength).trim();
}

function buildMissingFinalTextRecoveryPrompt(role: OrchRoleName, toolEvents: OrchSubagentToolEvent[]): string {
	const isAnalysisRole = role === "plan_codebase" || role === "research" || role === "smart_friend";
	const urgency = isAnalysisRole
		? "You must produce the complete final report now. Do not call tools. Just write the report directly in your final message based on the completed tool results you already have."
		: "Now provide the final report for that previous task based only on the completed tool results and conversation context.";
	return [
		`You are the Orch ${role} sub-agent. You completed the previous task turn without sending a final response.`,
		urgency,
		"Do not call tools. Follow the exact response format originally requested for the task.",
		"Observed tool activity:",
		...formatToolEventsForFallback(toolEvents),
	].join("\n");
}

function buildToolFallbackOutput(role: OrchRoleName, toolEvents: OrchSubagentToolEvent[]): string {
	return [
		`Orch ${role} produced no final assistant text.`,
		"",
		"This is diagnostic fallback output from Orch, not the sub-agent's conclusion.",
		"",
		"Tool activity observed:",
		...formatToolEventsForFallback(toolEvents),
	].join("\n");
}

function formatToolEventsForFallback(toolEvents: OrchSubagentToolEvent[]): string[] {
	if (toolEvents.length === 0) {
		return ["- none"];
	}
	return toolEvents.map((event) => `- ${event.label}: ${event.detail}`);
}

export async function runOrchWorkerSubagent(request: OrchWorkerSubagentRequest): Promise<OrchSubagentResult> {
	return spawnOrchSubagent({
		role: "worker",
		label: request.label ?? request.feature.title,
		prompt: buildWorkerSubagentPrompt(request),
		cwd: request.cwd,
		configState: request.configState,
		modelRegistry: request.modelRegistry,
		signal: request.signal,
		onStreamEvent: request.onStreamEvent,
	});
}

export async function runOrchValidatorSubagent(request: OrchValidatorSubagentRequest): Promise<OrchSubagentResult> {
	return spawnOrchSubagent({
		role: "validator",
		label: request.label ?? request.feature.title,
		prompt: buildValidatorSubagentPrompt(request),
		cwd: request.cwd,
		configState: request.configState,
		modelRegistry: request.modelRegistry,
		signal: request.signal,
		onStreamEvent: request.onStreamEvent,
	});
}

export async function disposeOrchSubagentSessions(): Promise<void> {
	const sessions = [...orchSubagentSessionCache.values()];
	orchSubagentSessionCache.clear();
	for (const { session } of sessions) {
		session.dispose();
	}
}

async function getOrCreateOrchSubagentSession(request: OrchSubagentRequest, model: Model<Api>): Promise<{
	session: OrchSubagentSession;
	isCached: boolean;
	boundExtensions: boolean;
	cacheKey?: string;
}> {
	if (request.role === "validator" || request.forceFresh) {
		return {
			session: await createFreshOrchSubagentSession(request, model),
			isCached: false,
			boundExtensions: false,
		};
	}

	const cacheKey = getOrchSubagentSessionCacheKey(request, model);
	const cached = orchSubagentSessionCache.get(cacheKey);
	if (cached) {
		const resetPolicy = getCachedSessionResetPolicy(request.role);
		if (!resetPolicy || !shouldResetCachedSession(cached, resetPolicy)) {
			return {
				session: cached.session,
				isCached: true,
				boundExtensions: cached.boundExtensions,
				cacheKey,
			};
		}
		await evictCachedOrchSubagentSession(cacheKey, cached.session);
	}

	const session = await createFreshOrchSubagentSession(request, model);
	orchSubagentSessionCache.set(cacheKey, { session, boundExtensions: false, runCount: 0, totalTokens: 0 });
	return {
		session,
		isCached: true,
		boundExtensions: false,
		cacheKey,
	};
}

async function createFreshOrchSubagentSession(request: OrchSubagentRequest, model: Model<Api>): Promise<OrchSubagentSession> {
	const rolePrompt = await loadOrchRolePrompt(request.role);
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: request.cwd,
		agentDir: getAgentDir(),
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		systemPromptOverride: (base) => [rolePrompt, base].filter(Boolean).join("\n\n"),
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: request.cwd,
		model,
		modelRegistry: request.modelRegistry,
		resourceLoader,
		thinkingLevel: request.thinkingLevel,
		customTools: getRoleToolOverrides(request),
		sessionManager: SessionManager.inMemory(request.cwd),
		settingsManager,
	});

	// Avoid depending on SDK-version-specific `tools` option semantics.
	// Older Pi SDKs expect built-in Tool objects, while newer SDKs expect tool-name strings.
	// The AgentSession runtime exposes a stable string-based activator in both versions.
	session.setActiveToolsByName(getRequestedTools(request));

	return session;
}

function getOrchSubagentSessionCacheKey(request: OrchSubagentRequest, model: Model<Api>): string {
	return JSON.stringify({
		cwd: request.cwd,
		role: request.role,
		provider: model.provider,
		modelId: model.id,
		toolNames: getRequestedTools(request),
		hasBashCommandGuard: Boolean(request.bashCommandGuard),
		bashGuardReason: request.bashGuardReason ?? null,
		thinkingLevel: request.thinkingLevel ?? null,
	});
}

function getRequestedTools(request: OrchSubagentRequest): string[] {
	return request.toolNames ?? getRoleTools(request.role);
}

function getCachedSessionResetPolicy(role: OrchRoleName): CachedSessionResetPolicy | undefined {
	switch (role) {
		case "worker":
			return WORKER_SESSION_RESET_POLICY;
		case "validator":
			return undefined;
		default:
			return NON_WORKER_SESSION_RESET_POLICY;
	}
}

function shouldResetCachedSession(
	cached: CachedOrchSubagentSession,
	policy: CachedSessionResetPolicy,
): boolean {
	return cached.runCount >= policy.maxRuns || cached.totalTokens >= policy.maxTotalTokens;
}

function updateCachedSessionCounters(cacheKey: string, session: OrchSubagentSession, role: OrchRoleName, totalTokens: number): void {
	const cached = orchSubagentSessionCache.get(cacheKey);
	if (!cached || cached.session !== session) {
		return;
	}
	cached.runCount += 1;
	cached.totalTokens += totalTokens;
	const resetPolicy = getCachedSessionResetPolicy(role);
	if (resetPolicy && shouldResetCachedSession(cached, resetPolicy)) {
		orchSubagentSessionCache.delete(cacheKey);
		session.dispose();
	}
}

async function evictCachedOrchSubagentSession(cacheKey: string, session: OrchSubagentSession): Promise<void> {
	const cached = orchSubagentSessionCache.get(cacheKey);
	if (cached?.session !== session) {
		return;
	}
	orchSubagentSessionCache.delete(cacheKey);
	session.dispose();
}

function resolveConfiguredModel(
	modelRegistry: ModelRegistry,
	provider: string,
	modelId: string,
	role: OrchRoleName,
): Model<Api> {
	const model = modelRegistry.find(provider, modelId);
	if (!model) {
		throw new Error(`Orch ${role} model not found: ${provider}/${modelId}`);
	}
	if (!modelRegistry.hasConfiguredAuth(model)) {
		throw new Error(`No configured auth for Orch ${role} model: ${provider}/${modelId}`);
	}
	return model;
}

function getRoleTools(role: OrchRoleName): string[] {
	switch (role) {
		case "orchestrator":
			return ORCHESTRATOR_TOOLS;
		case "worker":
			return WORKER_TOOLS;
		case "validator":
			return VALIDATOR_TOOLS;
		case "smart_friend":
			return SMART_FRIEND_TOOLS;
		case "research":
			return RESEARCH_TOOLS;
		case "plan_codebase":
			return PLAN_CODEBASE_TOOLS;
	}
}

function formatSubagentToolLabel(toolName: string): string {
	switch (toolName) {
		case "read":
			return "Read";
		case "bash":
			return "Bash";
		case "edit":
			return "Edit";
		case "write":
			return "Write";
		case "grep":
			return "Search";
		case "find":
			return "Find";
		case "ls":
			return "List";
		case TINYFISH_TOOL_NAME:
			return "TinyFish";
		case PARALLEL_SEARCH_TOOL_NAME:
			return "Parallel Search";
		case PARALLEL_FETCH_TOOL_NAME:
			return "Parallel Fetch";
		default:
			return toolName.length > 0 ? `${toolName.slice(0, 1).toUpperCase()}${toolName.slice(1)}` : "Tool";
	}
}

function extractSubagentToolDiff(toolName: string, args: unknown, result: unknown): { diff?: string; diffFilePath?: string } {
	const input = asRecord(args);
	const resultRecord = asRecord(result);
	const details = asRecord(resultRecord?.details);
	const path = asString(input?.path);

	if (toolName === "edit") {
		const diff = asString(details?.diff);
		return { diff, diffFilePath: path };
	}

	if (toolName === "write") {
		const diff = asString(details?._diff);
		return { diff, diffFilePath: path };
	}

	return {};
}

function formatSubagentToolDetail(toolName: string, args: unknown, result: unknown, isError: boolean): string {
	const input = asRecord(args);
	const resultRecord = asRecord(result);
	const details = asRecord(resultRecord?.details);
	const output = getToolResultText(resultRecord);
	const statusPrefix = isError ? "failed" : "done";

	switch (toolName) {
		case "read": {
			const path = asString(input?.path) ?? "file";
			const lines = asNumber(asRecord(details?.truncation)?.totalLines) ?? countMeaningfulLines(output);
			return `${path} • ${lines} ${lines === 1 ? "line" : "lines"}`;
		}
		case "bash": {
			const command = truncateOneLine(asString(input?.command) ?? "command", 80);
			const summary = output.length > 0 ? truncateOneLine(getFirstMeaningfulLine(output) ?? output, 80) : statusPrefix;
			return `${command} • ${summary}`;
		}
		case "edit": {
			const path = asString(input?.path) ?? "file";
			const editCount = Array.isArray(input?.edits) ? input.edits.length : 1;
			const diff = asString(details?.diff) ?? "";
			const diffStats = countDiffStats(diff);
			const inlineSummary = diff.length > 0 ? ` · ${formatInlineDiffSummary(diff)}` : "";
			return `${path} • Applied ${editCount} ${editCount === 1 ? "edit" : "edits"} • +${diffStats.additions}/-${diffStats.removals}${inlineSummary}`;
		}
		case "write": {
			const path = asString(input?.path) ?? "file";
			const lineCount = countLines(asString(input?.content) ?? output);
			const diff = asString(details?._diff) ?? "";
			const diffStats = diff.length > 0 ? countDiffStats(diff) : undefined;
			const diffPart = diffStats ? ` · +${diffStats.additions}/-${diffStats.removals}` : "";
			return `${path} • wrote ${lineCount} ${lineCount === 1 ? "line" : "lines"}${diffPart}`;
		}
		case "grep":
		case "find":
		case "ls": {
			const target = asString(input?.path) ?? asString(input?.pattern) ?? ".";
			const count = countMeaningfulLines(output);
			return `${target} • ${count} ${count === 1 ? "result" : "results"}`;
		}
		case TINYFISH_TOOL_NAME: {
			const target = asString(input?.url) ?? asString(input?.query) ?? "web";
			const summary = output.length > 0 ? truncateOneLine(getFirstMeaningfulLine(output) ?? output, 100) : statusPrefix;
			return `${target} • ${summary}`;
		}
		case PARALLEL_SEARCH_TOOL_NAME: {
			const objective = asString(input?.objective) ?? asString(input?.query) ?? "web search";
			return `${truncateOneLine(objective, 80)} • ${isError ? "failed" : "done"}`;
		}
		case PARALLEL_FETCH_TOOL_NAME: {
			const urlStr = asString(input?.urls) ?? "url";
			return `${truncateOneLine(urlStr, 80)} • ${isError ? "failed" : "done"}`;
		}
		default:
			return output.length > 0 ? truncateOneLine(getFirstMeaningfulLine(output) ?? output, 100) : statusPrefix;
	}
}

function getToolResultText(result: Record<string, unknown> | undefined): string {
	const content = result?.content;
	if (!Array.isArray(content)) {
		return "";
	}
	return getTextToolOutput(content as Array<{ type: string; text?: string }>);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function countLines(text: string): number {
	if (text.length === 0) {
		return 0;
	}
	return text.replace(/\r/g, "").split("\n").length;
}

function countMeaningfulLines(text: string): number {
	return text
		.replace(/\r/g, "")
		.split("\n")
		.filter((line) => line.trim().length > 0).length;
}

function getFirstMeaningfulLine(text: string): string | undefined {
	return text
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
}

function countDiffStats(diff: string): { additions: number; removals: number } {
	let additions = 0;
	let removals = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) {
			additions++;
		}
		if (line.startsWith("-") && !line.startsWith("---")) {
			removals++;
		}
	}
	return { additions, removals };
}

function truncateOneLine(value: string, maxLength: number): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	if (singleLine.length <= maxLength) {
		return singleLine;
	}
	return `${singleLine.slice(0, Math.max(0, maxLength - 1))}…`;
}

function emitSubagentDiffPreview(
	request: OrchSubagentRequest,
	label: string,
	path: string,
	diff: string | undefined,
	error?: string,
): void {
	const detail = error
		? `${path} • ${error}`
		: diff && diff.length > 0
			? `${path} • ${formatInlineDiffSummary(diff)}`
			: `${path} • no textual changes`;
	request.onStreamEvent?.({
		role: request.role,
		type: "tool_diff",
		label,
		detail,
		diff,
		diffFilePath: path,
	});
}

function getRoleToolOverrides(request: OrchSubagentRequest): OrchRoleToolDefinition[] {
	const overrides: OrchRoleToolDefinition[] = [];

	if (getRequestedTools(request).includes(TINYFISH_TOOL_NAME)) {
		overrides.push(createTinyFishToolDefinition());
	}

	if (getRequestedTools(request).includes(PARALLEL_SEARCH_TOOL_NAME)) {
		overrides.push(createParallelSearchToolDefinition());
	}

	if (getRequestedTools(request).includes(PARALLEL_FETCH_TOOL_NAME)) {
		overrides.push(createParallelFetchToolDefinition());
	}

	if (getRequestedTools(request).includes("bash")) {
		const bashTool = createBashToolDefinition(request.cwd);
		overrides.push({
			...bashTool,
			async execute(
				toolCallId: ToolExecuteParams<typeof bashTool>[0],
				params: ToolExecuteParams<typeof bashTool>[1],
				signal: ToolExecuteParams<typeof bashTool>[2],
				onUpdate: ToolExecuteParams<typeof bashTool>[3],
				ctx: ToolExecuteParams<typeof bashTool>[4],
			) {
				if (request.bashCommandGuard && !request.bashCommandGuard(params.command)) {
					throw new Error(
						request.bashGuardReason ??
							`Command blocked by Orch ${request.role} bash guard: ${params.command}`,
					);
				}
				return bashTool.execute(
					toolCallId,
					{
						...params,
						timeout: typeof params.timeout === "number" ? params.timeout : DEFAULT_SUBAGENT_BASH_TIMEOUT_SECONDS,
					},
					signal,
					onUpdate,
					ctx,
				);
			},
		});
	}

	// Wrap mutating tools so every sub-agent edit/write emits a review-first diff event.
	if (getRequestedTools(request).includes("edit")) {
		const editTool = createEditToolDefinition(request.cwd);
		overrides.push({
			...editTool,
			async execute(
				toolCallId: ToolExecuteParams<typeof editTool>[0],
				params: ToolExecuteParams<typeof editTool>[1],
				signal: ToolExecuteParams<typeof editTool>[2],
				onUpdate: ToolExecuteParams<typeof editTool>[3],
				ctx: ToolExecuteParams<typeof editTool>[4],
			) {
				const preview = await computeEditPreviewDiff(request.cwd, params.path, params.edits);
				if (preview.ok === true) {
					emitSubagentDiffPreview(request, "Edit preview", params.path, preview.diff);
				} else {
					emitSubagentDiffPreview(request, "Edit preview", params.path, undefined, preview.error);
				}
				return editTool.execute(toolCallId, params, signal, onUpdate, ctx);
			},
		});
	}

	if (getRequestedTools(request).includes("write")) {
		const writeTool = createWriteToolDefinition(request.cwd);
		overrides.push({
			...writeTool,
			async execute(
				toolCallId: ToolExecuteParams<typeof writeTool>[0],
				params: ToolExecuteParams<typeof writeTool>[1],
				signal: ToolExecuteParams<typeof writeTool>[2],
				onUpdate: ToolExecuteParams<typeof writeTool>[3],
				ctx: ToolExecuteParams<typeof writeTool>[4],
			) {
				const preview = await computeWritePreviewDiff(request.cwd, params.path, params.content);
				if (preview.ok === true) {
					emitSubagentDiffPreview(request, "Write preview", params.path, preview.diff);
				} else {
					emitSubagentDiffPreview(request, "Write preview", params.path, undefined, preview.error);
				}
				const result = await writeTool.execute(toolCallId, params, signal, onUpdate, ctx);
				return {
					...result,
					details: { ...((result.details as unknown as Record<string, unknown>) ?? {}), _diff: preview.ok === true ? preview.diff : undefined },
				};
			},
		});
	}

	if (request.role !== "validator") {
		return overrides;
	}

	const blockedRoots = getValidatorBlockedRoots(request.configState);
	const readTool = createReadToolDefinition(request.cwd);
	const grepTool = createGrepToolDefinition(request.cwd);
	const findTool = createFindToolDefinition(request.cwd);
	const lsTool = createLsToolDefinition(request.cwd);

	overrides.push(
		{
			...readTool,
			async execute(
				toolCallId: ToolExecuteParams<typeof readTool>[0],
				params: ToolExecuteParams<typeof readTool>[1],
				signal: ToolExecuteParams<typeof readTool>[2],
				onUpdate: ToolExecuteParams<typeof readTool>[3],
				ctx: ToolExecuteParams<typeof readTool>[4],
			) {
				assertValidatorPathAllowed(params.path, request.cwd, blockedRoots);
				return readTool.execute(toolCallId, params, signal, onUpdate, ctx);
			},
		},
		{
			...grepTool,
			async execute(
				toolCallId: ToolExecuteParams<typeof grepTool>[0],
				params: ToolExecuteParams<typeof grepTool>[1],
				signal: ToolExecuteParams<typeof grepTool>[2],
				onUpdate: ToolExecuteParams<typeof grepTool>[3],
				ctx: ToolExecuteParams<typeof grepTool>[4],
			) {
				const searchPath = resolveValidatorToolPath(request.cwd, params.path ?? ".");
				assertValidatorAbsolutePathAllowed(searchPath, blockedRoots);
				const result = await grepTool.execute(toolCallId, params, signal, onUpdate, ctx);
				const filtered = filterGrepOutput(getTextToolOutput(result.content), searchPath, blockedRoots);
				if (!filtered.changed) {
					return result;
				}
				return {
					...result,
					content: [{ type: "text", text: filtered.text }] satisfies TextContent[],
					details: undefined,
				};
			},
		},
		{
			...findTool,
			async execute(
				toolCallId: ToolExecuteParams<typeof findTool>[0],
				params: ToolExecuteParams<typeof findTool>[1],
				signal: ToolExecuteParams<typeof findTool>[2],
				onUpdate: ToolExecuteParams<typeof findTool>[3],
				ctx: ToolExecuteParams<typeof findTool>[4],
			) {
				const searchPath = resolveValidatorToolPath(request.cwd, params.path ?? ".");
				assertValidatorAbsolutePathAllowed(searchPath, blockedRoots);
				const result = await findTool.execute(toolCallId, params, signal, onUpdate, ctx);
				const filtered = filterFindOutput(getTextToolOutput(result.content), searchPath, blockedRoots);
				if (!filtered.changed) {
					return result;
				}
				return {
					...result,
					content: [{ type: "text", text: filtered.text }] satisfies TextContent[],
					details: undefined,
				};
			},
		},
		{
			...lsTool,
			async execute(
				toolCallId: ToolExecuteParams<typeof lsTool>[0],
				params: ToolExecuteParams<typeof lsTool>[1],
				signal: ToolExecuteParams<typeof lsTool>[2],
				onUpdate: ToolExecuteParams<typeof lsTool>[3],
				ctx: ToolExecuteParams<typeof lsTool>[4],
			) {
				const searchPath = resolveValidatorToolPath(request.cwd, params.path ?? ".");
				assertValidatorAbsolutePathAllowed(searchPath, blockedRoots);
				const result = await lsTool.execute(toolCallId, params, signal, onUpdate, ctx);
				const filtered = filterLsOutput(getTextToolOutput(result.content), searchPath, blockedRoots);
				if (!filtered.changed) {
					return result;
				}
				return {
					...result,
					content: [{ type: "text", text: filtered.text }] satisfies TextContent[],
					details: undefined,
				};
			},
		},
	);

	return overrides;
}

function getValidatorBlockedRoots(configState: OrchLoadedConfig): string[] {
	return [resolve(configState.resolvedPaths.missionsDir, VALIDATOR_STREAMS_DIR_NAME)];
}

function resolveValidatorToolPath(cwd: string, path: string): string {
	const normalized = path.startsWith("@") ? path.slice(1) : path;
	if (normalized === "~") {
		return homedir();
	}
	if (normalized.startsWith("~/")) {
		return join(homedir(), normalized.slice(2));
	}
	return resolve(cwd, normalized);
}

function assertValidatorPathAllowed(path: string, cwd: string, blockedRoots: string[]): void {
	assertValidatorAbsolutePathAllowed(resolveValidatorToolPath(cwd, path), blockedRoots);
}

function assertValidatorAbsolutePathAllowed(path: string, blockedRoots: string[]): void {
	if (isValidatorBlockedPath(path, blockedRoots)) {
		throw new Error(`Access denied: Orch validator cannot inspect cmux stream logs under ${path}.`);
	}
}

function isValidatorBlockedPath(path: string, blockedRoots: string[]): boolean {
	const absolutePath = resolve(path);
	return blockedRoots.some((root) => absolutePath === root || absolutePath.startsWith(`${root}${sep}`));
}

function getTextToolOutput(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trim();
}

function filterLsOutput(
	output: string,
	listedDirectory: string,
	blockedRoots: string[],
): { changed: boolean; text: string } {
	if (output.length === 0 || output === "(empty directory)") {
		return { changed: false, text: output };
	}

	const entries = output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("["));
	const visibleEntries = entries.filter((entry) => {
		const entryPath = resolve(listedDirectory, entry.endsWith("/") ? entry.slice(0, -1) : entry);
		return !isValidatorBlockedPath(entryPath, blockedRoots);
	});

	return {
		changed: visibleEntries.length !== entries.length,
		text: visibleEntries.length > 0 ? visibleEntries.join("\n") : "(empty directory)",
	};
}

function filterFindOutput(output: string, searchPath: string, blockedRoots: string[]): { changed: boolean; text: string } {
	if (output.length === 0 || output === "No files found matching pattern") {
		return { changed: false, text: output };
	}

	const paths = output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("["));
	const visiblePaths = paths.filter((line) => !isValidatorBlockedPath(resolve(searchPath, line), blockedRoots));

	return {
		changed: visiblePaths.length !== paths.length,
		text: visiblePaths.length > 0 ? visiblePaths.join("\n") : "No files found matching pattern",
	};
}

function filterGrepOutput(output: string, searchPath: string, blockedRoots: string[]): { changed: boolean; text: string } {
	if (output.length === 0 || output === "No matches found") {
		return { changed: false, text: output };
	}

	const keptLines: string[] = [];
	let changed = false;
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) {
			if (keptLines.length > 0 && keptLines[keptLines.length - 1] !== "") {
				keptLines.push("");
			}
			continue;
		}
		if (trimmed.startsWith("[")) {
			continue;
		}

		const resultPath = extractGrepResultPath(trimmed);
		if (resultPath && isValidatorBlockedPath(resolve(searchPath, resultPath), blockedRoots)) {
			changed = true;
			continue;
		}

		keptLines.push(line);
	}

	const normalizedLines = trimBlankLines(keptLines);
	return {
		changed,
		text: normalizedLines.length > 0 ? normalizedLines.join("\n") : "No matches found",
	};
}

function extractGrepResultPath(line: string): string | undefined {
	const match = line.match(/^(.*?)(?::\d+:|-\d+- )/);
	return match?.[1];
}

function trimBlankLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start] === "") {
		start++;
	}
	while (end > start && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(start, end);
}

function buildWorkerSubagentPrompt(request: OrchWorkerSubagentRequest): string {
	const dependencySummary = request.feature.dependencies.length > 0 ? request.feature.dependencies.join(", ") : "none";
	const steeringText = request.steering
		? [request.steering.summary, ...request.steering.instructions.map((instruction) => `- ${instruction}`)].join("\n")
		: "none";
	const validationCriteria = request.validationContract.criteria.map(
		(criterion) => `- ${criterion.id}: ${criterion.title} (${criterion.type}) — ${criterion.description}`,
	);
	const fixTaskLines = formatFixTasks(request.steering?.fixTasks ?? []);

	return [
		"Execute the assigned Orch worker feature and prepare a validator-ready handoff.",
		`Goal: ${request.goal}`,
		`Goal summary: ${request.missionSummary}`,
		`Feature ID: ${request.feature.id}`,
		`Feature title: ${request.feature.title}`,
		`Feature goal: ${request.feature.goal}`,
		`Dependencies: ${dependencySummary}`,
		"Deliverables:",
		...(request.feature.deliverables.length > 0
			? request.feature.deliverables.map((deliverable) => `- ${deliverable}`)
			: ["- none"]),
		"Feature notes:",
		...(request.feature.notes.length > 0 ? request.feature.notes.map((note) => `- ${note}`) : ["- none"]),
		"Validation contract:",
		...validationCriteria,
		...buildSharedStatePromptSection(request.sharedState, true),
		"Steering instructions from the orchestrator:",
		steeringText,
		"Fix tasks created from the latest validator findings:",
		...fixTaskLines,
		"You may edit files and run commands as needed, but stay within this feature's scope.",
		"You may also read and update the shared goal-state files when they help coordination, documentation, or handoff quality.",
		"Return strict JSON only with this shape:",
		'{ "summary": "string", "changes": ["path: description"], "testsRun": ["string"], "notes": ["string"], "followUps": ["string"], "handoff": "string" }',
		"The handoff must help a fresh validator understand what changed, what was verified, and what still needs scrutiny.",
	].join("\n");
}

function buildValidatorSubagentPrompt(request: OrchValidatorSubagentRequest): string {
	const validationCriteria = request.validationContract.criteria.map(
		(criterion) => `- ${criterion.id}: ${criterion.title} (${criterion.type}) — ${criterion.description}`,
	);

	return [
		"Validate a worker handoff for a single Orch goal feature.",
		`Goal: ${request.goal}`,
		`Goal summary: ${request.missionSummary}`,
		`Feature ID: ${request.feature.id}`,
		`Feature title: ${request.feature.title}`,
		`Feature goal: ${request.feature.goal}`,
		"Feature deliverables:",
		...(request.feature.deliverables.length > 0
			? request.feature.deliverables.map((deliverable) => `- ${deliverable}`)
			: ["- none"]),
		"Validation contract:",
		...validationCriteria,
		...buildSharedStatePromptSection(request.sharedState, false),
		"Worker summary:",
		request.workerRun.summary,
		"Worker handoff:",
		request.workerRun.handoff,
		"Worker-declared changes:",
		...(request.workerRun.changes.length > 0 ? request.workerRun.changes.map((change) => `- ${change}`) : ["- none"]),
		"Worker-declared tests:",
		...(request.workerRun.testsRun.length > 0 ? request.workerRun.testsRun.map((test) => `- ${test}`) : ["- none"]),
		"Worker notes:",
		...(request.workerRun.notes.length > 0 ? request.workerRun.notes.map((note) => `- ${note}`) : ["- none"]),
		"Inspect the repository and determine whether this feature is complete. Never modify files or shared mission-state artifacts.",
		"Return strict JSON only with this shape:",
		'{ "passed": true, "summary": "string", "issues": [{ "severity": "critical|major|minor", "title": "string", "details": "string", "action": "string" }], "evidence": ["string"] }',
	].join("\n");
}

function formatFixTasks(fixTasks: MissionFixTask[]): string[] {
	if (fixTasks.length === 0) {
		return ["- none"];
	}

	return fixTasks.flatMap((task) => {
		const lines = [`- ${task.id}: ${task.title}`];
		for (const instruction of task.instructions) {
			lines.push(`  - instruction: ${instruction}`);
		}
		for (const deliverable of task.deliverables) {
			lines.push(`  - deliverable: ${deliverable}`);
		}
		for (const note of task.notes) {
			lines.push(`  - note: ${note}`);
		}
		return lines;
	});
}

function findLastAssistantMessage(messages: AgentMessage[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (isAssistantMessage(message)) {
			return message;
		}
	}
	return undefined;
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && Array.isArray(message.content);
}

function findLastAssistantText(messages: AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!isAssistantMessage(message)) {
			continue;
		}
		const text = getAssistantText(message);
		if (text.length > 0) {
			return text;
		}
	}
	return undefined;
}

function getAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trim();
}
