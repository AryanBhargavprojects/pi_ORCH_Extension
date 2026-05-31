import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export const ORCH_ROLE_NAMES = [
	"orchestrator",
	"worker",
	"validator",
	"smart_friend",
	"research",
	"plan_codebase",
] as const;

export type OrchRoleName = (typeof ORCH_ROLE_NAMES)[number];
export type OrchConfigScope = "user" | "project";
export type OrchConfigValue = number | string;

export type OrchRoleModelConfig = {
	provider: string;
	model: string;
};

export type OrchTokenThresholds = {
	learningExtraction: number;
	contextWarning: number;
};

export type OrchCmuxVisibility = "off" | "status" | "panes" | "auto";

export type OrchSubagentRoleTimeouts = {
	/** Timeout for normal sub-agent prompt calls (ms). */
	promptMs: number;
	/** Timeout for missing-final-text recovery prompt (ms). */
	recoveryPromptMs: number;
};

export type OrchSubagentTimeouts = OrchSubagentRoleTimeouts & {
	/** Optional per-role overrides. Missing fields inherit the global subagentTimeouts values. */
	roles: Partial<Record<OrchRoleName, Partial<OrchSubagentRoleTimeouts>>>;
};

export type OrchPathConfig = {
	userProfileFile: string;
	projectContextFile: string;
	knowledgeBaseFile: string;
	missionsDir: string;
	adaptationLogFile: string;
	plansDir: string;
};

export type OrchConfig = {
	roles: Record<OrchRoleName, OrchRoleModelConfig>;
	tokenThresholds: OrchTokenThresholds;
	paths: OrchPathConfig;
	cmuxVisibility: OrchCmuxVisibility;
	subagentTimeouts: OrchSubagentTimeouts;
};

export type OrchConfigOverrides = {
	roles?: Partial<Record<OrchRoleName, Partial<OrchRoleModelConfig>>>;
	tokenThresholds?: Partial<OrchTokenThresholds>;
	paths?: Partial<OrchPathConfig>;
	cmuxVisibility?: OrchCmuxVisibility;
	subagentTimeouts?: Partial<OrchSubagentTimeouts>;
};

export type OrchConfigFileState = {
	scope: OrchConfigScope;
	path: string;
	exists: boolean;
	parseError?: string;
	overrides: OrchConfigOverrides;
	warnings: string[];
};

export type OrchResolvedPaths = {
	userConfigFile: string;
	projectConfigFile: string;
	userProfileFile: string;
	projectContextFile: string;
	knowledgeBaseFile: string;
	missionsDir: string;
	adaptationLogFile: string;
	plansDir: string;
};

export type OrchLoadedConfig = {
	merged: OrchConfig;
	user: OrchConfigFileState;
	project: OrchConfigFileState;
	resolvedPaths: OrchResolvedPaths;
	warnings: string[];
};

export const ORCH_CONFIG_KEYS = [
	"roles.orchestrator.provider",
	"roles.orchestrator.model",
	"roles.worker.provider",
	"roles.worker.model",
	"roles.validator.provider",
	"roles.validator.model",
	"roles.smart_friend.provider",
	"roles.smart_friend.model",
	"roles.research.provider",
	"roles.research.model",
	"roles.plan_codebase.provider",
	"roles.plan_codebase.model",
	"tokenThresholds.learningExtraction",
	"tokenThresholds.contextWarning",
	"paths.userProfileFile",
	"paths.projectContextFile",
	"paths.knowledgeBaseFile",
	"paths.missionsDir",
	"paths.adaptationLogFile",
	"paths.plansDir",
	"cmuxVisibility",
	"subagentTimeouts.promptMs",
	"subagentTimeouts.recoveryPromptMs",
	"subagentTimeouts.roles.worker.promptMs",
	"subagentTimeouts.roles.validator.promptMs",
	"subagentTimeouts.roles.smart_friend.promptMs",
	"subagentTimeouts.roles.research.promptMs",
	"subagentTimeouts.roles.plan_codebase.promptMs",
] as const;

export type OrchConfigKey = (typeof ORCH_CONFIG_KEYS)[number];

type OrchConfigValueType = "number" | "string";

export const ORCH_CONFIG_KEY_INFO: Record<
	OrchConfigKey,
	{ description: string; valueType: OrchConfigValueType }
