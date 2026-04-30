import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import {
	ORCH_CONFIG_KEYS,
	ORCH_CONFIG_KEY_INFO,
	formatJson,
	getEffectiveOrchConfigValue,
	initializeOrchConfigFile,
	isOrchConfigKey,
	isOrchConfigScope,
	loadOrchConfig,
	setOrchConfigValue,
	type OrchConfigFileState,
	type OrchConfigScope,
	type OrchConfigValue,
} from "./config.js";
import { ORCH_COMMANDS, ORCH_EXTENSION_NAME } from "./constants.js";
import { readMissionLiveStateFromFile } from "./mission-state.js";
import { requestMissionTakeover } from "./mission.js";
import { formatRuntimeSummary, setOrchStatus, type OrchRuntimeState } from "./runtime.js";
import { formatErrorMessage } from "./utils.js";

type CompletionItem = {
	label: string;
	value: string;
};

export function registerOrchCommands(pi: ExtensionAPI, state: OrchRuntimeState): void {
	pi.registerCommand(ORCH_COMMANDS.main, {
		description: "Orch control center: status, config, mission, model, takeover, reload",
		getArgumentCompletions: (prefix) => getOrchArgumentCompletions(prefix),
		handler: async (args, ctx) => {
			try {
				await handleOrchCommand(args, ctx, state);
			} catch (error) {
				showOutput(ctx, formatErrorMessage(error), "error");
			}
		},
	});

	pi.registerCommand(ORCH_COMMANDS.status, {
		description: "Alias for /orch status",
		handler: async (_args, ctx) => {
			try {
				await handleOrchCommand("status", ctx, state);
			} catch (error) {
				showOutput(ctx, formatErrorMessage(error), "error");
			}
		},
	});

	pi.registerCommand(ORCH_COMMANDS.reload, {
		description: "Alias for /orch reload",
		handler: async (_args, ctx) => {
			try {
				await handleOrchCommand("reload", ctx, state);
			} catch (error) {
				showOutput(ctx, formatErrorMessage(error), "error");
			}
		},
	});

	pi.registerCommand(ORCH_COMMANDS.takeover, {
		description: "Alias for /orch takeover",
		handler: async (args, ctx) => {
			try {
				await handleOrchCommand(`takeover ${args}`.trim(), ctx, state);
			} catch (error) {
				showOutput(ctx, formatErrorMessage(error), "error");
			}
		},
	});
}

async function handleOrchCommand(args: string, ctx: ExtensionCommandContext, state: OrchRuntimeState): Promise<void> {
	const { rest, token } = consumeToken(args);

	switch (token) {
		case undefined:
			await refreshConfigState(ctx, state);
			showOutput(ctx, `${await buildRuntimeStatusText(state, ctx.cwd)}\n\n${buildOrchHelpText()}`);
			return;
		case "status":
			await refreshConfigState(ctx, state);
			showOutput(ctx, await buildRuntimeStatusText(state, ctx.cwd));
			return;
		case "reload":
			if (ctx.hasUI) {
				ctx.ui.notify(`${ORCH_EXTENSION_NAME}: reloading runtime`, "info");
			}
			await ctx.reload();
			return;
		case "takeover": {
			const pendingTakeover = rest.trim();
			const interrupted = requestMissionTakeover(
				state,
				pendingTakeover.length > 0 ? { text: pendingTakeover, images: [] } : undefined,
			);
			if (!interrupted) {
				showOutput(ctx, "There is no running Orch mission to interrupt.", "warning");
				return;
			}
			showOutput(
				ctx,
				pendingTakeover.length > 0
					? "Interrupting the active Orch mission. Your takeover prompt will run once the mission stops."
					: "Interrupting the active Orch mission. You can continue interactively once it stops.",
				"warning",
			);
			return;
		}
		case "config":
			await handleConfigCommand(rest, ctx, state);
			return;
		default:
			await refreshConfigState(ctx, state);
			showOutput(ctx, `Unknown /orch subcommand: ${token}\n\n${buildOrchHelpText()}`, "warning");
			return;
	}
}

