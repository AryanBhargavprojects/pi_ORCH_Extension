import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, AssistantMessage, Model, TextContent } from "@mariozechner/pi-ai";
import {
	createAgentSession,
	createBashToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	DefaultResourceLoader,
	getAgentDir,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";

import type { OrchLoadedConfig, OrchRoleName } from "./config.js";
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
		type: "tool_call";
		label: string;
		detail: string;
	  };

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
};

export type OrchSubagentResult = {
	role: OrchRoleName;
	provider: string;
	modelId: string;
	output: string;
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
};

const ORCHESTRATOR_TOOLS = ["read", "bash", "grep", "find", "ls"];
const WORKER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const VALIDATOR_TOOLS = ["read", "grep", "find", "ls"];
const PLAN_CODEBASE_TOOLS = ["read", "grep", "find", "ls"];
const SMART_FRIEND_TOOLS = ["read", "bash", "grep", "find", "ls"];
const DEFAULT_SUBAGENT_BASH_TIMEOUT_SECONDS = 120;
const VALIDATOR_STREAMS_DIR_NAME = ".streams";
const WORKER_SESSION_RESET_POLICY: CachedSessionResetPolicy = { maxRuns: 5, maxTotalTokens: 60000 };
const NON_WORKER_SESSION_RESET_POLICY: CachedSessionResetPolicy = { maxRuns: 3, maxTotalTokens: 40000 };

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

const orchSubagentSessionCache = new Map<string, CachedOrchSubagentSession>();

export async function spawnOrchSubagent(request: OrchSubagentRequest): Promise<OrchSubagentResult> {
	const startedAt = Date.now();
	const modelConfig = request.configState.merged.roles[request.role];
	const model = resolveConfiguredModel(request.modelRegistry, modelConfig.provider, modelConfig.model, request.role);
	const { session, isCached, boundExtensions, cacheKey } = await getOrCreateOrchSubagentSession(request, model);

	const toolArgsById = new Map<string, { toolName: string; args: unknown }>();
	let streamedText = "";
	let toolCallCount = 0;
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			toolArgsById.set(event.toolCallId, { toolName: event.toolName, args: event.args });
			return;
		}

		if (event.type === "tool_execution_end") {
			toolCallCount++;
			const started = toolArgsById.get(event.toolCallId);
			toolArgsById.delete(event.toolCallId);
			request.onStreamEvent?.({
				role: request.role,
				type: "tool_call",
				label: formatSubagentToolLabel(event.toolName),
				detail: formatSubagentToolDetail(event.toolName, started?.args, event.result, event.isError),
			});
			return;
		}

		if (event.type !== "message_update") {
			return;
		}

		if (event.assistantMessageEvent.type === "thinking_delta") {
			request.onStreamEvent?.({
				role: request.role,
				type: "thinking_delta",
				delta: event.assistantMessageEvent.delta,
			});
			return;
		}

		if (event.assistantMessageEvent.type === "text_delta") {
			streamedText += event.assistantMessageEvent.delta;
			request.onStreamEvent?.({
				role: request.role,
				type: "text_delta",
				delta: event.assistantMessageEvent.delta,
			});
		}
	});

	let wasAborted = false;
	const abortHandler = () => {
		wasAborted = true;
		request.onStreamEvent?.({ role: request.role, type: "status", status: "aborted" });
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
		request.onStreamEvent?.({ role: request.role, type: "status", status: "starting" });
		if (!isCached || !boundExtensions) {
			await session.bindExtensions({});
			if (isCached && cacheKey) {
				const cachedSession = orchSubagentSessionCache.get(cacheKey);
				if (cachedSession?.session === session) {
					cachedSession.boundExtensions = true;
				}
			}
		}
		await session.prompt(request.prompt);
		if (wasAborted || request.signal?.aborted) {
			throw new Error(`Orch ${request.role} sub-agent aborted.`);
		}
		request.onStreamEvent?.({ role: request.role, type: "status", status: "completed" });
		const assistantMessage = findLastAssistantMessage(session.messages);
		const output = findLastAssistantText(session.messages) ?? streamedText.trim();

		const usage = {
			input: assistantMessage?.usage?.input ?? 0,
			output: assistantMessage?.usage?.output ?? 0,
			cacheRead: assistantMessage?.usage?.cacheRead ?? 0,
			cacheWrite: assistantMessage?.usage?.cacheWrite ?? 0,
			totalTokens: assistantMessage?.usage?.totalTokens ?? 0,
			costTotal: assistantMessage?.usage?.cost?.total ?? 0,
		};
		if (isCached && cacheKey) {
			updateCachedSessionCounters(cacheKey, session, request.role, usage.totalTokens);
		}

		return {
			role: request.role,
			provider: model.provider,
			modelId: model.id,
			output,
			usage,
			toolCalls: toolCallCount,
			elapsedMs: Date.now() - startedAt,
		};
	} catch (error) {
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
	}
}

export async function runOrchWorkerSubagent(request: OrchWorkerSubagentRequest): Promise<OrchSubagentResult> {
	return spawnOrchSubagent({
		role: "worker",
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
	if (request.role === "validator") {
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
		tools: getRequestedTools(request) as any,
		customTools: getRoleToolOverrides(request),
		sessionManager: SessionManager.inMemory(request.cwd),
		settingsManager,
	});

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
		case "plan_clarifier":
			return ORCHESTRATOR_TOOLS;
		case "plan_codebase":
			return PLAN_CODEBASE_TOOLS;
		case "plan_researcher":
		case "plan_feasibility":
		case "plan_synthesizer":
			return ORCHESTRATOR_TOOLS;
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
		default:
			return toolName.length > 0 ? `${toolName.slice(0, 1).toUpperCase()}${toolName.slice(1)}` : "Tool";
	}
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
			const diffStats = countDiffStats(asString(details?.diff) ?? "");
			return `${path} • Applied ${editCount} ${editCount === 1 ? "edit" : "edits"} • +${diffStats.additions}/-${diffStats.removals}`;
		}
		case "write": {
			const path = asString(input?.path) ?? "file";
			const lineCount = countLines(asString(input?.content) ?? output);
			return `${path} • wrote ${lineCount} ${lineCount === 1 ? "line" : "lines"}`;
		}
		case "grep":
		case "find":
		case "ls": {
			const target = asString(input?.path) ?? asString(input?.pattern) ?? ".";
			const count = countMeaningfulLines(output);
			return `${target} • ${count} ${count === 1 ? "result" : "results"}`;
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

function getRoleToolOverrides(request: OrchSubagentRequest) {
	const overrides: any[] = [];

	if (getRequestedTools(request).includes("bash")) {
		const bashTool = createBashToolDefinition(request.cwd);
		overrides.push({
			...bashTool,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
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
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				assertValidatorPathAllowed(params.path, request.cwd, blockedRoots);
				return readTool.execute(toolCallId, params, signal, onUpdate, ctx);
			},
		},
		{
			...grepTool,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
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
			async execute(toolCallId, params, signal, onUpdate, ctx) {
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
			async execute(toolCallId, params, signal, onUpdate, ctx) {
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
		`Mission goal: ${request.goal}`,
		`Mission summary: ${request.missionSummary}`,
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
		"You may also read and update the shared mission-state files when they help coordination, documentation, or handoff quality.",
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
		"Validate a worker handoff for a single Orch mission feature.",
		`Mission goal: ${request.goal}`,
		`Mission summary: ${request.missionSummary}`,
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
