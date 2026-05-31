import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { getOrchSubagentTimeoutsForRole, type OrchLoadedConfig, type OrchRoleName } from "./config.js";
import type { OrchSubagentResult, OrchSubagentStreamEvent } from "./role-runner.js";

const execFileAsync = promisify(execFile);
const CMUX_COMMAND_TIMEOUT_MS = 3000;
const RESULT_POLL_INTERVAL_MS = 1000;
const RESULT_GRACE_MS = 30_000;
const SURFACE_CLOSE_GRACE_MS = 750;
const MAX_TITLE_LENGTH = 56;
const VISIBLE_WORKER_ENV = "PI_ORCH_VISIBLE_WORKER";
const VISIBLE_ROLE_ENV = "PI_ORCH_VISIBLE_ROLE";
const VISIBLE_LABEL_ENV = "PI_ORCH_VISIBLE_LABEL";
const CMUX_SPAWNED_FOOTER_EXTENSION = fileURLToPath(new URL("./cmux-spawned-footer.ts", import.meta.url));
const DEFAULT_GRID_LAYOUT_GROUP_ID = "parallel-workers";

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "write"];
const RESEARCH_TOOLS = ["read", "bash", "grep", "find", "ls", "write"];
const WORKER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const VALIDATOR_TOOLS = ["read", "grep", "find", "ls", "write"];

type CmuxIdentifyResponse = {
	caller?: {
		workspace_ref?: string;
		surface_ref?: string;
	};
};

type CmuxPane = {
	ref: string;
	index?: number;
	pixel_frame?: { x?: number; width?: number };
	surface_refs?: string[];
	selected_surface_ref?: string;
};

type CmuxPanesResponse = {
	panes?: CmuxPane[];
};

type CmuxSurfaceResponse = {
	surface_ref?: string;
	pane_ref?: string;
	workspace_ref?: string;
};

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
	settled: boolean;
	started: boolean;
};

type VisiblePiLayoutState = {
	layoutKey: string;
	workspaceRef: string;
	callerSurfaceRef: string;
	workerAreaSurfaceRef?: string;
	lastSurfaceRef?: string;
	surfaceRefsByIndex: Map<number, string>;
	slots: Map<number, Deferred<string | undefined>>;
};

type RunVisiblePiSubagentRequest = {
	role: OrchRoleName;
	label: string;
	prompt: string;
	cwd: string;
	configState: OrchLoadedConfig;
	signal?: AbortSignal;
	toolNames?: string[];
	onStreamEvent?: (event: OrchSubagentStreamEvent) => void;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	parallelIndex?: number;
	parallelTotal?: number;
	layoutGroupId?: string;
};

const visibleLayouts = new Map<string, VisiblePiLayoutState>();
const layoutQueues = new Map<string, Promise<unknown>>();

