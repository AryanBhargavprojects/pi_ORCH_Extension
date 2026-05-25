import { execFile } from "node:child_process";
import { basename } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { PlanPhase } from "./plan-types.js";
import type { OrchRuntimeState, OrchTodoItem } from "./runtime.js";

const CMUX_STATUS_KEY = "orch";
const CMUX_COMMAND_TIMEOUT_MS = 2500;
const MAX_STATUS_TEXT = 96;
const MAX_LABEL_TEXT = 120;
const MAX_NOTIFICATION_BODY = 420;
const PHASE_PROGRESS: Record<PlanPhase, number> = {
	clarifying: 0.1,
	"researching-codebase": 0.3,
	"researching-docs": 0.5,
	"assessing-feasibility": 0.7,
	synthesizing: 0.9,
	completed: 1,
	cancelled: 1,
	failed: 1,
};

let cmuxAvailable: boolean | undefined;
let lastTodoCompletionSignature: string | undefined;
let agentTurnActive = false;

export function registerCmuxIntegration(pi: ExtensionAPI, state: OrchRuntimeState): void {
	pi.on("session_start", async (_event, ctx) => {
		void setCmuxStatus("ready", { icon: "sparkles", color: "#8e8eff" });
		void cmuxLog(`Orch loaded in ${basename(ctx.cwd)}`, "info");
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (state.activeMission || state.activePlan) {
			return;
		}
		agentTurnActive = true;
		void setCmuxStatus("Pi task running", { icon: "hammer", color: "#ff9500" });
		void setCmuxProgress(0.05, "Pi task running…");
		void cmuxLog(`Pi task started in ${basename(ctx.cwd)}`, "info");
	});

	pi.on("tool_execution_start", async (event) => {
		if (!agentTurnActive || state.activeMission || state.activePlan) {
			return;
		}
		void setCmuxStatus(`tool: ${event.toolName}`, { icon: "hammer", color: "#ff9500" });
		void setCmuxProgress(0.35, `Using ${event.toolName}…`);
	});

	pi.on("tool_execution_end", async (event) => {
		if (!agentTurnActive || state.activeMission || state.activePlan) {
			return;
		}
		if (event.isError) {
			void setCmuxStatus(`tool failed: ${event.toolName}`, { icon: "xmark", color: "#ff3b30" });
			void cmuxLog(`Tool failed: ${event.toolName}`, "error");
			return;
		}
		void setCmuxProgress(0.7, "Finishing Pi task…");
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!agentTurnActive || state.activeMission || state.activePlan) {
			return;
		}
		agentTurnActive = false;
		void setCmuxProgress(1, "Pi task complete");
		void setCmuxStatus("task complete", { icon: "checkmark", color: "#34c759" });
		void cmuxLog("Pi task complete", "success");
		void cmuxNotify("Pi task complete", `Finished in ${basename(ctx.cwd)}`);
		setTimeout(() => {
			void clearCmuxProgress();
			void setCmuxStatus("ready", { icon: "sparkles", color: "#8e8eff" });
		}, 1200).unref?.();
	});

	pi.on("session_shutdown", async () => {
		agentTurnActive = false;
		void clearCmuxProgress();
		void clearCmuxStatus();
	});
}

export function syncCmuxMissionStatus(state: OrchRuntimeState, text: string | undefined): void {
	if (!text) {
		return;
	}

	const mission = state.activeMission;
	const progress = getMissionProgress(state);
	void setCmuxStatus(`goal: ${text}`, { icon: "hammer", color: "#ff9500" });
	void setCmuxProgress(progress.value, progress.label ?? `Goal: ${text}`);
	if (mission) {
		void cmuxLog(`Goal ${mission.id}: ${text}`, "info");
	}
}

export function completeCmuxMission(status: "completed" | "needs-attention" | "failed" | "interrupted", goal: string, body?: string): void {
	const isSuccess = status === "completed";
	const isFailure = status === "failed";
	const title = isSuccess ? "Orch goal complete" : status === "interrupted" ? "Orch goal interrupted" : "Orch goal needs attention";
	const level = isSuccess ? "success" : isFailure ? "error" : "warning";
	void setCmuxProgress(1, title);
	void setCmuxStatus(title, { icon: isSuccess ? "checkmark" : "exclamationmark.triangle", color: isSuccess ? "#34c759" : isFailure ? "#ff3b30" : "#ff9500" });
	void cmuxLog(`${title}: ${goal}`, level);
	void cmuxNotify(title, truncateText(body || goal, MAX_NOTIFICATION_BODY));
	setTimeout(() => {
		void clearCmuxProgress();
		void setCmuxStatus("ready", { icon: "sparkles", color: "#8e8eff" });
	}, 1800).unref?.();
}

export function syncCmuxPlanStatus(state: OrchRuntimeState, text: string | undefined): void {
	if (!text) {
		return;
	}

	const phase = state.activePlan?.phase;
	const progress = phase ? PHASE_PROGRESS[phase] ?? 0.2 : 0.2;
	const label = state.activePlan?.lastActivity || `Plan: ${text}`;
	void setCmuxStatus(`plan: ${text}`, { icon: "clock", color: "#0a84ff" });
	void setCmuxProgress(progress, label);
	void cmuxLog(`Plan: ${text}`, "info");
}

