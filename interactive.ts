import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { loadOrchConfig, type OrchRoleName } from "./config.js";
import { ORCH_TOOL_NAMES } from "./constants.js";
import { formatElapsed, LOADING_VERBS, SPINNER_FRAME_MS, VERB_ROTATE_MS } from "./loading.js";
import type { DelegationBuffer, DelegationEventKind } from "./mission-types.js";
import { loadOrchRolePrompt } from "./prompt-loader.js";
import { spawnOrchSubagent, type OrchSubagentStreamEvent } from "./role-runner.js";
import type { OrchRuntimeState } from "./runtime.js";
import {
	renderDelegateCall,
	renderDelegateResult,
	renderSmartFriendCall,
	renderSmartFriendResult,
	type SmartFriendBuffer,
} from "./tool-renderers.js";

const DELEGATE_ROLE_NAMES = ["worker", "validator", "plan_codebase", "plan_researcher"] as const;
type DelegateRoleName = (typeof DELEGATE_ROLE_NAMES)[number];

const INTERACTIVE_CODEBASE_TOOLS = ["read", "grep", "find", "ls"] as const;
const INTERACTIVE_RESEARCH_TOOLS = ["read", "bash", "grep", "find", "ls"] as const;
const INTERACTIVE_RESEARCH_BASH_GUARD_REASON = "Interactive research delegation only allows read-only bash commands. Use read, grep, find, ls, or safe inspection/fetch commands.";
const FAST_ZERO_TOOL_WARNING_MS = 2000;