export async function runVisiblePiSubagentInCmux(
	request: RunVisiblePiSubagentRequest,
): Promise<OrchSubagentResult | undefined> {
	if (request.configState.merged.cmuxVisibility === "off" || process.env[VISIBLE_WORKER_ENV] === "1") {
		return undefined;
	}
	if (!process.env.CMUX_WORKSPACE_ID && !process.env.CMUX_SURFACE_ID) {
		return undefined;
	}

	const identify = await runCmuxJson<CmuxIdentifyResponse>(["identify"]);
	const workspaceRef = process.env.CMUX_WORKSPACE_ID || identify?.caller?.workspace_ref;
	const callerSurfaceRef = identify?.caller?.surface_ref;
	if (!workspaceRef || !callerSurfaceRef) {
		return undefined;
	}

	const startedAt = Date.now();
	const layoutKey = getVisiblePiLayoutKey(workspaceRef, request);
	const runId = `${startedAt}-${sanitizeForFileName(request.role)}-${sanitizeForFileName(request.label).slice(0, 48) || "subagent"}`;
	const runDir = join(request.cwd, ".pi", "orch", "cmux-runs", runId);
	await mkdir(runDir, { recursive: true });
	const promptFile = join(runDir, "prompt.md");
	const resultFile = join(runDir, "result.md");
	const statusFile = join(runDir, "status.json");
	const wrappedPrompt = buildVisiblePiPrompt(request, resultFile);
	await writeFile(promptFile, wrappedPrompt, "utf8");
	await writeFile(statusFile, JSON.stringify({ status: "starting", role: request.role, label: request.label, startedAt }, null, 2), "utf8");

	const surfaceRef = await createVisiblePiSurface({
		workspaceRef,
		callerSurfaceRef,
		role: request.role,
		label: request.label,
		parallelIndex: request.parallelIndex,
		parallelTotal: request.parallelTotal,
		layoutGroupId: request.layoutGroupId,
	});
	if (!surfaceRef) {
		return undefined;
	}

	request.onStreamEvent?.({ role: request.role, type: "status", status: "starting" });
	await writeFile(statusFile, JSON.stringify({ status: "running", role: request.role, label: request.label, surfaceRef, startedAt }, null, 2), "utf8");
	await sendToSurface(workspaceRef, surfaceRef, buildPiCommand(request, promptFile));

	const timeoutMs = getOrchSubagentTimeoutsForRole(request.configState.merged, request.role).promptMs + RESULT_GRACE_MS;
	try {
		const output = await waitForResultFile(resultFile, timeoutMs, request.signal, async () => {
			await sendKeyToSurface(workspaceRef, surfaceRef, "ctrl-c");
		});
		request.onStreamEvent?.({ role: request.role, type: "status", status: "completed" });
		const elapsedMs = Date.now() - startedAt;
		await writeFile(statusFile, JSON.stringify({ status: "completed", role: request.role, label: request.label, surfaceRef, elapsedMs }, null, 2), "utf8");
		return buildVisiblePiResult(request, output, elapsedMs);
	} catch (error) {
		request.onStreamEvent?.({ role: request.role, type: "status", status: request.signal?.aborted ? "aborted" : "aborted" });
		await writeFile(statusFile, JSON.stringify({ status: "failed", role: request.role, label: request.label, surfaceRef, error: error instanceof Error ? error.message : String(error), elapsedMs: Date.now() - startedAt }, null, 2), "utf8");
		throw error;
	} finally {
		await closeVisiblePiSurface(workspaceRef, surfaceRef, layoutKey, SURFACE_CLOSE_GRACE_MS);
	}
}

function buildVisiblePiResult(request: RunVisiblePiSubagentRequest, output: string, elapsedMs: number): OrchSubagentResult {
	return {
		role: request.role,
		provider: request.configState.merged.roles[request.role].provider,
		modelId: request.configState.merged.roles[request.role].model,
		output,
		outputSource: "assistant_text",
		emptyFinalText: output.trim().length === 0,
		toolEvents: [],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			costTotal: 0,
		},
		toolCalls: 0,
		elapsedMs,
	};
}

function buildVisiblePiPrompt(request: RunVisiblePiSubagentRequest, resultFile: string): string {
	return [
		`You are a visible Orch ${request.role} sub-agent running in your own Pi session for CMUX visibility.`,
		`Task label: ${request.label}`,
		"Do not delegate or spawn other agents. Do not use Orch delegation tools. Complete the assigned task yourself in this Pi session.",
		"The orchestrator is waiting for your final answer through a result file.",
		`When you are done, write your complete final answer to exactly this path: ${resultFile}`,
		"You may use the write tool for that result file. For read-only/research/validator roles, do not modify repository files other than this result file.",
		"After writing the result file, also print the same final answer in this Pi chat so the user can see it in CMUX.",
		"",
		"Original delegated task:",
		request.prompt,
	].join("\n");
}