export function completeCmuxPlan(status: "completed" | "cancelled" | "failed", goal: string, body?: string): void {
	const title = status === "completed" ? "Orch plan complete" : status === "cancelled" ? "Orch plan cancelled" : "Orch plan failed";
	const level = status === "completed" ? "success" : status === "failed" ? "error" : "warning";
	void setCmuxProgress(1, title);
	void setCmuxStatus(title, { icon: status === "completed" ? "checkmark" : "xmark", color: status === "completed" ? "#34c759" : status === "failed" ? "#ff3b30" : "#ff9500" });
	void cmuxLog(`${title}: ${goal}`, level);
	void cmuxNotify(title, truncateText(body || goal, MAX_NOTIFICATION_BODY));
	setTimeout(() => {
		void clearCmuxProgress();
		void setCmuxStatus("ready", { icon: "sparkles", color: "#8e8eff" });
	}, 1800).unref?.();
}

export function syncCmuxTodos(todos: OrchTodoItem[]): void {
	if (todos.length === 0) {
		return;
	}
	const completed = todos.filter((todo) => todo.status === "completed").length;
	const inProgress = todos.find((todo) => todo.status === "in_progress");
	const allComplete = completed === todos.length;
	const label = allComplete
		? `Todos complete (${completed}/${todos.length})`
		: inProgress
			? `Todo: ${inProgress.content}`
			: `Todos ${completed}/${todos.length}`;

	void setCmuxStatus(label, { icon: allComplete ? "checkmark" : "list.bullet", color: allComplete ? "#34c759" : "#ff9500" });
	void setCmuxProgress(completed / todos.length, label);

	if (allComplete) {
		const signature = todos.map((todo) => `${todo.id}:${todo.status}`).join("|");
		if (signature !== lastTodoCompletionSignature) {
			lastTodoCompletionSignature = signature;
			void cmuxLog(label, "success");
			void cmuxNotify("Orch todos complete", label);
		}
		setTimeout(() => {
			void clearCmuxProgress();
			void setCmuxStatus("ready", { icon: "sparkles", color: "#8e8eff" });
		}, 1200).unref?.();
	} else {
		lastTodoCompletionSignature = undefined;
	}
}

function getMissionProgress(state: OrchRuntimeState): { value: number; label?: string } {
	const features = state.activeMission?.featuresState?.features ?? [];
	if (features.length === 0) {
		return { value: 0.1 };
	}
	const done = features.filter((feature) => feature.status === "done").length;
	const failed = features.filter((feature) => feature.status === "failed").length;
	const active = features.find((feature) => feature.status === "in-progress");
	const label = active
		? `Goal: ${active.title}`
		: failed > 0
			? `Goal: ${done}/${features.length} done, ${failed} failed`
			: `Goal: ${done}/${features.length} features done`;
	return { value: Math.max(0.05, Math.min(0.98, done / features.length)), label };
}

async function setCmuxStatus(text: string, options?: { icon?: string; color?: string }): Promise<void> {
	const args = ["set-status", CMUX_STATUS_KEY, truncateText(text, MAX_STATUS_TEXT)];
	if (options?.icon) {
		args.push("--icon", options.icon);
	}
	if (options?.color) {
		args.push("--color", options.color);
	}
	await runCmux(args);
}

async function clearCmuxStatus(): Promise<void> {
	await runCmux(["clear-status", CMUX_STATUS_KEY]);
}

async function setCmuxProgress(value: number, label: string): Promise<void> {
	const normalized = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
	await runCmux(["set-progress", normalized.toFixed(2), "--label", truncateText(label, MAX_LABEL_TEXT)]);
}

async function clearCmuxProgress(): Promise<void> {
	await runCmux(["clear-progress"]);
}

async function cmuxLog(message: string, level: "info" | "success" | "warning" | "error" = "info"): Promise<void> {
	await runCmux(["log", "--level", level, "--source", "orch", truncateText(message, MAX_NOTIFICATION_BODY)]);
}

async function cmuxNotify(title: string, body: string): Promise<void> {
	await runCmux(["notify", "--title", truncateText(title, 80), "--body", truncateText(body, MAX_NOTIFICATION_BODY)]);
}

async function runCmux(args: string[]): Promise<void> {
	if (!shouldAttemptCmux()) {
		return;
	}

	try {
		await new Promise<void>((resolve, reject) => {
			const child = execFile("cmux", args, { timeout: CMUX_COMMAND_TIMEOUT_MS }, (error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
			child.on("error", reject);
		});
		cmuxAvailable = true;
	} catch {
		cmuxAvailable = false;
	}
}

function shouldAttemptCmux(): boolean {
	if (cmuxAvailable !== undefined) {
		return cmuxAvailable;
	}
	return Boolean(process.env.CMUX_SURFACE_ID || process.env.CMUX_WORKSPACE_ID || process.env.CMUX_PANEL_ID || process.env.CMUX_PANE_ID);
}

function truncateText(text: string, maxLength: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}
