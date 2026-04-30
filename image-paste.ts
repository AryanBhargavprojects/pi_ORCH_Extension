import { existsSync, readFileSync } from "node:fs";
import type { ImageContent } from "@mariozechner/pi-ai";
import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { EditorTheme, KeybindingsManager, TUI } from "@mariozechner/pi-tui";

const IMAGE_MARKER_PREFIX = "Image";
const PASTED_IMAGE_PATH_PATTERN = /(?:file:\/\/)?\/(?:[^\s'"`]+\/)*pi-clipboard-[a-f0-9-]+\.(?:png|jpg|jpeg|gif|webp)/gi;

const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

type PendingImageAttachment = {
	marker: string;
	path: string;
	mimeType: string;
};

type ImagePasteState = {
	pending: PendingImageAttachment[];
	nextIndex: number;
};

export function registerImagePasteAttachments(pi: ExtensionAPI): void {
	const state: ImagePasteState = {
		pending: [],
		nextIndex: 1,
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) {
			return;
		}

		resetImagePasteState(state);
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new OrchImageAttachmentEditor(tui, theme, keybindings, state));
	});

	pi.on("input", async (event) => {
		if (event.source === "extension") {
			return { action: "continue" };
		}

		const transformed = collectImageAttachmentsForInput(event.text, state);
		if (transformed.attachments.length === 0) {
			resetImagePasteState(state);
			return { action: "continue" };
		}

		resetImagePasteState(state);
		return {
			action: "transform",
			text: transformed.text,
			images: [...(event.images ?? []), ...transformed.attachments],
		};
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		resetImagePasteState(state);
		if (ctx.hasUI) {
			ctx.ui.setEditorComponent(undefined);
		}
	});
}

class OrchImageAttachmentEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly imagePasteState: ImagePasteState,
	) {
		super(tui, theme, keybindings);
	}

	insertTextAtCursor(text: string): void {
		const pastedImage = normalizePastedImagePath(text);
		if (!pastedImage) {
			super.insertTextAtCursor(text);
			return;
		}

		const marker = createImageMarker(this.imagePasteState.nextIndex++);
		this.imagePasteState.pending.push({
			marker,
			path: pastedImage.path,
			mimeType: pastedImage.mimeType,
		});
		super.insertTextAtCursor(marker);
	}
}

function collectImageAttachmentsForInput(
	inputText: string,
	state: ImagePasteState,
): { text: string; attachments: ImageContent[] } {
	let text = inputText;
	const attachments: ImageContent[] = [];

	for (const pendingImage of state.pending) {
		if (!text.includes(pendingImage.marker)) {
			continue;
		}

		const attachment = readImageAttachment(pendingImage);
		if (!attachment) {
			continue;
		}

		attachments.push(attachment);
	}

	const fallbackPaths = findPastedImagePaths(text);
	let fallbackMarkerIndex = attachments.length + 1;
	for (const imagePath of fallbackPaths) {
		const pastedImage = normalizePastedImagePath(imagePath);
		if (!pastedImage) {
			continue;
		}

		const marker = createImageMarker(fallbackMarkerIndex++);
		const attachment = readImageAttachment({ marker, path: pastedImage.path, mimeType: pastedImage.mimeType });
		if (!attachment) {
			continue;
		}

		text = text.replace(imagePath, marker);
		attachments.push(attachment);
	}

	return { text, attachments };
}

function readImageAttachment(image: PendingImageAttachment): ImageContent | undefined {
	if (!existsSync(image.path)) {
		return undefined;
	}

	return {
		type: "image",
		data: readFileSync(image.path).toString("base64"),
		mimeType: image.mimeType,
	};
}

function findPastedImagePaths(text: string): string[] {
	return Array.from(text.matchAll(PASTED_IMAGE_PATH_PATTERN), (match) => match[0]);
}

function normalizePastedImagePath(rawText: string): { path: string; mimeType: string } | undefined {
	const trimmed = rawText.trim().replace(/^file:\/\//, "");
	const match = trimmed.match(PASTED_IMAGE_PATH_PATTERN);
	if (!match || match[0] !== trimmed) {
		return undefined;
	}

	const extension = trimmed.split(".").at(-1)?.toLowerCase();
	const mimeType = extension ? MIME_TYPES_BY_EXTENSION[extension] : undefined;
	if (!mimeType || !existsSync(trimmed)) {
		return undefined;
	}

	return { path: trimmed, mimeType };
}

function createImageMarker(index: number): string {
	return `[${IMAGE_MARKER_PREFIX} #${index}]`;
}

function resetImagePasteState(state: ImagePasteState): void {
	state.pending = [];
	state.nextIndex = 1;
}
