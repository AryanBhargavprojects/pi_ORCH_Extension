import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type {
	BashToolDetails,
	BashToolInput,
	EditToolDetails,
	EditToolInput,
	ExtensionAPI,
	ExtensionContext,
	FindToolDetails,
	FindToolInput,
	GrepToolDetails,
	GrepToolInput,
	LsToolDetails,
	LsToolInput,
	ReadToolDetails,
	ReadToolInput,
	WriteToolInput,
} from "@mariozechner/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@mariozechner/pi-tui";

import { GLYPHS } from "./constants.js";
import { formatElapsed, LOADING_VERBS } from "./loading.js";
import type { DelegationBuffer, DelegationEventKind } from "./mission-types.js";

type OrchTheme = ExtensionContext["ui"]["theme"];

export type SmartFriendBufferStatus = "running" | "done" | "failed" | "aborted";

export type SmartFriendBuffer = {
	status: SmartFriendBufferStatus;
	startedAt: number;
	elapsedMs: number;
	spinnerIdx: number;
	question: string;
	assessment: string;
	recommendation: string;
	specificGuidance: string[];
	filesToRead: string[];
	needsMoreContext: boolean;
	followUpPrompt?: string;
	error?: string;
};

type ToolContentBlock = TextContent | ImageContent;

type BuiltInTools = {
	read: ReturnType<typeof createReadToolDefinition>;
	bash: ReturnType<typeof createBashToolDefinition>;
	edit: ReturnType<typeof createEditToolDefinition>;
	write: ReturnType<typeof createWriteToolDefinition>;
	find: ReturnType<typeof createFindToolDefinition>;
	grep: ReturnType<typeof createGrepToolDefinition>;
	ls: ReturnType<typeof createLsToolDefinition>;
};

const toolCache = new Map<string, BuiltInTools>();
const EXPAND_HINT = "ctrl+o to expand";
const WATERFALL_PREFIX = `  ${GLYPHS.toolOut}  `;

export function registerCompactToolRenderers(pi: ExtensionAPI): void {
	registerReadRenderer(pi);
	registerBashRenderer(pi);
	registerEditRenderer(pi);
	registerWriteRenderer(pi);
	registerFindRenderer(pi);
	registerGrepRenderer(pi);
	registerLsRenderer(pi);
}

export function renderDelegateCall(args: unknown, theme: OrchTheme, context?: { state?: Record<string, unknown> }): Component {
	return new DelegateCallComponent(args, theme, asDelegationBuffer(context?.state?.delegationBuffer));
}

export function renderDelegateResult(
	result: { content?: ToolContentBlock[]; details?: unknown },
	options: { expanded?: boolean },
	theme: OrchTheme,
	context?: { state?: Record<string, unknown> },
): Component {
	const buffer = getDelegationBufferFromResult(result);
	if (buffer && context?.state) {
		context.state.delegationBuffer = buffer;
	}
	return new DelegateResultComponent(buffer, options.expanded === true, theme);
}

export function renderSmartFriendCall(
	args: unknown,
	theme: OrchTheme,
	context?: { state?: Record<string, unknown> },
): Component {
	return new SmartFriendCallComponent(args, theme, asSmartFriendBuffer(context?.state?.smartFriendBuffer));
}

export function renderSmartFriendResult(
	result: { content?: ToolContentBlock[]; details?: unknown },
	options: { expanded?: boolean },
	theme: OrchTheme,
	context?: { state?: Record<string, unknown> },
): Component {
	const buffer = getSmartFriendBufferFromResult(result);
	if (buffer && context?.state) {
		context.state.smartFriendBuffer = buffer;
	}
	return new SmartFriendResultComponent(buffer, options.expanded === true, theme);
}

function registerReadRenderer(pi: ExtensionAPI): void {
	const original = getBuiltInTools(process.cwd()).read;
	pi.registerTool({
		name: "read",
		label: "read",
		description: original.description,
		parameters: original.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).read.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			return new Text(formatReadCall(args, context.cwd, theme), 0, 0);
		},
		renderResult(result, options, theme) {
			return new Text(formatReadResult(result.content, result.details, options.expanded, theme), 0, 0);
		},
	});
}

function registerBashRenderer(pi: ExtensionAPI): void {
	const original = getBuiltInTools(process.cwd()).bash;
	pi.registerTool({
		name: "bash",
		label: "bash",
		description: original.description,
		parameters: original.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).bash.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme) {
			return new Text(formatBashCall(args, theme), 0, 0);
		},
		renderResult(result, options, theme, context) {
			return new Text(
				formatBashResult(result.content, result.details, options.expanded, theme, context.isError),
				0,
				0,
			);
		},
	});
}

function registerEditRenderer(pi: ExtensionAPI): void {
	const original = getBuiltInTools(process.cwd()).edit;
	pi.registerTool({
		name: "edit",
		label: "edit",
		description: original.description,
		parameters: original.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).edit.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			return new Text(formatEditCall(args, context.cwd, theme), 0, 0);
		},
		renderResult(result, options, theme, context) {
			return new Text(
				formatEditResult(context.args, result.content, result.details, options.expanded, theme, context.isError),
				0,
				0,
			);
		},
	});
}

