import { supportsXhigh, type Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type Component, truncateToWidth, type TUI, visibleWidth } from "@mariozechner/pi-tui";

import {
	clearFooterToolActivity,
	getFooterTransientMood,
	setFooterToolActivity,
	setFooterTransientMood,
	type OrchFooterMascotMood,
	type OrchRuntimeState,
} from "./runtime.js";

const FOOTER_ANIMATION_MS = 180;

type FooterTheme = ExtensionContext["ui"]["theme"];

type MascotPalette = {
	shell: "accent" | "dim" | "muted";
	face: "accent" | "dim" | "muted" | "success" | "warning" | "error";
};

const MASCOT_FRAMES: Record<OrchFooterMascotMood, string[]> = {
	idle: [">_<", ">.<", ">_<", ">-<"],
	thinking: [">~<", ">.~", ">~.", ">~<"],
	tool: [">#<", ">$<", ">#<", ">$<"],
	orchestrator: [">@<", ">@.", ".@<", ">@<"],
	worker: [">><", ">>>", ">><", ">>>"],
	validator: [">=<", ">|<", ">=<", ">|<"],
	success: [">^<", ">*<", ">^<", ">*<"],
	error: [">!<", ">x<", ">!<", ">x<"],
	interrupted: [">?<", ">!?", "?!<", ">?<"],
};

const MASCOT_PALETTES: Record<OrchFooterMascotMood, MascotPalette> = {
	idle: { shell: "accent", face: "muted" },
	thinking: { shell: "accent", face: "accent" },
	tool: { shell: "accent", face: "warning" },
	orchestrator: { shell: "accent", face: "accent" },
	worker: { shell: "accent", face: "success" },
	validator: { shell: "accent", face: "warning" },
	success: { shell: "accent", face: "success" },
	error: { shell: "accent", face: "error" },
	interrupted: { shell: "accent", face: "warning" },
};

export function registerOrchFooter(pi: ExtensionAPI, state: OrchRuntimeState): void {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) {
			return;
		}

		ctx.ui.setFooter((tui, theme) => new OrchFooterComponent(tui, theme, ctx, pi, state));
	});

	pi.on("turn_start", async () => {
		state.footer.turnHadError = false;
		state.footer.transientMood = undefined;
		state.footer.transientUntil = undefined;
	});

	pi.on("turn_end", async () => {
		if (!state.footer.turnHadError) {
			setFooterTransientMood(state, "success", 1200);
		}
	});

	pi.on("tool_execution_start", async (event) => {
		state.footer.transientMood = undefined;
		state.footer.transientUntil = undefined;
		setFooterToolActivity(state, event.toolName);
	});

	pi.on("tool_execution_end", async (event) => {
		clearFooterToolActivity(state);
		if (event.isError) {
			state.footer.turnHadError = true;
			setFooterTransientMood(state, "error", 1800);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		state.footer.toolActive = false;
		state.footer.turnHadError = false;
		state.footer.lastToolName = undefined;
		state.footer.transientMood = undefined;
		state.footer.transientUntil = undefined;
		if (ctx.hasUI) {
			ctx.ui.setFooter(undefined);
		}
	});
}

class OrchFooterComponent implements Component {
	private readonly intervalId: ReturnType<typeof setInterval>;

	constructor(
		private readonly tui: TUI,
		private readonly theme: FooterTheme,
		private readonly ctx: ExtensionContext,
		private readonly pi: ExtensionAPI,
		private readonly state: OrchRuntimeState,
	) {
		this.intervalId = setInterval(() => {
			this.tui.requestRender();
		}, FOOTER_ANIMATION_MS);
	}

	render(width: number): string[] {
		const left = this.renderModelContext();
		const right = this.renderMascot();
		const leftWidth = visibleWidth(left);
		const rightWidth = visibleWidth(right);

		if (leftWidth + rightWidth + 1 <= width) {
			const spacing = " ".repeat(Math.max(1, width - leftWidth - rightWidth));
			return [left + spacing + right];
		}

		const compact = `${left} ${right}`;
		return [truncateToWidth(compact, width, this.theme.fg("dim", "..."))];
	}

	invalidate(): void {
		// Theme object is passed in fresh when the footer is recreated.
	}

	dispose(): void {
		clearInterval(this.intervalId);
	}

