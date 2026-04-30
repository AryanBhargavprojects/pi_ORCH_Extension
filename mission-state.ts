import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { OrchRoleName } from "./config.js";
import type {
	MissionFeatureStateStatus,
	MissionFeaturesStateFile,
	MissionFixTask,
	MissionLiveState,
	MissionPlan,
	MissionPromptSharedState,
	MissionStateHandle,
	MissionStatePaths,
	ValidationContract,
} from "./mission-types.js";
import { slugifyText } from "./utils.js";

const FEATURE_SUMMARY_LIMIT = 5000;
const GUIDELINES_LIMIT: Record<OrchRoleName, number> = {
	orchestrator: 4000,
	worker: 4000,
	validator: 0,
	smart_friend: 0,
	plan_clarifier: 4000,
	plan_codebase: 4000,
	plan_researcher: 4000,
	plan_feasibility: 4000,
	plan_synthesizer: 4000,
};
const KNOWLEDGE_BASE_LIMIT: Record<OrchRoleName, number> = {
	orchestrator: 5000,
	worker: 3500,
	validator: 5000,
	smart_friend: 5000,
	plan_clarifier: 5000,
	plan_codebase: 5000,
	plan_researcher: 5000,
	plan_feasibility: 5000,
	plan_synthesizer: 5000,
};
const VALIDATION_CONTRACT_LIMIT: Record<OrchRoleName, number> = {
	orchestrator: 4000,
	worker: 4000,
	validator: 4000,
	smart_friend: 4000,
	plan_clarifier: 4000,
	plan_codebase: 4000,
	plan_researcher: 4000,
	plan_feasibility: 4000,
	plan_synthesizer: 4000,
};

export async function initializeMissionState(
	missionsDir: string,
	missionId: string,
	goal: string,
	startedAt: string,
	plan: MissionPlan,
): Promise<MissionStateHandle> {
	const paths = createMissionStatePaths(missionsDir, missionId);
	const handle: MissionStateHandle = {
		missionId,
		goal,
		startedAt,
		paths,
	};

	await mkdir(paths.missionDir, { recursive: true });
	const featuresState = createInitialFeaturesState(plan, startedAt);
	const liveState = createLiveState(handle, featuresState, {
		phase: "planning complete",
		currentFeatureIndex: null,
		currentFeatureId: null,
		currentAttempt: null,
		currentMilestoneId: plan.milestones[0]?.id ?? null,
	});

	await Promise.all([
		writeJsonFile(paths.planFile, plan),
		writeJsonFile(paths.featuresFile, featuresState),
		writeJsonFile(paths.stateFile, liveState),
		writeTextFile(paths.validationContractFile, renderValidationContractMarkdown(plan.validationContract)),
		writeTextFile(paths.guidelinesFile, renderGuidelinesMarkdown(plan)),
		writeTextFile(paths.knowledgeBaseFile, renderKnowledgeBaseMarkdown(plan, goal)),
	]);

	return handle;
}

export async function updateMissionRuntimeState(
	handle: MissionStateHandle,
	patch: {
		phase?: string;
		currentFeatureIndex?: number | null;
		currentFeatureId?: string | null;
		currentAttempt?: number | null;
		currentMilestoneId?: string | null;
	},
): Promise<MissionLiveState> {
	const featuresState = await readJsonFile<MissionFeaturesStateFile>(handle.paths.featuresFile);
	const current = await readJsonFile<MissionLiveState>(handle.paths.stateFile);
	const next = createLiveState(handle, featuresState, {
		phase: patch.phase ?? current.phase,
		currentFeatureIndex:
			patch.currentFeatureIndex !== undefined ? patch.currentFeatureIndex : current.currentFeatureIndex,
		currentFeatureId: patch.currentFeatureId !== undefined ? patch.currentFeatureId : current.currentFeatureId,
		currentAttempt: patch.currentAttempt !== undefined ? patch.currentAttempt : current.currentAttempt,
		currentMilestoneId:
			patch.currentMilestoneId !== undefined ? patch.currentMilestoneId : current.currentMilestoneId,
	});
	await writeJsonFile(handle.paths.stateFile, next);
	return next;
}