function registerWriteRenderer(pi: ExtensionAPI): void {
	const original = getBuiltInTools(process.cwd()).write;
	pi.registerTool({
		name: "write",
		label: "write",
		description: original.description,
		parameters: original.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).write.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			return new Text(formatWriteCall(args, context.cwd, theme), 0, 0);
		},
		renderResult(result, options, theme, context) {
			return new Text(formatWriteResult(context.args, result.content, options.expanded, theme, context.isError), 0, 0);
		},
	});
}

function registerFindRenderer(pi: ExtensionAPI): void {
	const original = getBuiltInTools(process.cwd()).find;
	pi.registerTool({
		name: "find",
		label: "find",
		description: original.description,
		parameters: original.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).find.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			return new Text(formatFindCall(args, context.cwd, theme), 0, 0);
		},
		renderResult(result, options, theme) {
			return new Text(formatFindResult(result.content, result.details, options.expanded, theme), 0, 0);
		},
	});
}

function registerGrepRenderer(pi: ExtensionAPI): void {
	const original = getBuiltInTools(process.cwd()).grep;
	pi.registerTool({
		name: "grep",
		label: "grep",
		description: original.description,
		parameters: original.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).grep.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			return new Text(formatGrepCall(args, context.cwd, theme), 0, 0);
		},
		renderResult(result, options, theme) {
			return new Text(formatGrepResult(result.content, result.details, options.expanded, theme), 0, 0);
		},
	});
}

function registerLsRenderer(pi: ExtensionAPI): void {
	const original = getBuiltInTools(process.cwd()).ls;
	pi.registerTool({
		name: "ls",
		label: "ls",
		description: original.description,
		parameters: original.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).ls.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			return new Text(formatLsCall(args, context.cwd, theme), 0, 0);
		},
		renderResult(result, options, theme) {
			return new Text(formatLsResult(result.content, result.details, options.expanded, theme), 0, 0);
		},
	});
}

function getBuiltInTools(cwd: string): BuiltInTools {
	let tools = toolCache.get(cwd);
	if (!tools) {
		tools = {
			read: createReadToolDefinition(cwd),
			bash: createBashToolDefinition(cwd),
			edit: createEditToolDefinition(cwd),
			write: createWriteToolDefinition(cwd),
			find: createFindToolDefinition(cwd),
			grep: createGrepToolDefinition(cwd),
			ls: createLsToolDefinition(cwd),
		};
		toolCache.set(cwd, tools);
	}
	return tools;
}

class DelegateCallComponent implements Component {
	constructor(
		private readonly args: unknown,
		private readonly theme: OrchTheme,
		private readonly buffer: DelegationBuffer | undefined,
	) {}

	render(width: number): string[] {
		const input = asPlainRecord(this.args);
		const role = String(input?.role ?? this.buffer?.role ?? "agent");
		const featureId = this.buffer?.featureId ?? inferDelegationFeatureId(input);
		const header = [
			this.theme.fg("toolTitle", this.theme.bold("Delegate  ")),
			this.theme.fg("accent", `${role} → ${featureId}`),
			this.buffer ? `  ${renderDelegationBadge(this.buffer, this.theme)}` : "",
		].join("");
		return [truncateToWidth(header, width, this.theme.fg("dim", GLYPHS.ellipsis))];
	}

	invalidate(): void {
		// Stateless.
	}
}

class DelegateResultComponent implements Component {
	constructor(
		private readonly buffer: DelegationBuffer | undefined,
		private readonly expanded: boolean,
		private readonly theme: OrchTheme,
	) {}

	render(width: number): string[] {
		const lines = this.buffer
			? renderDelegationBuffer(this.buffer, this.expanded, this.theme, width)
			: [buildSummaryLine(this.theme, this.theme.fg("success", "Completed"), this.expanded)];
		return lines.map((line) => truncateToWidth(line, width, this.theme.fg("dim", GLYPHS.ellipsis)));
	}

	invalidate(): void {
		// Stateless.
	}
}

class SmartFriendCallComponent implements Component {
	constructor(
		private readonly args: unknown,
		private readonly theme: OrchTheme,
		private readonly buffer: SmartFriendBuffer | undefined,
	) {}

	render(width: number): string[] {
		const input = asPlainRecord(this.args);
		const question = typeof input?.question === "string" && input.question.trim().length > 0
			? input.question.trim()
			: this.buffer?.question ?? "question";
		const header = [
			this.theme.fg("toolTitle", this.theme.bold("Smart Friend  ")),
			this.theme.fg("dim", question),
		].join("");
		return [truncateToWidth(header, width, this.theme.fg("dim", GLYPHS.ellipsis))];
	}

	invalidate(): void {
		// Stateless.
	}
}

class SmartFriendResultComponent implements Component {
	constructor(
		private readonly buffer: SmartFriendBuffer | undefined,
		private readonly expanded: boolean,
		private readonly theme: OrchTheme,
	) {}

