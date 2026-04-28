export const ORCH_EXTENSION_ID = "orch";
export const ORCH_EXTENSION_NAME = "Orch";
export const ORCH_EXTENSION_VERSION = "0.2.0";

export const ORCH_COMMANDS = {
	main: "orch",
	mission: "mission",
	model: "orch-model",
	status: "orch-status",
	reload: "orch-reload",
	takeover: "orch-takeover",
} as const;

export const ORCH_CUSTOM_TYPES = {
	event: "orch-event",
} as const;

export const GLYPHS = {
	assistant: "⏺",
	user: "❯",
	recap: "※",
	toolOut: "⎿",
	boxTopLeft: "╭",
	boxBottomLeft: "╰",
	boxVert: "│",
	done: "●",
	pending: "○",
	inProgress: "◆",
	pass: "✓",
	fail: "✗",
	spinner: ["✻", "✽", "✦", "✶"] as const,
	diffAdd: "+",
	diffRemove: "-",
	ellipsis: "…",
} as const;

export const ORCH_TOOL_NAMES = {
	delegate: "orch_delegate",
	smartFriend: "orch_smart_friend",
} as const;

export const ORCH_WIDGET_IDS = {
	loadingIndicator: "orch-loading-indicator",
	missionBlock: "orch-mission-block",
	missionThinking: "orch-mission-thinking",
	missionProgress: "orch-mission-progress",
} as const;
