import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, AssistantMessage, Model, TextContent } from "@mariozechner/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";

import type { OrchLoadedConfig, OrchRoleName } from "./config.js";
import type {
	MissionFeature,
	MissionFixTask,
	MissionPromptSharedState,
	SteeringResult,
	ValidationContract,
	WorkerRun,
} from "./mission-types.js";
import { buildSharedStatePromptSection } from "./mission-state.js";
import { loadOrchRolePrompt } from "./prompt-loader.js";

export type OrchSubagentStreamEvent =
	| {
		role: OrchRoleName;
		type: "status";
		status: "starting" | "completed" | "aborted";
	  }
	| {
		role: OrchRoleName;
		type: "thinking_delta" | "text_delta";
		delta: string;
	  };

export type OrchSubagentRequest = {
	role: OrchRoleName;
	prompt: string;
	cwd: string;
	configState: OrchLoadedConfig;
	modelRegistry: ModelRegistry;
	signal?: AbortSignal;
	onStreamEvent?: (event: OrchSubagentStreamEvent) => void;
};

export type OrchSubagentResult = {
	role: OrchRoleName;
	provider: string;
	modelId: string;
	output: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		costTotal: number;
	};
};

export type OrchWorkerSubagentRequest = {
	goal: string;
	missionSummary: string;
	feature: MissionFeature;
	validationContract: ValidationContract;
	sharedState: MissionPromptSharedState;
	steering?: SteeringResult;
	cwd: string;
	configState: OrchLoadedConfig;
	modelRegistry: ModelRegistry;
	signal?: AbortSignal;
	onStreamEvent?: (event: OrchSubagentStreamEvent) => void;
};

export type OrchValidatorSubagentRequest = {
	goal: string;
	missionSummary: string;
	feature: MissionFeature;
	validationContract: ValidationContract;
	sharedState: MissionPromptSharedState;
	workerRun: WorkerRun;
	cwd: string;
	configState: OrchLoadedConfig;
	modelRegistry: ModelRegistry;
	signal?: AbortSignal;
	onStreamEvent?: (event: OrchSubagentStreamEvent) => void;
};

const ORCHESTRATOR_TOOLS = ["read", "bash", "grep", "find", "ls"];
const WORKER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const VALIDATOR_TOOLS = ["read", "bash", "grep", "find", "ls"];

export async function spawnOrchSubagent(request: OrchSubagentRequest): Promise<OrchSubagentResult> {
	const modelConfig = request.configState.merged.roles[request.role];
	const model = resolveConfiguredModel(request.modelRegistry, modelConfig.provider, modelConfig.model, request.role);
	const rolePrompt = await loadOrchRolePrompt(request.role);
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: request.cwd,
		agentDir: getAgentDir(),
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		systemPromptOverride: (base) => [rolePrompt, base].filter(Boolean).join("\n\n"),
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: request.cwd,
		model,
		modelRegistry: request.modelRegistry,
		resourceLoader,
		tools: getRoleTools(request.role),
		sessionManager: SessionManager.inMemory(request.cwd),
		settingsManager,
	});

	const unsubscribe = session.subscribe((event) => {
		if (event.type !== "message_update") {
			return;
		}

		if (event.assistantMessageEvent.type === "thinking_delta") {
			request.onStreamEvent?.({
				role: request.role,
				type: "thinking_delta",
				delta: event.assistantMessageEvent.delta,
			});
			return;
		}

		if (event.assistantMessageEvent.type === "text_delta") {
			request.onStreamEvent?.({
				role: request.role,
				type: "text_delta",
				delta: event.assistantMessageEvent.delta,
			});
		}
	});

	const abortHandler = () => {
		request.onStreamEvent?.({ role: request.role, type: "status", status: "aborted" });
		void session.abort().catch(() => {
			// Ignore abort races.
		});
	};

	if (request.signal) {
		if (request.signal.aborted) {
			abortHandler();
		} else {
			request.signal.addEventListener("abort", abortHandler, { once: true });
		}
	}

	try {
		request.onStreamEvent?.({ role: request.role, type: "status", status: "starting" });
		await session.bindExtensions({});
		await session.prompt(request.prompt);
		request.onStreamEvent?.({ role: request.role, type: "status", status: "completed" });
		const assistantMessage = findLastAssistantMessage(session.messages);
		const output = assistantMessage ? getAssistantText(assistantMessage) : "";

		return {
			role: request.role,
			provider: model.provider,
			modelId: model.id,
			output,
			usage: {
				input: assistantMessage?.usage?.input ?? 0,
				output: assistantMessage?.usage?.output ?? 0,
				cacheRead: assistantMessage?.usage?.cacheRead ?? 0,
				cacheWrite: assistantMessage?.usage?.cacheWrite ?? 0,
				totalTokens: assistantMessage?.usage?.totalTokens ?? 0,
				costTotal: assistantMessage?.usage?.cost?.total ?? 0,
			},
		};
	} finally {
		unsubscribe();
		if (request.signal) {
			request.signal.removeEventListener("abort", abortHandler);
		}
		session.dispose();
	}
}

export async function runOrchWorkerSubagent(request: OrchWorkerSubagentRequest): Promise<OrchSubagentResult> {
	return spawnOrchSubagent({
		role: "worker",
		prompt: buildWorkerSubagentPrompt(request),
		cwd: request.cwd,
		configState: request.configState,
		modelRegistry: request.modelRegistry,
		signal: request.signal,
		onStreamEvent: request.onStreamEvent,
	});
}

export async function runOrchValidatorSubagent(request: OrchValidatorSubagentRequest): Promise<OrchSubagentResult> {
	return spawnOrchSubagent({
		role: "validator",
		prompt: buildValidatorSubagentPrompt(request),
		cwd: request.cwd,
		configState: request.configState,
		modelRegistry: request.modelRegistry,
		signal: request.signal,
		onStreamEvent: request.onStreamEvent,
	});
}