	render(width: number): string[] {
		const lines = this.buffer
			? renderSmartFriendBuffer(this.buffer, this.expanded, this.theme, width)
			: [buildSummaryLine(this.theme, this.theme.fg("success", "Guidance ready"), this.expanded)];
		return lines.map((line) => truncateToWidth(line, width, this.theme.fg("dim", GLYPHS.ellipsis)));
	}

	invalidate(): void {
		// Stateless.
	}
}

function getDelegationBufferFromResult(result: { content?: ToolContentBlock[]; details?: unknown }): DelegationBuffer | undefined {
	const details = asPlainRecord(result.details);
	const fromDetails = asDelegationBuffer(details?.delegationBuffer) ?? asDelegationBuffer(result.details);
	if (fromDetails) {
		return fromDetails;
	}

	const raw = result.content ? getTextContent(result.content) : undefined;
	if (!raw) {
		return undefined;
	}
	try {
		return asDelegationBuffer(JSON.parse(raw));
	} catch {
		return undefined;
	}
}

function getSmartFriendBufferFromResult(result: { content?: ToolContentBlock[]; details?: unknown }): SmartFriendBuffer | undefined {
	const details = asPlainRecord(result.details);
	const fromDetails = asSmartFriendBuffer(details?.smartFriendBuffer) ?? asSmartFriendBuffer(result.details);
	if (fromDetails) {
		return fromDetails;
	}

	const raw = result.content ? getTextContent(result.content) : undefined;
	if (!raw) {
		return undefined;
	}
	try {
		return asSmartFriendBuffer(JSON.parse(raw));
	} catch {
		return undefined;
	}
}

function renderDelegationBuffer(
	buffer: DelegationBuffer,
	expanded: boolean,
	theme: OrchTheme,
	width: number,
): string[] {
	if (!expanded) {
		return renderCollapsedDelegationBuffer(buffer, theme, width);
	}
	return renderExpandedDelegationBuffer(buffer, theme, width);
}

function renderSmartFriendBuffer(
	buffer: SmartFriendBuffer,
	expanded: boolean,
	theme: OrchTheme,
	width: number,
): string[] {
	const lines = expanded
		? renderExpandedSmartFriendBuffer(buffer, theme)
		: renderCollapsedSmartFriendBuffer(buffer, theme);
	return lines.map((line) => truncateToWidth(line, width, theme.fg("dim", GLYPHS.ellipsis)));
}

function renderDelegationBadge(buffer: DelegationBuffer, theme: OrchTheme): string {
	if (buffer.status === "running") {
		return theme.fg("accent", `${GLYPHS.inProgress} running`);
	}
	if (buffer.status === "done") {
		return theme.fg("success", `${GLYPHS.pass} done`);
	}
	if (buffer.status === "failed") {
		const issueLabel = buffer.issueCount > 0 ? `  ${buffer.issueCount} ${buffer.issueCount === 1 ? "issue" : "issues"}` : "";
		return theme.fg("error", `${GLYPHS.fail} failed${issueLabel}`);
	}
	return theme.fg("error", `${GLYPHS.fail} aborted`);
}

function renderCollapsedDelegationBuffer(buffer: DelegationBuffer, theme: OrchTheme, width: number): string[] {
	if (buffer.status === "running") {
		const frame = GLYPHS.spinner[buffer.spinnerIdx % GLYPHS.spinner.length] ?? GLYPHS.spinner[0];
		const verb = LOADING_VERBS[buffer.verbIdx % LOADING_VERBS.length]?.[0] ?? "Thinking";
		return [
			buildSummaryLine(
				theme,
				[
					theme.fg("accent", `${frame} `),
					theme.fg("muted", `${verb}${GLYPHS.ellipsis}  `),
					theme.fg("dim", formatElapsed(buffer.elapsedMs)),
				].join(""),
				false,
			),
		];
	}

	if (buffer.status === "failed" && buffer.issueCount > 0) {
		const issueLines = buffer.finalIssues.slice(0, 3).map((issue) =>
			`${getWaterfallPrefix(theme)}${theme.fg("error", `${GLYPHS.fail} ${issue.title}`)}${theme.fg("dim", ` (${issue.severity})`)}`,
		);
		if (buffer.finalIssues.length > 3) {
			issueLines.push(
				`${getWaterfallPrefix(theme)}${theme.fg("dim", `${GLYPHS.ellipsis} ${buffer.finalIssues.length - 3} more  (${EXPAND_HINT})`)}`,
			);
		} else if (issueLines.length > 0) {
			issueLines[issueLines.length - 1] += theme.fg("dim", `  (${EXPAND_HINT})`);
		}
		return issueLines.map((line) => truncateToWidth(line, width, theme.fg("dim", GLYPHS.ellipsis)));
	}

	if (buffer.status === "aborted") {
		return [buildSummaryLine(theme, theme.fg("error", `Interrupted after ${formatElapsed(buffer.elapsedMs)}`), false)];
	}

	if (buffer.status === "failed") {
		return [buildSummaryLine(theme, theme.fg("error", buffer.finalSummary || "Delegate failed"), false)];
	}

	const warnings = getDelegationWarnings(buffer);
	if (warnings.length > 0) {
		return [buildSummaryLine(theme, theme.fg("warning", `! warning: ${warnings[0]?.title ?? "check delegation"}`), false)];
	}

	const parts = buildDelegationCountParts(buffer);
	return [buildSummaryLine(theme, theme.fg("muted", parts.length > 0 ? parts.join(" • ") : "no tool calls"), false)];
}