function buildPiCommand(request: RunVisiblePiSubagentRequest, promptFile: string): string {
	const model = request.configState.merged.roles[request.role];
	const args = [
		"env",
		`${VISIBLE_WORKER_ENV}=1`,
		`${VISIBLE_ROLE_ENV}=${request.role}`,
		`${VISIBLE_LABEL_ENV}=${request.label}`,
		"pi",
		"--model",
		`${model.provider}/${model.model}`,
		"--tools",
		getVisiblePiTools(request).join(","),
		"--no-extensions",
		"-e",
		CMUX_SPAWNED_FOOTER_EXTENSION,
		"--no-context-files",
	];
	if (request.thinkingLevel && request.thinkingLevel !== "off") {
		args.push("--thinking", request.thinkingLevel);
	}
	args.push(`@${promptFile}`);
	return `cd ${quoteForShell(request.cwd)} && ${args.map(quoteForShell).join(" ")}\n`;
}

function getVisiblePiTools(request: RunVisiblePiSubagentRequest): string[] {
	if (request.toolNames && request.toolNames.length > 0) {
		return Array.from(new Set([...request.toolNames, "write"]));
	}
	switch (request.role) {
		case "worker":
			return WORKER_TOOLS;
		case "validator":
			return VALIDATOR_TOOLS;
		case "research":
			return RESEARCH_TOOLS;
		case "plan_codebase":
		case "smart_friend":
		case "orchestrator":
		default:
			return READ_ONLY_TOOLS;
	}
}

type VisiblePiSurfaceRequest = {
	workspaceRef: string;
	callerSurfaceRef: string;
	role: OrchRoleName;
	label: string;
	parallelIndex?: number;
	parallelTotal?: number;
	layoutGroupId?: string;
};

async function createVisiblePiSurface(request: VisiblePiSurfaceRequest): Promise<string | undefined> {
	if (shouldUseGridLayout(request.parallelIndex, request.parallelTotal)) {
		return createGridVisiblePiSurface(request);
	}

	const layoutKey = getSimpleLayoutKey(request.workspaceRef);
	return enqueueLayout(layoutKey, async () => {
		const state = getOrCreateLayoutState(layoutKey, request.workspaceRef, request.callerSurfaceRef);
		return createSimpleVisiblePiSurface(state, request.role, request.label);
	});
}

async function createSimpleVisiblePiSurface(
	state: VisiblePiLayoutState,
	role: OrchRoleName,
	label: string,
): Promise<string | undefined> {
	const title = truncateForCmux(`${role}: ${label}`, MAX_TITLE_LENGTH);
	let surface: CmuxSurfaceResponse | undefined;
	if (state.lastSurfaceRef) {
		surface = await runCmuxJson<CmuxSurfaceResponse>([
			"new-split",
			"down",
			"--workspace",
			state.workspaceRef,
			"--surface",
			state.lastSurfaceRef,
			"--focus",
			"false",
		]);
	}

	if (!surface?.surface_ref) {
		const anchorSurface = await findBestAnchorSurface(state.workspaceRef, state.callerSurfaceRef);
		const direction = anchorSurface === state.callerSurfaceRef ? "right" : "down";
		surface = await runCmuxJson<CmuxSurfaceResponse>([
			"new-split",
			direction,
			"--workspace",
			state.workspaceRef,
			"--surface",
			anchorSurface,
			"--focus",
			"false",
		]);
	}

	const surfaceRef = surface?.surface_ref;
	if (!surfaceRef) {
		return undefined;
	}
	state.lastSurfaceRef = surfaceRef;
	await runCmux(["rename-tab", "--workspace", state.workspaceRef, "--surface", surfaceRef, title]);
	return surfaceRef;
}