	private renderModelContext(): string {
		const modelName = this.ctx.model?.id ?? "no-model";
		const thinkingLevel = getDisplayedThinkingLevel(this.ctx.model, this.pi.getThinkingLevel());
		const contextUsage = this.ctx.getContextUsage();
		const usedTokens = contextUsage?.tokens;
		const totalContext = contextUsage?.contextWindow ?? this.ctx.model?.contextWindow;
		const contextColor = getContextColor(contextUsage?.percent ?? null);

		const parts = [this.theme.fg("muted", modelName)];
		if (thinkingLevel) {
			parts.push(this.theme.fg("dim", " • "));
			parts.push(this.theme.fg(getThinkingLevelColor(thinkingLevel), thinkingLevel));
		}
		parts.push(this.theme.fg("dim", " • "));
		parts.push(this.theme.fg(contextColor, formatTokenCount(usedTokens)));
		parts.push(this.theme.fg("dim", "/"));
		parts.push(this.theme.fg(contextColor, formatTokenCount(totalContext)));
		return parts.join("");
	}

	private renderMascot(): string {
		const mood = resolveMascotMood(this.ctx, this.state);
		const frames = MASCOT_FRAMES[mood];
		const frame = frames[Math.floor(Date.now() / FOOTER_ANIMATION_MS) % frames.length] ?? frames[0];
		const palette = MASCOT_PALETTES[mood];
		const shellOpen = frame.slice(0, 1);
		const face = frame.slice(1, -1);
		const shellClose = frame.slice(-1);

		return [
			this.theme.fg(palette.shell, shellOpen),
			this.theme.fg(palette.face, face),
			this.theme.fg(palette.shell, shellClose),
		].join("");
	}
}

function resolveMascotMood(ctx: ExtensionContext, state: OrchRuntimeState): OrchFooterMascotMood {
	const phase = state.activeMission?.phase.toLowerCase();
	if (phase) {
		if (phase.includes("validat")) {
			return "validator";
		}
		if (phase.includes("attempt") || phase.includes("feature") || phase.includes("execut")) {
			return "worker";
		}
		return "orchestrator";
	}

	const transientMood = getFooterTransientMood(state);
	if (transientMood) {
		return transientMood;
	}

	if (state.footer.toolActive) {
		return "tool";
	}

	if (!ctx.isIdle()) {
		return "thinking";
	}

	return "idle";
}

function getDisplayedThinkingLevel(
	model: Model<unknown> | undefined,
	currentLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>,
): ReturnType<ExtensionAPI["getThinkingLevel"]> | undefined {
	const availableLevels = getAvailableThinkingLevels(model);
	if (availableLevels.length === 1 && availableLevels[0] === "off" && !model?.reasoning) {
		return undefined;
	}
	return availableLevels.includes(currentLevel) ? currentLevel : availableLevels[availableLevels.length - 1];
}

function getAvailableThinkingLevels(model: Model<unknown> | undefined): Array<ReturnType<ExtensionAPI["getThinkingLevel"]>> {
	if (!model?.reasoning) {
		return ["off"];
	}
	return supportsXhigh(model)
		? ["off", "minimal", "low", "medium", "high", "xhigh"]
		: ["off", "minimal", "low", "medium", "high"];
}

function getThinkingLevelColor(
	level: ReturnType<ExtensionAPI["getThinkingLevel"]>,
): "dim" | "muted" | "success" | "accent" | "warning" | "error" {
	switch (level) {
		case "off":
			return "muted";
		case "minimal":
			return "dim";
		case "low":
			return "success";
		case "medium":
			return "accent";
		case "high":
			return "warning";
		case "xhigh":
			return "error";
	}
}

function getContextColor(percent: number | null): "accent" | "success" | "warning" | "error" | "muted" {
	if (percent === null) {
		return "muted";
	}
	if (percent >= 90) {
		return "error";
	}
	if (percent >= 70) {
		return "warning";
	}
	if (percent >= 40) {
		return "accent";
	}
	return "success";
}

function formatTokenCount(value: number | null | undefined): string {
	if (value === null || value === undefined) {
		return "?";
	}
	if (value < 1000) {
		return String(value);
	}
	if (value < 10000) {
		return `${(value / 1000).toFixed(1)}k`;
	}
	if (value < 1000000) {
		return `${Math.round(value / 1000)}k`;
	}
	return `${(value / 1000000).toFixed(1)}M`;
}