function renderExpandedDelegationBuffer(buffer: DelegationBuffer, theme: OrchTheme, width: number): string[] {
	const lines: string[] = [];
	const waterfallPrefix = getWaterfallPrefix(theme);

	for (const event of buffer.events) {
		lines.push(...renderDelegationEvent(event, theme, waterfallPrefix));
	}

	if (buffer.status === "running" && lines.length === 0) {
		const frame = GLYPHS.spinner[buffer.spinnerIdx % GLYPHS.spinner.length] ?? GLYPHS.spinner[0];
		const verb = LOADING_VERBS[buffer.verbIdx % LOADING_VERBS.length]?.[0] ?? "Thinking";
		lines.push(`${waterfallPrefix}${theme.fg("accent", `${frame} `)}${theme.fg("muted", `${verb}${GLYPHS.ellipsis}`)} ${theme.fg("dim", formatElapsed(buffer.elapsedMs))}`);
	}

	if (lines.length > 0 && buffer.status !== "running") {
		lines.push(waterfallPrefix);
	}

	if (buffer.status === "done" || buffer.status === "failed") {
		if (buffer.finalSummary) {
			const summaryLines = buffer.finalSummary.replace(/\r/g, "").split("\n").filter((line) => line.trim().length > 0);
			for (let index = 0; index < summaryLines.length; index++) {
				const label = index === 0 ? "Summary: " : "  ";
				lines.push(`${waterfallPrefix}${theme.fg("muted", `${label}${summaryLines[index]}`)}`);
			}
		}
		if (buffer.finalHandoff) {
			lines.push(waterfallPrefix);
			const handoffLines = buffer.finalHandoff.replace(/\r/g, "").split("\n").filter((line) => line.trim().length > 0);
			for (let index = 0; index < handoffLines.length; index++) {
				const label = index === 0 ? "Handoff: " : "  ";
				lines.push(`${waterfallPrefix}${theme.fg("dim", `${label}${handoffLines[index]}`)}`);
			}
		}
		const warnings = getDelegationWarnings(buffer);
		if (warnings.length > 0) {
			for (const warning of warnings) {
				lines.push(`${waterfallPrefix}${theme.fg("warning", `! ${warning.title}`)}`);
				for (const line of warning.details.replace(/\r/g, "").split("\n")) {
					if (line.trim().length > 0) {
						lines.push(`${waterfallPrefix}${theme.fg("dim", `  ${line}`)}`);
					}
				}
			}
		}
		if (buffer.finalIssues.length > 0) {
			for (const issue of buffer.finalIssues) {
				lines.push(`${waterfallPrefix}${theme.fg("error", `${GLYPHS.fail} ${issue.title}`)}${theme.fg("dim", ` (${issue.severity})`)}`);
				for (const line of issue.details.replace(/\r/g, "").split("\n")) {
					if (line.trim().length > 0) {
						lines.push(`${waterfallPrefix}${theme.fg("dim", `  ${line}`)}`);
					}
				}
			}
		}
	} else if (buffer.status === "aborted") {
		lines.push(`${waterfallPrefix}${theme.fg("error", `Interrupted after ${formatElapsed(buffer.elapsedMs)}`)}`);
	}

	const rendered = lines.length > 0 ? lines : [buildSummaryLine(theme, theme.fg("muted", "no delegate activity yet"), true)];
	return rendered.map((line) => truncateToWidth(line, width, theme.fg("dim", GLYPHS.ellipsis)));
}

function renderDelegationEvent(event: DelegationEventKind, theme: OrchTheme, waterfallPrefix: string): string[] {
	if (event.kind === "thinking") {
		const snippet = event.text.trim().slice(-120).replace(/\n+/g, " ");
		return snippet.length > 0 ? [`${waterfallPrefix}${theme.fg("dim", `${GLYPHS.spinner[0]} ${snippet}`)}`] : [];
	}

	if (event.kind === "text") {
		const paragraphs = event.text.trim().split(/\n{2,}/);
		const lastParagraph = (paragraphs.at(-1) ?? "").trim();
		return lastParagraph
			.replace(/\r/g, "")
			.split("\n")
			.slice(-3)
			.filter((line) => line.trim().length > 0)
			.map((line) => `${waterfallPrefix}${theme.fg("toolOutput", line)}`);
	}

	return [
		`${waterfallPrefix}${theme.fg("toolTitle", theme.bold(`${event.label}  `))}${theme.fg("accent", event.detail)}`,
	];
}

