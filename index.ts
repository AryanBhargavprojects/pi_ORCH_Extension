import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { loadOrchConfig } from "./config.js";
import { ORCH_WIDGET_IDS } from "./constants.js";
import { registerOrchCommands } from "./commands.js";
import { registerOrchFooter } from "./footer.js";
import { registerImagePasteAttachments } from "./image-paste.js";
import { registerInteractiveOrch } from "./interactive.js";
import { registerMissionCommand } from "./mission.js";
import { registerPlanCommand } from "./plan.js";
import { registerOrchMessageRenderer } from "./messages.js";
import { registerOrchModelCommand } from "./model-command.js";
import { clearOrchStatus, createRuntimeState, markSessionStart, setOrchStatus } from "./runtime.js";
import { registerOrchLoadingIndicator } from "./loading.js";
import { registerCompactToolRenderers } from "./tool-renderers.js";

export default function orchExtension(pi: ExtensionAPI): void {
	const runtimeState = createRuntimeState();

	registerOrchMessageRenderer(pi);
	registerOrchLoadingIndicator(pi);
	registerCompactToolRenderers(pi);
	registerOrchCommands(pi, runtimeState);
	registerOrchFooter(pi, runtimeState);
	registerOrchModelCommand(pi, runtimeState);
	registerImagePasteAttachments(pi);
	registerMissionCommand(pi, runtimeState);
	registerPlanCommand(pi, runtimeState);
	registerInteractiveOrch(pi, runtimeState);

	pi.on("session_start", async (event, ctx) => {
		runtimeState.configState = await loadOrchConfig(ctx.cwd);
		markSessionStart(runtimeState, event.reason);
		setOrchStatus(ctx, runtimeState);

		if (ctx.hasUI && runtimeState.configState.warnings.length > 0) {
			ctx.ui.notify(runtimeState.configState.warnings.join("\n"), "warning");
		}

		if (ctx.hasUI && event.reason === "reload") {
			ctx.ui.notify(`Orch reloaded at ${runtimeState.loadedAt}`, "info");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (runtimeState.activeMission && !runtimeState.activeMission.abortController.signal.aborted) {
			runtimeState.activeMission.abortController.abort();
		}
		if (runtimeState.activePlan && !runtimeState.activePlan.abortController.signal.aborted) {
			runtimeState.activePlan.abortController.abort();
		}
		if (runtimeState.activePlan) {
			runtimeState.activePlan = undefined;
		}
		clearOrchStatus(ctx);
		if (ctx.hasUI) {
			ctx.ui.setStatus("orch-mission", undefined);
			ctx.ui.setStatus("orch-plan", undefined);
			ctx.ui.setWidget(ORCH_WIDGET_IDS.missionBlock, undefined);
			ctx.ui.setWidget(ORCH_WIDGET_IDS.missionThinking, undefined);
			ctx.ui.setWidget(ORCH_WIDGET_IDS.missionProgress, undefined);
			ctx.ui.setWidget(ORCH_WIDGET_IDS.planProgress, undefined);
		}
	});
}
