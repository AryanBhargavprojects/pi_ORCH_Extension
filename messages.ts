import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import { ORCH_CUSTOM_TYPES } from "./constants.js";

export type OrchEventLevel = "info" | "success" | "warning" | "error";

export type OrchEventDetails = {
	level?: OrchEventLevel;
	phase?: string;
	title?: string;
};

export function registerOrchMessageRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(ORCH_CUSTOM_TYPES.event, (message, _options, theme) => {
		const details = (message.details ?? {}) as OrchEventDetails;
		const level = details.level ?? "info";
		const title = details.title?.trim();
		const phase = details.phase?.trim();
		const color = getLevelColor(level);
		const prefix = theme.fg(color, theme.bold("Orch"));
		const tags = [
			phase ? theme.fg("muted", `[${phase}]`) : undefined,
			title ? theme.fg("accent", title) : undefined,
		]
			.filter((value): value is string => value !== undefined)
			.join(" ");

		let text = prefix;
		if (tags.length > 0) {
			text += ` ${tags}`;
		}

		const content = typeof message.content === "string" ? message.content : String(message.content ?? "");
		if (content.length > 0) {
			text += `\n${content}`;
		}

		return new Text(text, 0, 0);
	});
}

export function emitOrchEvent(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext | undefined,
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
