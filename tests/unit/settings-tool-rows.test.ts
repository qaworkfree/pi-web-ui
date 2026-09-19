/**
 * 设置「工具」页覆盖率守卫（静态源码检查，不渲染 React）。
 *
 * 为什么需要：`AGENT_TOOL_CATALOG`（tool-manager.ts）是工具开关的唯一事实源，
 * 但设置页那一列 ToggleRow 是**手写**的——终端组与子代理组由名单循环渲染，
 * 「其他」组逐个手写。历史教训：`skill`、`present_files` 都是加进目录后忘了挂
 * 行，表现是「目录里有、设置里找不到」，用户只能靠 AI 报错才发现关不掉。
 *
 * 规则：目录里每个工具必须是下列之一——
 *   a) 出现在 TERMINAL_TOOL_NAMES / SUBAGENT_TOOL_NAMES（设置页按名单循环渲染）；
 *   b) 在 SettingsModal.tsx 里有 `title={<对应名字常量>}` 的显式行。
 * 名字常量的解析走 tool-manager 的导出表反查（值 === 工具名），所以改常量名也不会假红。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as toolManager from "../../server/tool-manager.js";
import { AGENT_TOOL_CATALOG, SUBAGENT_TOOL_NAMES, TERMINAL_TOOL_NAMES } from "../../server/tool-manager.js";

const SETTINGS_SRC = readFileSync(join(__dirname, "..", "..", "web", "src", "components", "SettingsModal.tsx"), "utf8");

/** 循环渲染的两组（设置页只写名单，不逐个写行）。 */
const LOOP_RENDERED = new Set<string>([...TERMINAL_TOOL_NAMES, ...SUBAGENT_TOOL_NAMES]);

/** 工具名 → tool-manager 里值为该名的导出常量名（如 present_files → PRESENT_FILES_TOOL_NAME）。 */
function constNameFor(toolName: string): string | undefined {
	return Object.entries(toolManager).find(([, v]) => v === toolName)?.[0];
}

describe("设置「工具」页覆盖率", () => {
	it("目录里每个工具都能被设置页渲染（循环组或显式行）", () => {
		const missing: string[] = [];
		for (const tool of AGENT_TOOL_CATALOG) {
			if (LOOP_RENDERED.has(tool.name)) continue;
			const constName = constNameFor(tool.name);
			if (!constName || !SETTINGS_SRC.includes(`title={${constName}}`)) missing.push(tool.name);
		}
		expect(missing, `以下工具在 tool-manager 目录里，却没有在设置「工具」页挂行：${missing.join(", ")}`).toEqual([]);
	});

	it("设置页的每个显式行都对应目录里的工具（防手写名字打错）", () => {
		const known = new Set(AGENT_TOOL_CATALOG.map((t) => t.name));
		const rows = [...SETTINGS_SRC.matchAll(/title=\{([A-Z_][A-Z0-9_]*_TOOL_NAME)\}/g)].map((m) => m[1]);
		expect(rows.length).toBeGreaterThan(0);
		const unknown: string[] = [];
		for (const constName of rows) {
			const value = (toolManager as unknown as Record<string, unknown>)[constName];
			if (typeof value !== "string" || !known.has(value)) unknown.push(constName);
		}
		expect(unknown, `设置页引用了不在目录里的工具常量：${unknown.join(", ")}`).toEqual([]);
	});

	it("循环组里没有目录外的名字", () => {
		const known = new Set(AGENT_TOOL_CATALOG.map((t) => t.name));
		const extra = [...LOOP_RENDERED].filter((n) => !known.has(n));
		expect(extra).toEqual([]);
	});
});
