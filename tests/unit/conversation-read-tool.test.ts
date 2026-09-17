/**
 * conversation-read-tool 单测：转录文本化 / 分页格式化 / 转录解析 / 列表过滤。
 * 纯函数零 token；工具 execute 经 defineTool 走 SDK 类型，仅测纯函数部分。
 */
import { describe, expect, it } from "vitest";
import {
	filterHistory,
	filterRunning,
	formatTranscript,
	parseTranscriptLines,
	shortPath,
	transcriptText,
	type TranscriptInputMessage,
} from "../../server/conversation-read-tool.js";

const MSGS: TranscriptInputMessage[] = [
	{ role: "user", content: "看看这个 bug" },
	{ role: "assistant", content: [{ type: "text", text: "好的" }] },
	{
		role: "assistant",
		content: [
			{ type: "toolCall", name: "bash" },
			{ type: "text", text: "跑一下" },
		],
	},
	{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "ok" }] },
	{ role: "bashExecution", command: "npm test", output: "pass" },
	{ role: "custom", content: [{ type: "text", text: "文件内容" }], details: { name: "a.ts", path: "a.ts" } },
	{ role: "compactionSummary", summary: "摘要" },
];

describe("transcriptText", () => {
	it("字符串内容原样", () => {
		expect(transcriptText(MSGS[0])).toBe("看看这个 bug");
	});
	it("assistant 文本块拼接 + 具名块留名", () => {
		expect(transcriptText(MSGS[1])).toBe("好的");
		expect(transcriptText(MSGS[2])).toBe("[tool call: bash]\n跑一下");
	});
	it("toolResult 带工具名", () => {
		expect(transcriptText(MSGS[3])).toBe("[tool result (bash)]\nok");
	});
	it("bash/摘要/custom 都有可读头", () => {
		expect(transcriptText(MSGS[4])).toContain("[bash $ npm test]");
		expect(transcriptText(MSGS[5])).toContain("[attachment: a.ts]");
		expect(transcriptText(MSGS[6])).toContain("[compaction summary]");
	});
	it("图片块占位不抛错", () => {
		expect(transcriptText({ role: "user", content: [{ type: "image" }] })).toBe("[image]");
	});
});

describe("formatTranscript", () => {
	it("序号 [i/total role] + 默认分页", () => {
		const f = formatTranscript(MSGS);
		expect(f.total).toBe(MSGS.length);
		expect(f.from).toBe(0);
		expect(f.to).toBe(MSGS.length);
		expect(f.truncated).toBe(false);
		expect(f.text).toContain("[1/7 user]");
		expect(f.text).toContain("[4/7 tool result (bash)]");
	});
	it("offset/limit 翻页 + truncated", () => {
		const f = formatTranscript(MSGS, { offset: 5, limit: 1 });
		expect(f.from).toBe(5);
		expect(f.to).toBe(6);
		expect(f.truncated).toBe(true);
		expect(f.text).toContain("[6/7");
		expect(f.text).not.toContain("[1/7");
	});
	it("limit 上限 200，maxChars 截断带标记", () => {
		const big: TranscriptInputMessage[] = Array.from({ length: 300 }, (_, i) => ({
			role: "user",
			content: `m${i}`,
		}));
		const f = formatTranscript(big, { limit: 500 });
		expect(f.to - f.from).toBe(200);
		const c = formatTranscript(big, { limit: 200, maxChars: 1000 });
		expect(c.truncated).toBe(true);
		expect(c.text).toContain("… [truncated]");
	});
	it("空转录", () => {
		const f = formatTranscript([]);
		expect(f.total).toBe(0);
		expect(f.text).toBe("");
		expect(f.truncated).toBe(false);
	});
});

describe("parseTranscriptLines", () => {
	it("message 取 message，compaction/branch 取 summary，坏行跳过", () => {
		const text = [
			JSON.stringify({ type: "session", id: "s1" }),
			JSON.stringify({ type: "message", message: { role: "user", content: "hi", timestamp: 1 } }),
			"not json {",
			"",
			JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "yo" }] } }),
			JSON.stringify({ type: "compaction", summary: "sum" }),
			JSON.stringify({ type: "branch_summary", summary: "b" }),
			JSON.stringify({ type: "thinking_level_change" }),
		].join("\n");
		const out = parseTranscriptLines(text);
		expect(out.map((m) => m.role)).toEqual(["user", "assistant", "compactionSummary", "branchSummary"]);
		expect(out[0].content).toBe("hi");
		expect(out[2].summary).toBe("sum");
	});
});

describe("filterRunning / filterHistory / shortPath", () => {
	it("空 query 全返回，大小写不敏感", () => {
		const list = [
			{ id: "c1", title: "修 Bug", cwd: "/a", messageCount: 3, isStreaming: false, isSubagent: false },
			{ id: "c2", title: "Review", cwd: "/b", messageCount: 1, isStreaming: true, isSubagent: true },
		];
		expect(filterRunning(list, "")).toHaveLength(2);
		expect(filterRunning(list, "review")).toHaveLength(1);
		expect(filterRunning(list, "C1")).toHaveLength(1);
		expect(filterRunning(list, "zzz")).toHaveLength(0);
	});
	it("历史按 path/name/首条过滤", () => {
		const list = [{ path: "/s/1.jsonl", name: "买菜", firstMessage: "", messageCount: 2, modified: 1, cwd: "/a" }];
		expect(filterHistory(list, "买菜")).toHaveLength(1);
		expect(filterHistory(list, "1.jsonl")).toHaveLength(1);
		expect(filterHistory(list, "nope")).toHaveLength(0);
	});
	it("短路径截断", () => {
		expect(shortPath("abc")).toBe("abc");
		expect(shortPath("x".repeat(100), 10)).toBe(`…${"x".repeat(10)}`);
	});
});