> = {
	"roles.orchestrator.provider": {
		description: "Provider used by the Orch orchestrator role",
		valueType: "string",
	},
	"roles.orchestrator.model": {
		description: "Model used by the Orch orchestrator role",
		valueType: "string",
	},
	"roles.worker.provider": {
		description: "Provider used by Orch worker tasks",
		valueType: "string",
	},
	"roles.worker.model": {
		description: "Model used by Orch worker tasks",
		valueType: "string",
	},
	"roles.validator.provider": {
		description: "Provider used by Orch validators",
		valueType: "string",
	},
	"roles.validator.model": {
		description: "Model used by Orch validators",
		valueType: "string",
	},
	"roles.smart_friend.provider": {
		description: "Provider used by the Orch smart friend advisor",
		valueType: "string",
	},
	"roles.smart_friend.model": {
		description: "Model used by the Orch smart friend advisor",
		valueType: "string",
	},
	"roles.research.provider": {
		description: "Provider used by the Orch general research sub-agent",
		valueType: "string",
	},
	"roles.research.model": {
		description: "Model used by the Orch general research sub-agent",
		valueType: "string",
	},
	"roles.plan_codebase.provider": {
		description: "Provider used by the Orch read-only codebase analyst",
		valueType: "string",
	},
	"roles.plan_codebase.model": {
		description: "Model used by the Orch read-only codebase analyst",
		valueType: "string",
	},
	"tokenThresholds.learningExtraction": {
		description: "Token count that triggers a learning-extraction prompt",
		valueType: "number",
	},
	"tokenThresholds.contextWarning": {
		description: "Token count where Orch should warn about context pressure",
		valueType: "number",
	},
	"paths.userProfileFile": {
		description: "User-level memory/profile file, relative to ~/.pi/agent unless absolute",
		valueType: "string",
	},
	"paths.projectContextFile": {
		description: "Project memory/context file, relative to the project root unless absolute",
		valueType: "string",
	},
	"paths.knowledgeBaseFile": {
		description: "Goal knowledge-base file, relative to the project root unless absolute",
		valueType: "string",
	},
	"paths.missionsDir": {
		description: "Goal working directory, relative to the project root unless absolute",
		valueType: "string",
	},
	"paths.adaptationLogFile": {
		description: "Proposal/adaptation log file, relative to the project root unless absolute",
		valueType: "string",
	},
	"paths.plansDir": {
		description: "Legacy plans directory (currently unused), relative to the project root unless absolute",
		valueType: "string",
	},
	"cmuxVisibility": {
		description: "CMUX visibility mode for sub-agent panes: off, status, panes, or auto",
		valueType: "string",
	},
	"subagentTimeouts.promptMs": {
		description: "Timeout in milliseconds for sub-agent prompt calls (default 300000 = 5 min)",
		valueType: "number",
	},
	"subagentTimeouts.recoveryPromptMs": {
		description: "Timeout in milliseconds for recovery prompt when sub-agent misses final text (default 120000 = 2 min)",
		valueType: "number",
	},
	"subagentTimeouts.roles.worker.promptMs": {
		description: "Worker role prompt timeout in milliseconds (default 600000 = 10 min)",
		valueType: "number",
	},
	"subagentTimeouts.roles.validator.promptMs": {
		description: "Validator role prompt timeout in milliseconds (default 600000 = 10 min)",
		valueType: "number",
	},
	"subagentTimeouts.roles.smart_friend.promptMs": {
		description: "Smart friend role prompt timeout in milliseconds (default 600000 = 10 min)",
		valueType: "number",
	},
	"subagentTimeouts.roles.research.promptMs": {
		description: "Research role prompt timeout in milliseconds (default 420000 = 7 min)",
		valueType: "number",
	},
	"subagentTimeouts.roles.plan_codebase.promptMs": {
		description: "Read-only codebase analyst prompt timeout in milliseconds (default 300000 = 5 min)",
		valueType: "number",
	},
};

const PROJECT_PATH_KEYS: Array<keyof OrchPathConfig> = [
	"projectContextFile",
	"knowledgeBaseFile",
	"missionsDir",
	"adaptationLogFile",
	"plansDir",
];