async function handleConfigCommand(
	args: string,
	ctx: ExtensionCommandContext,
	state: OrchRuntimeState,
): Promise<void> {
	const { rest, token } = consumeToken(args);

	switch (token) {
		case undefined:
		case "show":
			await refreshConfigState(ctx, state);
			showOutput(ctx, buildConfigShowText(state));
			return;
		case "paths":
			await refreshConfigState(ctx, state);
			showOutput(ctx, buildConfigPathsText(state));
			return;
		case "init":
			await handleConfigInitCommand(rest, ctx, state);
			return;
		case "set":
			await handleConfigSetCommand(rest, ctx, state);
			return;
		default:
			await refreshConfigState(ctx, state);
			showOutput(ctx, `Unknown /orch config subcommand: ${token}\n\n${buildConfigHelpText()}`, "warning");
			return;
	}
}

async function handleConfigInitCommand(
	args: string,
	ctx: ExtensionCommandContext,
	state: OrchRuntimeState,
): Promise<void> {
	const parsedScope = consumeToken(args);
	if (!parsedScope.token || !isOrchConfigScope(parsedScope.token)) {
		showOutput(ctx, `Usage: /orch config init user|project [force]\n\n${buildConfigHelpText()}`, "warning");
		return;
	}

	const parsedFlag = consumeToken(parsedScope.rest);
	const force = parsedFlag.token === "force" || parsedFlag.token === "--force";
	if (parsedFlag.token && !force) {
		showOutput(ctx, `Unknown init flag: ${parsedFlag.token}\nUse 'force' to overwrite an existing file.`, "warning");
		return;
	}

	const result = await initializeOrchConfigFile(parsedScope.token, ctx.cwd, force);
	await refreshConfigState(ctx, state);

	if (!result.written) {
		showOutput(
			ctx,
			`${capitalize(parsedScope.token)} config already exists: ${result.path}\nUse /orch config init ${parsedScope.token} force to overwrite it.`,
			"warning",
		);
		return;
	}

	showOutput(
		ctx,
		`${capitalize(parsedScope.token)} config ${result.overwritten ? "overwritten" : "initialized"}: ${result.path}`,
	);
}

async function handleConfigSetCommand(
	args: string,
	ctx: ExtensionCommandContext,
	state: OrchRuntimeState,
): Promise<void> {
	const parsedScope = consumeToken(args);
	if (!parsedScope.token || !isOrchConfigScope(parsedScope.token)) {
		showOutput(ctx, `Usage: /orch config set user|project <key> <value>\n\n${buildConfigHelpText()}`, "warning");
		return;
	}

	const parsedKey = consumeToken(parsedScope.rest);
	if (!parsedKey.token || !isOrchConfigKey(parsedKey.token)) {
		showOutput(ctx, `Unknown config key: ${parsedKey.token ?? "(missing)"}\n\n${buildConfigKeyListText()}`, "warning");
		return;
	}

	const rawValue = parsedKey.rest.trim();
	if (rawValue.length === 0) {
		showOutput(
			ctx,
			`Missing value for ${parsedKey.token}.\nUsage: /orch config set ${parsedScope.token} ${parsedKey.token} <value>`,
			"warning",
		);
		return;
	}

	const saved = await setOrchConfigValue(parsedScope.token, ctx.cwd, parsedKey.token, rawValue);
	await refreshConfigState(ctx, state);

	const effectiveValue = state.configState
		? getEffectiveOrchConfigValue(state.configState.merged, parsedKey.token)
		: saved.value;

	showOutput(
		ctx,
		[
			`Saved ${parsedKey.token}=${formatConfigValue(saved.value)} to ${parsedScope.token} config: ${saved.path}`,
			`Effective merged value: ${formatConfigValue(effectiveValue)}`,
		].join("\n"),
	);
}

async function refreshConfigState(ctx: ExtensionCommandContext, state: OrchRuntimeState): Promise<void> {
	state.configState = await loadOrchConfig(ctx.cwd);
	setOrchStatus(ctx, state);
}

