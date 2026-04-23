export const ORCH_EXTENSION_ID = "orch";
export const ORCH_EXTENSION_NAME = "Orch";
export const ORCH_EXTENSION_VERSION = "0.1.0";

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

export const ORCH_TOOL_NAMES = {
	delegate: "orch_delegate",
} as const;

export const ORCH_WIDGET_IDS = {
	missionBlock: "orch-mission-block",
	missionThinking: "orch-mission-thinking",
	missionProgress: "orch-mission-progress",
} as const;