function getDelegationWarnings(buffer: DelegationBuffer): Array<{ title: string; details: string }> {
	return Array.isArray(buffer.finalWarnings) ? buffer.finalWarnings : [];
}

function buildDelegationCountParts(buffer: DelegationBuffer): string[] {
	const parts: string[] = [];
	if (buffer.edits > 0) {
		parts.push(`${buffer.edits} ${buffer.edits === 1 ? "edit" : "edits"}`);
	}
	if (buffer.bashes > 0) {
		parts.push(`${buffer.bashes} bash ${buffer.bashes === 1 ? "run" : "runs"}`);
	}
	if (buffer.reads > 0) {
		parts.push(`${buffer.reads} ${buffer.reads === 1 ? "read" : "reads"}`);
	}
	if (buffer.otherTools > 0) {
		parts.push(`${buffer.otherTools} other`);
	}
	return parts;
}

function inferDelegationFeatureId(input: Record<string, unknown> | undefined): string {
	const explicit = input?.featureId ?? input?.feature;
	if (typeof explicit === "string" && explicit.trim().length > 0) {
		return explicit.trim();
	}
	const task = typeof input?.task === "string" ? input.task : "";
	const firstLine = task
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	return firstLine ? truncatePlainText(firstLine, 48) : "task";
}

function asDelegationBuffer(value: unknown): DelegationBuffer | undefined {
	const record = asPlainRecord(value);
	if (!record) {
		return undefined;
	}
	const status = record.status;
	const role = record.role;
	if (
		(role !== "orchestrator" && role !== "worker" && role !== "validator" && role !== "smart_friend" && role !== "plan_clarifier" && role !== "plan_codebase" && role !== "plan_researcher" && role !== "plan_feasibility" && role !== "plan_synthesizer") ||
		(status !== "running" && status !== "done" && status !== "failed" && status !== "aborted") ||
		!Array.isArray(record.events)
	) {
		return undefined;
	}
	return record as DelegationBuffer;
}

function renderCollapsedSmartFriendBuffer(buffer: SmartFriendBuffer, theme: OrchTheme): string[] {
	if (buffer.status === "running") {
		const frame = GLYPHS.spinner[buffer.spinnerIdx % GLYPHS.spinner.length] ?? GLYPHS.spinner[0];
		return [
			buildSummaryLine(
				theme,
				[
					theme.fg("accent", `${frame} `),
					theme.fg("muted", `Consulting${GLYPHS.ellipsis}  `),
					theme.fg("dim", formatElapsed(buffer.elapsedMs)),
				].join(""),
				false,
			),
		];
	}

	if (buffer.status === "aborted") {
		return [buildSummaryLine(theme, theme.fg("error", `Interrupted after ${formatElapsed(buffer.elapsedMs)}`), false)];
	}

	if (buffer.status === "failed") {
		return [buildSummaryLine(theme, theme.fg("error", buffer.error || "Smart friend failed"), false)];
	}

	if (buffer.needsMoreContext) {
		const count = buffer.filesToRead.length;
		return [
			buildSummaryLine(
				theme,
				theme.fg("accent", `${GLYPHS.inProgress} More context needed — read ${count} ${pluralize(count, "file")}`),
				false,
			),
		];
	}

	return [
		buildSummaryLine(
			theme,
			theme.fg("success", `${GLYPHS.pass} Guidance ready — ${buffer.specificGuidance.length} ${pluralize(buffer.specificGuidance.length, "step")}`),
			false,
		),
	];
}

function renderExpandedSmartFriendBuffer(buffer: SmartFriendBuffer, theme: OrchTheme): string[] {
	const waterfallPrefix = getWaterfallPrefix(theme);
	const lines: string[] = [];

	if (buffer.status === "running") {
		const frame = GLYPHS.spinner[buffer.spinnerIdx % GLYPHS.spinner.length] ?? GLYPHS.spinner[0];
		return [`${waterfallPrefix}${theme.fg("accent", `${frame} `)}${theme.fg("muted", `Consulting${GLYPHS.ellipsis}`)} ${theme.fg("dim", formatElapsed(buffer.elapsedMs))}`];
	}

	if (buffer.assessment) {
		lines.push(...formatSmartFriendSection("Assessment: ", buffer.assessment, theme));
	}
	if (buffer.assessment && (buffer.recommendation || buffer.specificGuidance.length > 0 || buffer.filesToRead.length > 0 || buffer.followUpPrompt || buffer.error)) {
		lines.push(waterfallPrefix);
	}
	if (buffer.recommendation) {
		lines.push(...formatSmartFriendSection("Recommendation: ", buffer.recommendation, theme));
	}
	if (buffer.recommendation && (buffer.specificGuidance.length > 0 || buffer.filesToRead.length > 0 || buffer.followUpPrompt || buffer.error)) {
		lines.push(waterfallPrefix);
	}
	if (buffer.specificGuidance.length > 0) {
		lines.push(`${waterfallPrefix}${theme.fg("muted", "Guidance:")}`);
		for (const [index, step] of buffer.specificGuidance.entries()) {
			lines.push(...formatSmartFriendSection(`  ${index + 1}. `, step, theme));
		}
	}
	if (buffer.filesToRead.length > 0) {
		if (lines.length > 0) {
			lines.push(waterfallPrefix);
		}
		lines.push(`${waterfallPrefix}${theme.fg("muted", "Files to read:")}`);
		for (const file of buffer.filesToRead) {
			lines.push(`${waterfallPrefix}${theme.fg("accent", `  - ${file}`)}`);
		}
	}
	if (buffer.followUpPrompt) {
		if (lines.length > 0) {
			lines.push(waterfallPrefix);
		}
		lines.push(...formatSmartFriendSection("Follow-up prompt: ", buffer.followUpPrompt, theme));
	}
	if (buffer.error) {
		if (lines.length > 0) {
			lines.push(waterfallPrefix);
		}
		lines.push(`${waterfallPrefix}${theme.fg("error", buffer.error)}`);
	}
	if (buffer.status === "aborted" && !buffer.error) {
		if (lines.length > 0) {
			lines.push(waterfallPrefix);
		}
		lines.push(`${waterfallPrefix}${theme.fg("error", `Interrupted after ${formatElapsed(buffer.elapsedMs)}`)}`);
	}

	return lines.length > 0 ? lines : [buildSummaryLine(theme, theme.fg("muted", "no smart friend guidance yet"), true)];
}

