import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { PlanPhase, PlanStateFile } from "./plan-types.js";
import { slugifyText } from "./utils.js";

export type PlanStatePaths = {
	planDir: string;
	briefFile: string;
	questionsFile: string;
	codebaseAnalysisFile: string;
	docsWebResearchFile: string;
	feasibilityFile: string;
	planFile: string;
	validationContractFile: string;
	stateFile: string;
};

export function createPlanStatePaths(plansDir: string, planId: string): PlanStatePaths {
	const planDir = join(plansDir, planId);
	return {
		planDir,
		briefFile: join(planDir, "brief.md"),
		questionsFile: join(planDir, "questions.json"),
		codebaseAnalysisFile: join(planDir, "research", "codebase-analysis.md"),
		docsWebResearchFile: join(planDir, "research", "docs-web-research.md"),
		feasibilityFile: join(planDir, "feasibility.md"),
		planFile: join(planDir, "plan.md"),
		validationContractFile: join(planDir, "validation-contract.md"),
		stateFile: join(planDir, "state.json"),
	};
}

export function createPlanId(goal: string, startedAt: string): string {
	return `${startedAt.replace(/[:.]/g, "-")}-${slugifyText(goal, 60, "plan").slice(0, 40)}`;
}

export async function initializePlanState(
	plansDir: string,
	planId: string,
	goal: string,
	startedAt: string,
): Promise<{ paths: PlanStatePaths; state: PlanStateFile }> {
	const paths = createPlanStatePaths(plansDir, planId);
	const state: PlanStateFile = {
		id: planId,
		goal,
		refinedGoal: null,
		phase: "clarifying",
		stateDir: paths.planDir,
		startedAt,
		completedAt: null,
	};

	await mkdir(paths.planDir, { recursive: true });
	await mkdir(dirname(paths.codebaseAnalysisFile), { recursive: true });
	await mkdir(dirname(paths.docsWebResearchFile), { recursive: true });
	await writeJsonFile(paths.stateFile, state);

	return { paths, state };
}

export async function updatePlanPhase(paths: PlanStatePaths, phase: PlanPhase, refinedGoal?: string): Promise<PlanStateFile> {
	const state = await readPlanState(paths.stateFile);
	state.phase = phase;
	if (refinedGoal !== undefined) {
		state.refinedGoal = refinedGoal;
	}
	if (phase === "completed" || phase === "cancelled" || phase === "failed") {
		state.completedAt = new Date().toISOString();
	}
	await writeJsonFile(paths.stateFile, state);
	return state;
}

export async function readPlanState(stateFilePath: string): Promise<PlanStateFile> {
	return readJsonFile<PlanStateFile>(stateFilePath);
}

export async function writePlanArtifact(filePath: string, content: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.tmp-${Date.now()}`;
	await writeFile(tempPath, content, "utf8");
	await rename(tempPath, filePath);
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.tmp-${Date.now()}`;
	await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(tempPath, path);
}

async function readJsonFile<T>(path: string): Promise<T> {
	const content = await readFile(path, "utf8");
	return JSON.parse(content) as T;
}