const DEFAULT_ORCH_CONFIG: OrchConfig = {
	roles: {
		orchestrator: {
			provider: "anthropic",
			model: "claude-opus-4-5",
		},
		worker: {
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		},
		validator: {
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		},
		smart_friend: {
			provider: "anthropic",
			model: "claude-opus-4-7",
		},
		research: {
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		},
		plan_codebase: {
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		},
	},
	tokenThresholds: {
		learningExtraction: 100_000,
		contextWarning: 80_000,
	},
	paths: {
		userProfileFile: "orch/user-profile.json",
		projectContextFile: ".pi/orch/project-context.json",
		knowledgeBaseFile: ".pi/orch/knowledge-base.json",
		missionsDir: ".pi/orch/goals",
		adaptationLogFile: ".pi/orch/adaptation-log.jsonl",
		plansDir: ".pi/orch/plans",
	},
	cmuxVisibility: "auto",
	subagentTimeouts: {
		promptMs: 300_000,
		recoveryPromptMs: 120_000,
		roles: {
			worker: { promptMs: 600_000 },
			validator: { promptMs: 600_000 },
			smart_friend: { promptMs: 600_000 },
			research: { promptMs: 420_000 },
			plan_codebase: { promptMs: 300_000 },
		},
	},
};

export function createDefaultOrchConfig(): OrchConfig {
	return structuredClone(DEFAULT_ORCH_CONFIG);
}

export function getOrchSubagentTimeoutsForRole(config: OrchConfig, role: OrchRoleName): OrchSubagentRoleTimeouts {
	const roleTimeouts = config.subagentTimeouts.roles[role];
	return {
		promptMs: roleTimeouts?.promptMs ?? config.subagentTimeouts.promptMs,
		recoveryPromptMs: roleTimeouts?.recoveryPromptMs ?? config.subagentTimeouts.recoveryPromptMs,
	};
}

export function isOrchConfigScope(value: string): value is OrchConfigScope {
	return value === "user" || value === "project";
}

export function isOrchConfigKey(value: string): value is OrchConfigKey {
	return ORCH_CONFIG_KEYS.includes(value as OrchConfigKey);
}

export function getOrchConfigPath(scope: OrchConfigScope, cwd: string): string {
	if (scope === "user") {
		return join(getAgentDir(), "orch", "config.json");
	}

	return join(cwd, ".pi", "orch", "config.json");
}

export function getEffectiveOrchConfigValue(config: OrchConfig, key: OrchConfigKey): OrchConfigValue {
	const roleKey = parseRoleConfigKey(key);
	if (roleKey) {
		return config.roles[roleKey.role][roleKey.field];
	}
	const timeoutKey = parseSubagentTimeoutConfigKey(key);
	if (timeoutKey) {
		const roleTimeouts = getOrchSubagentTimeoutsForRole(config, timeoutKey.role);
		return roleTimeouts[timeoutKey.field];
	}

	switch (key) {
		case "roles.orchestrator.provider":
			return config.roles.orchestrator.provider;
		case "roles.orchestrator.model":
			return config.roles.orchestrator.model;
		case "roles.worker.provider":
			return config.roles.worker.provider;
		case "roles.worker.model":
			return config.roles.worker.model;
		case "roles.validator.provider":
			return config.roles.validator.provider;
		case "roles.validator.model":
			return config.roles.validator.model;
		case "roles.smart_friend.provider":
			return config.roles.smart_friend.provider;
		case "roles.smart_friend.model":
			return config.roles.smart_friend.model;
		case "tokenThresholds.learningExtraction":
			return config.tokenThresholds.learningExtraction;
		case "tokenThresholds.contextWarning":
			return config.tokenThresholds.contextWarning;
		case "paths.userProfileFile":
			return config.paths.userProfileFile;
		case "paths.projectContextFile":
			return config.paths.projectContextFile;
		case "paths.knowledgeBaseFile":
			return config.paths.knowledgeBaseFile;
		case "paths.missionsDir":
			return config.paths.missionsDir;
		case "paths.adaptationLogFile":
			return config.paths.adaptationLogFile;
		case "paths.plansDir":
			return config.paths.plansDir;
		case "cmuxVisibility":
			return config.cmuxVisibility;
		case "subagentTimeouts.promptMs":
			return config.subagentTimeouts.promptMs;
		case "subagentTimeouts.recoveryPromptMs":
			return config.subagentTimeouts.recoveryPromptMs;
		default:
			throw new Error(`Unhandled Orch config key: ${key}`);
	}
}