function formatSmartFriendSection(label: string, text: string, theme: OrchTheme): string[] {
	const normalizedLines = text.replace(/\r/g, "").split("\n").filter((line) => line.trim().length > 0);
	if (normalizedLines.length === 0) {
		return [];
	}
	const waterfallPrefix = getWaterfallPrefix(theme);
	return normalizedLines.map((line, index) => `${waterfallPrefix}${theme.fg(index === 0 ? "muted" : "dim", `${index === 0 ? label : "  "}${line.trim()}`)}`);
}

function asSmartFriendBuffer(value: unknown): SmartFriendBuffer | undefined {
	const record = asPlainRecord(value);
	if (!record) {
		return undefined;
	}
	const status = record.status;
	if (status !== "running" && status !== "done" && status !== "failed" && status !== "aborted") {
		return undefined;
	}
	if (!Array.isArray(record.specificGuidance) || !Array.isArray(record.filesToRead)) {
		return undefined;
	}
	return record as SmartFriendBuffer;
}

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function formatReadCall(args: ReadToolInput, cwd: string, theme: OrchTheme): string {
	const path = formatPathForDisplay(args.path, cwd);
	const range = formatReadRange(args.offset, args.limit);
	return [theme.fg("toolTitle", theme.bold("Read ")), theme.fg("accent", `${path}${range}`)].join("");
}

function formatReadResult(
	content: ToolContentBlock[],
	details: ReadToolDetails | undefined,
	expanded: boolean,
	theme: OrchTheme,
): string {
	const textContent = getTextContent(content);
	if (!textContent) {
		return `${theme.fg("dim", WATERFALL_PREFIX)}${theme.fg("success", "Loaded image")}`;
	}

	const totalLines = details?.truncation?.totalLines ?? countLines(textContent);
	const summaryParts = [theme.fg("success", `${totalLines} ${pluralize(totalLines, "line")}`)];
	if (details?.truncation?.truncated) {
		summaryParts.push(theme.fg("warning", " [truncated]"));
	}
	const summary = buildSummaryLine(theme, summaryParts.join(""), expanded);
	if (!expanded) {
		return summary;
	}

	return [summary, formatExpandedBlock(textContent, theme)].join("\n");
}

function formatBashCall(args: BashToolInput, theme: OrchTheme): string {
	return [
		theme.fg("toolTitle", theme.bold(`${describeBashCommand(args.command)} `)),
		theme.fg("accent", truncatePlainText(args.command, 100)),
		args.timeout ? theme.fg("dim", ` (${args.timeout}s timeout)`) : "",
	].join("");
}

function formatBashResult(
	content: ToolContentBlock[],
	details: BashToolDetails | undefined,
	expanded: boolean,
	theme: OrchTheme,
	isError: boolean,
): string {
	const output = getTextContent(content);
	if (!output) {
		return buildSummaryLine(theme, theme.fg(isError ? "error" : "success", isError ? "Command failed" : "Done"), expanded);
	}
	if (output.trim() === "(no output)") {
		return buildSummaryLine(theme, theme.fg(isError ? "error" : "success", isError ? "Command failed" : "No output"), expanded);
	}

	const summary = buildSummaryLine(
		theme,
		[
			theme.fg(isError ? "error" : "success", `${countMeaningfulLines(output)} ${pluralize(countMeaningfulLines(output), "line")}`),
			details?.truncation?.truncated ? theme.fg("warning", " [truncated]") : "",
		].join(""),
		expanded,
	);
	if (!expanded) {
		return summary;
	}

	return [summary, formatExpandedBlock(output, theme)].join("\n");
}

