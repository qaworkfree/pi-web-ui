/**
 * server/chat-only.ts
 *
 * Chat only preset (`ask`): the model has no tools, except `web_search` while the
 * conversation's web search button is on (gating in tool-manager.ts
 * filterToolsByPreset). This module builds the system prompt section for it,
 * including the user's memory file, which the model can read but never change.
 *
 * Memory file: `PI_WEB_MEMORY_FILE`, default `<dataDir>/memories.md`. Read on
 * every prompt rebuild (new chat / reload), capped at MEMORY_MAX_BYTES.
 */

import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const CHAT_ONLY_PRESET_ID = "ask";
export const MEMORY_MAX_BYTES = 16 * 1024;

export function memoryFilePath(dataDir: string): string {
	const env = process.env.PI_WEB_MEMORY_FILE?.trim();
	return resolve(env || join(dataDir, "memories.md"));
}

/** The memory file's text ("" when missing, empty or unreadable); cut at MEMORY_MAX_BYTES. */
export function readMemoryFile(file: string): string {
	try {
		if (!statSync(file).isFile()) return "";
		const buf = readFileSync(file);
		const text = buf.subarray(0, MEMORY_MAX_BYTES).toString("utf8").trim();
		return buf.length > MEMORY_MAX_BYTES ? `${text}\n[... memory file cut at ${MEMORY_MAX_BYTES / 1024} KB]` : text;
	} catch {
		return "";
	}
}

export function buildChatOnlyPrompt(memory: string, webSearch: boolean): string {
	const lines = [
		"\n\n────────── CHAT ONLY MODE ──────────",
		"This conversation is chat only: answer in text. You cannot run commands, read or change files, or act on the computer.",
		"Never claim to have run, checked or changed anything. If the user asks for an action, explain what they could do or suggest another preset.",
		webSearch
			? "Web search is on for this chat: use web_search only when the question needs current or outside information."
			: "Web search is off for this chat (the user can turn it on with the globe button).",
	];
	if (memory) {
		lines.push(
			"",
			"The user's memory file (facts they want you to know; read-only, you cannot change it):",
			"<user_memories>",
			memory,
			"</user_memories>",
		);
	}
	return lines.join("\n");
}
