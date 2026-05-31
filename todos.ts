import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type Component, Text, truncateToWidth, type TUI, visibleWidth } from "@mariozechner/pi-tui";

import { GLYPHS, ORCH_TOOL_NAMES, ORCH_WIDGET_IDS } from "./constants.js";
import { syncCmuxTodos } from "./cmux-integration.js";
import {
	setOrchStatus,
	setRuntimeTodos,
	type OrchRuntimeState,
	type OrchTodoItem,
	type OrchTodoStatus,
} from "./runtime.js";

const TODO_STATUS_LABELS: Record<OrchTodoStatus, string> = {
	pending: "pending",
	in_progress: "in progress",
	completed: "completed",
};

export function registerTodoWriteTool(pi: ExtensionAPI, state: OrchRuntimeState): void {
	pi.registerTool({
		name: ORCH_TOOL_NAMES.todoWrite,
		label: "TodoWrite",
		description: "Maintain Orch's shared todo list for the main interactive orchestrator.",
		promptSnippet: "Use TodoWrite to track multi-step work with pending, in_progress, and completed statuses.",
		promptGuidelines: [
			"Use TodoWrite for multi-step tasks with more than one meaningful step.",
			"Create or refresh the todo list near the start of the task, keep exactly one item in_progress when actively working, and mark items completed as you finish them.",
			"Keep todo content short, concrete, and outcome-focused. Skip TodoWrite for trivial one-step requests.",
		],
		parameters: Type.Object({
			todos: Type.Array(Type.Object({
				id: Type.Optional(Type.String()),
				content: Type.String({ minLength: 1 }),
				status: Type.Union([
					Type.Literal("pending"),
					Type.Literal("in_progress"),
					Type.Literal("completed"),
				]),
			}), { minItems: 1 }),
		}),
		executionMode: "sequential",
		renderShell: "self",
		renderCall(args, theme) {
			const count = getTodoCount(args);
			return new Text(theme.fg("accent", `TodoWrite ${count} item${count === 1 ? "" : "s"}`), 0, 0);
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const todos = setRuntimeTodos(state, params.todos);
			setOrchStatus(ctx, state);
			updateTodoUi(ctx, todos);
			syncCmuxTodos(todos);
			const summary = summarizeTodos(todos);
			return {
				content: [{ type: "text", text: summary }],
				details: { todos },
			};
		},
		renderResult(result, _options, theme) {
			const todos = getTodosFromResult(result.details);
			return new Text(theme.fg("accent", todos ? summarizeTodos(todos) : "Todos updated"), 0, 0);
		},
	});
}

export function clearTodoUi(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus("orch-todos", undefined);
	ctx.ui.setWidget(ORCH_WIDGET_IDS.todos, undefined);
}

export function updateTodoUi(ctx: ExtensionContext, todos: OrchTodoItem[]): void {
	if (!ctx.hasUI) return;
	if (todos.length === 0 || areTodosComplete(todos)) {
		clearTodoUi(ctx);
		return;
	}

	ctx.ui.setStatus("orch-todos", undefined);
	ctx.ui.setWidget(
		ORCH_WIDGET_IDS.todos,
		(_tui, theme) => new OrchTodoComponent(theme, todos),
		{ placement: "aboveEditor" },
	);
}

class OrchTodoComponent implements Component {
	constructor(
		private readonly theme: ExtensionContext["ui"]["theme"],
		private readonly todos: OrchTodoItem[],
	) {}

	render(width: number): string[] {
		return formatTodoWidget(this.theme, this.todos, width);
	}

	invalidate(): void {}
	dispose(): void {}
}

function areTodosComplete(todos: OrchTodoItem[]): boolean {
	return todos.length > 0 && todos.every((todo) => todo.status === "completed");
}

function summarizeTodos(todos: OrchTodoItem[]): string {
	const pending = todos.filter((todo) => todo.status === "pending").length;
	const inProgress = todos.filter((todo) => todo.status === "in_progress").length;
	const completed = todos.filter((todo) => todo.status === "completed").length;
	return `Todos ${completed}/${todos.length} completed • ${inProgress} in progress • ${pending} pending`;
}

function formatTodoWidget(theme: ExtensionContext["ui"]["theme"], todos: OrchTodoItem[], width: number): string[] {
	const lines: string[] = [];
	const summary = summarizeTodos(todos);

	lines.push(formatTodoLine(theme, width, GLYPHS.boxTopLeft, ` ${theme.fg("accent", "Orch Todos")} ${theme.fg("dim", `· ${summary}`)}`));

	for (const todo of todos) {
		const bullet = formatTodoBullet(theme, todo.status);
		const contentColor = todo.status === "completed" ? "dim" : todo.status === "in_progress" ? "accent" : "muted";
		const contentText = todo.status === "in_progress"
			? theme.fg("accent", todo.content)
			: theme.fg(contentColor, todo.content);
		lines.push(formatTodoLine(theme, width, GLYPHS.boxVert, `   ${bullet} ${contentText}`));
	}

	lines.push(formatTodoLine(theme, width, GLYPHS.boxBottomLeft, ""));
	return lines;
}

function formatTodoLine(theme: ExtensionContext["ui"]["theme"], width: number, leftGlyph: string, body: string): string {
	const styledGlyph = theme.fg("dim", leftGlyph);
	if (width <= visibleWidth(styledGlyph)) {
		return truncateToWidth(styledGlyph, width, "");
	}
	const prefix = `${styledGlyph} `;
	const contentWidth = Math.max(0, width - visibleWidth(prefix));
	const content = truncateToWidth(body, contentWidth, theme.fg("dim", GLYPHS.ellipsis));
	return truncateToWidth(`${prefix}${content}`, width, theme.fg("dim", GLYPHS.ellipsis));
}

function formatTodoBullet(theme: ExtensionContext["ui"]["theme"], status: OrchTodoStatus): string {
	switch (status) {
		case "completed":
			return theme.fg("success", GLYPHS.pass);
		case "in_progress":
			return theme.fg("accent", GLYPHS.inProgress);
		case "pending":
			return theme.fg("dim", GLYPHS.pending);
		default:
			return TODO_STATUS_LABELS[status];
	}
}

function getTodoCount(args: unknown): number {
	if (!isRecord(args) || !Array.isArray(args.todos)) {
		return 0;
	}
	return args.todos.length;
}

function getTodosFromResult(details: unknown): OrchTodoItem[] | undefined {
	if (!isRecord(details) || !Array.isArray(details.todos)) {
		return undefined;
	}
	return details.todos.filter(isTodoItem);
}

function isTodoItem(value: unknown): value is OrchTodoItem {
	return isRecord(value)
		&& typeof value.id === "string"
		&& typeof value.content === "string"
		&& (value.status === "pending" || value.status === "in_progress" || value.status === "completed");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