function formatEditCall(args: EditToolInput, cwd: string, theme: OrchTheme): string {
	return [theme.fg("toolTitle", theme.bold("Edit ")), theme.fg("accent", formatPathForDisplay(args.path, cwd))].join("");
}

function formatEditResult(
	args: EditToolInput,
	content: ToolContentBlock[],
	details: EditToolDetails | undefined,
	expanded: boolean,
	theme: OrchTheme,
	isError: boolean,
): string {
	const textContent = getTextContent(content);
	if (isError) {
		const firstLine = getFirstMeaningfulLine(textContent) ?? "Edit failed";
		const summary = buildSummaryLine(theme, theme.fg("error", firstLine), expanded);
		if (!expanded || !textContent) {
			return summary;
		}
		return [summary, formatExpandedBlock(textContent, theme)].join("\n");
	}

	const diff = details?.diff ?? "";
	const diffStats = countDiffStats(diff);
	const replacements = args.edits.length;
	const summary = buildSummaryLine(
		theme,
		[
			theme.fg("success", `Applied ${replacements} ${pluralize(replacements, "edit")}`),
			theme.fg("dim", " • "),
			theme.fg("success", `+${diffStats.additions}`),
			theme.fg("dim", "/"),
			theme.fg("error", `-${diffStats.removals}`),
		].join(""),
		expanded,
	);
	if (!expanded || diff.length === 0) {
		return summary;
	}

	return [summary, formatDiffBlock(diff, theme)].join("\n");
}

function formatWriteCall(args: WriteToolInput, cwd: string, theme: OrchTheme): string {
	return [
		theme.fg("toolTitle", theme.bold("Write(")),
		theme.fg("accent", formatPathForDisplay(args.path, cwd)),
		theme.fg("toolTitle", theme.bold(")")),
	].join("");
}

function formatWriteResult(
	args: WriteToolInput,
	content: ToolContentBlock[],
	expanded: boolean,
	theme: OrchTheme,
	isError: boolean,
): string {
	const textContent = getTextContent(content);
	if (isError) {
		const firstLine = getFirstMeaningfulLine(textContent) ?? "Write failed";
		const summary = buildSummaryLine(theme, theme.fg("error", firstLine), expanded);
		if (!expanded || !textContent) {
			return summary;
		}
		return [summary, formatExpandedBlock(textContent, theme)].join("\n");
	}

	const lineCount = countLines(args.content);
	const summary = buildSummaryLine(theme, theme.fg("success", `Wrote ${lineCount} ${pluralize(lineCount, "line")}`), expanded);
	if (!expanded) {
		return summary;
	}
	return [summary, formatExpandedBlock(args.content, theme)].join("\n");
}

function formatFindCall(args: FindToolInput, cwd: string, theme: OrchTheme): string {
	return [
		theme.fg("toolTitle", theme.bold("Find ")),
		theme.fg("accent", args.pattern),
		theme.fg("dim", ` in ${formatPathForDisplay(args.path ?? ".", cwd)}`),
	].join("");
}

function formatFindResult(
	content: ToolContentBlock[],
	details: FindToolDetails | undefined,
	expanded: boolean,
	theme: OrchTheme,
): string {
	const textContent = getTextContent(content);
	if (!textContent || textContent === "No files found matching pattern") {
		return buildSummaryLine(theme, theme.fg("muted", "No files found"), expanded);
	}

	const count = countMeaningfulLines(textContent);
	const summary = buildSummaryLine(
		theme,
		[
			theme.fg("success", `${count} ${pluralize(count, "file")}`),
			details?.resultLimitReached || details?.truncation?.truncated ? theme.fg("warning", " [truncated]") : "",
		].join(""),
		expanded,
	);
	if (!expanded) {
		return summary;
	}
	return [summary, formatExpandedBlock(textContent, theme)].join("\n");
}

function formatGrepCall(args: GrepToolInput, cwd: string, theme: OrchTheme): string {
	const path = formatPathForDisplay(args.path ?? ".", cwd);
	return [
		theme.fg("toolTitle", theme.bold("Search ")),
		theme.fg("accent", `/${args.pattern}/`),
		theme.fg("dim", ` in ${path}`),
		args.glob ? theme.fg("dim", ` (${args.glob})`) : "",
	].join("");
}

function formatGrepResult(
	content: ToolContentBlock[],
	details: GrepToolDetails | undefined,
	expanded: boolean,
	theme: OrchTheme,
): string {
	const textContent = getTextContent(content);
	if (!textContent || textContent === "No matches found") {
		return buildSummaryLine(theme, theme.fg("muted", "No matches found"), expanded);
	}

	const count = countMeaningfulLines(textContent);
	const summary = buildSummaryLine(
		theme,
		[
			theme.fg("success", `${count} ${pluralize(count, "match")}`),
			details?.matchLimitReached || details?.truncation?.truncated || details?.linesTruncated
				? theme.fg("warning", " [truncated]")
				: "",
		].join(""),
		expanded,
	);
	if (!expanded) {
		return summary;
	}
	return [summary, formatExpandedBlock(textContent, theme)].join("\n");
}

