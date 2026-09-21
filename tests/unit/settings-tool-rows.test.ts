/**
 * 设置「工具」页覆盖率守卫（静态源码检查，不渲染 React）。
 *
 * 机制（2026-09，claim_files 补目录时收敛）：设置页不再手写 ToggleRow——终端组与
 * 子代理组按名单循环，「其他」组按 OTHER_AGENT_TOOLS（= 目录过滤）循环，文案走
 * 目录项的 descKey/offHintKey。目录里加一行，页面自动多一行。
 *
 * 唯一例外：todo_list 的行固定在 markers 分区（OTHER_AGENT_TOOLS 跳过它），本文件
 * 把这个例外锁死——多了第二个例外、或例外丢了行，都算红。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as toolManager from "../../server/tool-manager.js";
import {
	AGENT_TOOL_CATALOG,
	MARKERS_LIST_TOOL_NAME,
	SUBAGENT_TOOL_NAMES,
	TERMINAL_TOOL_NAMES,
} from "../../server/tool-manager.js";
import { zh } from "../../web/src/i18n.js";

const SETTINGS_SRC = readFileSync(join(__dirname, "..", "..", "web", "src", "components", "SettingsModal.tsx"), "utf8");

/** 循环渲染的两组（设置页只写名单，不逐个写行）。 */
const LOOP_RENDERED = new Set<string>([...TERMINAL_TOOL_NAMES, ...SUBAGENT_TOOL_NAMES]);

/** 「其他」组循环的唯一例外（行在 markers 分区，不在「其他」组）。 */
const OTHER_LOOP_SKIP = new Set([MARKERS_LIST_TOOL_NAME]);

describe("设置「工具」页覆盖率", () => {
	it("「其他」组每个目录项都自带文案 key（且 key 真存在），循环才画得出说明", () => {
		const zhKeys = new Set(Object.keys(zh));
		const bad: string[] = [];
		for (const tool of AGENT_TOOL_CATALOG) {
			if (tool.group !== "other" || OTHER_LOOP_SKIP.has(tool.name)) continue;
			if (!tool.descKey || !zhKeys.has(tool.descKey)) bad.push(`${tool.name}.descKey=${tool.descKey}`);
			if (!tool.offHintKey || !zhKeys.has(tool.offHintKey)) bad.push(`${tool.name}.offHintKey=${tool.offHintKey}`);
		}
		expect(bad, `以下「其他」组目录项缺文案 key（设置页循环渲染时说明是空的）：${bad.join("、")}`).toEqual([]);
	});

	it("设置页确实用目录循环画「其他」组（不是又手写回去）", () => {
		expect(SETTINGS_SRC.includes("OTHER_AGENT_TOOLS"), "设置页里找不到 OTHER_AGENT_TOOLS 循环口径").toBe(true);
		expect(SETTINGS_SRC.includes("OTHER_AGENT_TOOLS.map"), "OTHER_AGENT_TOOLS 定义了却没有 .map 渲染").toBe(true);
	});

	it("唯一的例外锁死：todo_list 只在 markers 分区画一行，循环里跳过它", () => {
		expect(SETTINGS_SRC.includes("title={MARKERS_LIST_TOOL_NAME}"), "markers 分区的 todo_list 行丢了").toBe(true);
		// 例外只能是这一个：OTHER_AGENT_TOOLS 定义里除 MARKERS_LIST 外不许再点名任何工具。
		const defs = [...SETTINGS_SRC.matchAll(/OTHER_AGENT_TOOLS = AGENT_TOOL_CATALOG\.filter\((.*?)\);/gs)].map(
			(m) => m[1],
		);
		expect(defs.length, "OTHER_AGENT_TOOLS 定义丢了").toBe(1);
		const named = [...defs[0].matchAll(/\b([A-Z_][A-Z0-9_]*_TOOL_NAME)\b/g)].map((m) => m[1]);
		expect(named, `OTHER_AGENT_TOOLS 多了例外（只允许跳过 todo_list）：${named.join(", ")}`).toEqual([
			"MARKERS_LIST_TOOL_NAME",
		]);
	});

	it("设置页手写的工具行（只剩 markers 例外）都对应目录里的工具（防名字打错）", () => {
		const known = new Set(AGENT_TOOL_CATALOG.map((t) => t.name));
		const rows = [...SETTINGS_SRC.matchAll(/title=\{([A-Z_][A-Z0-9_]*_TOOL_NAME)\}/g)].map((m) => m[1]);
		expect(rows, "连 markers 例外行都丢了？").toContain("MARKERS_LIST_TOOL_NAME");
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