export async function setMissionFeatureState(
	handle: MissionStateHandle,
	featureId: string,
	patch: {
		status?: MissionFeatureStateStatus;
		attempts?: number;
		workerSummary?: string | null;
		validatorVerdict?: "passed" | "failed" | null;
	},
): Promise<MissionFeaturesStateFile> {
	return updateMissionFeaturesState(handle, (state) => {
		const feature = state.features.find((entry) => entry.id === featureId);
		if (!feature) {
			throw new Error(`Mission state feature not found: ${featureId}`);
		}

		if (patch.status !== undefined) {
			feature.status = patch.status;
		}
		if (patch.attempts !== undefined) {
			feature.attempts = patch.attempts;
		}
		if ("workerSummary" in patch) {
			feature.workerSummary = patch.workerSummary ?? null;
		}
		if ("validatorVerdict" in patch) {
			feature.validatorVerdict = patch.validatorVerdict ?? null;
		}
		feature.lastUpdatedAt = new Date().toISOString();
	});
}

export async function setMissionFeatureStates(
	handle: MissionStateHandle,
	featureIds: string[],
	patch: {
		status?: MissionFeatureStateStatus;
		attempts?: number;
		workerSummary?: string | null;
		validatorVerdict?: "passed" | "failed" | null;
	},
): Promise<MissionFeaturesStateFile> {
	if (featureIds.length === 0) {
		return readJsonFile<MissionFeaturesStateFile>(handle.paths.featuresFile);
	}

	const featureIdSet = new Set(featureIds);
	return updateMissionFeaturesState(handle, (state) => {
		for (const feature of state.features) {
			if (!featureIdSet.has(feature.id)) {
				continue;
			}
			if (patch.status !== undefined) {
				feature.status = patch.status;
			}
			if (patch.attempts !== undefined) {
				feature.attempts = patch.attempts;
			}
			if ("workerSummary" in patch) {
				feature.workerSummary = patch.workerSummary ?? null;
			}
			if ("validatorVerdict" in patch) {
				feature.validatorVerdict = patch.validatorVerdict ?? null;
			}
			feature.lastUpdatedAt = new Date().toISOString();
		}
	});
}

export async function setMissionMilestoneState(
	handle: MissionStateHandle,
	milestoneId: string,
	patch: {
		status?: MissionFeatureStateStatus;
		validationSummary?: string | null;
		lastValidatedAt?: string | null;
	},
): Promise<MissionFeaturesStateFile> {
	return updateMissionFeaturesState(handle, (state) => {
		const milestone = state.milestones.find((entry) => entry.id === milestoneId);
		if (!milestone) {
			throw new Error(`Mission state milestone not found: ${milestoneId}`);
		}

		if (patch.status !== undefined) {
			milestone.status = patch.status;
		}
		if ("validationSummary" in patch) {
			milestone.validationSummary = patch.validationSummary ?? null;
		}
		if ("lastValidatedAt" in patch) {
			milestone.lastValidatedAt = patch.lastValidatedAt ?? null;
		}
		milestone.lastUpdatedAt = new Date().toISOString();
	});
}

export async function registerMissionFixTasks(
	handle: MissionStateHandle,
	sourceFeatureId: string,
	milestoneId: string,
	attempt: number,
	fixTasks: MissionFixTask[],
): Promise<string[]> {
	if (fixTasks.length === 0) {
		return [];
	}

	const createdIds: string[] = [];
	await updateMissionFeaturesState(handle, (state) => {
		for (let index = 0; index < fixTasks.length; index++) {
			const fixTask = fixTasks[index];
			const featureId = createFixTaskFeatureId(sourceFeatureId, attempt, index + 1, fixTask.id);
			createdIds.push(featureId);
			state.features.push({
				id: featureId,
				title: fixTask.title,
				status: "pending",
				attempts: 0,
				milestoneId,
				kind: "fix",
				sourceFeatureId,
				workerSummary: null,
				validatorVerdict: null,
				lastUpdatedAt: new Date().toISOString(),
			});
		}
	});
	return createdIds;
}

