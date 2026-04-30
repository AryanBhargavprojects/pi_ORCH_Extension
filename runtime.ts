import type { WriteStream } from "node:fs";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { ORCH_ROLE_NAMES, type OrchLoadedConfig, type OrchRoleName } from "./config.js";
import { ORCH_COMMANDS, ORCH_EXTENSION_ID, ORCH_EXTENSION_NAME, ORCH_EXTENSION_VERSION } from "./constants.js";
import type { MissionFeaturesStateFile, MissionLiveState } from "./mission-types.js";

import type { PlanPhase } from "./plan-types.js";

export type OrchFooterMascotMood =
	| "idle"
	| "thinking"
	| "tool"
	| "orchestrator"
	| "worker"
	| "validator"
	| "success"
	| "error"
	| "interrupted";

export type OrchFooterRuntimeState = {
	toolActive: boolean;
	turnHadError: boolean;
	lastToolName?: string;
	transientMood?: OrchFooterMascotMood;
	transientUntil?: number;
};

export type OrchPendingTakeoverPrompt = {
	text: string;
	images: ImageContent[];
};

export type OrchCmuxRoleStream = {
	role: OrchRoleName;
	surfaceRef: string;
	paneRef?: string;
	logFilePath: string;
	stream: WriteStream;
};

export type OrchCmuxMissionStreaming = {
	enabled: boolean;
	workspaceRef: string;
	anchorSurfaceRef: string;
	streamDir: string;
	roleStreams: Partial<Record<OrchRoleName, OrchCmuxRoleStream>>;
};

export type OrchActiveMission = {
	readonly id: string;
	readonly goal: string;
	readonly startedAt: string;
	abortController: AbortController;
	phase: string;
	orchestratorThinking: string;
	orchestratorText: string;
	featuresState?: MissionFeaturesStateFile;
	liveState?: MissionLiveState;
	takeoverRequested: boolean;
	cmuxStreaming?: OrchCmuxMissionStreaming;
	stateDir?: string;
	stateFilePath?: string;
	pendingTakeover?: OrchPendingTakeoverPrompt;
	backgroundPromise?: Promise<void>;
};

export type OrchActivePlan = {
	readonly id: string;
	readonly goal: string;
	refinedGoal: string;
	readonly startedAt: string;
	phase: PlanPhase;
	phaseStartedAt: number;
	currentAgent: string;
	lastActivity: string;
	lastActivityAt: number;
	abortController: AbortController;
	stateDir?: string;
	stateFilePath?: string;
	backgroundPromise?: Promise<void>;
};

export type OrchRuntimeState = {
	readonly bootId: string;
	readonly version: string;
	readonly loadedAt: string;
	configState?: OrchLoadedConfig;
	activeMission?: OrchActiveMission;
	activePlan?: OrchActivePlan;
	footer: OrchFooterRuntimeState;
	lastSessionStartReason?: string;
	lastSessionStartedAt?: string;
};

export function createRuntimeState(): OrchRuntimeState {
	const loadedAt = new Date().toISOString();

	return {
		bootId: `orch-${loadedAt}`,
		version: ORCH_EXTENSION_VERSION,
		loadedAt,
		footer: {
			toolActive: false,
			turnHadError: false,
		},
	};
}

export function markSessionStart(state: OrchRuntimeState, reason: string): void {
	state.lastSessionStartReason = reason;
	state.lastSessionStartedAt = new Date().toISOString();
}

export function setOrchStatus(ctx: ExtensionContext, state: OrchRuntimeState): void {
	if (!ctx.hasUI) return;

	const parts = [
		ctx.ui.theme.fg("accent", ORCH_EXTENSION_NAME),
		ctx.ui.theme.fg("dim", `v${state.version}`),
		ctx.ui.theme.fg("muted", `loaded ${state.loadedAt}`),
	];

	if (state.lastSessionStartReason) {
		parts.push(ctx.ui.theme.fg("dim", `session ${state.lastSessionStartReason}`));
	}

	const warningCount = state.configState?.warnings.length ?? 0;
	if (warningCount > 0) {
		parts.push(ctx.ui.theme.fg("warning", `${warningCount} config warning${warningCount === 1 ? "" : "s"}`));
	}

	if (state.activeMission) {
		parts.push(ctx.ui.theme.fg("accent", `mission:${state.activeMission.phase}`));
	}

	if (state.activePlan) {
		parts.push(ctx.ui.theme.fg("accent", `plan:${state.activePlan.phase}`));
	}

	ctx.ui.setStatus(ORCH_EXTENSION_ID, parts.join(" "));
}

export function clearOrchStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(ORCH_EXTENSION_ID, undefined);
}

export function setFooterTransientMood(
	state: OrchRuntimeState,
	mood: OrchFooterMascotMood,
	durationMs = 1500,
): void {
	state.footer.transientMood = mood;
	state.footer.transientUntil = Date.now() + durationMs;
}

