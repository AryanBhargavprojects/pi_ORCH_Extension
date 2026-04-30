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

export function registerInteractiveOrch(pi: ExtensionAPI, state: OrchRuntimeState): void {
	pi.registerTool({
		name: ORCH_TOOL_NAMES.delegate,
		label: "Orch Delegate",
		description: "Run a fresh Orch sub-agent with the configured worker or validator model.",
		promptSnippet: "Delegate focused implementation or validation work to a fresh Orch role session.",
		promptGuidelines: [
			"Use orch_delegate when you need a fresh Orch worker or validator with isolated context.",
			"Do not delegate orchestration through orch_delegate; the main chat agent remains the orchestrator in interactive mode.",
			"When delegating, include the relevant file paths, constraints, and expected output in the task itself because the sub-agent starts fresh.",
		],
		parameters: Type.Object({
			role: StringEnum(["worker", "validator"] as const, {
				description: "Which Orch role to run in a fresh context",
			}),
			task: Type.String({ description: "Self-contained task for the selected Orch role" }),
			featureId: Type.Optional(Type.String({ description: "Optional short feature/task id for the inline delegate header" })),
		}),
		renderShell: "self",
		renderCall: renderDelegateCall,
		renderResult: renderDelegateResult,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			state.configState = await loadOrchConfig(ctx.cwd);
			const role = params.role as OrchRoleName;
			const buffer = createDelegationBuffer(role, params.featureId ?? deriveDelegationFeatureId(params.task));
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
					prompt: params.task,
					cwd: ctx.cwd,
					configState: state.configState,
					modelRegistry: ctx.modelRegistry,
					signal,
					onStreamEvent: (event) => {
						applyDelegationStreamEvent(buffer, event);
						updateDelegationTiming(buffer);
						emitUpdate();
					},
				});

				applyDelegationFinalOutput(buffer, role, result.output);
				updateDelegationTiming(buffer);
				emitUpdate();

				const summary = [`Orch ${result.role}`, `${result.provider}/${result.modelId}`].join(" • ");

				return {
					content: [
						{
							type: "text",
							text: result.output.length > 0 ? result.output : `${summary} completed with no text output.`,
						},
					],
					details: {
						delegationBuffer: cloneDelegationBuffer(buffer),
						role: result.role,
						provider: result.provider,
						modelId: result.modelId,
						usage: result.usage,
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
		description: "Ask Orch's read-only advisor for a second opinion when the orchestrator is stuck.",
		promptSnippet: "Consult a fresh read-only Orch advisor for concrete guidance on a hard problem.",
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
			"You are operating as Orch's default interactive orchestrator.",
			"Stay conversational and keep the user in the loop.",
			"Use built-in tools directly for simple inspection or straightforward edits when that is the fastest path.",
			`Use ${ORCH_TOOL_NAMES.delegate} when a task benefits from fresh isolated context, or when you want a separate worker or validator pass.`,
			`Use ${ORCH_TOOL_NAMES.smartFriend} when you are genuinely stuck and need a fresh read-only advisor to inspect the repo independently.`,
			"Do not silently switch into autonomous mission mode. Full autonomous execution only begins when the user explicitly invokes /mission.",
			`Configured Orch role models: orchestrator=${config.roles.orchestrator.provider}/${config.roles.orchestrator.model}, worker=${config.roles.worker.provider}/${config.roles.worker.model}, validator=${config.roles.validator.provider}/${config.roles.validator.model}, smart_friend=${config.roles.smart_friend.provider}/${config.roles.smart_friend.model}.`,
		].join("\n\n");

		return {
			systemPrompt: `${event.systemPrompt}\n\n${interactivePrompt}`,
		};
	});
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

function applyDelegationFinalOutput(buffer: DelegationBuffer, role: OrchRoleName, output: string): void {
	const parsed = parseJsonObject(output);
	if (!parsed) {
		buffer.finalSummary = output.trim();
		buffer.status = "done";
		return;
	}

	buffer.finalSummary = asNonEmptyString(parsed.summary) ?? output.trim();
	buffer.finalHandoff = role === "worker" ? asNonEmptyString(parsed.handoff) ?? "" : "";
	buffer.finalIssues = Array.isArray(parsed.issues)
		? parsed.issues.map(normalizeDelegationIssue).filter((issue): issue is DelegationBuffer["finalIssues"][number] => issue !== undefined)
		: [];
	buffer.issueCount = buffer.finalIssues.length;

	if (role === "validator" && (parsed.passed === false || buffer.issueCount > 0)) {
		buffer.status = "failed";
		return;
	}
	buffer.status = "done";
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