export async function appendMissionKnowledgeBase(
	handle: MissionStateHandle,
	title: string,
	lines: string[],
): Promise<void> {
	if (lines.length === 0) {
		return;
	}

	const existing = await readTextFile(handle.paths.knowledgeBaseFile);
	const section = [`\n## ${title}`, ...lines.map((line) => `- ${line}`), ""].join("\n");
	await writeTextFile(handle.paths.knowledgeBaseFile, `${existing.trimEnd()}\n${section}`);
}

export async function appendMissionGuidelines(
	handle: MissionStateHandle,
	title: string,
	items: string[],
): Promise<void> {
	if (items.length === 0) {
		return;
	}

	const existing = await readTextFile(handle.paths.guidelinesFile);
	const section = [`\n## ${title}`, ...items.map((item) => `- ${item}`), ""].join("\n");
	await writeTextFile(handle.paths.guidelinesFile, `${existing.trimEnd()}\n${section}`);
}

export async function buildMissionPromptSharedState(
	handle: MissionStateHandle,
	role: OrchRoleName,
	currentMilestoneId: string | null,
): Promise<MissionPromptSharedState> {
	const [featuresState, liveState, validationContractText, knowledgeBaseText, guidelinesText] = await Promise.all([
		readJsonFile<MissionFeaturesStateFile>(handle.paths.featuresFile),
		readJsonFile<MissionLiveState>(handle.paths.stateFile),
		readTextFile(handle.paths.validationContractFile),
		readTextFile(handle.paths.knowledgeBaseFile),
		readTextFile(handle.paths.guidelinesFile),
	]);

	const currentMilestone = currentMilestoneId
		? featuresState.milestones.find((milestone) => milestone.id === currentMilestoneId)
		: undefined;

	return {
		missionDir: handle.paths.missionDir,
		planFile: handle.paths.planFile,
		featuresFile: handle.paths.featuresFile,
		validationContractFile: handle.paths.validationContractFile,
		knowledgeBaseFile: handle.paths.knowledgeBaseFile,
		guidelinesFile: handle.paths.guidelinesFile,
		stateFile: handle.paths.stateFile,
		missionStateSummary: formatMissionStateSummary(liveState),
		featureStatusSummary: truncateText(formatFeatureStatusSummary(featuresState), FEATURE_SUMMARY_LIMIT),
		currentMilestoneSummary: currentMilestone ? formatMilestoneSummary(currentMilestone) : "No current milestone selected.",
		validationContractExcerpt: truncateText(validationContractText, VALIDATION_CONTRACT_LIMIT[role]),
		knowledgeBaseExcerpt: truncateFromEnd(knowledgeBaseText, KNOWLEDGE_BASE_LIMIT[role]),
		guidelinesExcerpt: truncateText(guidelinesText, GUIDELINES_LIMIT[role]),
	};
}

export async function readMissionLiveStateFromFile(stateFilePath: string): Promise<MissionLiveState> {
	return readJsonFile<MissionLiveState>(stateFilePath);
}

export function buildSharedStatePromptSection(
	sharedState: MissionPromptSharedState,
	includeGuidelines: boolean,
): string[] {
	const lines = [
		"Shared mission state:",
		`- Mission directory: ${sharedState.missionDir}`,
		`- Plan file: ${sharedState.planFile}`,
		`- Features file: ${sharedState.featuresFile}`,
		`- Validation contract file: ${sharedState.validationContractFile}`,
		`- Knowledge base file: ${sharedState.knowledgeBaseFile}`,
		`- Guidelines file: ${sharedState.guidelinesFile}`,
		`- Runtime state file: ${sharedState.stateFile}`,
		"Mission runtime summary:",
		sharedState.missionStateSummary,
		"Current milestone summary:",
		sharedState.currentMilestoneSummary,
		"Feature status summary:",
		sharedState.featureStatusSummary,
		"Knowledge base excerpt:",
		sharedState.knowledgeBaseExcerpt || "none",
		"Validation contract excerpt:",
		sharedState.validationContractExcerpt || "none",
	];

	if (includeGuidelines) {
		lines.push("Guidelines excerpt:");
		lines.push(sharedState.guidelinesExcerpt || "none");
	}

	return lines;
}

