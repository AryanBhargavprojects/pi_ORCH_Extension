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
import { Text } from "@mariozechner/pi-tui";

type OrchTheme = ExtensionContext["ui"]["theme"];

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
const RESULT_PREFIX = "⎿  ";
const DETAIL_INDENT = "   ";

export function registerCompactToolRenderers(pi: ExtensionAPI): void {
	registerReadRenderer(pi);
	registerBashRenderer(pi);
	registerEditRenderer(pi);
	registerWriteRenderer(pi);
	registerFindRenderer(pi);
	registerGrepRenderer(pi);
	registerLsRenderer(pi);
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
		return `${theme.fg("dim", RESULT_PREFIX)}${theme.fg("success", "Loaded image")}`;
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
	return `${theme.fg("dim", RESULT_PREFIX)}${body}${hint}`;
}

function formatExpandedBlock(text: string, theme: OrchTheme): string {
	return text
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => `${DETAIL_INDENT}${theme.fg("toolOutput", line)}`)
		.join("\n");
}

function formatDiffBlock(diff: string, theme: OrchTheme): string {
	return diff
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => `${DETAIL_INDENT}${colorizeDiffLine(line, theme)}`)
		.join("\n");
}

function colorizeDiffLine(line: string, theme: OrchTheme): string {
	if (line.startsWith("+") && !line.startsWith("+++")) {
		return theme.fg("success", line);
	}
	if (line.startsWith("-") && !line.startsWith("---")) {
		return theme.fg("error", line);
	}
	return theme.fg("toolOutput", line);
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
	return `${singleLine.slice(0, maxLength - 3)}...`;
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
