import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Reusable Pi-native, Hunk-inspired diff helpers for Orch.
 *
 * Hunk itself renders through OpenTUI/React, while Pi extensions render through
 * @mariozechner/pi-tui Components. These helpers keep the review-first feel
 * (file headers, hunk ranges, side line numbers, colored additions/removals)
 * without taking over the terminal or adding OpenTUI peer dependencies.
 */

export interface DiffHunk {
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	heading: string;
	lines: string[];
	additions: number;
	removals: number;
}

export interface ReplacementEdit {
	oldText: string;
	newText: string;
}

export type DiffPreviewResult =
	| { ok: true; diff: string; oldContent: string; newContent: string }
	| { ok: false; error: string };

interface OrchThemeLike {
	fg(name: any, text: string): string;
	bold(text: string): string;
}

interface DiffOp {
	type: "equal" | "insert" | "delete";
	lines: string[];
}

const DEFAULT_CONTEXT_LINES = 3;
const MAX_EXACT_LCS_CELLS = 600_000;
const MAX_FALLBACK_LINES_PER_SIDE = 1200;

export async function computeEditPreviewDiff(
	cwd: string,
	path: string,
	edits: ReplacementEdit[],
	contextLines = DEFAULT_CONTEXT_LINES,
): Promise<DiffPreviewResult> {
	try {
		const oldContent = await readFile(resolve(cwd, normalizeToolPath(path)), "utf8");
		return computeEditPreviewDiffFromContent(oldContent, edits, path, contextLines);
	} catch (error) {
		return { ok: false, error: `Could not read ${path} for diff preview: ${formatError(error)}` };
	}
}

export function computeEditPreviewDiffFromContent(
	oldContent: string,
	edits: ReplacementEdit[],
	path?: string,
	contextLines = DEFAULT_CONTEXT_LINES,
): DiffPreviewResult {
	const applied = applyReplacementEdits(oldContent, edits);
	if (applied.ok === false) {
		return { ok: false, error: applied.error };
	}
	return {
		ok: true,
		oldContent,
		newContent: applied.content,
		diff: computeUnifiedDiff(oldContent, applied.content, path, contextLines),
	};
}

export async function computeWritePreviewDiff(
	cwd: string,
	path: string,
	newContent: string,
	contextLines = DEFAULT_CONTEXT_LINES,
): Promise<DiffPreviewResult> {
	let oldContent = "";
	try {
		oldContent = await readFile(resolve(cwd, normalizeToolPath(path)), "utf8");
	} catch {
		// Missing file is a create. Diff against an empty file.
	}
	return {
		ok: true,
		oldContent,
		newContent,
		diff: computeUnifiedDiff(oldContent, newContent, path, contextLines),
	};
}

/** Compute a line-level unified diff between oldContent and newContent. */
export function computeUnifiedDiff(oldContent: string, newContent: string, filePath?: string, contextLines = DEFAULT_CONTEXT_LINES): string {
	const oldLines = splitLines(oldContent);
	const newLines = splitLines(newContent);
	if (oldContent === newContent) {
		return "";
	}

	const ops = diffLines(oldLines, newLines);
	const hunks = buildHunks(ops, contextLines);
	if (hunks.length === 0) {
		return "";
	}

	const header = filePath ? `--- a/${filePath}\n+++ b/${filePath}\n` : "";
	return header + hunks.map(renderHunk).join("\n");
}

/** Parse a unified diff string into structured hunks. */
export function parseDiffHunks(diff: string): DiffHunk[] {
	const lines = splitLines(diff);
	const hunks: DiffHunk[] = [];
	let i = 0;

	while (i < lines.length) {
		const hunkMatch = lines[i]?.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/);
		if (!hunkMatch) {
			i++;
			continue;
		}

		const oldStart = Number(hunkMatch[1] ?? 1);
		const oldCount = Number(hunkMatch[2] ?? 1);
		const newStart = Number(hunkMatch[3] ?? 1);
		const newCount = Number(hunkMatch[4] ?? 1);
		const heading = (hunkMatch[5] ?? "").trim();
		const hunkLines: string[] = [];
		let additions = 0;
		let removals = 0;
		i++;

		while (i < lines.length && !lines[i]?.startsWith("@@")) {
			const line = lines[i]!;
			hunkLines.push(line);
			if (line.startsWith("+") && !line.startsWith("+++")) additions++;
			if (line.startsWith("-") && !line.startsWith("---")) removals++;
			i++;
		}

		hunks.push({ oldStart, oldCount, newStart, newCount, heading, lines: hunkLines, additions, removals });
	}

	return hunks;
}