async function createGridVisiblePiSurface(request: VisiblePiSurfaceRequest): Promise<string | undefined> {
	const parallelIndex = request.parallelIndex;
	if (!Number.isInteger(parallelIndex) || parallelIndex === undefined || parallelIndex < 0) {
		return undefined;
	}

	const layoutKey = getGridLayoutKey(request.workspaceRef, request.layoutGroupId ?? DEFAULT_GRID_LAYOUT_GROUP_ID);
	const state = getOrCreateLayoutState(layoutKey, request.workspaceRef, request.callerSurfaceRef);
	const slot = ensureLayoutSlot(state, parallelIndex);
	if (slot.started) {
		return slot.promise;
	}
	slot.started = true;

	try {
		// Parallel visible workers can race each other. We gate each index on the
		// previous index so the group always materializes in a deterministic order:
		// 0 creates the right-side worker area, 1 extends it downward, 2 creates the
		// top-right cell, 3 creates the bottom-right cell, and later workers keep
		// growing the grid in alternating down/right steps.
		if (parallelIndex > 0) {
			const previousSurfaceRef = await ensureLayoutSlot(state, parallelIndex - 1).promise;
			if (!previousSurfaceRef) {
				slot.resolve(undefined);
				return undefined;
			}
		}

		const surfaceRef = await enqueueLayout(layoutKey, async () => {
			const existing = state.surfaceRefsByIndex.get(parallelIndex);
			if (existing) {
				return existing;
			}
			return createGridVisiblePiSurfaceNow(state, request.role, request.label, parallelIndex);
		});
		slot.resolve(surfaceRef);
		return surfaceRef;
	} catch (error) {
		slot.reject(error);
		throw error;
	}
}

async function createGridVisiblePiSurfaceNow(
	state: VisiblePiLayoutState,
	role: OrchRoleName,
	label: string,
	parallelIndex: number,
): Promise<string | undefined> {
	const title = truncateForCmux(`${role}: ${label}`, MAX_TITLE_LENGTH);
	const placement = getGridPlacement(parallelIndex);
	const anchorSurfaceRef = placement.anchorIndex === undefined
		? state.callerSurfaceRef
		: state.surfaceRefsByIndex.get(placement.anchorIndex) ?? state.workerAreaSurfaceRef ?? state.callerSurfaceRef;
	let surface = await createSplitSurface(state.workspaceRef, anchorSurfaceRef, placement.direction);
	if (!surface?.surface_ref) {
		const fallbackAnchorSurfaceRef = await findBestAnchorSurface(state.workspaceRef, state.callerSurfaceRef);
		if (fallbackAnchorSurfaceRef !== anchorSurfaceRef) {
			surface = await createSplitSurface(state.workspaceRef, fallbackAnchorSurfaceRef, placement.direction);
		}
	}
	const surfaceRef = surface?.surface_ref;
	if (!surfaceRef) {
		return undefined;
	}

	if (parallelIndex === 0) {
		state.workerAreaSurfaceRef = surfaceRef;
	}
	state.lastSurfaceRef = surfaceRef;
	state.surfaceRefsByIndex.set(parallelIndex, surfaceRef);
	await runCmux(["rename-tab", "--workspace", state.workspaceRef, "--surface", surfaceRef, title]);
	return surfaceRef;
}

type GridPlacement = {
	anchorIndex?: number;
	direction: "right" | "down";
};

// Grid policy for visible parallel workers:
// - 0 creates the root worker area to the right of the caller
// - 1 grows a second row under the root
// - 2 and 3 create the right column for rows 0 and 1
// - 4+ keep extending the left column downward, then fill that row's right cell
function getGridPlacement(parallelIndex: number): GridPlacement {
	if (parallelIndex === 0) {
		return { direction: "right" };
	}
	if (parallelIndex === 1) {
		return { anchorIndex: 0, direction: "down" };
	}
	if (parallelIndex === 2) {
		return { anchorIndex: 0, direction: "right" };
	}
	if (parallelIndex === 3) {
		return { anchorIndex: 1, direction: "right" };
	}

	const offset = parallelIndex - 4;
	const row = 2 + Math.floor(offset / 2);
	const isRightColumn = offset % 2 === 1;
	if (isRightColumn) {
		return {
			anchorIndex: getGridLeftColumnIndex(row),
			direction: "right",
		};
	}
	return {
		anchorIndex: getGridLeftColumnIndex(row - 1),
		direction: "down",
	};
}

