import { execFile } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { OrchCmuxVisibility, OrchRoleName } from "./config.js";
import type { OrchSubagentStreamEvent } from "./role-runner.js";

const execFileAsync = promisify(execFile);
const CMUX_COMMAND_TIMEOUT_MS = 2500;
const MAX_CMUX_LABEL_LENGTH = 48;

const STATUS_COLOR_RUNNING = "#ff9500";
const STATUS_COLOR_DONE = "#34c759";
const STATUS_COLOR_ERROR = "#ff3b30";

type CmuxIdentifyResponse = {
	caller?: {
		workspace_ref?: string;
		surface_ref?: string;
		pane_ref?: string;
	};
};

type CmuxSurfaceResponse = {
	workspace_ref?: string;
	surface_ref?: string;
	pane_ref?: string;
};

export type OrchSubagentCmuxHandle = {
	logFilePath: string;
	stream: WriteStream;
	workspaceRef: string;
	startedAt: number;
	label: string;
	role: OrchRoleName;
	statusKey: string;
	surfaceRef?: string;
};

let cmuxGloballyAvailable: boolean | undefined;

/** Check whether CMUX is reachable from the caller workspace. Cached after first call. */
async function isCmuxAvailable(): Promise<boolean> {
	if (cmuxGloballyAvailable !== undefined) {
		return cmuxGloballyAvailable;
	}

	// Stay scoped to cmux-spawned terminals. If the env is absent, no-op instead of
	// guessing from the visually focused workspace.
	if (!process.env.CMUX_WORKSPACE_ID && !process.env.CMUX_SURFACE_ID) {
		cmuxGloballyAvailable = false;
		return false;
	}

	try {
		await execFileAsync("cmux", ["--json", "identify"], {
			timeout: CMUX_COMMAND_TIMEOUT_MS,
			encoding: "utf8",
		});
		cmuxGloballyAvailable = true;
	} catch {
		cmuxGloballyAvailable = false;
	}
	return cmuxGloballyAvailable;
}

function shouldCreatePane(visibility: OrchCmuxVisibility): boolean {
	return visibility === "panes" || visibility === "auto";
}

/**
 * Create a CMUX visibility handle for a sub-agent.
 *
 * This mirrors Orch's existing AgentSession stream into a log file and, when
 * configured, opens a no-focus terminal surface that tails the log. It does not
 * spawn a separate CLI agent and does not feed pane output back into prompts.
 */
export async function createSubagentCmuxHandle(
	cwd: string,
	role: OrchRoleName,
	label: string,
	visibility: OrchCmuxVisibility,
): Promise<OrchSubagentCmuxHandle | undefined> {
	if (visibility === "off" || !(await isCmuxAvailable())) {
		return undefined;
	}

	const identify = await runCmuxJson<CmuxIdentifyResponse>(["identify"]);
	const workspaceRef = process.env.CMUX_WORKSPACE_ID || identify?.caller?.workspace_ref;
	if (!workspaceRef) {
		return undefined;
	}

	const logDir = join(cwd, ".pi", "orch", "streams");
	await mkdir(logDir, { recursive: true });

	const timestamp = Date.now();
	const safeRole = sanitizeForFileName(role);
	const safeLabel = sanitizeForFileName(label).slice(0, 60) || "subagent";
	const logFilePath = join(logDir, `${timestamp}-${safeRole}-${safeLabel}.log`);
	const shortLabel = truncateForCmux(`${role}: ${label}`, MAX_CMUX_LABEL_LENGTH);
	const statusKey = `orch-${safeRole}-${timestamp}`;

	const header = [
		"# Orch Sub-Agent Stream",
		`# Role: ${role}`,
		`# Label: ${label}`,
		`# Workspace: ${workspaceRef}`,
		`# Started: ${new Date(timestamp).toISOString()}`,
		"",
	].join("\n");
	await writeFile(logFilePath, header, "utf8");
	const stream = createWriteStream(logFilePath, { flags: "a" });

	const handle: OrchSubagentCmuxHandle = {
		logFilePath,
		stream,
		workspaceRef,
		startedAt: timestamp,
		label,
		role,
		statusKey,
	};

	void runCmux(["set-status", statusKey, "starting", "--workspace", workspaceRef, "--color", STATUS_COLOR_RUNNING]);
	void runCmux(["log", "--workspace", workspaceRef, "--source", "orch", `Started ${shortLabel}`]);

	if (!shouldCreatePane(visibility)) {
		return handle;
	}

	try {
		const surface = await runCmuxJson<CmuxSurfaceResponse>([
			"new-pane",
			"--workspace",
			workspaceRef,
			"--type",
			"terminal",
			"--direction",
			"right",
			"--focus",
			"false",
		]);
		const surfaceRef = surface?.surface_ref;
		if (!surfaceRef) {
			return handle;
		}

		handle.surfaceRef = surfaceRef;
		await runCmux(["rename-tab", "--workspace", workspaceRef, "--surface", surfaceRef, shortLabel]);
		await sendToSurface(workspaceRef, surfaceRef, "clear\n");
		await sendToSurface(workspaceRef, surfaceRef, `tail -n +1 -f -- ${quoteForShell(logFilePath)}\n`);
	} catch {
		// CMUX pane creation is best-effort. Keep the log/status handle alive.
	}

	return handle;
}