async function buildRuntimeStatusText(state: OrchRuntimeState, cwd: string): Promise<string> {
	const summary = formatRuntimeSummary(state, cwd);
	const stateFilePath = state.activeMission?.stateFilePath;
	if (!stateFilePath) {
		return summary;
	}

	try {
		const liveState = await readMissionLiveStateFromFile(stateFilePath);
		return [
			summary,
			"liveMissionState:",
			`phase: ${liveState.phase}`,
			`currentMilestoneId: ${liveState.currentMilestoneId ?? "none"}`,
			`currentFeatureId: ${liveState.currentFeatureId ?? "none"}`,
			`currentAttempt: ${liveState.currentAttempt ?? "none"}`,
			`featureProgress: ${liveState.completedFeatures}/${liveState.totalFeatures} done, ${liveState.failedFeatures} failed`,
			`milestoneProgress: ${liveState.completedMilestones}/${liveState.totalMilestones} done, ${liveState.failedMilestones} failed`,
			`stateUpdatedAt: ${liveState.lastUpdatedAt}`,
		].join("\n");
	} catch (error) {
		return `${summary}\nmissionStateReadError: ${formatErrorMessage(error)}`;
	}
}

function buildOrchHelpText(): string {
	return [
		"Usage:",
		`  /${ORCH_COMMANDS.main}`,
		`  /${ORCH_COMMANDS.main} status`,
		`  /${ORCH_COMMANDS.main} config`,
		`  /${ORCH_COMMANDS.main} config paths`,
		`  /${ORCH_COMMANDS.main} config init user|project [force]`,
		`  /${ORCH_COMMANDS.main} config set user|project <key> <value>`,
		`  /${ORCH_COMMANDS.main} takeover [prompt]`,
		`  /${ORCH_COMMANDS.main} reload`,
		`  /${ORCH_COMMANDS.model} [user|project] [role] [provider/model]`,
		`  /${ORCH_COMMANDS.mission} <goal>`,
		`  /${ORCH_COMMANDS.plan} <goal>`,
		`  /${ORCH_COMMANDS.plan} status`,
		`  /${ORCH_COMMANDS.plan} cancel`,
		`  /${ORCH_COMMANDS.takeover} [prompt]`,
		"",
		buildConfigKeyListText(),
	].join("\n");
}

function buildConfigHelpText(): string {
	return [
		"Orch config commands:",
		`  /${ORCH_COMMANDS.main} config`,
		`  /${ORCH_COMMANDS.main} config show`,
		`  /${ORCH_COMMANDS.main} config paths`,
		`  /${ORCH_COMMANDS.main} config init user|project [force]`,
		`  /${ORCH_COMMANDS.main} config set user|project <key> <value>`,
		"",
		buildConfigKeyListText(),
	].join("\n");
}

function buildConfigKeyListText(): string {
	const lines = ["Supported config keys:"];
	for (const key of ORCH_CONFIG_KEYS) {
		const info = ORCH_CONFIG_KEY_INFO[key];
		lines.push(`  - ${key} (${info.valueType}): ${info.description}`);
	}
	return lines.join("\n");
}

function buildConfigShowText(state: OrchRuntimeState): string {
	const configState = state.configState;
	if (!configState) {
		return "Orch config is not loaded yet.";
	}

	const lines = [
		"Orch config",
		formatConfigFileLine(configState.user),
		formatConfigFileLine(configState.project),
		"",
		"userOverrides:",
		formatJson(configState.user.overrides),
		"",
		"projectOverrides:",
		formatJson(configState.project.overrides),
		"",
		"merged:",
		formatJson(configState.merged),
	];

	if (configState.warnings.length > 0) {
		lines.push("", "warnings:");
		for (const warning of configState.warnings) {
			lines.push(`- ${warning}`);
		}
	}

	return lines.join("\n");
}

