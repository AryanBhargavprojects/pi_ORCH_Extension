import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import type { OrchRoleName } from "./config.js";
import type { OrchCmuxMissionStreaming, OrchCmuxRoleStream } from "./runtime.js";

const execFileAsync = promisify(execFile);
const CMUX_ROLE_ORDER: OrchRoleName[] = ["worker", "validator"];

type CmuxIdentifyResponse = {
	caller?: {
		workspace_ref?: string;
		surface_ref?: string;
		pane_ref?: string;
	};
	focused?: {
		workspace_ref?: string;
		surface_ref?: string;
		pane_ref?: string;
	};
};

type CmuxSplitResponse = {
	workspace_ref?: string;
	surface_ref?: string;
	pane_ref?: string;
};

export async function setupCmuxMissionStreaming(
	missionsDir: string,
	missionId: string,
	goal: string,
): Promise<OrchCmuxMissionStreaming | undefined> {
	const identify = await safeIdentifyCmux();
	if (!identify) {
		return undefined;
	}

	const workspaceRef = identify.caller?.workspace_ref;
	const anchorSurfaceRef = identify.caller?.surface_ref;
	const anchorPanelRef = identify.caller?.pane_ref ?? identify.caller?.surface_ref;
	if (!workspaceRef || !anchorSurfaceRef || !anchorPanelRef) {
		return undefined;
	}

	const streamDir = join(missionsDir, ".streams", missionId);
	await mkdir(streamDir, { recursive: true });

	const roleStreams: Partial<Record<OrchRoleName, OrchCmuxRoleStream>> = {};
	const createdSurfaceRefs: string[] = [];

	try {
		const worker = await createSplit("right", workspaceRef, anchorPanelRef);
		createdSurfaceRefs.push(worker.surfaceRef);
		const validator = await createSplit("down", workspaceRef, worker.paneRef ?? worker.surfaceRef);
		createdSurfaceRefs.push(validator.surfaceRef);

		roleStreams.worker = await createRoleStream(streamDir, missionId, goal, "worker", worker);
		roleStreams.validator = await createRoleStream(streamDir, missionId, goal, "validator", validator);

		await Promise.all(CMUX_ROLE_ORDER.map((role) => attachTail(roleStreams[role]!, workspaceRef)));
		await focusSurface(workspaceRef, anchorSurfaceRef);

		return {
			enabled: true,
			workspaceRef,
			anchorSurfaceRef,
			roleStreams,
			streamDir,
		};
	} catch (error) {
		await Promise.allSettled(createdSurfaceRefs.map((surfaceRef) => closeSurface(workspaceRef, surfaceRef)));
		await Promise.allSettled(
			Object.values(roleStreams).map(async (roleStream) => {
				roleStream?.stream.end();
			}),
		);
		throw error;
	}
}

export function writeCmuxRoleMarker(
	streaming: OrchCmuxMissionStreaming | undefined,
	role: OrchRoleName,
	label: string,
): void {
	if (!streaming?.enabled) {
		return;
	}
	const roleStream = streaming.roleStreams[role];
	if (!roleStream) {
		return;
	}
	roleStream.stream.write(`\n\n===== ${label} =====\n\n`);
}

export function appendCmuxRoleDelta(
	streaming: OrchCmuxMissionStreaming | undefined,
	role: OrchRoleName,
	delta: string,
): void {
	if (!streaming?.enabled || delta.length === 0) {
		return;
	}
	const roleStream = streaming.roleStreams[role];
	if (!roleStream) {
		return;
	}
	roleStream.stream.write(delta);
}

export async function cleanupCmuxMissionStreaming(
	streaming: OrchCmuxMissionStreaming | undefined,
	footer: string,
): Promise<void> {
	if (!streaming?.enabled) {
		return;
	}

	for (const roleStream of Object.values(streaming.roleStreams)) {
		roleStream?.stream.write(`\n\n===== ${footer} =====\n`);
	}

	const roleStreams = Object.values(streaming.roleStreams).filter(
		(roleStream): roleStream is OrchCmuxRoleStream => roleStream !== undefined,
	);

	await Promise.all(
		roleStreams.map(
			(roleStream) =>
				new Promise<void>((resolve) => {
					roleStream.stream.end(resolve);
				}),
		),
	);

	await Promise.allSettled(roleStreams.map((roleStream) => closeSurface(streaming.workspaceRef, roleStream.surfaceRef)));
	await focusSurface(streaming.workspaceRef, streaming.anchorSurfaceRef).catch(() => {
		// Focus restore is best-effort during teardown.
	});
}

async function safeIdentifyCmux(): Promise<CmuxIdentifyResponse | undefined> {
	try {
		return await runCmuxJson<CmuxIdentifyResponse>(["identify"]);
	} catch {
		return undefined;
	}
}

async function createSplit(
	direction: "right" | "down",
	workspaceRef: string,
	panelRef: string,
): Promise<{ surfaceRef: string; paneRef?: string }> {
	const response = await runCmuxJson<CmuxSplitResponse>([
		"new-split",
		direction,
		"--workspace",
		workspaceRef,
		"--panel",
		panelRef,
	]);

	if (!response.surface_ref) {
		throw new Error(`cmux new-split did not return a surface_ref for ${direction} split.`);
	}

	return {
		surfaceRef: response.surface_ref,
		paneRef: response.pane_ref ?? response.surface_ref,
	};
}

async function createRoleStream(
	streamDir: string,
	missionId: string,
	goal: string,
	role: OrchRoleName,
	surface: { surfaceRef: string; paneRef?: string },
): Promise<OrchCmuxRoleStream> {
	const logFilePath = join(streamDir, `${role}.log`);
	const header = [
		`Orch ${role} stream`,
		`Mission: ${missionId}`,
		`Goal: ${goal}`,
		"",
	].join("\n");
	await writeFile(logFilePath, header, "utf8");
	const stream = createWriteStream(logFilePath, { flags: "a" });

	return {
		role,
		surfaceRef: surface.surfaceRef,
		paneRef: surface.paneRef,
		logFilePath,
		stream,
	};
}

async function attachTail(roleStream: OrchCmuxRoleStream, workspaceRef: string): Promise<void> {
	await sendToSurface(workspaceRef, roleStream.surfaceRef, "clear\\n");
	await sendToSurface(
		workspaceRef,
		roleStream.surfaceRef,
		`tail -n +1 -f -- ${quoteForShell(roleStream.logFilePath)}\\n`,
	);
}

async function focusSurface(workspaceRef: string, surfaceRef: string): Promise<void> {
	await runCmux(["focus-panel", "--workspace", workspaceRef, "--panel", surfaceRef]);
}

async function closeSurface(workspaceRef: string, surfaceRef: string): Promise<void> {
	await runCmux(["close-surface", "--workspace", workspaceRef, "--surface", surfaceRef]);
}

async function sendToSurface(workspaceRef: string, surfaceRef: string, text: string): Promise<void> {
	await runCmux(["send", "--workspace", workspaceRef, "--surface", surfaceRef, text]);
}

async function runCmuxJson<T>(args: string[]): Promise<T> {
	const stdout = await runCmux(["--json", ...args]);
	return JSON.parse(stdout) as T;
}

async function runCmux(args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("cmux", args, {
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
	});
	return stdout;
}

function quoteForShell(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}