export function parseOrchConfigValue(key: OrchConfigKey, rawValue: string): OrchConfigValue {
	const trimmed = stripWrappingQuotes(rawValue.trim());
	if (trimmed.length === 0) {
		throw new Error(`Config value for ${key} cannot be empty.`);
	}

	const definition = ORCH_CONFIG_KEY_INFO[key];
	if (definition.valueType === "number") {
		const numericValue = Number(trimmed);
		if (!Number.isFinite(numericValue) || numericValue <= 0) {
			throw new Error(`Config value for ${key} must be a positive number.`);
		}
		return numericValue;
	}

	return trimmed;
}

export async function loadOrchConfig(cwd: string): Promise<OrchLoadedConfig> {
	const user = await readOrchConfigFile("user", cwd);
	const project = await readOrchConfigFile("project", cwd);

	let merged = createDefaultOrchConfig();
	merged = applyOrchConfigOverrides(merged, user.overrides);
	merged = applyOrchConfigOverrides(merged, project.overrides);

	const warnings = [...user.warnings, ...project.warnings];

	return {
		merged,
		user,
		project,
		resolvedPaths: resolveOrchPaths(merged, cwd),
		warnings,
	};
}

export async function initializeOrchConfigFile(
	scope: OrchConfigScope,
	cwd: string,
	force = false,
): Promise<{ overwritten: boolean; path: string; written: boolean }> {
	const path = getOrchConfigPath(scope, cwd);
	const fileState = await readOrchConfigFile(scope, cwd);

	if (fileState.exists && !force) {
		return {
			overwritten: false,
			path,
			written: false,
		};
	}

	await writeConfigFile(path, createDefaultOrchConfig());

	return {
		overwritten: fileState.exists,
		path,
		written: true,
	};
}

export async function setOrchConfigValue(
	scope: OrchConfigScope,
	cwd: string,
	key: OrchConfigKey,
	rawValue: string,
): Promise<{ path: string; value: OrchConfigValue }> {
	const fileState = await readOrchConfigFile(scope, cwd);
	if (fileState.parseError) {
		throw new Error(
			`Cannot update ${scope} config because ${fileState.path} contains invalid JSON: ${fileState.parseError}`,
		);
	}

	const nextOverrides = structuredClone(fileState.overrides);
	const value = parseOrchConfigValue(key, rawValue);
	setValueInOverrides(nextOverrides, key, value);

	await writeConfigFile(fileState.path, nextOverrides);

	return {
		path: fileState.path,
		value,
	};
}

export async function setOrchRoleModelConfig(
	scope: OrchConfigScope,
	cwd: string,
	role: OrchRoleName,
	provider: string,
	model: string,
): Promise<{ path: string }> {
	const fileState = await readOrchConfigFile(scope, cwd);
	if (fileState.parseError) {
		throw new Error(
			`Cannot update ${scope} config because ${fileState.path} contains invalid JSON: ${fileState.parseError}`,
		);
	}

	const nextOverrides = structuredClone(fileState.overrides);
	nextOverrides.roles ??= {};
	nextOverrides.roles[role] ??= {};
	nextOverrides.roles[role].provider = provider;
	nextOverrides.roles[role].model = model;

	await writeConfigFile(fileState.path, nextOverrides);

	return {
		path: fileState.path,
	};
}

export function formatJson(value: OrchConfig | OrchConfigOverrides): string {
	return JSON.stringify(value, null, 2);
}

function stripWrappingQuotes(value: string): string {
	if (value.length < 2) return value;

	const first = value[0];
	const last = value[value.length - 1];
	if ((first === '"' || first === "'") && first === last) {
		return value.slice(1, -1);
	}

	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStringValue(value: unknown, label: string, warnings: string[]): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		warnings.push(`${label} must be a string.`);
		return undefined;
	}

	const trimmed = value.trim();
	if (trimmed.length === 0) {
		warnings.push(`${label} must be a non-empty string.`);
		return undefined;
	}

	return trimmed;
}

function getPositiveNumberValue(value: unknown, label: string, warnings: string[]): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		warnings.push(`${label} must be a positive number.`);
		return undefined;
	}

	return value;
}

