import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type Component, truncateToWidth, type TUI } from "@mariozechner/pi-tui";

import { GLYPHS, ORCH_WIDGET_IDS } from "./constants.js";

export const LOADING_VERBS: Array<[string, string]> = [
	["Brewing", "Brewed"],
	["Calculating", "Calculated"],
	["Cerebrating", "Cerebrated"],
	["Churning", "Churned"],
	["Coalescing", "Coalesced"],
	["Cogitating", "Cogitated"],
	["Computing", "Computed"],
	["Conjuring", "Conjured"],
	["Considering", "Considered"],
	["Constructing", "Constructed"],
	["Contemplating", "Contemplated"],
	["Crafting", "Crafted"],
	["Crunching", "Crunched"],
	["Deliberating", "Deliberated"],
	["Determining", "Determined"],
	["Distilling", "Distilled"],
	["Effecting", "Effected"],
	["Finagling", "Finagled"],
	["Forging", "Forged"],
	["Generating", "Generated"],
	["Hatching", "Hatched"],
	["Herding", "Herded"],
	["Honking", "Honked"],
	["Hustling", "Hustled"],
	["Ideating", "Ideated"],
	["Incubating", "Incubated"],
	["Inferring", "Inferred"],
	["Manifesting", "Manifested"],
	["Marinating", "Marinated"],
	["Meandering", "Meandered"],
	["Moseying", "Moseyed"],
	["Mulling", "Mulled"],
	["Musing", "Mused"],
	["Noodling", "Noodled"],
	["Percolating", "Percolated"],
	["Philosophising", "Philosophised"],
	["Polishing", "Polished"],
	["Pondering", "Pondered"],
	["Processing", "Processed"],
	["Puttering", "Puttered"],
	["Puzzling", "Puzzled"],
	["Reticulating", "Reticulated"],
	["Ruminating", "Ruminated"],
	["Schlepping", "Schlepped"],
	["Shucking", "Shucked"],
	["Simmering", "Simmered"],
	["Sleuthing", "Sleuthed"],
	["Smooshing", "Smooshed"],
	["Spinning", "Spun"],
	["Stewing", "Stewed"],
	["Sussing", "Sussed"],
	["Synthesizing", "Synthesized"],
	["Thinking", "Thought"],
	["Tinkering", "Tinkered"],
	["Transmuting", "Transmuted"],
	["Unfurling", "Unfurled"],
	["Vibing", "Vibed"],
	["Wandering", "Wandered"],
	["Whirring", "Whirred"],
	["Whisking", "Whisked"],
	["Wibbling", "Wibbled"],
	["Wrangling", "Wrangled"],
];

export const SPINNER_FRAME_MS = 180;
export const VERB_ROTATE_MS = 2000;

export function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) {
		return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export function getLoadingVerbIndex(elapsed: number, startVerbIndex: number): number {
	return (startVerbIndex + Math.floor(elapsed / VERB_ROTATE_MS)) % LOADING_VERBS.length;
}

export function renderLoadingLine(elapsed: number, startVerbIndex: number, theme: LoadingTheme): string {
	const frame = GLYPHS.spinner[Math.floor(Date.now() / SPINNER_FRAME_MS) % GLYPHS.spinner.length] ?? GLYPHS.spinner[0];
	const verbIndex = getLoadingVerbIndex(elapsed, startVerbIndex);
	const verb = LOADING_VERBS[verbIndex]?.[0] ?? LOADING_VERBS[0][0];
	return [
		theme.fg("accent", frame),
		" ",
		theme.fg("muted", `${verb}${GLYPHS.ellipsis}`),
		" ",
		theme.fg("dim", formatElapsed(elapsed)),
	].join("");
}

export function registerOrchLoadingIndicator(pi: ExtensionAPI): void {
	pi.on("turn_start", async (_event, ctx) => {
		if (!ctx.hasUI) {
			return;
		}

		const startedAt = Date.now();
		const startVerbIndex = Math.floor(Math.random() * LOADING_VERBS.length);
		ctx.ui.setWidget(
			ORCH_WIDGET_IDS.loadingIndicator,
			(tui, theme) => new OrchLoadingComponent(tui, theme, startedAt, startVerbIndex),
			{ placement: "belowEditor" },
		);
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!ctx.hasUI) {
			return;
		}
		ctx.ui.setWidget(ORCH_WIDGET_IDS.loadingIndicator, undefined);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) {
			return;
		}
		ctx.ui.setWidget(ORCH_WIDGET_IDS.loadingIndicator, undefined);
	});
}

class OrchLoadingComponent implements Component {
	private readonly intervalId: ReturnType<typeof setInterval>;

	constructor(
		private readonly tui: TUI,
		private readonly theme: LoadingTheme,
		private readonly startedAt: number,
		private readonly startVerbIndex: number,
	) {
		this.intervalId = setInterval(() => {
			this.tui.requestRender();
		}, SPINNER_FRAME_MS);
	}

	render(width: number): string[] {
		const elapsed = Date.now() - this.startedAt;
		const loadingLine = truncateToWidth(renderLoadingLine(elapsed, this.startVerbIndex, this.theme), width, this.theme.fg("dim", GLYPHS.ellipsis));
		const hintLine = truncateToWidth(this.theme.fg("dim", "  esc to interrupt"), width, this.theme.fg("dim", GLYPHS.ellipsis));
		return [loadingLine, hintLine];
	}

	handleInput(): void {
		// No-op.
	}

	invalidate(): void {
		// Stateless aside from time; render reads Date.now().
	}

	dispose(): void {
		clearInterval(this.intervalId);
	}
}

type LoadingTheme = ExtensionContext["ui"]["theme"];