function getGridLeftColumnIndex(row: number): number {
	if (row === 0) {
		return 0;
	}
	if (row === 1) {
		return 1;
	}
	return 4 + (row - 2) * 2;
}

function shouldUseGridLayout(parallelIndex: number | undefined, parallelTotal: number | undefined): boolean {
	return Number.isInteger(parallelIndex) && (parallelIndex ?? -1) >= 0 && typeof parallelTotal === "number" && parallelTotal > 2;
}

function getVisiblePiLayoutKey(workspaceRef: string, request: Pick<RunVisiblePiSubagentRequest, "parallelIndex" | "parallelTotal" | "layoutGroupId">): string {
	if (shouldUseGridLayout(request.parallelIndex, request.parallelTotal)) {
		return getGridLayoutKey(workspaceRef, request.layoutGroupId ?? DEFAULT_GRID_LAYOUT_GROUP_ID);
	}
	return getSimpleLayoutKey(workspaceRef);
}

function getSimpleLayoutKey(workspaceRef: string): string {
	return `${workspaceRef}::visible-simple`;
}

function getGridLayoutKey(workspaceRef: string, layoutGroupId: string): string {
	return `${workspaceRef}::visible-grid::${layoutGroupId}`;
}

function getOrCreateLayoutState(layoutKey: string, workspaceRef: string, callerSurfaceRef: string): VisiblePiLayoutState {
	const existing = visibleLayouts.get(layoutKey);
	if (existing) {
		existing.callerSurfaceRef = callerSurfaceRef;
		return existing;
	}

	const state: VisiblePiLayoutState = {
		layoutKey,
		workspaceRef,
		callerSurfaceRef,
		surfaceRefsByIndex: new Map<number, string>(),
		slots: new Map<number, Deferred<string | undefined>>(),
	};
	visibleLayouts.set(layoutKey, state);
	return state;
}

function ensureLayoutSlot(state: VisiblePiLayoutState, index: number): Deferred<string | undefined> {
	const existing = state.slots.get(index);
	if (existing) {
		return existing;
	}
	const deferred = createDeferred<string | undefined>();
	state.slots.set(index, deferred);
	return deferred;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: Deferred<T>["resolve"];
	let reject!: Deferred<T>["reject"];
	const deferred: Deferred<T> = {
		promise: new Promise<T>((innerResolve, innerReject) => {
			resolve = (value) => {
				deferred.settled = true;
				innerResolve(value);
			};
			reject = (reason) => {
				deferred.settled = true;
				innerReject(reason);
			};
		}),
		resolve: (value) => resolve(value),
		reject: (reason) => reject(reason),
		settled: false,
		started: false,
	};
	return deferred;
}

async function findBestAnchorSurface(workspaceRef: string, callerSurfaceRef: string): Promise<string> {
	const panes = await runCmuxJson<CmuxPanesResponse>(["list-panes", "--workspace", workspaceRef]);
	const candidates = (panes?.panes ?? [])
		.filter((pane) => !(pane.surface_refs ?? []).includes(callerSurfaceRef))
		.filter((pane) => pane.selected_surface_ref || (pane.surface_refs?.length ?? 0) > 0)
		.sort((a, b) => {
			const ax = a.pixel_frame?.x ?? a.index ?? 0;
			const bx = b.pixel_frame?.x ?? b.index ?? 0;
			if (bx !== ax) return bx - ax;
			return (b.pixel_frame?.width ?? 0) - (a.pixel_frame?.width ?? 0);
		});
	const chosen = candidates[0];
	return chosen?.selected_surface_ref ?? chosen?.surface_refs?.[0] ?? callerSurfaceRef;
}

