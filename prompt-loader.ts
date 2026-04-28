import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { OrchRoleName } from "./config.js";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(EXTENSION_DIR, "prompts");

export function getOrchRolePromptPath(role: OrchRoleName): string {
	const fileName = role === "smart_friend" ? "smart-friend.md" : `${role}.md`;
	return join(PROMPTS_DIR, fileName);
}

export async function loadOrchRolePrompt(role: OrchRoleName): Promise<string> {
	const filePath = getOrchRolePromptPath(role);
	try {
		const content = await readFile(filePath, "utf8");
		return content.trim();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to load Orch ${role} prompt at ${filePath}: ${message}`);
	}
}
