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
	const lines = [
		`${theme.fg("dim", GLYPHS.boxTopLeft)} ${theme.fg("accent", "Worker changes")}`,
	];

	for (const change of changes) {
		const parsed = parseWorkerChange(change);
		const marker = getWorkerChangeMarker(parsed.description);
		lines.push(
			[
				theme.fg("dim", GLYPHS.boxVert),
				"  ",
				theme.fg(marker.color, marker.glyph),
				" ",
				theme.fg("muted", parsed.path),
				parsed.description ? `  ${theme.fg("dim", parsed.description)}` : "",
			].join(""),
		);
	}

	lines.push(theme.fg("dim", GLYPHS.boxBottomLeft));
	return lines.join("\n");
}

function parseWorkerChange(change: string): { path: string; description: string } {
	const separator = change.indexOf(":");
	if (separator === -1) {
		return { path: change.trim(), description: "" };
	}
	return {
		path: change.slice(0, separator).trim(),
		description: change.slice(separator + 1).trim(),
	};
}

function getWorkerChangeMarker(description: string): { glyph: string; color: "success" | "error" | "accent" } {
	const normalized = description.toLowerCase();
	if (/\b(add|added|create|created|new)\b/.test(normalized)) {
		return { glyph: GLYPHS.diffAdd, color: "success" };
	}
	if (/\b(remove|removed|delete|deleted)\b/.test(normalized)) {
		return { glyph: GLYPHS.diffRemove, color: "error" };
	}
	return { glyph: "~", color: "accent" };
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