function enqueueLayout<T>(layoutKey: string, task: () => Promise<T>): Promise<T> {
	const queue = layoutQueues.get(layoutKey) ?? Promise.resolve();
	const run = queue.then(task, task);
	layoutQueues.set(layoutKey, run.catch(() => undefined));
	return run;
}

async function waitForResultFile(
	resultFile: string,
	timeoutMs: number,
	signal: AbortSignal | undefined,
	onAbort: () => Promise<void>,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (signal?.aborted) {
			await onAbort().catch(() => {});
			throw new Error("Visible CMUX Pi sub-agent aborted.");
		}
		try {
			const text = await readFile(resultFile, "utf8");
			if (text.trim().length > 0) {
				return text.trim();
			}
		} catch {
			// Result file not written yet.
		}
		await new Promise((resolve) => setTimeout(resolve, RESULT_POLL_INTERVAL_MS));
	}
	await onAbort().catch(() => {});
	throw new Error(`Visible CMUX Pi sub-agent did not write result file within ${Math.round(timeoutMs / 1000)}s.`);
}

async function closeVisiblePiSurface(
	workspaceRef: string,
	surfaceRef: string,
	layoutKey: string,
	graceMs: number,
): Promise<void> {
	if (graceMs > 0) {
		await new Promise((resolve) => setTimeout(resolve, graceMs));
	}
	await runCmux(["close-surface", "--workspace", workspaceRef, "--surface", surfaceRef]);
	removeSurfaceFromLayout(layoutKey, surfaceRef);
}

function removeSurfaceFromLayout(layoutKey: string, surfaceRef: string): void {
	const state = visibleLayouts.get(layoutKey);
	if (!state) {
		return;
	}
	if (state.lastSurfaceRef === surfaceRef) {
		state.lastSurfaceRef = undefined;
	}
	if (state.workerAreaSurfaceRef === surfaceRef) {
		state.workerAreaSurfaceRef = undefined;
	}
	for (const [index, indexedSurfaceRef] of state.surfaceRefsByIndex.entries()) {
		if (indexedSurfaceRef === surfaceRef) {
			state.surfaceRefsByIndex.delete(index);
		}
	}
	if (!state.lastSurfaceRef && !state.workerAreaSurfaceRef && state.surfaceRefsByIndex.size === 0) {
		visibleLayouts.delete(layoutKey);
	}
}

async function createSplitSurface(
	workspaceRef: string,
	surfaceRef: string,
	direction: "right" | "down",
): Promise<CmuxSurfaceResponse | undefined> {
	return runCmuxJson<CmuxSurfaceResponse>([
		"new-split",
		direction,
		"--workspace",
		workspaceRef,
		"--surface",
		surfaceRef,
		"--focus",
		"false",
	]);
}

async function runCmuxJson<T>(args: string[]): Promise<T | undefined> {
	try {
		const { stdout } = await execFileAsync("cmux", ["--json", ...args], {
			encoding: "utf8",
			maxBuffer: 1024 * 1024,
			timeout: CMUX_COMMAND_TIMEOUT_MS,
		});
		return JSON.parse(stdout) as T;
	} catch {
		return undefined;
	}
}

async function runCmux(args: string[]): Promise<void> {
	try {
		await execFileAsync("cmux", args, { timeout: CMUX_COMMAND_TIMEOUT_MS });
	} catch {
		// CMUX UI helpers must not fail the parent Orch task.
	}
}

async function sendToSurface(workspaceRef: string, surfaceRef: string, text: string): Promise<void> {
	await runCmux(["send", "--workspace", workspaceRef, "--surface", surfaceRef, text]);
}

async function sendKeyToSurface(workspaceRef: string, surfaceRef: string, key: string): Promise<void> {
	await runCmux(["send-key", "--workspace", workspaceRef, "--surface", surfaceRef, key]);
}

function sanitizeForFileName(value: string): string {
	return value.replace(/[^a-z0-9_-]/gi, "_");
}

function truncateForCmux(value: string, maxLength: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function quoteForShell(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}
