import type { Api, Model } from "@mariozechner/pi-ai";
import { DynamicBorder, getSelectListTheme, type ExtensionAPI, type ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";

import {
	isOrchConfigScope,
	loadOrchConfig,
	ORCH_ROLE_NAMES,
	setOrchRoleModelConfig,
	type OrchConfigScope,
	type OrchLoadedConfig,
	type OrchRoleName,
} from "./config.js";
import { ORCH_COMMANDS } from "./constants.js";
import { setOrchStatus, type OrchRuntimeState } from "./runtime.js";
import { formatErrorMessage } from "./utils.js";

type CompletionItem = {
	label: string;
	value: string;
};

const ORCH_MODEL_ROLE_NAMES = ORCH_ROLE_NAMES.filter((role) => role !== "orchestrator") as Exclude<OrchRoleName, "orchestrator">[];

type OrchModelChoice = {
	model: Model<Api>;
	reference: string;
	label: string;
	description: string;
};

export function registerOrchModelCommand(pi: ExtensionAPI, state: OrchRuntimeState): void {
	pi.registerCommand(ORCH_COMMANDS.model, {
		description: "Configure Orch sub-agent models from Pi's available models",
		getArgumentCompletions: (prefix) => getOrchModelArgumentCompletions(prefix),
		handler: async (args, ctx) => {
			try {
				await handleOrchModelCommand(args, ctx, state);
			} catch (error) {
				showOutput(ctx, formatErrorMessage(error), "error");
			}
		},
	});
}

async function handleOrchModelCommand(
	args: string,
	ctx: ExtensionCommandContext,
	state: OrchRuntimeState,
): Promise<void> {
	ctx.modelRegistry.refresh();
	const availableModels = ctx.modelRegistry.getAvailable();
	if (availableModels.length === 0) {
		showOutput(
			ctx,
			`No Pi models are currently available for Orch sub-agents. Configure model auth first, then retry /${ORCH_COMMANDS.model}.`,
			"warning",
		);
		return;
	}

	state.configState = await loadOrchConfig(ctx.cwd);
	const parsed = parseOrchModelArgs(args);
	if (parsed.error) {
		showOutput(ctx, `${parsed.error}\n\n${buildUsageText()}`, "warning");
		return;
	}

	const scope = await resolveScope(parsed.scope, ctx, state.configState);
	if (!scope) {
		return;
	}

	const role = await resolveRole(parsed.role, ctx, state.configState);
	if (!role) {
		return;
	}

	const modelChoices = buildModelChoices(availableModels, state.configState, role);
	const chosenModel = await resolveModelChoice(parsed.modelReference, modelChoices, ctx, role, state.configState, scope);
	if (!chosenModel) {
		return;
	}

	const result = await setOrchRoleModelConfig(scope, ctx.cwd, role, chosenModel.model.provider, chosenModel.model.id);
	state.configState = await loadOrchConfig(ctx.cwd);
	setOrchStatus(ctx, state);

	showOutput(
		ctx,
		[
			`Saved Orch ${role} model to ${scope} config: ${chosenModel.reference}`,
			`Config file: ${result.path}`,
			`Current merged role models: ${formatRoleModelSummary(state.configState)}`,
		].join("\n"),
	);
}

function parseOrchModelArgs(args: string): {
	scope?: OrchConfigScope;
	role?: OrchRoleName;
	modelReference?: string;
	error?: string;
} {
	let remaining = args.trim();
	let scope: OrchConfigScope | undefined;
	let role: OrchRoleName | undefined;

	const first = consumeToken(remaining);
	if (first.token && isOrchConfigScope(first.token)) {
		scope = first.token;
		remaining = first.rest;
	} else if (first.token && isOrchModelRoleName(first.token)) {
		role = first.token;
		remaining = first.rest;
	} else if (first.token === "orchestrator") {
		return { error: "The main Pi agent is the Orch orchestrator; /orch-model only configures sub-agent roles." };
	} else if (first.token) {
		return { error: `Unknown scope or role: ${first.token}` };
	}

	if (!role) {
		const second = consumeToken(remaining);
		if (second.token && isOrchModelRoleName(second.token)) {
			role = second.token;
			remaining = second.rest;
		} else if (second.token === "orchestrator") {
			return { error: "The main Pi agent is the Orch orchestrator; /orch-model only configures sub-agent roles." };
		} else if (second.token) {
			return { error: `Unknown Orch role: ${second.token}` };
		}
	}

	const third = consumeToken(remaining);
	if (third.token) {
		if (third.rest.trim().length > 0) {
			return { error: `Unexpected extra arguments: ${third.rest.trim()}` };
		}
		return {
			scope,
			role,
			modelReference: third.token,
		};
	}

	return { scope, role };
}

async function resolveScope(
	scope: OrchConfigScope | undefined,
	ctx: ExtensionCommandContext,
	configState: OrchLoadedConfig,
): Promise<OrchConfigScope | undefined> {
	if (scope) {
		return scope;
	}

	if (!ctx.hasUI) {
		return "project";
	}

	const options = [
		{
			value: "project",
			label: `project — ${configState.project.path}`,
		},
		{
			value: "user",
			label: `user — ${configState.user.path}`,
		},
	] as const;
	const selected = await ctx.ui.select(
		"Select Orch model config scope",
		options.map((option) => option.label),
	);
	const match = options.find((option) => option.label === selected);
	return match?.value;
}

async function resolveRole(
	role: OrchRoleName | undefined,
	ctx: ExtensionCommandContext,
	configState: OrchLoadedConfig,
): Promise<OrchRoleName | undefined> {
	if (role) {
		return role;
	}

	if (!ctx.hasUI) {
		showOutput(ctx, `Missing Orch role.\n\n${buildUsageText()}`, "warning");
		return undefined;
	}

	const options = ORCH_MODEL_ROLE_NAMES.map((name) => ({
		value: name,
		label: `${name} — current ${configState.merged.roles[name].provider}/${configState.merged.roles[name].model}`,
	}));
	const selected = await ctx.ui.select(
		"Select Orch sub-agent role",
		options.map((option) => option.label),
	);
	const match = options.find((option) => option.label === selected);
	return match?.value;
}

async function resolveModelChoice(
	modelReference: string | undefined,
	choices: OrchModelChoice[],
	ctx: ExtensionCommandContext,
	role: OrchRoleName,
	configState: OrchLoadedConfig,
	scope: OrchConfigScope,
): Promise<OrchModelChoice | undefined> {
	if (modelReference) {
		const normalized = modelReference.trim();
		const exactMatch = choices.find((choice) => choice.reference === normalized);
		if (!exactMatch) {
			showOutput(
				ctx,
				[`Unknown Orch model: ${normalized}`, "", buildAvailableModelsText(choices)].join("\n"),
				"warning",
			);
			return undefined;
		}
		return exactMatch;
	}

	if (!ctx.hasUI) {
		showOutput(ctx, `Missing model reference.\n\n${buildUsageText()}\n\n${buildAvailableModelsText(choices)}`, "warning");
		return undefined;
	}

	const currentReference = `${configState.merged.roles[role].provider}/${configState.merged.roles[role].model}`;
	const title = `Select model for ${role} (${scope} scope, current ${currentReference})`;
	return selectModelChoice(ctx, title, choices);
}

async function selectModelChoice(
	ctx: ExtensionCommandContext,
	title: string,
	choices: OrchModelChoice[],
): Promise<OrchModelChoice | undefined> {
	const items: SelectItem[] = choices.map((choice) => ({
		value: choice.reference,
		label: choice.reference,
		description: choice.description,
	}));

	const selectedReference = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		container.addChild(new Text(theme.fg("dim", `${choices.length} available models • ↑↓ navigate • PgUp/PgDn scroll • enter select • esc cancel`), 1, 0));

		const maxVisible = Math.min(Math.max(6, Math.min(choices.length, 14)), choices.length);
		const selectList = new SelectList(items, maxVisible, getSelectListTheme(), {
			minPrimaryColumnWidth: 18,
			maxPrimaryColumnWidth: 46,
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(undefined);
		container.addChild(selectList);
		container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});

	return selectedReference ? choices.find((choice) => choice.reference === selectedReference) : undefined;
}

function buildModelChoices(
	models: Model<Api>[],
	configState: OrchLoadedConfig,
	role: OrchRoleName,
): OrchModelChoice[] {
	const currentReference = `${configState.merged.roles[role].provider}/${configState.merged.roles[role].model}`;
	return [...models]
		.sort((left, right) => {
			const leftRef = `${left.provider}/${left.id}`;
			const rightRef = `${right.provider}/${right.id}`;
			const leftCurrent = leftRef === currentReference;
			const rightCurrent = rightRef === currentReference;
			if (leftCurrent && !rightCurrent) return -1;
			if (!leftCurrent && rightCurrent) return 1;
			if (left.provider !== right.provider) return left.provider.localeCompare(right.provider);
			return left.name.localeCompare(right.name);
		})
		.map((model) => {
			const reference = `${model.provider}/${model.id}`;
			const markers = [
				reference === currentReference ? "current" : undefined,
				model.reasoning ? "reasoning" : undefined,
				model.input.includes("image") ? "vision" : undefined,
			]
				.filter((value): value is string => value !== undefined)
				.join(", ");
			const description = `${model.name}${markers.length > 0 ? ` [${markers}]` : ""}`;
			return {
				model,
				reference,
				label: `${reference} — ${description}`,
				description,
			};
		});
}

function buildAvailableModelsText(choices: OrchModelChoice[]): string {
	return ["Available Pi models:", ...choices.map((choice) => `- ${choice.reference}`)].join("\n");
}

function buildUsageText(): string {
	const roles = ORCH_MODEL_ROLE_NAMES.join("|");
	return [
		"Usage:",
		`  /${ORCH_COMMANDS.model}`,
		`  /${ORCH_COMMANDS.model} <${roles}>`,
		`  /${ORCH_COMMANDS.model} <user|project> <${roles}>`,
		`  /${ORCH_COMMANDS.model} <${roles}> <provider/model>`,
		`  /${ORCH_COMMANDS.model} <user|project> <${roles}> <provider/model>`,
	].join("\n");
}

function formatRoleModelSummary(configState: OrchLoadedConfig): string {
	return ORCH_MODEL_ROLE_NAMES.map(
		(role) => `${role}=${configState.merged.roles[role].provider}/${configState.merged.roles[role].model}`,
	).join(", ");
}

function getOrchModelArgumentCompletions(prefix: string): CompletionItem[] | null {
	const tokens = toCompletionTokens(prefix);
	if (tokens.length === 0) {
		return toCompletionItems(["project", "user", ...ORCH_MODEL_ROLE_NAMES], "");
	}

	if (tokens.length === 1) {
		return toCompletionItems(["project", "user", ...ORCH_MODEL_ROLE_NAMES], tokens[0]);
	}

	if (isOrchConfigScope(tokens[0])) {
		if (tokens.length === 2) {
			return toCompletionItems([...ORCH_MODEL_ROLE_NAMES], tokens[1]);
		}
		return null;
	}

	if (isOrchModelRoleName(tokens[0])) {
		return null;
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

function isOrchModelRoleName(value: string): value is OrchRoleName {
	return ORCH_MODEL_ROLE_NAMES.includes(value as Exclude<OrchRoleName, "orchestrator">);
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

