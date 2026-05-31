import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type Component, truncateToWidth, type TUI, visibleWidth } from "@mariozechner/pi-tui";

const FOOTER_REFRESH_MS = 1000;
const VISIBLE_ROLE_ENV = "PI_ORCH_VISIBLE_ROLE";
const VISIBLE_LABEL_ENV = "PI_ORCH_VISIBLE_LABEL";
const BADGE_OPEN = "\x1b[1;38;5;39m";
const BADGE_CLOSE = "\x1b[0m";

type FooterTheme = ExtensionContext["ui"]["theme"];
type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type FooterColor = "accent" | "success" | "warning" | "error" | "muted" | "dim";

const ROLE_VERBS: Partial<Record<string, string>> = {
	worker: "Working",
	validator: "Validating",
	smart_friend: "Advising",
	research: "Researching",
	plan_codebase: "Analyzing code",
};

export default function cmuxSpawnedFooterExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) {
			return;
		}

		const role = normalizeAgentValue(process.env[VISIBLE_ROLE_ENV]);
		const label = normalizeAgentValue(process.env[VISIBLE_LABEL_ENV]);
		ctx.ui.setFooter((tui, theme) => new CmuxSpawnedFooterComponent(tui, theme, ctx, pi, role, label));
	});
}

class CmuxSpawnedFooterComponent implements Component {
	private readonly intervalId: ReturnType<typeof setInterval>;
	private readonly startedAt = Date.now();
	private readonly displayRole: string;
	private readonly displayLabel: string;
	private readonly verb: string;

	constructor(
		private readonly tui: TUI,
		private readonly theme: FooterTheme,
		private readonly ctx: ExtensionContext,
		private readonly pi: ExtensionAPI,
		private readonly role: string,
		private readonly label: string,
	) {
		this.displayRole = role.replace(/_/g, "-");
		this.displayLabel = label.replace(/_/g, "-");
		this.verb = ROLE_VERBS[role] ?? "Working";
		this.intervalId = setInterval(() => {
			this.tui.requestRender();
		}, FOOTER_REFRESH_MS);
	}

	render(width: number): string[] {
		const badge = this.renderBadge();
		const badgeWidth = visibleWidth(badge);
		const modelName = this.ctx.model?.id ?? "no-model";
		const thinkingLevel = getDisplayedThinkingLevel(this.ctx.model, this.pi.getThinkingLevel());
		const contextUsage = this.ctx.getContextUsage();
		const contextColor = getContextColor(contextUsage?.percent ?? null);
		const status = this.theme.fg(this.ctx.isIdle() ? "muted" : "accent", `${this.verb}…`);
		const elapsed = this.theme.fg("dim", formatElapsed(Math.max(0, Date.now() - this.startedAt)));
		const context = renderContextUsage(this.theme, contextColor, contextUsage?.tokens, contextUsage?.contextWindow ?? this.ctx.model?.contextWindow);
		const thinking = this.theme.fg(getThinkingLevelColor(thinkingLevel), thinkingLevel);
		const model = this.theme.fg("muted", modelName);
		const fullLeft = joinInline([
			status,
			" ",
			this.theme.fg("dim", "("),
			elapsed,
			this.theme.fg("dim", " · "),
			context,
			this.theme.fg("dim", " · "),
			thinking,
			this.theme.fg("dim", " · "),
			model,
			this.theme.fg("dim", ")"),
		]);
		const noModelLeft = joinInline([
			status,
			" ",
			this.theme.fg("dim", "("),
			elapsed,
			this.theme.fg("dim", " · "),
			context,
			this.theme.fg("dim", " · "),
			thinking,
			this.theme.fg("dim", ")"),
		]);
		const compactLeft = joinInline([context, this.theme.fg("dim", " · "), thinking]);

		for (const left of [fullLeft, noModelLeft, compactLeft]) {
			if (visibleWidth(left) + badgeWidth + 1 <= width) {
				return [padFooter(left, badge, width)];
			}
		}

		return [fitFooter(compactLeft, badge, width, this.theme.fg("dim", "…"))];
	}

	invalidate(): void {
		// Render output is computed fresh on every paint.
	}

	dispose(): void {
		clearInterval(this.intervalId);
	}

	private renderBadge(): string {
		const roleText = this.displayRole || this.displayLabel || "agent";
		return `${BADGE_OPEN}@${roleText}${BADGE_CLOSE}`;
	}
}

function normalizeAgentValue(value: string | undefined): string {
	const normalized = value?.trim();
	return normalized && normalized.length > 0 ? normalized : "agent";
}

function padFooter(left: string, right: string, width: number): string {
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	const spacing = " ".repeat(Math.max(1, width - leftWidth - rightWidth));
	return `${left}${spacing}${right}`;
}

function fitFooter(left: string, right: string, width: number, ellipsis: string): string {
	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) {
		return truncateToWidth(right, width, ellipsis);
	}

	const availableLeft = Math.max(0, width - rightWidth - 1);
	if (availableLeft === 0) {
		return truncateToWidth(right, width, ellipsis);
	}

	const truncatedLeft = truncateToWidth(left, availableLeft, ellipsis);
	const truncatedLeftWidth = visibleWidth(truncatedLeft);
	const spacing = " ".repeat(Math.max(1, width - truncatedLeftWidth - rightWidth));
	return `${truncatedLeft}${spacing}${right}`;
}

function joinInline(parts: string[]): string {
	return parts.join("");
}

function renderContextUsage(
	theme: FooterTheme,
	color: FooterColor,
	usedTokens: number | null | undefined,
	totalContext: number | null | undefined,
): string {
	return joinInline([
		theme.fg(color, formatTokenCount(usedTokens)),
		theme.fg("dim", "/"),
		theme.fg(color, formatTokenCount(totalContext)),
	]);
}

function getDisplayedThinkingLevel(model: Model<Api> | undefined, currentLevel: ThinkingLevel): ThinkingLevel {
	if (!model?.reasoning) {
		return "off";
	}
	return currentLevel;
}

function getThinkingLevelColor(level: ThinkingLevel): FooterColor {
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

function getContextColor(percent: number | null): FooterColor {
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

function formatElapsed(ms: number): string {
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
