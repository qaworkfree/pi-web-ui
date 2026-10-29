import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildChatOnlyPrompt,
	CHAT_ONLY_PRESET_ID,
	MEMORY_MAX_BYTES,
	memoryFilePath,
	readMemoryFile,
} from "../../server/chat-only.js";
import {
	applyAgentToolsGating,
	filterToolsByPreset,
	LOAD_TOOLS_TOOL_NAME,
	WEB_SEARCH_TOOL_NAME,
} from "../../server/tool-manager.js";

const ALL = ["bash", "powershell", "read", "edit", "write", "eval", "browser_page", WEB_SEARCH_TOOL_NAME, "subagent"];

function gate(preset: string, chatWebSearch: boolean, disabled: string[] = []): string[] {
	let active: string[] = ALL.slice();
	const session = {
		getAllTools: () => ALL.map((name) => ({ name })),
		getActiveToolNames: () => active,
		setActiveToolsByName: (names: string[]) => {
			active = names;
		},
	};
	applyAgentToolsGating(session as never, disabled, preset, { forceActive: [], chatWebSearch });
	return active;
}

describe("Chat only (ask preset) tool gating", () => {
	it("has no tools at all, bash included, while web search is off", () => {
		expect(CHAT_ONLY_PRESET_ID).toBe("ask");
		expect(filterToolsByPreset(ALL, "ask")).toEqual([]);
		expect(gate("ask", false)).toEqual([]);
	});

	it("keeps only web_search when the chat's button is on", () => {
		expect(filterToolsByPreset(ALL, "ask", { chatWebSearch: true })).toEqual([WEB_SEARCH_TOOL_NAME]);
		expect(gate("ask", true)).toEqual([WEB_SEARCH_TOOL_NAME]);
		// a user-disabled web_search stays off
		expect(gate("ask", true, [WEB_SEARCH_TOOL_NAME])).toEqual([]);
	});

	it("the button does not change other presets", () => {
		expect(filterToolsByPreset(ALL, "reader", { chatWebSearch: true })).toEqual(filterToolsByPreset(ALL, "reader"));
		expect(filterToolsByPreset(ALL, "standard", { chatWebSearch: false })).toEqual(ALL);
		expect(gate("ask", true)).not.toContain(LOAD_TOOLS_TOOL_NAME);
	});
});

describe("Chat only memory file and prompt", () => {
	const dirs: string[] = [];
	const tmp = () => {
		const d = mkdtempSync(join(tmpdir(), "chat-only-"));
		dirs.push(d);
		return d;
	};
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
		delete process.env.PI_WEB_MEMORY_FILE;
	});

	it("defaults to <dataDir>/memories.md; PI_WEB_MEMORY_FILE overrides it", () => {
		const d = tmp();
		expect(memoryFilePath(d)).toBe(join(d, "memories.md"));
		process.env.PI_WEB_MEMORY_FILE = join(d, "notes", "me.md");
		expect(memoryFilePath(d)).toBe(join(d, "notes", "me.md"));
	});

	it("reads the file, missing = empty, and caps the size", () => {
		const d = tmp();
		expect(readMemoryFile(join(d, "none.md"))).toBe("");
		expect(readMemoryFile(d)).toBe("");
		const f = join(d, "memories.md");
		writeFileSync(f, "  Prefers short answers.\n");
		expect(readMemoryFile(f)).toBe("Prefers short answers.");
		writeFileSync(f, "x".repeat(MEMORY_MAX_BYTES + 100));
		const big = readMemoryFile(f);
		expect(big.startsWith("x".repeat(MEMORY_MAX_BYTES))).toBe(true);
		expect(big).toContain("memory file cut");
	});

	it("puts the memories in a read-only block and states the web search state", () => {
		const on = buildChatOnlyPrompt("Likes green tea", true);
		expect(on).toContain("<user_memories>\nLikes green tea\n</user_memories>");
		expect(on).toContain("read-only");
		expect(on).toContain("Web search is on");
		const off = buildChatOnlyPrompt("", false);
		expect(off).not.toContain("<user_memories>");
		expect(off).toContain("Web search is off");
		expect(off).toContain("cannot run commands");
	});
});