export function countDiffStats(diff: string): { additions: number; removals: number } {
	let additions = 0;
	let removals = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions++;
		if (line.startsWith("-") && !line.startsWith("---")) removals++;
	}
	return { additions, removals };
}

export function formatInlineDiffSummary(diff: string, maxHunks = 3): string {
	const hunks = parseDiffHunks(diff);
	if (hunks.length === 0) return "";
	const stats = countDiffStats(diff);
	const parts = [`+${stats.additions}/-${stats.removals}`];
	for (const hunk of hunks.slice(0, maxHunks)) {
		parts.push(formatHunkHeader(hunk));
	}
	if (hunks.length > maxHunks) {
		parts.push(`… ${hunks.length - maxHunks} more`);
	}
	return parts.join(" · ");
}

export function formatCompactDiffPreview(diff: string, theme: OrchThemeLike, waterfallPrefix: string, maxHunks = 3): string[] {
	const hunks = parseDiffHunks(diff);
	if (hunks.length === 0) {
		return [`${waterfallPrefix}${theme.fg("dim", "No textual diff")}`];
	}
	const stats = countDiffStats(diff);
	const lines = [
		`${waterfallPrefix}${theme.fg("success", `+${stats.additions}`)}${theme.fg("dim", "/")}${theme.fg("error", `-${stats.removals}`)}${theme.fg("dim", ` across ${hunks.length} ${hunks.length === 1 ? "hunk" : "hunks"}`)}`,
	];
	for (const hunk of hunks.slice(0, maxHunks)) {
		lines.push(`${waterfallPrefix}${theme.fg("dim", formatHunkHeader(hunk))}`);
	}
	if (hunks.length > maxHunks) {
		lines.push(`${waterfallPrefix}${theme.fg("dim", `… ${hunks.length - maxHunks} more hunks`)}`);
	}
	return lines;
}

/** Render enriched diff with file headers, hunk headers, and old/new line numbers. */
export function formatDiffBlockEnhanced(diff: string, theme: OrchThemeLike, waterfallPrefix: string): string {
	const hunks = parseDiffHunks(diff);
	if (hunks.length === 0) {
		return splitLines(diff).map((line) => `${waterfallPrefix}${colorizeDiffLine(line, theme)}`).join("\n");
	}

	const lines: string[] = [];
	const fileHeaders = splitLines(diff).filter((line) => line.startsWith("--- ") || line.startsWith("+++ "));
	for (const header of fileHeaders) {
		lines.push(`${waterfallPrefix}${theme.fg(header.startsWith("+++") ? "success" : "error", header)}`);
	}
	if (fileHeaders.length > 0) {
		lines.push(`${waterfallPrefix}${theme.fg("dim", "")}`);
	}

	for (const hunk of hunks) {
		lines.push(`${waterfallPrefix}${theme.fg("accent", theme.bold(formatHunkHeader(hunk)))}`);
		let oldLine = hunk.oldStart;
		let newLine = hunk.newStart;
		for (const rawLine of hunk.lines) {
			if (rawLine.startsWith("+++") || rawLine.startsWith("---")) {
				continue;
			}
			const tag = rawLine.slice(0, 1);
			const body = rawLine.slice(1);
			let oldLabel = "";
			let newLabel = "";
			if (tag === "+") {
				newLabel = String(newLine++);
			} else if (tag === "-") {
				oldLabel = String(oldLine++);
			} else {
				oldLabel = String(oldLine++);
				newLabel = String(newLine++);
			}
			const gutter = `${oldLabel.padStart(4)} ${newLabel.padStart(4)} │ `;
			lines.push(`${waterfallPrefix}${theme.fg("dim", gutter)}${colorizeDiffLine(`${tag}${body}`, theme)}`);
		}
	}
	return lines.join("\n");
}

