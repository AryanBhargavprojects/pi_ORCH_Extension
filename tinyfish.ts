import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type } from "@sinclair/typebox";
import { defineTool, getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

export const TINYFISH_TOOL_NAME = "tinyfish";

const TINYFISH_API_ENDPOINT = "https://agent.tinyfish.ai/v1/automation/run-sse";
const TINYFISH_KEY_FILE_NAME = "tinyfish-api-key";
const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 300;
const MAX_OUTPUT_CHARS = 50_000;

type TinyFishRunResult = {
	result: unknown;
	eventCount: number;
	completed: boolean;
};

export function getTinyFishApiKeyPath(): string {
	return join(getAgentDir(), "orch", TINYFISH_KEY_FILE_NAME);
}

export async function saveTinyFishApiKey(apiKey: string): Promise<void> {
	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new Error("TinyFish API key is empty.");
	}
	const keyPath = getTinyFishApiKeyPath();
	await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
	await writeFile(keyPath, `${trimmed}\n`, { mode: 0o600 });
	await chmod(keyPath, 0o600);
}

export function registerTinyFishTool(pi: ExtensionAPI): void {
	pi.registerTool(createTinyFishToolDefinition());
}

export function createTinyFishToolDefinition() {
	return defineTool({
		name: TINYFISH_TOOL_NAME,
		label: "TinyFish",
		description: "Run the TinyFish web automation/search agent for current web search, website extraction, scraping, and online fact gathering.",
		promptSnippet: "Run the TinyFish web automation/search agent for current web search, website extraction, scraping, and online fact gathering.",
		promptGuidelines: [
			"Use tinyfish when the user asks for current web search, online information, live website extraction, scraping, or source-backed web research.",
			"Provide either a query for broad web search or a url plus goal for a specific website. Ask TinyFish to return source URLs when doing research.",
			"Do not include API keys or secrets in tinyfish inputs.",
		],
		parameters: Type.Object({
			query: Type.Optional(Type.String({
				description: "Web search query. If url is omitted, TinyFish opens DuckDuckGo HTML search results for this query.",
			})),
			url: Type.Optional(Type.String({
				description: "Specific http(s) URL for TinyFish to automate or extract from. Use this instead of query for a known target page.",
			})),
			goal: Type.Optional(Type.String({
				description: "Natural-language instruction for TinyFish. If omitted with query, TinyFish summarizes the best results with source URLs.",
			})),
			timeoutSeconds: Type.Optional(Type.Number({
				description: `Maximum TinyFish run time in seconds. Defaults to ${DEFAULT_TIMEOUT_SECONDS}; max ${MAX_TIMEOUT_SECONDS}.`,
				minimum: 10,
				maximum: MAX_TIMEOUT_SECONDS,
			})),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const { url, goal } = normalizeTinyFishParams(params);
			const apiKey = await resolveTinyFishApiKey();
			const timeoutSeconds = clampTimeoutSeconds(params.timeoutSeconds);
			const run = await runTinyFishAutomation({ apiKey, url, goal, timeoutSeconds, signal });
			const formatted = formatTinyFishResult(run.result);
			const truncated = formatted.length > MAX_OUTPUT_CHARS;
			const output = truncated
				? `${formatted.slice(0, MAX_OUTPUT_CHARS)}\n\n[Output truncated to ${MAX_OUTPUT_CHARS} characters.]`
				: formatted;

			return {
				content: [{ type: "text", text: output }],
				details: {
					url,
					goal,
					eventCount: run.eventCount,
					completed: run.completed,
					truncated,
				},
			};
		},
	});
}

function normalizeTinyFishParams(params: { query?: string; url?: string; goal?: string }): { url: string; goal: string } {
	const query = params.query?.trim();
	const rawUrl = params.url?.trim();
	const rawGoal = params.goal?.trim();

	if (!query && !rawUrl) {
		throw new Error("TinyFish requires either query or url.");
	}

	const url = rawUrl ? validateHttpUrl(rawUrl) : buildSearchUrl(query ?? "");
	const goal = rawGoal && rawGoal.length > 0
		? rawGoal
		: query
			? `Search the web for ${JSON.stringify(query)}. Return a concise answer with the most relevant source URLs and note any uncertainty.`
			: "Extract the information requested by the user. Return concise structured results with source URLs where available.";

	return { url, goal };
}

function buildSearchUrl(query: string): string {
	return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
}

function validateHttpUrl(value: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`TinyFish url must be a valid http(s) URL: ${value}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`TinyFish url must use http or https, got ${parsed.protocol}`);
	}
	return parsed.toString();
}

function clampTimeoutSeconds(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_TIMEOUT_SECONDS;
	}
	return Math.max(10, Math.min(MAX_TIMEOUT_SECONDS, Math.round(value)));
}

async function resolveTinyFishApiKey(): Promise<string> {
	const envKey = process.env.TINYFISH_API_KEY?.trim();
	if (envKey) {
		return envKey;
	}

	const keyPath = getTinyFishApiKeyPath();
	try {
		const fileKey = (await readFile(keyPath, "utf8")).trim();
		if (fileKey) {
			return fileKey;
		}
	} catch (error) {
		if (!isNodeErrorCode(error, "ENOENT")) {
			throw error;
		}
	}

	throw new Error(`TinyFish API key is not configured. Set TINYFISH_API_KEY or create ${keyPath}.`);
}

async function runTinyFishAutomation(request: {
	apiKey: string;
	url: string;
	goal: string;
	timeoutSeconds: number;
	signal?: AbortSignal;
}): Promise<TinyFishRunResult> {
	const controller = new AbortController();
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, request.timeoutSeconds * 1000);
	const abortHandler = () => controller.abort();

	if (request.signal) {
		if (request.signal.aborted) {
			controller.abort();
		} else {
			request.signal.addEventListener("abort", abortHandler, { once: true });
		}
	}

	try {
		const response = await fetch(TINYFISH_API_ENDPOINT, {
			method: "POST",
			headers: {
				"X-API-Key": request.apiKey,
				"Content-Type": "application/json",
				Accept: "text/event-stream",
			},
			body: JSON.stringify({ url: request.url, goal: request.goal }),
			signal: controller.signal,
		});

		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(`TinyFish request failed (${response.status} ${response.statusText})${body ? `: ${truncateOneLine(body, 500)}` : ""}`);
		}

		if (!response.body) {
			throw new Error("TinyFish response did not include a stream body.");
		}

		return await parseTinyFishSse(response.body);
	} catch (error) {
		if (timedOut) {
			throw new Error(`TinyFish run timed out after ${request.timeoutSeconds} seconds.`);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
		if (request.signal) {
			request.signal.removeEventListener("abort", abortHandler);
		}
	}
}

async function parseTinyFishSse(body: ReadableStream<Uint8Array>): Promise<TinyFishRunResult> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let eventName: string | undefined;
	let dataLines: string[] = [];
	let eventCount = 0;
	let lastPayload: unknown;

	const dispatch = (): { completed: boolean; result?: unknown } => {
		if (dataLines.length === 0) {
			eventName = undefined;
			return { completed: false };
		}

		const data = dataLines.join("\n").trim();
		dataLines = [];
		const currentEventName = eventName;
		eventName = undefined;

		if (!data || data === "[DONE]") {
			return { completed: false };
		}

		const payload = parseSseData(data, currentEventName);
		eventCount += 1;
		lastPayload = payload;

		const payloadRecord = asRecord(payload);
		const payloadType = normalizeEventType(payloadRecord?.type ?? currentEventName);
		if (payloadType === "ERROR" || payloadType === "FAILED" || payloadType === "FAILURE") {
			throw new Error(`TinyFish failed: ${formatTinyFishResult(payloadRecord?.error ?? payloadRecord?.message ?? payload)}`);
		}
		if (payloadType === "COMPLETE" || payloadType === "COMPLETED" || payloadType === "DONE") {
			return { completed: true, result: payloadRecord?.result ?? payloadRecord?.data ?? payload };
		}

		return { completed: false };
	};

	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				if (line === "") {
					const dispatched = dispatch();
					if (dispatched.completed) {
						await reader.cancel().catch(() => undefined);
						return { result: dispatched.result, eventCount, completed: true };
					}
					continue;
				}
				if (line.startsWith(":")) {
					continue;
				}
				const colon = line.indexOf(":");
				const field = colon === -1 ? line : line.slice(0, colon);
				const valueText = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
				if (field === "event") {
					eventName = valueText;
				} else if (field === "data") {
					dataLines.push(valueText);
				}
			}
		}

		buffer += decoder.decode();
		if (buffer.trim().length > 0) {
			dataLines.push(buffer.trim());
		}
		const dispatched = dispatch();
		if (dispatched.completed) {
			return { result: dispatched.result, eventCount, completed: true };
		}
		if (lastPayload !== undefined) {
			return { result: lastPayload, eventCount, completed: false };
		}
		throw new Error("TinyFish stream ended without result data.");
	} finally {
		reader.releaseLock();
	}
}

function parseSseData(data: string, eventName: string | undefined): unknown {
	try {
		return JSON.parse(data);
	} catch {
		return eventName ? { type: eventName, data } : data;
	}
}

function normalizeEventType(value: unknown): string | undefined {
	return typeof value === "string" ? value.trim().toUpperCase() : undefined;
}

function formatTinyFishResult(value: unknown): string {
	if (typeof value === "string") {
		return value.trim();
	}
	const record = asRecord(value);
	if (record && typeof record.text === "string" && Object.keys(record).length === 1) {
		return record.text.trim();
	}
	return JSON.stringify(value, null, 2) ?? String(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function truncateOneLine(value: string, maxLength: number): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, Math.max(0, maxLength - 1))}…`;
}