const INTERACTIVE_DESTRUCTIVE_BASH_PATTERNS = [
	/\brm\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bfind\b.*\s-delete\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/[;&|`]/,
	/\$\(/,
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

const INTERACTIVE_SAFE_BASH_PATTERNS = [
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

export function registerInteractiveOrch(pi: ExtensionAPI, state: OrchRuntimeState): void {
	pi.registerTool({
		name: ORCH_TOOL_NAMES.delegate,
		label: "Orch Delegate",
		description: "Run an Orch sub-agent with the configured worker, validator, codebase analyst, or docs researcher model. Validator runs are always fresh; other roles may reuse cached context.",
		promptSnippet: "Delegate focused implementation, validation, codebase analysis, or docs/API research to an Orch role session. Validators are fresh; other roles may reuse context.",
		promptGuidelines: [
			"Use orch_delegate with role=plan_codebase for broad repository/codebase reading, architecture discovery, multi-file context gathering, or unfamiliar project analysis.",
			"Use orch_delegate with role=plan_researcher for documentation, framework, package, SDK, API, README, or external official-docs research.",
			"Use orch_delegate with role=worker for scoped implementation and role=validator for independent review.",
			"Use main-session built-in tools only for very small targeted reads needed for important immediate context, such as one known file or a short snippet; do not do broad docs/codebase sweeps in the main context.",
			"Do not delegate orchestration through orch_delegate; the main chat agent remains the orchestrator in interactive mode and decides whether to work directly, plan, or delegate.",
			"When delegating, include the relevant file paths, constraints, and expected output in the task itself. Validator runs start fresh; other roles may retain prior Orch sub-agent context.",
		],
		parameters: Type.Object({
			role: StringEnum(DELEGATE_ROLE_NAMES, {
				description: "Which Orch role to run: validator always gets a fresh context; worker, plan_codebase, and plan_researcher may reuse cached Orch context",
			}),
			task: Type.String({ description: "Self-contained task for the selected Orch role" }),
			featureId: Type.Optional(Type.String({ description: "Optional short feature/task id for the inline delegate header" })),
		}),
		executionMode: "sequential",
		renderShell: "self",
		renderCall: renderDelegateCall,
		renderResult: renderDelegateResult,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			state.configState = await loadOrchConfig(ctx.cwd);
			const role = params.role as DelegateRoleName;
			const task = params.task;
			const buffer = createDelegationBuffer(role, params.featureId ?? deriveDelegationFeatureId(task));
			const emitUpdate = () => emitDelegationBufferUpdate(buffer, onUpdate);
			const tickInterval = setInterval(() => {
				updateDelegationTiming(buffer);
				emitUpdate();
			}, SPINNER_FRAME_MS);

			updateDelegationTiming(buffer);
			emitUpdate();

			try {
				const result = await spawnOrchSubagent({
					role,
					prompt: buildInteractiveDelegationPrompt(role, task),
					cwd: ctx.cwd,
					configState: state.configState,
					modelRegistry: ctx.modelRegistry,
					signal,
					...getInteractiveDelegationOptions(role),
					onStreamEvent: (event) => {
						applyDelegationStreamEvent(buffer, event);
						updateDelegationTiming(buffer);
						emitUpdate();
					},
				});

				applyDelegationFinalOutput(buffer, role, result.output);
				applyDelegationRunWarnings(buffer, role, result.toolCalls, result.elapsedMs);
				updateDelegationTiming(buffer);
				emitUpdate();

				const summary = [`Orch ${result.role}`, `${result.provider}/${result.modelId}`].join(" • ");
				const resultText = result.output.trim().length > 0
					? result.output
					: buffer.finalSummary || `${summary} completed with no text output.`;

				return {
					content: [
						{
							type: "text",
							text: resultText,
						},
					],
					details: {
						delegationBuffer: cloneDelegationBuffer(buffer),
						role: result.role,
						provider: result.provider,
						modelId: result.modelId,
						usage: result.usage,
						toolCalls: result.toolCalls,
						elapsedMs: result.elapsedMs,
					},
				};
			} catch (error) {
				buffer.status = signal?.aborted || buffer.status === "aborted" ? "aborted" : "failed";
				updateDelegationTiming(buffer);
				buffer.finalSummary = buffer.status === "aborted"
					? `Orch ${role} delegation interrupted after ${formatElapsed(buffer.elapsedMs)}.`
					: `Orch ${role} delegation failed: ${formatDelegationError(error)}`;
				emitUpdate();
				return {
					content: [{ type: "text", text: buffer.finalSummary }],
					details: {
						delegationBuffer: cloneDelegationBuffer(buffer),
						role,
					},
				};
			} finally {
				clearInterval(tickInterval);
			}
		},
	});

	pi.registerTool({
		name: ORCH_TOOL_NAMES.smartFriend,
		label: "Orch Smart Friend",
		description: "Ask Orch's read-only advisor for a second opinion when the orchestrator is stuck. This advisor may reuse cached Orch context.",
		promptSnippet: "Consult Orch's read-only advisor for concrete guidance on a hard problem. It may reuse cached context.",
		promptGuidelines: [
			"Use orch_smart_friend only when you are genuinely stuck or low-confidence after making a real attempt.",
			"Ask a broad question, include what you tried, and pass relevant file paths as hints instead of summarizing code.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "What the orchestrator is stuck on. Broad is better than narrow." }),
			context: Type.String({ description: "What has been tried, what the user said, and what failed." }),
			relevantFiles: Type.Optional(Type.Array(Type.String(), {
				description: "Optional file paths the smart friend should inspect as hints only.",
			})),
		}),
		executionMode: "sequential",
		renderShell: "self",
		renderCall: renderSmartFriendCall,
		renderResult: renderSmartFriendResult,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			state.configState = await loadOrchConfig(ctx.cwd);
			const buffer = createSmartFriendBuffer(params.question);
			const emitUpdate = () => emitSmartFriendBufferUpdate(buffer, onUpdate);
			const tickInterval = setInterval(() => {
				updateSmartFriendTiming(buffer);
				emitUpdate();
			}, SPINNER_FRAME_MS);

			updateSmartFriendTiming(buffer);
			emitUpdate();

			try {
				const result = await spawnOrchSubagent({
					role: "smart_friend",
					prompt: buildSmartFriendPrompt(params.question, params.context, params.relevantFiles, state),
					cwd: ctx.cwd,
					configState: state.configState,
					modelRegistry: ctx.modelRegistry,
					signal,
				});

				applySmartFriendFinalOutput(buffer, result.output);
				updateSmartFriendTiming(buffer);
				emitUpdate();

				return {
					content: [{ type: "text", text: result.output }],
					details: {
						smartFriendBuffer: cloneSmartFriendBuffer(buffer),
						role: result.role,
						provider: result.provider,
						modelId: result.modelId,
						usage: result.usage,
					},
				};
			} catch (error) {
				buffer.status = signal?.aborted || buffer.status === "aborted" ? "aborted" : "failed";
				updateSmartFriendTiming(buffer);
				buffer.error = buffer.status === "aborted"
					? `Smart friend interrupted after ${formatElapsed(buffer.elapsedMs)}.`
					: `Smart friend failed: ${formatDelegationError(error)}`;
				emitUpdate();
				return {
					content: [{ type: "text", text: buffer.error }],
					details: {
						smartFriendBuffer: cloneSmartFriendBuffer(buffer),
					},
				};
			} finally {
				clearInterval(tickInterval);
			}
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		state.configState = await loadOrchConfig(ctx.cwd);
		const config = state.configState.merged;
		const orchestratorPrompt = await loadOrchRolePrompt("orchestrator");
		const interactivePrompt = [
			orchestratorPrompt,
			"# Orch Interactive Mode",
			"You are the main Pi agent and Orch's default interactive orchestrator.",
			"Stay conversational and keep the user in the loop.",
			"You decide whether to answer directly, do a little direct work, make a short plan, or delegate focused work to Orch sub-agents.",
			"For multi-step tasks, use TodoWrite to keep a short live checklist and maintain statuses as work progresses.",
			"Use delegation when it is likely to save main-context tokens or wall-clock time; otherwise work directly in the main Pi agent.",
			"Use orch_delegate role=plan_codebase for broad repository/codebase reading, architecture discovery, multi-file inspection, or unfamiliar project analysis.",
			"Use orch_delegate role=plan_researcher for documentation research only when local knowledge or quick direct reads are not enough.",
			"Use main-session built-in tools for simple inspection or straightforward edits when that is the fastest path.",
			`Use ${ORCH_TOOL_NAMES.delegate} role=worker for focused implementation and role=validator for separate review only when risk or uncertainty justifies it.`,
			`Use ${ORCH_TOOL_NAMES.smartFriend} when you are genuinely stuck and need a read-only advisor to inspect the repo independently; it may reuse cached Orch context.`,
			"Do not spawn or request an orchestrator sub-agent for orchestration. The main Pi agent is already the orchestrator.",
			"Do not silently switch into autonomous mission mode. Full autonomous execution only begins when the user explicitly invokes /mission.",
			`Configured Orch sub-agent models: worker=${config.roles.worker.provider}/${config.roles.worker.model}, validator=${config.roles.validator.provider}/${config.roles.validator.model}, smart_friend=${config.roles.smart_friend.provider}/${config.roles.smart_friend.model}, plan_codebase=${config.roles.plan_codebase.provider}/${config.roles.plan_codebase.model}, plan_researcher=${config.roles.plan_researcher.provider}/${config.roles.plan_researcher.model}.`,
		].join("\n\n");

		return {
			systemPrompt: `${event.systemPrompt}\n\n${interactivePrompt}`,
		};
	});
}

function getInteractiveDelegationOptions(role: DelegateRoleName): {
	toolNames?: string[];
	bashCommandGuard?: (command: string) => boolean;
	bashGuardReason?: string;
} {
	switch (role) {
		case "plan_codebase":
			return {
				toolNames: [...INTERACTIVE_CODEBASE_TOOLS],
			};
		case "plan_researcher":
			return {
				toolNames: [...INTERACTIVE_RESEARCH_TOOLS],
				bashCommandGuard: isInteractiveReadOnlyBashCommand,
				bashGuardReason: INTERACTIVE_RESEARCH_BASH_GUARD_REASON,
			};
		case "worker":
		case "validator":
			return {};
	}
}

function buildInteractiveDelegationPrompt(role: DelegateRoleName, task: string): string {
	switch (role) {
		case "plan_codebase":
			return [
				"Interactive delegation mode: perform broad codebase analysis. This Orch role may reuse cached context, so re-check files when precision matters.",
				"Stay read-only. Use read, grep, find, and ls only. Do not edit files or run shell commands.",
				"Return a concise markdown report with relevant files/modules, current architecture, dependencies/integrations, impact areas, patterns to follow, and risks.",
				"Keep findings evidence-backed and implementation-relevant.",
				"",
				"Task:",
				task,
			].join("\n");
		case "plan_researcher":
			return [
				"Interactive delegation mode: perform documentation, framework, package, SDK, API, or official-docs research. This Orch role may reuse cached context, so re-check sources when precision matters.",
				"Stay read-only. You may inspect repository docs and use only safe read-only/fetch commands for external docs when needed.",
				"Prefer official documentation and cite URLs when external lookup is available. If external lookup is unavailable or blocked, state that limitation clearly.",
				"Return a concise markdown report with relevant documentation, API patterns, caveats, sources/limitations, and implementation implications.",
				"",
				"Task:",
				task,
			].join("\n");
		case "worker":
		case "validator":
			return task;
	}
}

function isInteractiveReadOnlyBashCommand(command: string): boolean {
	const trimmed = command.trim();
	if (trimmed.length === 0) {
		return false;
	}
	if (INTERACTIVE_DESTRUCTIVE_BASH_PATTERNS.some((pattern) => pattern.test(trimmed))) {
		return false;
	}
	return INTERACTIVE_SAFE_BASH_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function createDelegationBuffer(role: OrchRoleName, featureId: string): DelegationBuffer {
	const startedAt = Date.now();
	return {
		role,
		featureId,
		status: "running",
		startedAt,
		elapsedMs: 0,
		edits: 0,
		bashes: 0,
		reads: 0,
		otherTools: 0,
		events: [],
		spinnerIdx: 0,
		verbIdx: 0,
		finalSummary: "",
		finalHandoff: "",
		finalIssues: [],
		finalWarnings: [],
		issueCount: 0,
	};
}

function updateDelegationTiming(buffer: DelegationBuffer): void {
	buffer.elapsedMs = Date.now() - buffer.startedAt;
	buffer.spinnerIdx = Math.floor(Date.now() / SPINNER_FRAME_MS) % 4;
	buffer.verbIdx = Math.floor(buffer.elapsedMs / VERB_ROTATE_MS) % LOADING_VERBS.length;
}

function emitDelegationBufferUpdate(buffer: DelegationBuffer, onUpdate: ((result: { content: Array<{ type: "text"; text: string }>; details: { delegationBuffer: DelegationBuffer } }) => void) | undefined): void {
	if (!onUpdate) {
		return;
	}
	const serialized = JSON.stringify(buffer);
	onUpdate({
		content: [{ type: "text", text: serialized }],
		details: { delegationBuffer: JSON.parse(serialized) as DelegationBuffer },
	});
}

function cloneDelegationBuffer(buffer: DelegationBuffer): DelegationBuffer {
	return JSON.parse(JSON.stringify(buffer)) as DelegationBuffer;
}

function applyDelegationStreamEvent(buffer: DelegationBuffer, event: OrchSubagentStreamEvent): void {
	if (event.type === "status") {
		if (event.status === "aborted") {
			buffer.status = "aborted";
		}
		return;
	}

	if (event.type === "thinking_delta") {
		appendDelegationTextEvent(buffer.events, "thinking", event.delta);
		return;
	}

	if (event.type === "text_delta") {
		appendDelegationTextEvent(buffer.events, "text", event.delta);
		return;
	}

	if (event.type === "tool_call") {
		buffer.events.push({ kind: "tool", label: event.label, detail: event.detail });
		incrementDelegationToolCount(buffer, event.label);
		trimDelegationEvents(buffer.events);
	}
}

function appendDelegationTextEvent(events: DelegationEventKind[], kind: "thinking" | "text", delta: string): void {
	const last = events.at(-1);
	if (last?.kind === kind) {
		last.text = trimDelegationText(`${last.text}${delta}`);
	} else {
		events.push({ kind, text: trimDelegationText(delta) });
		trimDelegationEvents(events);
	}
}

function incrementDelegationToolCount(buffer: DelegationBuffer, label: string): void {
	if (label === "Edit" || label === "Write") {
		buffer.edits++;
		return;
	}
	if (label === "Bash" || label === "Search") {
		buffer.bashes++;
		return;
	}
	if (label === "Read") {
		buffer.reads++;
		return;
	}
	buffer.otherTools++;
}

function trimDelegationText(text: string): string {
	const maxChars = 8000;
	return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

function trimDelegationEvents(events: DelegationEventKind[]): void {
	const maxEvents = 200;
	if (events.length > maxEvents) {
		events.splice(0, events.length - maxEvents);
	}
}

function applyDelegationRunWarnings(buffer: DelegationBuffer, role: DelegateRoleName, toolCalls: number, elapsedMs: number): void {
	if ((role !== "plan_codebase" && role !== "plan_researcher") || toolCalls > 0 || elapsedMs >= FAST_ZERO_TOOL_WARNING_MS) {
		return;
	}

	buffer.finalWarnings.push({
		title: "No inspection tools used",
		details: `The ${role} delegation completed in ${formatElapsed(elapsedMs)} without tool calls. It may have relied on cached context; re-run or ask for explicit file reads if precision matters.`,
	});
}

function applyDelegationFinalOutput(buffer: DelegationBuffer, role: OrchRoleName, output: string): void {
	const trimmedOutput = output.trim();
	const parsed = parseJsonObject(output);
	if (!parsed) {
		buffer.finalSummary = trimmedOutput.length > 0
			? trimmedOutput
			: `Orch ${role} delegation returned no text output.`;
		buffer.finalHandoff = "";
		buffer.finalIssues = [];
		buffer.issueCount = 0;

		if (trimmedOutput.length === 0) {
			buffer.status = "failed";
			if (role === "validator") {
				buffer.finalIssues = [createDelegationIssue(
					"major",
					"No validator output",
					"The validator sub-agent completed without returning review text or structured JSON.",
				)];
				buffer.issueCount = buffer.finalIssues.length;
			}
			return;
		}

		if (role === "validator") {
			buffer.status = "failed";
			buffer.finalIssues = [createDelegationIssue(
				"major",
				"Unstructured validator output",
				"The validator sub-agent returned text, but not the expected strict JSON with passed, summary, issues, and evidence fields.",
			)];
			buffer.issueCount = buffer.finalIssues.length;
			return;
		}

		buffer.status = "done";
		return;
	}

	buffer.finalSummary = asNonEmptyString(parsed.summary) ?? trimmedOutput;
	buffer.finalHandoff = role === "worker" ? asNonEmptyString(parsed.handoff) ?? "" : "";
	buffer.finalIssues = Array.isArray(parsed.issues)
		? parsed.issues.map(normalizeDelegationIssue).filter((issue): issue is DelegationBuffer["finalIssues"][number] => issue !== undefined)
		: [];
	buffer.issueCount = buffer.finalIssues.length;

	if (role === "validator" && typeof parsed.passed !== "boolean") {
		buffer.finalIssues.unshift(createDelegationIssue(
			"major",
			"Missing validator verdict",
			"The validator JSON did not include a boolean passed field.",
		));
		buffer.issueCount = buffer.finalIssues.length;
		buffer.status = "failed";
		return;
	}

	if (role === "validator" && (parsed.passed === false || buffer.issueCount > 0)) {
		buffer.status = "failed";
		return;
	}
	buffer.status = "done";
}

function createDelegationIssue(
	severity: string,
	title: string,
	details: string,
): DelegationBuffer["finalIssues"][number] {
	return { severity, title, details };
}

function normalizeDelegationIssue(value: unknown): DelegationBuffer["finalIssues"][number] | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const title = asNonEmptyString(value.title);
	if (!title) {
		return undefined;
	}
	return {
		severity: asNonEmptyString(value.severity) ?? "issue",
		title,
		details: asNonEmptyString(value.details) ?? asNonEmptyString(value.action) ?? "",
	};
}

function parseJsonObject(output: string): Record<string, unknown> | undefined {
	const trimmed = output.trim();
	if (trimmed.length === 0) {
		return undefined;
	}

	const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	const candidates = [fenceMatch?.[1], trimmed, extractBalancedJson(trimmed)].filter(
		(candidate): candidate is string => candidate !== undefined && candidate.trim().length > 0,
	);
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate);
			return isRecord(parsed) ? parsed : undefined;
		} catch {
			// Try the next representation.
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

function createSmartFriendBuffer(question: string): SmartFriendBuffer {
	const startedAt = Date.now();
	return {
		status: "running",
		startedAt,
		elapsedMs: 0,
		spinnerIdx: 0,
		question,
		assessment: "",
		recommendation: "",
		specificGuidance: [],
		filesToRead: [],
		needsMoreContext: false,
		followUpPrompt: undefined,
		error: "",
	};
}

function updateSmartFriendTiming(buffer: SmartFriendBuffer): void {
	buffer.elapsedMs = Date.now() - buffer.startedAt;
	buffer.spinnerIdx = Math.floor(Date.now() / SPINNER_FRAME_MS) % 4;
}

function emitSmartFriendBufferUpdate(
	buffer: SmartFriendBuffer,
	onUpdate: ((result: { content: Array<{ type: "text"; text: string }>; details: { smartFriendBuffer: SmartFriendBuffer } }) => void) | undefined,
): void {
	if (!onUpdate) {
		return;
	}
	const serialized = JSON.stringify(buffer);
	onUpdate({
		content: [{ type: "text", text: serialized }],
		details: { smartFriendBuffer: JSON.parse(serialized) as SmartFriendBuffer },
	});
}

function cloneSmartFriendBuffer(buffer: SmartFriendBuffer): SmartFriendBuffer {
	return JSON.parse(JSON.stringify(buffer)) as SmartFriendBuffer;
}

function applySmartFriendFinalOutput(buffer: SmartFriendBuffer, output: string): void {
	const parsed = parseJsonObject(output);
	if (!parsed) {
		throw new Error("Smart friend returned invalid JSON.");
	}

	buffer.assessment = asNonEmptyString(parsed.assessment) ?? "";
	buffer.recommendation = asNonEmptyString(parsed.recommendation) ?? "";
	buffer.specificGuidance = asStringArray(parsed.specificGuidance);
	buffer.filesToRead = asStringArray(parsed.filesToRead);
	buffer.needsMoreContext = parsed.needsMoreContext === true;
	buffer.followUpPrompt = parsed.followUpPrompt === null ? undefined : asNonEmptyString(parsed.followUpPrompt);
	buffer.status = "done";
}

function buildSmartFriendPrompt(
	question: string,
	context: string,
	relevantFiles: string[] | undefined,
	state: OrchRuntimeState,
): string {
	const lines = [
		"You are being consulted by Orch's main orchestrator.",
		"Investigate the repository yourself and return strict JSON only.",
		"Question:",
		question.trim(),
		"Context:",
		context.trim(),
		"Relevant files (hints only — read what you need, do not trust summaries):",
		...(relevantFiles && relevantFiles.length > 0 ? relevantFiles.map((file) => `- ${file}`) : ["- none provided"]),
	];

	const missionLines = buildSmartFriendMissionContext(state);
	if (missionLines.length > 0) {
		lines.push(...missionLines);
	}

	return lines.join("\n");
}

function buildSmartFriendMissionContext(state: OrchRuntimeState): string[] {
	const activeMission = state.activeMission;
	if (!activeMission) {
		return [];
	}

	const lines = [
		"Active mission context:",
		`- Mission id: ${activeMission.id}`,
		`- Goal: ${activeMission.goal}`,
		`- Phase: ${activeMission.phase}`,
	];

	if (activeMission.stateDir) {
		lines.push(`- Mission state directory: ${activeMission.stateDir}`);
		lines.push(`- Plan file: ${activeMission.stateDir}/plan.json`);
		lines.push(`- Features file: ${activeMission.stateDir}/features.json`);
		lines.push(`- Validation contract file: ${activeMission.stateDir}/validation-contract.md`);
		lines.push(`- Knowledge base file: ${activeMission.stateDir}/knowledge-base.md`);
		lines.push(`- Guidelines file: ${activeMission.stateDir}/guidelines.md`);
	}
	if (activeMission.stateFilePath) {
		lines.push(`- Runtime state file: ${activeMission.stateFilePath}`);
	}

	return lines;
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map((entry) => asNonEmptyString(entry))
		.filter((entry): entry is string => entry !== undefined);
}

function formatDelegationError(error: unknown): string {
	if (error instanceof Error && error.message.length > 0) {
		return error.message;
	}
	return String(error);
}

function deriveDelegationFeatureId(task: string): string {
	const firstLine = task
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!firstLine) {
		return "task";
	}
	const normalized = firstLine
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return normalized.length > 0 ? normalized : firstLine.slice(0, 48);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