/** Write a stream event to the sub-agent's CMUX log/status surface. */
export function writeSubagentCmuxEvent(
	handle: OrchSubagentCmuxHandle | undefined,
	event: OrchSubagentStreamEvent,
): void {
	if (!handle) return;

	const stream = handle.stream;
	const ts = new Date().toISOString();

	switch (event.type) {
		case "status": {
			if (event.status === "starting") {
				stream.write(`\n[${ts}] ─ START ${handle.role} (${handle.label}) ─\n`);
				void runCmux([
					"set-status",
					handle.statusKey,
					"running",
					"--workspace",
					handle.workspaceRef,
					"--color",
					STATUS_COLOR_RUNNING,
				]);
			} else if (event.status === "completed") {
				const elapsed = Math.round((Date.now() - handle.startedAt) / 1000);
				stream.write(`\n[${ts}] ─ END ${handle.role} — ${elapsed}s ─\n`);
				void runCmux([
					"set-status",
					handle.statusKey,
					"done",
					"--workspace",
					handle.workspaceRef,
					"--color",
					STATUS_COLOR_DONE,
				]);
			} else if (event.status === "aborted") {
				const elapsed = Math.round((Date.now() - handle.startedAt) / 1000);
				stream.write(`\n[${ts}] ─ ABORTED ${handle.role} after ${elapsed}s ─\n`);
				void runCmux([
					"set-status",
					handle.statusKey,
					"aborted",
					"--workspace",
					handle.workspaceRef,
					"--color",
					STATUS_COLOR_ERROR,
				]);
			}
			return;
		}
		case "tool_call": {
			const diffNote = event.diff ? " (+diff)" : "";
			stream.write(`\n[${ts}] tool: ${event.label} — ${event.detail}${diffNote}\n`);
			return;
		}
		case "tool_diff": {
			stream.write(`\n[${ts}] preview: ${event.label} — ${event.detail}\n`);
			return;
		}
		case "thinking_delta": {
			stream.write(event.delta);
			return;
		}
		case "text_delta": {
			stream.write(event.delta);
			return;
		}
	}
}

/** Close the log stream and update CMUX status. Leaves the visible surface open. */
export async function closeSubagentCmuxHandle(
	handle: OrchSubagentCmuxHandle | undefined,
	summary: string,
): Promise<void> {
	if (!handle) return;

	const ts = new Date().toISOString();
	const elapsed = Math.round((Date.now() - handle.startedAt) / 1000);
	handle.stream.write(`\n[${ts}] CLOSED — ${summary} — ${elapsed}s\n`);

	await new Promise<void>((resolve) => {
		handle.stream.end(resolve);
	});

	const failed = summary.startsWith("failed") || summary === "aborted";
	void runCmux([
		"set-status",
		handle.statusKey,
		failed ? "failed" : "done",
		"--workspace",
		handle.workspaceRef,
		"--color",
		failed ? STATUS_COLOR_ERROR : STATUS_COLOR_DONE,
	]);
	void runCmux([
		"log",
		"--workspace",
		handle.workspaceRef,
		"--source",
		"orch",
		`${failed ? "Finished with error" : "Finished"} ${truncateForCmux(`${handle.role}: ${handle.label}`, MAX_CMUX_LABEL_LENGTH)}`,
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
		// CMUX visibility must never fail the Orch task.
	}
}

async function sendToSurface(workspaceRef: string, surfaceRef: string, text: string): Promise<void> {
	await runCmux(["send", "--workspace", workspaceRef, "--surface", surfaceRef, text]);
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