function applyReplacementEdits(oldContent: string, edits: ReplacementEdit[]): { ok: true; content: string } | { ok: false; error: string } {
	if (!Array.isArray(edits) || edits.length === 0) {
		return { ok: false, error: "No edit replacements were provided." };
	}

	const replacements: Array<{ start: number; end: number; newText: string }> = [];
	for (const [index, edit] of edits.entries()) {
		if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
			return { ok: false, error: `Edit ${index + 1} is invalid.` };
		}
		if (edit.oldText.length === 0) {
			return { ok: false, error: `Edit ${index + 1} has empty oldText.` };
		}

		const matches = findAllMatches(oldContent, edit.oldText);
		if (matches.length === 0) {
			return { ok: false, error: `Preview unavailable: edit ${index + 1} oldText was not found exactly.` };
		}
		if (matches.length > 1) {
			return { ok: false, error: `Preview unavailable: edit ${index + 1} oldText matched ${matches.length} times.` };
		}
		replacements.push({ start: matches[0]!, end: matches[0]! + edit.oldText.length, newText: edit.newText });
	}

	replacements.sort((a, b) => a.start - b.start);
	for (let i = 1; i < replacements.length; i++) {
		if (replacements[i]!.start < replacements[i - 1]!.end) {
			return { ok: false, error: "Preview unavailable: edit replacements overlap." };
		}
	}

	let content = oldContent;
	for (const replacement of [...replacements].reverse()) {
		content = `${content.slice(0, replacement.start)}${replacement.newText}${content.slice(replacement.end)}`;
	}
	return { ok: true, content };
}

function findAllMatches(haystack: string, needle: string): number[] {
	const matches: number[] = [];
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		matches.push(index);
		index = haystack.indexOf(needle, index + Math.max(needle.length, 1));
	}
	return matches;
}

function splitLines(text: string): string[] {
	if (text.length === 0) return [];
	const normalized = text.replace(/\r/g, "");
	const lines = normalized.split("\n");
	if (normalized.endsWith("\n")) {
		lines.pop();
	}
	return lines;
}

function diffLines(oldLines: string[], newLines: string[]): DiffOp[] {
	if (oldLines.length * newLines.length > MAX_EXACT_LCS_CELLS) {
		return buildFallbackDiffOps(oldLines, newLines);
	}

	const lcs = computeLCS(oldLines, newLines);
	const ops: DiffOp[] = [];
	let oi = 0;
	let ni = 0;

	for (const [lo, ln] of lcs) {
		if (oi < lo) ops.push({ type: "delete", lines: oldLines.slice(oi, lo) });
		if (ni < ln) ops.push({ type: "insert", lines: newLines.slice(ni, ln) });
		if (oldLines[lo] !== undefined) ops.push({ type: "equal", lines: [oldLines[lo]!] });
		oi = lo + 1;
		ni = ln + 1;
	}
	if (oi < oldLines.length) ops.push({ type: "delete", lines: oldLines.slice(oi) });
	if (ni < newLines.length) ops.push({ type: "insert", lines: newLines.slice(ni) });
	return coalesceOps(ops);
}

function buildFallbackDiffOps(oldLines: string[], newLines: string[]): DiffOp[] {
	const oldPreview = oldLines.slice(0, MAX_FALLBACK_LINES_PER_SIDE);
	const newPreview = newLines.slice(0, MAX_FALLBACK_LINES_PER_SIDE);
	const ops: DiffOp[] = [];
	if (oldPreview.length > 0) ops.push({ type: "delete", lines: oldPreview });
	if (oldLines.length > oldPreview.length) ops.push({ type: "delete", lines: [`… ${oldLines.length - oldPreview.length} removed lines omitted from preview`] });
	if (newPreview.length > 0) ops.push({ type: "insert", lines: newPreview });
	if (newLines.length > newPreview.length) ops.push({ type: "insert", lines: [`… ${newLines.length - newPreview.length} added lines omitted from preview`] });
	return ops;
}

function coalesceOps(ops: DiffOp[]): DiffOp[] {
	const coalesced: DiffOp[] = [];
	for (const op of ops) {
		const last = coalesced.at(-1);
		if (last?.type === op.type) {
			last.lines.push(...op.lines);
		} else if (op.lines.length > 0) {
			coalesced.push({ type: op.type, lines: [...op.lines] });
		}
	}
	return coalesced;
}