function resolveConfiguredModel(
	modelRegistry: ModelRegistry,
	provider: string,
	modelId: string,
	role: OrchRoleName,
): Model<Api> {
	const model = modelRegistry.find(provider, modelId);
	if (!model) {
		throw new Error(`Orch ${role} model not found: ${provider}/${modelId}`);
	}
	if (!modelRegistry.hasConfiguredAuth(model)) {
		throw new Error(`No configured auth for Orch ${role} model: ${provider}/${modelId}`);
	}
	return model;
}

function getRoleTools(role: OrchRoleName): string[] {
	switch (role) {
		case "orchestrator":
			return ORCHESTRATOR_TOOLS;
		case "worker":
			return WORKER_TOOLS;
		case "validator":
			return VALIDATOR_TOOLS;
	}
}

function buildWorkerSubagentPrompt(request: OrchWorkerSubagentRequest): string {
	const dependencySummary = request.feature.dependencies.length > 0 ? request.feature.dependencies.join(", ") : "none";
	const steeringText = request.steering
		? [request.steering.summary, ...request.steering.instructions.map((instruction) => `- ${instruction}`)].join("\n")
		: "none";
	const validationCriteria = request.validationContract.criteria.map(
		(criterion) => `- ${criterion.id}: ${criterion.title} (${criterion.type}) — ${criterion.description}`,
	);
	const fixTaskLines = formatFixTasks(request.steering?.fixTasks ?? []);

	return [
		"Execute the assigned Orch worker feature and prepare a validator-ready handoff.",
		`Mission goal: ${request.goal}`,
		`Mission summary: ${request.missionSummary}`,
		`Feature ID: ${request.feature.id}`,
		`Feature title: ${request.feature.title}`,
		`Feature goal: ${request.feature.goal}`,
		`Dependencies: ${dependencySummary}`,
		"Deliverables:",
		...(request.feature.deliverables.length > 0
			? request.feature.deliverables.map((deliverable) => `- ${deliverable}`)
			: ["- none"]),
		"Feature notes:",
		...(request.feature.notes.length > 0 ? request.feature.notes.map((note) => `- ${note}`) : ["- none"]),
		"Validation contract:",
		...validationCriteria,
		...buildSharedStatePromptSection(request.sharedState, true),
		"Steering instructions from the orchestrator:",
		steeringText,
		"Fix tasks created from the latest validator findings:",
		...fixTaskLines,
		"You may edit files and run commands as needed, but stay within this feature's scope.",
		"You may also read and update the shared mission-state files when they help coordination, documentation, or handoff quality.",
		"Return strict JSON only with this shape:",
		'{ "summary": "string", "changes": ["path: description"], "testsRun": ["string"], "notes": ["string"], "followUps": ["string"], "handoff": "string" }',
		"The handoff must help a fresh validator understand what changed, what was verified, and what still needs scrutiny.",
	].join("\n");
}

function buildValidatorSubagentPrompt(request: OrchValidatorSubagentRequest): string {
	const validationCriteria = request.validationContract.criteria.map(
		(criterion) => `- ${criterion.id}: ${criterion.title} (${criterion.type}) — ${criterion.description}`,
	);

	return [
		"Validate a worker handoff for a single Orch mission feature.",
		`Mission goal: ${request.goal}`,
		`Mission summary: ${request.missionSummary}`,
		`Feature ID: ${request.feature.id}`,
		`Feature title: ${request.feature.title}`,
		`Feature goal: ${request.feature.goal}`,
		"Feature deliverables:",
		...(request.feature.deliverables.length > 0
			? request.feature.deliverables.map((deliverable) => `- ${deliverable}`)
			: ["- none"]),
		"Validation contract:",
		...validationCriteria,
		...buildSharedStatePromptSection(request.sharedState, false),
		"Worker summary:",
		request.workerRun.summary,
		"Worker handoff:",
		request.workerRun.handoff,
		"Worker-declared changes:",
		...(request.workerRun.changes.length > 0 ? request.workerRun.changes.map((change) => `- ${change}`) : ["- none"]),
		"Worker-declared tests:",
		...(request.workerRun.testsRun.length > 0 ? request.workerRun.testsRun.map((test) => `- ${test}`) : ["- none"]),
		"Worker notes:",
		...(request.workerRun.notes.length > 0 ? request.workerRun.notes.map((note) => `- ${note}`) : ["- none"]),
		"Inspect the repository and determine whether this feature is complete. Never modify project source files.",
		"You may append observations to the shared mission knowledge base if that helps later agents avoid repeated mistakes.",
		"Return strict JSON only with this shape:",
		'{ "passed": true, "summary": "string", "issues": [{ "severity": "critical|major|minor", "title": "string", "details": "string", "action": "string" }], "evidence": ["string"] }',
	].join("\n");
}

function formatFixTasks(fixTasks: MissionFixTask[]): string[] {
	if (fixTasks.length === 0) {
		return ["- none"];
	}

	return fixTasks.flatMap((task) => {
		const lines = [`- ${task.id}: ${task.title}`];
		for (const instruction of task.instructions) {
			lines.push(`  - instruction: ${instruction}`);
		}
		for (const deliverable of task.deliverables) {
			lines.push(`  - deliverable: ${deliverable}`);
		}
		for (const note of task.notes) {
			lines.push(`  - note: ${note}`);
		}
		return lines;
	});
}

function findLastAssistantMessage(messages: AgentMessage[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (isAssistantMessage(message)) {
			return message;
		}
	}
	return undefined;
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && Array.isArray(message.content);
}

function getAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trim();
}
