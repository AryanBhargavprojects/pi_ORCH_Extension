export function formatErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

export function isAbortLikeError(error: unknown): boolean {
	const message = formatErrorMessage(error).toLowerCase();
	return /\b(abort|aborted|cancel|cancelled|canceled|interrupt|interrupted)\b/.test(message);
}

export function slugifyText(value: string, maxLength: number, fallback: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, maxLength);
	return slug.length > 0 ? slug : fallback;
}