async function readOrchConfigFile(scope: OrchConfigScope, cwd: string): Promise<OrchConfigFileState> {
	const path = getOrchConfigPath(scope, cwd);
	if (!existsSync(path)) {
		return {
			scope,
			path,
			exists: false,
			overrides: {},
			warnings: [],
		};
	}

	try {
		const raw = await readFile(path, "utf8");
		const parsed: unknown = JSON.parse(raw);
		const normalized = normalizeOrchConfigOverrides(parsed, `${scope} config (${path})`);
		return {
			scope,
			path,
			exists: true,
			overrides: normalized.overrides,
			warnings: normalized.warnings,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			scope,
			path,
			exists: true,
			parseError: message,
			overrides: {},
			warnings: [`${scope} config (${path}) could not be loaded: ${message}`],
		};
	}
}

function normalizeOrchConfigOverrides(
	value: unknown,
	label: string,
): { overrides: OrchConfigOverrides; warnings: string[] } {
	const warnings: string[] = [];
	if (!isRecord(value)) {
		warnings.push(`${label} must be a JSON object.`);
		return { overrides: {}, warnings };
	}

	const overrides: OrchConfigOverrides = {};

	const rolesValue = value.roles;
	if (rolesValue !== undefined) {
		if (!isRecord(rolesValue)) {
			warnings.push(`${label}.roles must be an object.`);
		} else {
			const roles: NonNullable<OrchConfigOverrides["roles"]> = {};

			for (const role of ORCH_ROLE_NAMES) {
				const roleValue = rolesValue[role];
				if (roleValue === undefined) continue;
				if (!isRecord(roleValue)) {
					warnings.push(`${label}.roles.${role} must be an object.`);
					continue;
				}

				const roleOverride: Partial<OrchRoleModelConfig> = {};
				const provider = getStringValue(roleValue.provider, `${label}.roles.${role}.provider`, warnings);
				const model = getStringValue(roleValue.model, `${label}.roles.${role}.model`, warnings);

				if (provider !== undefined) {
					roleOverride.provider = provider;
				}
				if (model !== undefined) {
					roleOverride.model = model;
				}

				if (Object.keys(roleOverride).length > 0) {
					roles[role] = roleOverride;
				}
			}

			if (Object.keys(roles).length > 0) {
				overrides.roles = roles;
			}
		}
	}

	const tokenThresholdsValue = value.tokenThresholds;
	if (tokenThresholdsValue !== undefined) {
		if (!isRecord(tokenThresholdsValue)) {
			warnings.push(`${label}.tokenThresholds must be an object.`);
		} else {
			const tokenThresholds: Partial<OrchTokenThresholds> = {};
			const learningExtraction = getPositiveNumberValue(
				tokenThresholdsValue.learningExtraction,
				`${label}.tokenThresholds.learningExtraction`,
				warnings,
			);
			const contextWarning = getPositiveNumberValue(
				tokenThresholdsValue.contextWarning,
				`${label}.tokenThresholds.contextWarning`,
				warnings,
			);

			if (learningExtraction !== undefined) {
				tokenThresholds.learningExtraction = learningExtraction;
			}
			if (contextWarning !== undefined) {
				tokenThresholds.contextWarning = contextWarning;
			}

			if (Object.keys(tokenThresholds).length > 0) {
				overrides.tokenThresholds = tokenThresholds;
			}
		}
	}

	const cmuxVisibilityValue = value.cmuxVisibility;
	if (cmuxVisibilityValue !== undefined) {
		const cmuxVis = getStringValue(cmuxVisibilityValue, `${label}.cmuxVisibility`, warnings);
		if (cmuxVis !== undefined) {
			if (cmuxVis === "off" || cmuxVis === "status" || cmuxVis === "panes" || cmuxVis === "auto") {
				overrides.cmuxVisibility = cmuxVis as OrchCmuxVisibility;
			} else {
				warnings.push(`${label}.cmuxVisibility must be one of "off", "status", "panes", or "auto".`);
			}
		}
	}

	const subagentTimeoutsValue = value.subagentTimeouts;
	if (subagentTimeoutsValue !== undefined) {
		if (!isRecord(subagentTimeoutsValue)) {
			warnings.push(`${label}.subagentTimeouts must be an object.`);
		} else {
			const subagentTimeouts: Partial<OrchSubagentTimeouts> = {};
			const promptMs = getPositiveNumberValue(
				subagentTimeoutsValue.promptMs,
				`${label}.subagentTimeouts.promptMs`,
				warnings,
			);
			const recoveryPromptMs = getPositiveNumberValue(
				subagentTimeoutsValue.recoveryPromptMs,
				`${label}.subagentTimeouts.recoveryPromptMs`,
				warnings,
			);
			if (promptMs !== undefined) {
				subagentTimeouts.promptMs = promptMs;
			}
			if (recoveryPromptMs !== undefined) {
				subagentTimeouts.recoveryPromptMs = recoveryPromptMs;
			}

			const roleTimeoutsValue = subagentTimeoutsValue.roles;
			if (roleTimeoutsValue !== undefined) {
				if (!isRecord(roleTimeoutsValue)) {
					warnings.push(`${label}.subagentTimeouts.roles must be an object.`);
				} else {
					const roleTimeouts: Partial<Record<OrchRoleName, Partial<OrchSubagentRoleTimeouts>>> = {};
					for (const [rawRole, rawRoleValue] of Object.entries(roleTimeoutsValue)) {
						if (!ORCH_ROLE_NAMES.includes(rawRole as OrchRoleName)) {
							warnings.push(`${label}.subagentTimeouts.roles.${rawRole} is not a known Orch role.`);
							continue;
						}
						if (!isRecord(rawRoleValue)) {
							warnings.push(`${label}.subagentTimeouts.roles.${rawRole} must be an object.`);
							continue;
						}
						const role = rawRole as OrchRoleName;
						const roleOverride: Partial<OrchSubagentRoleTimeouts> = {};
						const rolePromptMs = getPositiveNumberValue(
							rawRoleValue.promptMs,
							`${label}.subagentTimeouts.roles.${rawRole}.promptMs`,
							warnings,
						);
						const roleRecoveryPromptMs = getPositiveNumberValue(
							rawRoleValue.recoveryPromptMs,
							`${label}.subagentTimeouts.roles.${rawRole}.recoveryPromptMs`,
							warnings,
						);
						if (rolePromptMs !== undefined) {
							roleOverride.promptMs = rolePromptMs;
						}
						if (roleRecoveryPromptMs !== undefined) {
							roleOverride.recoveryPromptMs = roleRecoveryPromptMs;
						}
						if (Object.keys(roleOverride).length > 0) {
							roleTimeouts[role] = roleOverride;
						}
					}
					if (Object.keys(roleTimeouts).length > 0) {
						subagentTimeouts.roles = roleTimeouts;
					}
				}
			}

			if (Object.keys(subagentTimeouts).length > 0) {
				overrides.subagentTimeouts = subagentTimeouts;
			}
		}
	}

	const pathsValue = value.paths;
	if (pathsValue !== undefined) {
		if (!isRecord(pathsValue)) {
			warnings.push(`${label}.paths must be an object.`);
		} else {
			const paths: Partial<OrchPathConfig> = {};
			const userProfileFile = getStringValue(pathsValue.userProfileFile, `${label}.paths.userProfileFile`, warnings);
			const projectContextFile = getStringValue(
				pathsValue.projectContextFile,
				`${label}.paths.projectContextFile`,
				warnings,
			);
			const knowledgeBaseFile = getStringValue(
				pathsValue.knowledgeBaseFile,
				`${label}.paths.knowledgeBaseFile`,
				warnings,
			);
			const missionsDir = getStringValue(pathsValue.missionsDir, `${label}.paths.missionsDir`, warnings);
			const adaptationLogFile = getStringValue(
				pathsValue.adaptationLogFile,
				`${label}.paths.adaptationLogFile`,
				warnings,
			);
			const plansDir = getStringValue(
				pathsValue.plansDir,
				`${label}.paths.plansDir`,
				warnings,
			);

			if (userProfileFile !== undefined) {
				paths.userProfileFile = userProfileFile;
			}
			if (projectContextFile !== undefined) {
				paths.projectContextFile = projectContextFile;
			}
			if (knowledgeBaseFile !== undefined) {
				paths.knowledgeBaseFile = knowledgeBaseFile;
			}
			if (missionsDir !== undefined) {
				paths.missionsDir = missionsDir;
			}
			if (adaptationLogFile !== undefined) {
				paths.adaptationLogFile = adaptationLogFile;
			}
			if (plansDir !== undefined) {
				paths.plansDir = plansDir;
			}

			if (Object.keys(paths).length > 0) {
				overrides.paths = paths;
			}
		}
	}

	return { overrides, warnings };
}