function createMissionStatePaths(missionsDir: string, missionId: string): MissionStatePaths {
	const missionDir = join(missionsDir, missionId);
	return {
		missionDir,
		planFile: join(missionDir, "plan.json"),
		featuresFile: join(missionDir, "features.json"),
		validationContractFile: join(missionDir, "validation-contract.md"),
		knowledgeBaseFile: join(missionDir, "knowledge-base.md"),
		guidelinesFile: join(missionDir, "guidelines.md"),
		stateFile: join(missionDir, "state.json"),
	};
}

function createInitialFeaturesState(plan: MissionPlan, startedAt: string): MissionFeaturesStateFile {
	const milestoneByFeatureId = new Map<string, string>();
	for (const milestone of plan.milestones) {
		for (const featureId of milestone.featureIds) {
			milestoneByFeatureId.set(featureId, milestone.id);
		}
	}

	return {
		features: plan.features.map((feature) => ({
			id: feature.id,
			title: feature.title,
			status: "pending",
			attempts: 0,
			milestoneId: milestoneByFeatureId.get(feature.id) ?? plan.milestones[0]?.id ?? "milestone-1",
			kind: "planned",
			workerSummary: null,
			validatorVerdict: null,
			lastUpdatedAt: startedAt,
		})),
		milestones: plan.milestones.map((milestone) => ({
			id: milestone.id,
			title: milestone.title,
			summary: milestone.summary,
			featureIds: milestone.featureIds,
			validationTrigger: milestone.validationTrigger,
			notes: milestone.notes,
			status: "pending",
			validationSummary: null,
			lastUpdatedAt: startedAt,
			lastValidatedAt: null,
		})),
	};
}

function createLiveState(
	handle: MissionStateHandle,
	featuresState: MissionFeaturesStateFile,
	current: {
		phase: string;
		currentFeatureIndex: number | null;
		currentFeatureId: string | null;
		currentAttempt: number | null;
		currentMilestoneId: string | null;
	},
): MissionLiveState {
	const now = new Date().toISOString();
	const completedFeatures = featuresState.features.filter((feature) => feature.status === "done").length;
	const failedFeatures = featuresState.features.filter((feature) => feature.status === "failed").length;
	const completedMilestones = featuresState.milestones.filter((milestone) => milestone.status === "done").length;
	const failedMilestones = featuresState.milestones.filter((milestone) => milestone.status === "failed").length;

	return {
		missionId: handle.missionId,
		phase: current.phase,
		currentFeatureIndex: current.currentFeatureIndex,
		currentFeatureId: current.currentFeatureId,
		currentAttempt: current.currentAttempt,
		currentMilestoneId: current.currentMilestoneId,
		totalFeatures: featuresState.features.length,
		completedFeatures,
		failedFeatures,
		totalMilestones: featuresState.milestones.length,
		completedMilestones,
		failedMilestones,
		startedAt: handle.startedAt,
		lastUpdatedAt: now,
	};
}

function renderValidationContractMarkdown(contract: ValidationContract): string {
	const lines = ["# Validation Contract", "", "## Summary", contract.summary, "", "## Criteria", ""];

	for (const criterion of contract.criteria) {
		lines.push(`### ${criterion.id}: ${criterion.title} (${criterion.type})`);
		lines.push(criterion.description);
		lines.push("");
	}

	return `${lines.join("\n").trimEnd()}\n`;
}

function renderGuidelinesMarkdown(plan: MissionPlan): string {
	const lines = ["# Mission Guidelines", ""];
	if (plan.guidelines.length === 0) {
		lines.push("- No additional mission guidelines were generated during planning.");
	} else {
		for (const guideline of plan.guidelines) {
			lines.push(`- ${guideline}`);
		}
	}

	if (plan.milestones.length > 0) {
		lines.push("", "## Milestones", "");
		for (const milestone of plan.milestones) {
			lines.push(`### ${milestone.title}`);
			lines.push(milestone.summary);
			lines.push(`- Validation trigger: ${milestone.validationTrigger}`);
			for (const note of milestone.notes) {
				lines.push(`- ${note}`);
			}
			lines.push("");
		}
	}

	return `${lines.join("\n").trimEnd()}\n`;
}

