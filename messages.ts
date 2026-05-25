import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import { GLYPHS, ORCH_CUSTOM_TYPES } from "./constants.js";

export type OrchEventLevel = "info" | "success" | "warning" | "error";

export type OrchEventDetails = {
	level?: OrchEventLevel;
	phase?: string;
	title?: string;
	recap?: boolean;
	workerChanges?: string[];
};

export function registerOrchMessageRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(ORCH_CUSTOM_TYPES.event, (message, _options, theme) => {
		const details = (message.details ?? {}) as OrchEventDetails;
		const content = typeof message.content === "string" ? message.content : String(message.content ?? "");

		if (details.recap) {
			return new Text(theme.fg("dim", `${GLYPHS.recap} ${content}`), 0, 0);
		}

		if (details.workerChanges && details.workerChanges.length > 0) {
			return new Text(renderWorkerChangesBlock(details.workerChanges, theme), 0, 0);
		}

		const level = details.level ?? "info";
		const title = details.title?.trim();
		const phase = details.phase?.trim();
		const color = getLevelColor(level);
		const tags = [
			phase ? theme.fg("muted", `[${phase}]`) : undefined,
			title ? theme.fg("accent", title) : undefined,
		]
			.filter((value): value is string => value !== undefined)
			.join(" ");

		const lines = [
			`${theme.fg("accent", GLYPHS.assistant)} ${theme.fg(color, "Orch")}${tags.length > 0 ? ` ${tags}` : ""}`,
		];

		if (content.length > 0) {
			lines.push(...content.replace(/\r/g, "").split("\n").map((line) => `  ${line}`));
		}

		return new Text(lines.join("\n"), 0, 0);
	});
}

export function emitOrchEvent(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext | ExtensionContext | undefined,
	content: string,
	details: OrchEventDetails = {},
): void {
	if (ctx?.hasUI) {
		pi.sendMessage(
			{
				customType: ORCH_CUSTOM_TYPES.event,
				content,
				display: true,
				details,
			},
			{ triggerTurn: false },
		);
		return;
	}

	process.stdout.write(`${content}\n`);
}

function renderWorkerChangesBlock(changes: string[], theme: ExtensionContext["ui"]["theme"]): string {
	const parsedChanges = changes.map(parseWorkerChange).filter((change) => change.path.length > 0);
	const stats = countWorkerChanges(parsedChanges);
	const summary = [
		stats.added > 0 ? theme.fg("success", `+${stats.added}`) : undefined,
		stats.modified > 0 ? theme.fg("accent", `~${stats.modified}`) : undefined,
		stats.removed > 0 ? theme.fg("error", `-${stats.removed}`) : undefined,
	]
		.filter((value): value is string => value !== undefined)
		.join(theme.fg("dim", " "));
	const header = [theme.fg("accent", "Worker diff"), summary ? theme.fg("dim", `(${summary})`) : undefined]
		.filter((value): value is string => value !== undefined)
		.join(" ");
	const lines = [`${theme.fg("dim", GLYPHS.boxTopLeft)} ${header}`];

	for (const change of parsedChanges) {
		const marker = getWorkerChangeMarker(change);
		const description = change.description ? ` ${theme.fg("dim", "—")} ${theme.fg("toolOutput", change.description)}` : "";
		lines.push(
			[
				theme.fg("dim", GLYPHS.boxVert),
				"  ",
				theme.fg(marker.color, marker.glyph),
				" ",
				theme.fg(marker.color, marker.label.padEnd(8)),
				" ",
				theme.fg("customMessageText", change.path),
				description,
			].join(""),
		);
	}

	if (parsedChanges.length === 0) {
		lines.push(`${theme.fg("dim", GLYPHS.boxVert)}  ${theme.fg("dim", "No file changes reported by worker.")}`);
	}

	lines.push(theme.fg("dim", GLYPHS.boxBottomLeft));
	return lines.join("\n");
}

type WorkerChangeKind = "added" | "modified" | "removed";

type ParsedWorkerChange = {
	path: string;
	description: string;
	kind: WorkerChangeKind;
};

function parseWorkerChange(change: string): ParsedWorkerChange {
	const separator = change.indexOf(":");
	const path = separator === -1 ? change.trim() : change.slice(0, separator).trim();
	const description = separator === -1 ? "" : change.slice(separator + 1).trim();
	return {
		path,
		description,
		kind: classifyWorkerChange(path, description),
	};
}

function classifyWorkerChange(path: string, description: string): WorkerChangeKind {
	const normalized = `${path} ${description}`.toLowerCase();
	if (/\b(remove|removed|delete|deleted|drop|dropped)\b/.test(normalized)) {
		return "removed";
	}
	if (/\b(add|added|create|created|new|introduce|introduced)\b/.test(normalized)) {
		return "added";
	}
	return "modified";
}

function countWorkerChanges(changes: ParsedWorkerChange[]): Record<WorkerChangeKind, number> {
	return changes.reduce<Record<WorkerChangeKind, number>>(
		(counts, change) => {
			counts[change.kind]++;
			return counts;
		},
		{ added: 0, modified: 0, removed: 0 },
	);
}

function getWorkerChangeMarker(change: ParsedWorkerChange): { glyph: string; label: string; color: "success" | "error" | "accent" } {
	switch (change.kind) {
		case "added":
			return { glyph: GLYPHS.diffAdd, label: "added", color: "success" };
		case "removed":
			return { glyph: GLYPHS.diffRemove, label: "removed", color: "error" };
		default:
			return { glyph: "~", label: "changed", color: "accent" };
	}
}

function getLevelColor(level: OrchEventLevel):
	| "accent"
	| "success"
	| "warning"
	| "error" {
	switch (level) {
		case "success":
			return "success";
		case "warning":
			return "warning";
		case "error":
			return "error";
		default:
			return "accent";
	}
}