function applyOrchConfigOverrides(base: OrchConfig, overrides: OrchConfigOverrides): OrchConfig {
	const next = structuredClone(base);

	for (const role of ORCH_ROLE_NAMES) {
		const roleOverride = overrides.roles?.[role];
		if (roleOverride?.provider !== undefined) {
			next.roles[role].provider = roleOverride.provider;
		}
		if (roleOverride?.model !== undefined) {
			next.roles[role].model = roleOverride.model;
		}
	}

	if (overrides.tokenThresholds?.learningExtraction !== undefined) {
		next.tokenThresholds.learningExtraction = overrides.tokenThresholds.learningExtraction;
	}
	if (overrides.tokenThresholds?.contextWarning !== undefined) {
		next.tokenThresholds.contextWarning = overrides.tokenThresholds.contextWarning;
	}

	if (overrides.paths?.userProfileFile !== undefined) {
		next.paths.userProfileFile = overrides.paths.userProfileFile;
	}
	if (overrides.cmuxVisibility !== undefined) {
		next.cmuxVisibility = overrides.cmuxVisibility;
	}
	if (overrides.subagentTimeouts?.promptMs !== undefined) {
		next.subagentTimeouts.promptMs = overrides.subagentTimeouts.promptMs;
	}
	if (overrides.subagentTimeouts?.recoveryPromptMs !== undefined) {
		next.subagentTimeouts.recoveryPromptMs = overrides.subagentTimeouts.recoveryPromptMs;
	}
	if (overrides.subagentTimeouts?.roles !== undefined) {
		for (const role of ORCH_ROLE_NAMES) {
			const roleOverride = overrides.subagentTimeouts.roles[role];
			if (!roleOverride) {
				continue;
			}
			next.subagentTimeouts.roles[role] ??= {};
			if (roleOverride.promptMs !== undefined) {
				next.subagentTimeouts.roles[role].promptMs = roleOverride.promptMs;
			}
			if (roleOverride.recoveryPromptMs !== undefined) {
				next.subagentTimeouts.roles[role].recoveryPromptMs = roleOverride.recoveryPromptMs;
			}
		}
	}
	for (const key of PROJECT_PATH_KEYS) {
		const value = overrides.paths?.[key];
		if (value !== undefined) {
			next.paths[key] = value;
		}
	}

	return next;
}