function buildConfigPathsText(state: OrchRuntimeState): string {
	const configState = state.configState;
	if (!configState) {
		return "Orch config is not loaded yet.";
	}

	const { resolvedPaths } = configState;
	return [
		"Orch config paths",
		formatConfigFileLine(configState.user),
		formatConfigFileLine(configState.project),
		"",
		`resolved.userProfileFile: ${resolvedPaths.userProfileFile}`,
		`resolved.projectContextFile: ${resolvedPaths.projectContextFile}`,
		`resolved.knowledgeBaseFile: ${resolvedPaths.knowledgeBaseFile}`,
		`resolved.missionsDir: ${resolvedPaths.missionsDir}`,
		`resolved.adaptationLogFile: ${resolvedPaths.adaptationLogFile}`,
		`resolved.plansDir: ${resolvedPaths.plansDir}`,
	].join("\n");
}

function formatConfigFileLine(fileState: OrchConfigFileState): string {
	return `${fileState.scope}Config: ${fileState.path} (${describeConfigFileState(fileState)})`;
}

function describeConfigFileState(fileState: OrchConfigFileState): string {
	if (!fileState.exists) return "missing";
	if (fileState.parseError) return "invalid";
	return "present";
}

function consumeToken(input: string): { rest: string; token?: string } {
	const trimmed = input.trimStart();
	if (trimmed.length === 0) {
		return { rest: "" };
	}

	const separatorIndex = trimmed.search(/\s/);
	if (separatorIndex === -1) {
		return { token: trimmed, rest: "" };
	}

	return {
		token: trimmed.slice(0, separatorIndex),
		rest: trimmed.slice(separatorIndex + 1),
	};
}

function getOrchArgumentCompletions(prefix: string): CompletionItem[] | null {
	const tokens = toCompletionTokens(prefix);
	if (tokens.length === 0) {
		return toCompletionItems(["status", "config", "takeover", "reload"], "");
	}

	if (tokens.length === 1) {
		return toCompletionItems(["status", "config", "takeover", "reload"], tokens[0]);
	}

	if (tokens[0] !== "config") {
		return null;
	}

	if (tokens.length === 2) {
		return toCompletionItems(["show", "paths", "init", "set"], tokens[1]);
	}

	if (tokens[1] === "init") {
		if (tokens.length === 3) {
			return toCompletionItems(["user", "project"], tokens[2]);
		}
		if (tokens.length === 4) {
			return toCompletionItems(["force", "--force"], tokens[3]);
		}
		return null;
	}

	if (tokens[1] === "set") {
		if (tokens.length === 3) {
			return toCompletionItems(["user", "project"], tokens[2]);
		}
		if (tokens.length === 4) {
			return toCompletionItems([...ORCH_CONFIG_KEYS], tokens[3]);
		}
	}

	return null;
}

function toCompletionTokens(prefix: string): string[] {
	const trimmedStart = prefix.trimStart();
	if (trimmedStart.length === 0) {
		return [];
	}

	const hasTrailingWhitespace = /\s$/.test(prefix);
	const normalized = hasTrailingWhitespace ? trimmedStart.trimEnd() : trimmedStart;
	const tokens = normalized.length === 0 ? [] : normalized.split(/\s+/);
	if (hasTrailingWhitespace) {
		tokens.push("");
	}
	return tokens;
}

function toCompletionItems(values: string[], prefix: string): CompletionItem[] | null {
	const filtered = values.filter((value) => value.startsWith(prefix));
	if (filtered.length === 0) {
		return null;
	}

	return filtered.map((value) => ({ label: value, value }));
}

function showOutput(
	ctx: ExtensionCommandContext,
	message: string,
	level: "error" | "info" | "warning" = "info",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
		return;
	}

	process.stdout.write(`${message}\n`);
}

function formatConfigValue(value: OrchConfigValue): string {
	if (typeof value === "number") {
		return String(value);
	}
	return JSON.stringify(value);
}

function capitalize(value: OrchConfigScope): string {
	return value[0].toUpperCase() + value.slice(1);
}
