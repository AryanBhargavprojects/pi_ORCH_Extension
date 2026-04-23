import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { loadOrchConfig, type OrchRoleName } from "./config.js";
import { ORCH_TOOL_NAMES } from "./constants.js";
import { loadOrchRolePrompt } from "./prompt-loader.js";
import { spawnOrchSubagent } from "./role-runner.js";
import type { OrchRuntimeState } from "./runtime.js";

export function registerInteractiveOrch(pi: ExtensionAPI, state: OrchRuntimeState): void {
	pi.registerTool({
		name: ORCH_TOOL_NAMES.delegate,
		label: "Orch Delegate",
		description: "Run a fresh Orch sub-agent with the configured orchestrator, worker, or validator model.",
		promptSnippet: "Delegate focused planning, implementation, or validation work to a fresh Orch role session.",
		promptGuidelines: [
			"Use orch_delegate when you need a fresh Orch orchestrator, worker, or validator with isolated context.",
			"When delegating, include the relevant file paths, constraints, and expected output in the task itself because the sub-agent starts fresh.",
		],
		parameters: Type.Object({
			role: StringEnum(["orchestrator", "worker", "validator"] as const, {
				description: "Which Orch role to run in a fresh context",
			}),
			task: Type.String({ description: "Self-contained task for the selected Orch role" }),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			state.configState = await loadOrchConfig(ctx.cwd);
			onUpdate?.({
				content: [{ type: "text", text: `Running Orch ${params.role}...` }],
				details: {
					role: params.role,
					status: "running",
				},
			});

			const result = await spawnOrchSubagent({
				role: params.role as OrchRoleName,
				prompt: params.task,
				cwd: ctx.cwd,
				configState: state.configState,
				modelRegistry: ctx.modelRegistry,
			});

			const summary = [`Orch ${result.role}`, `${result.provider}/${result.modelId}`].join(" • ");

			return {
				content: [
					{
						type: "text",
						text: result.output.length > 0 ? result.output : `${summary} completed with no text output.`,
					},
				],
				details: {
					role: result.role,
					provider: result.provider,
					modelId: result.modelId,
					usage: result.usage,
				},
			};
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		state.configState = await loadOrchConfig(ctx.cwd);
		const config = state.configState.merged;
		const orchestratorPrompt = await loadOrchRolePrompt("orchestrator");
		const interactivePrompt = [
			orchestratorPrompt,
			"# Orch Interactive Mode",
			"You are operating as Orch's default interactive orchestrator.",
			"Stay conversational and keep the user in the loop.",
			"Use built-in tools directly for simple inspection or straightforward edits when that is the fastest path.",
			`Use ${ORCH_TOOL_NAMES.delegate} when a task benefits from fresh isolated context, or when you want a separate worker or validator pass.`,
			"Do not silently switch into autonomous mission mode. Full autonomous execution only begins when the user explicitly invokes /mission.",
			`Configured Orch role models: orchestrator=${config.roles.orchestrator.provider}/${config.roles.orchestrator.model}, worker=${config.roles.worker.provider}/${config.roles.worker.model}, validator=${config.roles.validator.provider}/${config.roles.validator.model}.`,
		].join("\n\n");

		return {
			systemPrompt: `${event.systemPrompt}\n\n${interactivePrompt}`,
		};
	});
}