export function getFooterTransientMood(state: OrchRuntimeState): OrchFooterMascotMood | undefined {
	if (!state.footer.transientMood || !state.footer.transientUntil) {
		return undefined;
	}
	if (Date.now() > state.footer.transientUntil) {
		state.footer.transientMood = undefined;
		state.footer.transientUntil = undefined;
		return undefined;
	}
	return state.footer.transientMood;
}

export function setFooterToolActivity(state: OrchRuntimeState, toolName: string): void {
	state.footer.toolActive = true;
	state.footer.lastToolName = toolName;
}

export function clearFooterToolActivity(state: OrchRuntimeState): void {
	state.footer.toolActive = false;
}

export function formatRuntimeSummary(state: OrchRuntimeState, cwd: string): string {
	const sessionReason = state.lastSessionStartReason ?? "unknown";
	const sessionStartedAt = state.lastSessionStartedAt ?? "unknown";
	const lines = [
		`${ORCH_EXTENSION_NAME} ${state.version}`,
		`bootId: ${state.bootId}`,
		`loadedAt: ${state.loadedAt}`,
		`sessionReason: ${sessionReason}`,
		`sessionStartedAt: ${sessionStartedAt}`,
		`cwd: ${cwd}`,
		`commands: /${ORCH_COMMANDS.main} | /${ORCH_COMMANDS.model} | /${ORCH_COMMANDS.mission} | /${ORCH_COMMANDS.plan} | /${ORCH_COMMANDS.status} | /${ORCH_COMMANDS.reload} | /${ORCH_COMMANDS.takeover} | /reload`,
	];

	if (state.activeMission) {
		lines.push(`activeMission: ${state.activeMission.goal}`);
		lines.push(`activeMissionPhase: ${state.activeMission.phase}`);
		lines.push(`takeoverCommands: /${ORCH_COMMANDS.main} takeover | /${ORCH_COMMANDS.takeover}`);
		if (state.activeMission.stateDir) {
			lines.push(`missionStateDir: ${state.activeMission.stateDir}`);
		}
		if (state.activeMission.stateFilePath) {
			lines.push(`missionStateFile: ${state.activeMission.stateFilePath}`);
		}
		if (state.activeMission.cmuxStreaming?.enabled) {
			const cmuxPanes = Object.values(state.activeMission.cmuxStreaming.roleStreams).filter(
				(stream): stream is OrchCmuxRoleStream => stream !== undefined,
			);
			lines.push(`cmuxStreaming: workspace=${state.activeMission.cmuxStreaming.workspaceRef}`);
			lines.push(`cmuxPanes: ${cmuxPanes.map((stream) => `${stream.role}=${stream.surfaceRef}`).join(", ")}`);
		}
	}

	if (state.activePlan) {
		lines.push(`activePlan: ${state.activePlan.goal}`);
		lines.push(`activePlanPhase: ${state.activePlan.phase}`);
		if (state.activePlan.stateDir) {
			lines.push(`planStateDir: ${state.activePlan.stateDir}`);
		}
		if (state.activePlan.stateFilePath) {
			lines.push(`planStateFile: ${state.activePlan.stateFilePath}`);
		}
	}

	if (state.configState) {
		const { merged, project, resolvedPaths, user, warnings } = state.configState;
		lines.push(
			`roles: ${ORCH_ROLE_NAMES.map((role) => `${role}=${merged.roles[role].provider}/${merged.roles[role].model}`).join(", ")}`,
		);
		lines.push(
			`tokenThresholds: learningExtraction=${merged.tokenThresholds.learningExtraction}, contextWarning=${merged.tokenThresholds.contextWarning}`,
		);
		lines.push(`userConfig: ${user.path} (${formatConfigFileStatus(user.exists, user.parseError)})`);
		lines.push(`projectConfig: ${project.path} (${formatConfigFileStatus(project.exists, project.parseError)})`);
		lines.push(`userProfileFile: ${resolvedPaths.userProfileFile}`);
		lines.push(`projectContextFile: ${resolvedPaths.projectContextFile}`);
		lines.push(`knowledgeBaseFile: ${resolvedPaths.knowledgeBaseFile}`);
		lines.push(`missionsDir: ${resolvedPaths.missionsDir}`);
		lines.push(`adaptationLogFile: ${resolvedPaths.adaptationLogFile}`);
		lines.push(`plansDir: ${resolvedPaths.plansDir}`);

		if (warnings.length > 0) {
			lines.push(`warnings: ${warnings.join(" | ")}`);
		}
	}

	return lines.join("\n");
}

function formatConfigFileStatus(exists: boolean, parseError: string | undefined): string {
	if (!exists) return "missing";
	if (parseError) return "invalid";
	return "present";
}