function formatLsCall(args: LsToolInput, cwd: string, theme: OrchTheme): string {
	return [theme.fg("toolTitle", theme.bold("List ")), theme.fg("accent", formatPathForDisplay(args.path ?? ".", cwd))].join("");
}

function formatLsResult(
	content: ToolContentBlock[],
	details: LsToolDetails | undefined,
	expanded: boolean,
	theme: OrchTheme,
): string {
	const textContent = getTextContent(content);
	if (!textContent || textContent === "(empty directory)") {
		return buildSummaryLine(theme, theme.fg("muted", "Empty directory"), expanded);
	}

	const count = countMeaningfulLines(textContent);
	const summary = buildSummaryLine(
		theme,
		[
			theme.fg("success", `${count} ${pluralize(count, "entry")}`),
			details?.entryLimitReached || details?.truncation?.truncated ? theme.fg("warning", " [truncated]") : "",
		].join(""),
		expanded,
	);
	if (!expanded) {
		return summary;
	}
	return [summary, formatExpandedBlock(textContent, theme)].join("\n");
}

function buildSummaryLine(theme: OrchTheme, body: string, expanded: boolean): string {
	const hint = expanded ? "" : theme.fg("dim", ` (${EXPAND_HINT})`);
	return `${getWaterfallPrefix(theme)}${body}${hint}`;
}

function formatExpandedBlock(text: string, theme: OrchTheme): string {
	return text
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => `${getWaterfallPrefix(theme)}${theme.fg("toolOutput", line)}`)
		.join("\n");
}

function formatDiffBlock(diff: string, theme: OrchTheme): string {
	return diff
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => `${getWaterfallPrefix(theme)}${colorizeDiffLine(line, theme)}`)
		.join("\n");
}

function getWaterfallPrefix(theme: OrchTheme): string {
	return theme.fg("dim", WATERFALL_PREFIX);
}

function colorizeDiffLine(line: string, theme: OrchTheme): string {
	if (line.startsWith(GLYPHS.diffAdd) && !line.startsWith(`${GLYPHS.diffAdd}${GLYPHS.diffAdd}${GLYPHS.diffAdd}`)) {
		return theme.fg("success", line);
	}
	if (line.startsWith(GLYPHS.diffRemove) && !line.startsWith(`${GLYPHS.diffRemove}${GLYPHS.diffRemove}${GLYPHS.diffRemove}`)) {
		return theme.fg("error", line);
	}
	return theme.fg("toolOutput", line);
}

function countDiffStats(diff: string): { additions: number; removals: number } {
	let additions = 0;
	let removals = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith(GLYPHS.diffAdd) && !line.startsWith(`${GLYPHS.diffAdd}${GLYPHS.diffAdd}${GLYPHS.diffAdd}`)) {
			additions++;
		}
		if (line.startsWith(GLYPHS.diffRemove) && !line.startsWith(`${GLYPHS.diffRemove}${GLYPHS.diffRemove}${GLYPHS.diffRemove}`)) {
			removals++;
		}
	}
	return { additions, removals };
}

function formatReadRange(offset: number | undefined, limit: number | undefined): string {
	if (offset === undefined && limit === undefined) {
		return "";
	}
	const start = offset ?? 1;
	const end = limit !== undefined ? start + limit - 1 : undefined;
	return end !== undefined ? `:${start}-${end}` : `:${start}`;
}

function formatPathForDisplay(path: string, cwd: string): string {
	const absolutePath = path.startsWith("/") ? path : resolve(cwd, path);
	const relativePath = relative(cwd, absolutePath);
	if (relativePath.length > 0 && !relativePath.startsWith("..")) {
		return relativePath;
	}
	const home = homedir();
	if (absolutePath.startsWith(home)) {
		return `~${absolutePath.slice(home.length)}`;
	}
	return path;
}

function describeBashCommand(command: string): string {
	const trimmed = command.trim();
	if (trimmed.startsWith("rg ") || trimmed.includes("\nrg ")) {
		return "Search";
	}
	if (trimmed.startsWith("ls ") || trimmed === "ls") {
		return "List";
	}
	if (trimmed.startsWith("find ") || trimmed.startsWith("fd ")) {
		return "Find";
	}
	return "Bash";
}

function truncatePlainText(value: string, maxLength: number): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	if (singleLine.length <= maxLength) {
		return singleLine;
	}
	return `${singleLine.slice(0, maxLength - 3)}${GLYPHS.ellipsis}`;
}

function getTextContent(content: ToolContentBlock[]): string | undefined {
	const textBlocks = content.filter((block): block is TextContent => block.type === "text");
	if (textBlocks.length === 0) {
		return undefined;
	}
	return textBlocks.map((block) => block.text).join("\n");
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

function getFirstMeaningfulLine(text: string | undefined): string | undefined {
	if (!text) {
		return undefined;
	}
	return text
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
}

function pluralize(count: number, noun: string): string {
	return count === 1 ? noun : `${noun}s`;
}