function computeLCS(a: string[], b: string[]): Array<[number, number]> {
	const n = a.length;
	const m = b.length;
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = 1; i <= n; i++) {
		for (let j = 1; j <= m; j++) {
			dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
		}
	}

	const result: Array<[number, number]> = [];
	let i = n;
	let j = m;
	while (i > 0 && j > 0) {
		if (a[i - 1] === b[j - 1]) {
			result.unshift([i - 1, j - 1]);
			i--;
			j--;
		} else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
			i--;
		} else {
			j--;
		}
	}
	return result;
}

function buildHunks(ops: DiffOp[], contextLines: number): DiffHunk[] {
	type TaggedLine = { text: string; tag: " " | "+" | "-" };
	const tagged: TaggedLine[] = [];
	for (const op of ops) {
		for (const line of op.lines) {
			if (op.type === "equal") tagged.push({ text: line, tag: " " });
			else if (op.type === "delete") tagged.push({ text: line, tag: "-" });
			else tagged.push({ text: line, tag: "+" });
		}
	}

	const changeIndexes = tagged
		.map((line, index) => line.tag === " " ? -1 : index)
		.filter((index) => index >= 0);
	const hunks: DiffHunk[] = [];
	let changeCursor = 0;

	while (changeCursor < changeIndexes.length) {
		const firstChange = changeIndexes[changeCursor]!;
		let hunkStart = Math.max(0, firstChange - contextLines);
		let hunkEnd = Math.min(tagged.length, firstChange + contextLines + 1);
		changeCursor++;

		while (changeCursor < changeIndexes.length) {
			const nextChange = changeIndexes[changeCursor]!;
			const nextStartWithContext = Math.max(0, nextChange - contextLines);
			if (nextStartWithContext > hunkEnd) {
				break;
			}
			hunkEnd = Math.min(tagged.length, nextChange + contextLines + 1);
			changeCursor++;
		}

		// Avoid starting a hunk on a blank trailing context line when possible.
		while (hunkStart < hunkEnd && tagged[hunkStart]?.tag === " " && tagged[hunkStart]?.text === "" && hunkStart < firstChange) {
			hunkStart++;
		}

		const hunkTagged = tagged.slice(hunkStart, hunkEnd);
		let oldStart = 1;
		let newStart = 1;
		for (const line of tagged.slice(0, hunkStart)) {
			if (line.tag !== "+") oldStart++;
			if (line.tag !== "-") newStart++;
		}

		let oldCount = 0;
		let newCount = 0;
		for (const line of hunkTagged) {
			if (line.tag !== "+") oldCount++;
			if (line.tag !== "-") newCount++;
		}

		const heading = hunkTagged.find((line) => line.tag === " " && line.text.trim().length > 0)?.text.trim().slice(0, 80) ?? "";
		const additions = hunkTagged.filter((line) => line.tag === "+").length;
		const removals = hunkTagged.filter((line) => line.tag === "-").length;
		hunks.push({
			oldStart,
			oldCount,
			newStart,
			newCount,
			heading,
			lines: hunkTagged.map((line) => `${line.tag}${line.text}`),
			additions,
			removals,
		});
	}
	return hunks;
}

function renderHunk(hunk: DiffHunk): string {
	return [formatHunkHeader(hunk), ...hunk.lines].join("\n");
}

function formatHunkHeader(hunk: DiffHunk): string {
	const oldRange = hunk.oldCount === 1 ? `${hunk.oldStart}` : `${hunk.oldStart},${hunk.oldCount}`;
	const newRange = hunk.newCount === 1 ? `${hunk.newStart}` : `${hunk.newStart},${hunk.newCount}`;
	return `@@ -${oldRange} +${newRange} @@${hunk.heading ? ` ${hunk.heading}` : ""}`;
}

function colorizeDiffLine(line: string, theme: OrchThemeLike): string {
	if (line.startsWith("+") && !line.startsWith("+++")) return theme.fg("success", line);
	if (line.startsWith("-") && !line.startsWith("---")) return theme.fg("error", line);
	if (line.startsWith("@@")) return theme.fg("accent", theme.bold(line));
	return theme.fg("toolOutput", line);
}

function normalizeToolPath(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