function renderKnowledgeBaseMarkdown(plan: MissionPlan, goal: string): string {
	const lines = [
		"# Mission Knowledge Base",
		"",
		`Mission: ${plan.missionTitle}`,
		`Goal: ${goal}`,
		"",
		"## Initial context",
		`- ${plan.summary}`,
	];

	for (const note of plan.notes) {
		lines.push(`- ${note}`);
	}

	lines.push("", "## Running observations", "");
	return `${lines.join("\n").trimEnd()}\n`;
}

function formatMissionStateSummary(state: MissionLiveState): string {
	return [
		`Mission phase: ${state.phase}`,
		`Current milestone: ${state.currentMilestoneId ?? "none"}`,
		`Current feature: ${state.currentFeatureId ?? "none"}`,
		`Current attempt: ${state.currentAttempt ?? "none"}`,
		`Feature progress: ${state.completedFeatures}/${state.totalFeatures} done, ${state.failedFeatures} failed`,
		`Milestone progress: ${state.completedMilestones}/${state.totalMilestones} done, ${state.failedMilestones} failed`,
	].join("\n");
}

function formatFeatureStatusSummary(state: MissionFeaturesStateFile): string {
	const lines = ["Milestones:"];
	for (const milestone of state.milestones) {
		lines.push(
			`- [${milestone.status}] ${milestone.id} ${milestone.title} — trigger: ${milestone.validationTrigger}`,
		);
	}

	lines.push("", "Features:");
	for (const feature of state.features) {
		const detailParts = [
			`milestone=${feature.milestoneId}`,
			`kind=${feature.kind}`,
			`attempts=${feature.attempts}`,
		];
		if (feature.sourceFeatureId) {
			detailParts.push(`source=${feature.sourceFeatureId}`);
		}
		if (feature.validatorVerdict) {
			detailParts.push(`validator=${feature.validatorVerdict}`);
		}
		if (feature.workerSummary) {
			detailParts.push(`summary=${feature.workerSummary}`);
		}

		lines.push(`- [${feature.status}] ${feature.id} ${feature.title} (${detailParts.join(", ")})`);
	}

	return lines.join("\n");
}

function formatMilestoneSummary(milestone: MissionFeaturesStateFile["milestones"][number]): string {
	const lines = [
		`${milestone.id}: ${milestone.title}`,
		milestone.summary,
		`Status: ${milestone.status}`,
		`Validation trigger: ${milestone.validationTrigger}`,
	];
	if (milestone.validationSummary) {
		lines.push(`Last validation summary: ${milestone.validationSummary}`);
	}
	if (milestone.notes.length > 0) {
		lines.push("Notes:");
		for (const note of milestone.notes) {
			lines.push(`- ${note}`);
		}
	}
	return lines.join("\n");
}

function createFixTaskFeatureId(sourceFeatureId: string, attempt: number, index: number, taskId: string): string {
	return `${sourceFeatureId}-fix-${attempt}-${index}-${slugifyText(taskId, 30, "fix")}`;
}

async function updateMissionFeaturesState(
	handle: MissionStateHandle,
	mutate: (state: MissionFeaturesStateFile) => void,
): Promise<MissionFeaturesStateFile> {
	// TODO: add file locking if future Orch phases allow parallel workers/writers for mission state.
	const state = await readJsonFile<MissionFeaturesStateFile>(handle.paths.featuresFile);
	mutate(state);
	await writeJsonFile(handle.paths.featuresFile, state);
	return state;
}

async function readJsonFile<T>(path: string): Promise<T> {
	const content = await readFile(path, "utf8");
	return JSON.parse(content) as T;
}

async function readTextFile(path: string): Promise<string> {
	return readFile(path, "utf8");
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
	await writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextFile(path: string, value: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.tmp-${Date.now()}`;
	await writeFile(tempPath, value, "utf8");
	await rename(tempPath, path);
}

function truncateText(value: string, maxChars: number): string {
	if (maxChars <= 0) {
		return "";
	}
	if (value.length <= maxChars) {
		return value.trim();
	}
	return `${value.slice(0, maxChars).trimEnd()}\n\n[truncated]`;
}

function truncateFromEnd(value: string, maxChars: number): string {
	if (maxChars <= 0) {
		return "";
	}
	if (value.length <= maxChars) {
		return value.trim();
	}
	return `[truncated]\n\n${value.slice(value.length - maxChars).trimStart()}`;
}
