import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

const execFileAsync = promisify(execFile);

export const PARALLEL_SEARCH_TOOL_NAME = "parallel_search";
export const PARALLEL_FETCH_TOOL_NAME = "parallel_fetch";

const PARALLEL_CLI_BIN = "parallel-cli";
const PARALLEL_CLI_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_CHARS = 50_000;

type ParallelCliResult = {
	stdout: string;
	stderr: string;
	exitCode: number | null;
};

export function registerParallelTools(pi: ExtensionAPI): void {
	pi.registerTool(createParallelSearchToolDefinition());
	pi.registerTool(createParallelFetchToolDefinition());
}

export function createParallelSearchToolDefinition() {
	return defineTool({
		name: PARALLEL_SEARCH_TOOL_NAME,
		label: "Parallel Search",
		description: "Search the web using Parallel's AI-powered search. Returns structured JSON results with titles, URLs, and excerpts. Prefer this over bash parallel-cli for web research.",
		promptSnippet: "Search the web using Parallel's AI-powered search. Returns structured JSON results with titles, URLs, and excerpts.",
		promptGuidelines: [
			"Use parallel_search for current web research, source-backed search, API doc lookup, and reference page retrieval.",
			"Provide a natural-language objective describing what you need. Optionally narrow with query keywords, domains, or mode.",
			"Use parallel_fetch to extract full content from specific URLs found by parallel_search.",
			"Prefer these first-class Parallel tools over bash parallel-cli calls. They are safer and avoid shell pipe/redirection issues.",
			"Cite source URLs from the results in your response.",
		],
		parameters: Type.Object({
			objective: Type.String({
				description: "Natural language description of what you're looking for.",
			}),
			query: Type.Optional(Type.String({
				description: "Optional keyword search query. If omitted, the objective is used directly.",
			})),
			mode: Type.Optional(StringEnum(["fast", "basic", "advanced"], {
				description: "Search mode: fast/basic is cheaper and faster; advanced is more thorough (agentic). Defaults to basic.",
			})),
			maxResults: Type.Optional(Type.Number({
				description: "Maximum number of results to return (defaults to 10).",
				minimum: 1,
				maximum: 50,
			})),
			includeDomains: Type.Optional(Type.String({
				description: "Comma-separated list of domains to restrict search to (e.g. 'docs.python.org,github.com').",
			})),
			excludeDomains: Type.Optional(Type.String({
				description: "Comma-separated list of domains to exclude from search.",
			})),
			sessionId: Type.Optional(Type.String({
				description: "Session ID to group related search/extract calls.",
			})),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const args = buildParallelSearchArgs(params);
			const result = await runParallelCli(args, signal);
			const output = formatParallelCliOutput(result);
			const truncated = output.length > MAX_OUTPUT_CHARS;
			const text = truncated
				? `${output.slice(0, MAX_OUTPUT_CHARS)}\n\n[Output truncated to ${MAX_OUTPUT_CHARS} characters.]`
				: output;

			return {
				content: [{ type: "text", text }],
				details: {
					exitCode: result.exitCode,
					truncated,
				},
			};
		},
	});
}

export function createParallelFetchToolDefinition() {
	return defineTool({
		name: PARALLEL_FETCH_TOOL_NAME,
		label: "Parallel Fetch",
		description: "Extract content from URLs as clean markdown using Parallel. Prefer this over bash parallel-cli extract/fetch for web page retrieval.",
		promptSnippet: "Extract content from URLs as clean markdown using Parallel.",
		promptGuidelines: [
			"Use parallel_fetch to extract clean markdown content from specific URLs.",
			"Provide at least one URL. You can pass multiple URLs to extract from several pages at once.",
			"Use --fullContent or set fullContent=true for complete page content when deep research is needed.",
			"Use parallel_search first to find relevant URLs, then parallel_fetch to extract full content.",
			"Prefer these first-class Parallel tools over bash parallel-cli. They are safer and avoid shell pipe/redirection issues.",
			"Cite the source URLs in your response.",
		],
		parameters: Type.Object({
			urls: Type.String({
				description: "One or more URLs to extract content from, separated by spaces.",
			}),
			objective: Type.Optional(Type.String({
				description: "Focus extraction on a specific goal or topic.",
			})),
			fullContent: Type.Optional(Type.Boolean({
				description: "Include complete page content instead of just excerpts. Defaults to false.",
			})),
			sessionId: Type.Optional(Type.String({
				description: "Session ID to group related search/extract calls.",
			})),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const args = buildParallelFetchArgs(params);
			const result = await runParallelCli(args, signal);
			const output = formatParallelCliOutput(result);
			const truncated = output.length > MAX_OUTPUT_CHARS;
			const text = truncated
				? `${output.slice(0, MAX_OUTPUT_CHARS)}\n\n[Output truncated to ${MAX_OUTPUT_CHARS} characters.]`
				: output;

			return {
				content: [{ type: "text", text }],
				details: {
					exitCode: result.exitCode,
					truncated,
				},
			};
		},
	});
}

function buildParallelSearchArgs(params: {
	objective: string;
	query?: string;
	mode?: string;
	maxResults?: number;
	includeDomains?: string;
	excludeDomains?: string;
	sessionId?: string;
}): string[] {
	const args: string[] = ["search"];

	// Push objective as positional arg if no query; otherwise use query
	if (params.query?.trim()) {
		args.push("--query", params.query.trim());
		// Also pass objective if present
		if (params.objective.trim()) {
			args.push(params.objective.trim());
		}
	} else {
		args.push(params.objective.trim());
	}

	if (params.mode) {
		args.push("--mode", params.mode);
	}
	if (params.maxResults !== undefined) {
		args.push("--max-results", String(params.maxResults));
	}
	if (params.includeDomains?.trim()) {
		for (const domain of params.includeDomains.split(",").map((d) => d.trim()).filter(Boolean)) {
			args.push("--include-domains", domain);
		}
	}
	if (params.excludeDomains?.trim()) {
		for (const domain of params.excludeDomains.split(",").map((d) => d.trim()).filter(Boolean)) {
			args.push("--exclude-domains", domain);
		}
	}
	if (params.sessionId?.trim()) {
		args.push("--session-id", params.sessionId.trim());
	}

	args.push("--json");
	return args;
}

function buildParallelFetchArgs(params: {
	urls: string;
	objective?: string;
	fullContent?: boolean;
	sessionId?: string;
}): string[] {
	const args: string[] = ["fetch"];

	if (params.objective?.trim()) {
		args.push("--objective", params.objective.trim());
	}
	if (params.fullContent) {
		args.push("--full-content");
	}
	if (params.sessionId?.trim()) {
		args.push("--session-id", params.sessionId.trim());
	}

	// URLs are positional, split by whitespace
	const urls = params.urls.trim().split(/\s+/).filter(Boolean);
	for (const url of urls) {
		args.push(url);
	}

	args.push("--json");
	return args;
}

async function runParallelCli(args: string[], signal?: AbortSignal): Promise<ParallelCliResult> {
	const controller = new AbortController();
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, PARALLEL_CLI_TIMEOUT_MS);

	const abortHandler = () => controller.abort();
	if (signal) {
		if (signal.aborted) {
			controller.abort();
		} else {
			signal.addEventListener("abort", abortHandler, { once: true });
		}
	}

	try {
		const { stdout, stderr } = await execFileAsync(PARALLEL_CLI_BIN, args, {
			timeout: PARALLEL_CLI_TIMEOUT_MS,
			maxBuffer: 10 * 1024 * 1024, // 10MB
			signal: controller.signal,
			env: { ...process.env },
		});

		return { stdout, stderr, exitCode: 0 };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		const exitCode = typeof (error as { exitCode?: number }).exitCode === "number"
			? (error as { exitCode: number }).exitCode
			: null;
		const stderr = (error as { stderr?: string }).stderr ?? "";
		const stdout = (error as { stdout?: string }).stdout ?? "";

		if (timedOut) {
			return {
				stdout,
				stderr: `Parallel CLI timed out after ${PARALLEL_CLI_TIMEOUT_MS / 1000} seconds.\n${stderr}`,
				exitCode,
			};
		}

		if (code === "ENOENT") {
			return {
				stdout: "",
				stderr: `Parallel CLI binary not found: ${PARALLEL_CLI_BIN}. Install with instructions at https://parallel.ai or ensure parallel-cli is in PATH.`,
				exitCode: 127,
			};
		}

		if (signal?.aborted) {
			return {
				stdout,
				stderr: `Parallel CLI was aborted.\n${stderr}`,
				exitCode,
			};
		}

		return {
			stdout,
			stderr: stderr || String(error),
			exitCode,
		};
	} finally {
		clearTimeout(timeout);
		if (signal) {
			signal.removeEventListener("abort", abortHandler);
		}
	}
}

function formatParallelCliOutput(result: ParallelCliResult): string {
	const parts: string[] = [];

	if (result.stdout.trim()) {
		// Try to pretty-print JSON for readability
		try {
			const parsed = JSON.parse(result.stdout);
			parts.push(JSON.stringify(parsed, null, 2));
		} catch {
			parts.push(result.stdout.trim());
		}
	}

	if (result.stderr.trim()) {
		if (parts.length > 0) {
			parts.push("");
		}
		parts.push(`[stderr] ${result.stderr.trim()}`);
	}

	if (result.exitCode !== 0 && result.exitCode !== null) {
		if (parts.length > 0) {
			parts.push("");
		}
		parts.push(`[exit code: ${result.exitCode}]`);
	}

	if (parts.length === 0) {
		return "Parallel CLI returned no output.";
	}

	return parts.join("\n");
}