function resolveOrchPaths(config: OrchConfig, cwd: string): OrchResolvedPaths {
	const agentDir = getAgentDir();
	return {
		userConfigFile: getOrchConfigPath("user", cwd),
		projectConfigFile: getOrchConfigPath("project", cwd),
		userProfileFile: resolveConfiguredPath(agentDir, config.paths.userProfileFile),
		projectContextFile: resolveConfiguredPath(cwd, config.paths.projectContextFile),
		knowledgeBaseFile: resolveConfiguredPath(cwd, config.paths.knowledgeBaseFile),
		missionsDir: resolveConfiguredPath(cwd, config.paths.missionsDir),
		adaptationLogFile: resolveConfiguredPath(cwd, config.paths.adaptationLogFile),
		plansDir: resolveConfiguredPath(cwd, config.paths.plansDir),
	};
}

function resolveConfiguredPath(baseDir: string, configuredPath: string): string {
	if (isAbsolute(configuredPath)) {
		return configuredPath;
	}

	return resolve(baseDir, configuredPath);
}

function setValueInOverrides(overrides: OrchConfigOverrides, key: OrchConfigKey, value: OrchConfigValue): void {
	const roleKey = parseRoleConfigKey(key);
	if (roleKey) {
		overrides.roles ??= {};
		const roleOverrides = (overrides.roles[roleKey.role] ??= {});
		roleOverrides[roleKey.field] = value as string;
		return;
	}
	const timeoutKey = parseSubagentTimeoutConfigKey(key);
	if (timeoutKey) {
		overrides.subagentTimeouts ??= {};
		overrides.subagentTimeouts.roles ??= {};
		const roleTimeouts = (overrides.subagentTimeouts.roles[timeoutKey.role] ??= {});
		roleTimeouts[timeoutKey.field] = value as number;
		return;
	}

	switch (key) {
		case "roles.orchestrator.provider":
			overrides.roles ??= {};
			overrides.roles.orchestrator ??= {};
			overrides.roles.orchestrator.provider = value as string;
			return;
		case "roles.orchestrator.model":
			overrides.roles ??= {};
			overrides.roles.orchestrator ??= {};
			overrides.roles.orchestrator.model = value as string;
			return;
		case "roles.worker.provider":
			overrides.roles ??= {};
			overrides.roles.worker ??= {};
			overrides.roles.worker.provider = value as string;
			return;
		case "roles.worker.model":
			overrides.roles ??= {};
			overrides.roles.worker ??= {};
			overrides.roles.worker.model = value as string;
			return;
		case "roles.validator.provider":
			overrides.roles ??= {};
			overrides.roles.validator ??= {};
			overrides.roles.validator.provider = value as string;
			return;
		case "roles.validator.model":
			overrides.roles ??= {};
			overrides.roles.validator ??= {};
			overrides.roles.validator.model = value as string;
			return;
		case "roles.smart_friend.provider":
			overrides.roles ??= {};
			overrides.roles.smart_friend ??= {};
			overrides.roles.smart_friend.provider = value as string;
			return;
		case "roles.smart_friend.model":
			overrides.roles ??= {};
			overrides.roles.smart_friend ??= {};
			overrides.roles.smart_friend.model = value as string;
			return;
		case "tokenThresholds.learningExtraction":
			overrides.tokenThresholds ??= {};
			overrides.tokenThresholds.learningExtraction = value as number;
			return;
		case "tokenThresholds.contextWarning":
			overrides.tokenThresholds ??= {};
			overrides.tokenThresholds.contextWarning = value as number;
			return;
		case "paths.userProfileFile":
			overrides.paths ??= {};
			overrides.paths.userProfileFile = value as string;
			return;
		case "paths.projectContextFile":
			overrides.paths ??= {};
			overrides.paths.projectContextFile = value as string;
			return;
		case "paths.knowledgeBaseFile":
			overrides.paths ??= {};
			overrides.paths.knowledgeBaseFile = value as string;
			return;
		case "paths.missionsDir":
			overrides.paths ??= {};
			overrides.paths.missionsDir = value as string;
			return;
		case "paths.adaptationLogFile":
			overrides.paths ??= {};
			overrides.paths.adaptationLogFile = value as string;
			return;
		case "paths.plansDir":
			overrides.paths ??= {};
			overrides.paths.plansDir = value as string;
			return;
		case "cmuxVisibility":
			overrides.cmuxVisibility = value as string as OrchCmuxVisibility;
			return;
		case "subagentTimeouts.promptMs":
			overrides.subagentTimeouts ??= {};
			overrides.subagentTimeouts.promptMs = value as number;
			return;
		case "subagentTimeouts.recoveryPromptMs":
			overrides.subagentTimeouts ??= {};
			overrides.subagentTimeouts.recoveryPromptMs = value as number;
			return;
	}
}

function parseRoleConfigKey(key: string): { role: OrchRoleName; field: keyof OrchRoleModelConfig } | undefined {
	const match = key.match(/^roles\.([^.]+)\.(provider|model)$/);
	if (!match) {
		return undefined;
	}
	const role = match[1];
	if (!ORCH_ROLE_NAMES.includes(role as OrchRoleName)) {
		return undefined;
	}
	return { role: role as OrchRoleName, field: match[2] as keyof OrchRoleModelConfig };
}

function parseSubagentTimeoutConfigKey(key: string): { role: OrchRoleName; field: keyof OrchSubagentRoleTimeouts } | undefined {
	const match = key.match(/^subagentTimeouts\.roles\.([^.]+)\.(promptMs|recoveryPromptMs)$/);
	if (!match) {
		return undefined;
	}
	const role = match[1];
	if (!ORCH_ROLE_NAMES.includes(role as OrchRoleName)) {
		return undefined;
	}
	return { role: role as OrchRoleName, field: match[2] as keyof OrchSubagentRoleTimeouts };
}

async function writeConfigFile(path: string, value: OrchConfig | OrchConfigOverrides): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
