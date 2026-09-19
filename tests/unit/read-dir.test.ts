/**
 * read-tool 单测：read 覆盖定义在「路径是目录」时列目录，其余情形原样转发内置实现。
 * 磁盘隔离：mkdtempSync 临时目录；无端口、无 SDK 会话（纯工具定义）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as nodeResolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeReadDirTool, resolvePathForDirCheck } from "../../server/read-tool.js";

let root = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-read-dir-"));
	mkdirSync(join(root, "nested"));
	writeFileSync(join(root, "b.txt"), "beta\n");
	writeFileSync(join(root, "a.txt"), "alpha\n");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** 调用工具定义，把返回的文本内容拼成一串（只关心正文）。 */
async function readText(
	tool: { execute: (...args: never[]) => Promise<unknown> },
	params: Record<string, unknown>,
	cwd = root,
): Promise<string> {
	const res = (await (tool.execute as unknown as (...a: unknown[]) => Promise<unknown>)(
		"t1",
		params,
		undefined,
		undefined,
		{ cwd },
	)) as { content: { type: string; text?: string }[] };
	return res.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
}

describe("resolvePathForDirCheck", () => {
	it("相对路径按 cwd 解析，绝对路径原样，@ 前缀剥掉", () => {
		const cwd = process.cwd();
		expect(resolvePathForDirCheck("server", cwd)).toBe(nodeResolve(cwd, "server"));
		expect(resolvePathForDirCheck(join(cwd, "server"), cwd)).toBe(join(cwd, "server"));
		expect(resolvePathForDirCheck("@server", cwd)).toBe(nodeResolve(cwd, "server"));
	});
});

describe("read 覆盖：目录", () => {
	it("目录 → 头部 + 条目（目录带 / 后缀，排序与 SDK ls 一致）", async () => {
		const tool = makeReadDirTool(root);
		const text = await readText(tool as never, { path: "." });
		expect(text).toContain("[Directory: .]");
		expect(text).toContain("nested/");
		expect(text).toContain("a.txt");
		// 排序：a.txt 在 b.txt 前
		expect(text.indexOf("a.txt")).toBeLessThan(text.indexOf("b.txt"));
	});

	it("相对 cwd 的目录路径（ctx.cwd 优先于创建时的 fallbackCwd）", async () => {
		const tool = makeReadDirTool("/definitely/not/here");
		const text = await readText(tool as never, { path: "nested" }, root);
		// 空目录：SDK ls 给 (empty directory)
		expect(text).toContain("[Directory: nested]");
		expect(text).toContain("(empty directory)");
	});

	it("目录模式下 limit 是条目上限（并给出 SDK 的续读提示）", async () => {
		const tool = makeReadDirTool(root);
		const text = await readText(tool as never, { path: ".", limit: 1 });
		expect(text).toContain("1 entries limit reached");
		expect(text.match(/a\.txt|b\.txt|nested\//g)?.length).toBe(1);
	});

	it("开关关掉 → 交回内置 read（目录报错，不再列目录）", async () => {
		const tool = makeReadDirTool(root, { dirEnabled: () => false });
		await expect(readText(tool as never, { path: "." })).rejects.toThrow();
	});

	it("开关实时读取：同一定义关掉后立刻恢复内置行为", async () => {
		let on = true;
		const tool = makeReadDirTool(root, { dirEnabled: () => on });
		expect(await readText(tool as never, { path: "." })).toContain("[Directory: .]");
		on = false;
		await expect(readText(tool as never, { path: "." })).rejects.toThrow();
	});
});

describe("read 覆盖：非目录照旧", () => {
	it("普通文件 → 原样返回内容（不带目录头）", async () => {
		const tool = makeReadDirTool(root);
		const text = await readText(tool as never, { path: "a.txt" });
		expect(text).toBe("alpha\n");
		expect(text).not.toContain("[Directory:");
	});

	it("不存在的路径 → 抛错（与内置 read 一致）", async () => {
		const tool = makeReadDirTool(root);
		await expect(readText(tool as never, { path: "nope.txt" })).rejects.toThrow();
	});

	it("中文 UI 语言 → 目录头用中文", async () => {
		const tool = makeReadDirTool(root, { getLang: () => "zh" });
		const text = await readText(tool as never, { path: "." });
		expect(text).toContain("[目录：.]");
	});
});
