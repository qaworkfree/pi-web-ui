/**
 * server/locales.ts 单测：pack 校验、安装（stub fetch）、删除。
 * 磁盘隔离：mkdtempSync 临时 data-dir；端口：无（纯函数 + stub 网络）。
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	installPack,
	isKnownPack,
	listPacks,
	packPath,
	readPackFile,
	removePack,
	validatePack,
} from "../../server/locales.js";

const PACK = {
	code: "ja",
	nativeName: "日本語",
	version: "0.68.1",
	strings: { cancel: "キャンセル", ok: "OK" },
};

function stubFetch(body: unknown, status = 200) {
	return (async (_url: string) => ({
		ok: status >= 200 && status < 300,
		status,
		text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
	})) as unknown as typeof fetch;
}

describe("locales", () => {
	it("isKnownPack 只认 manifest 里的 8 个包", () => {
		expect(isKnownPack("ja")).toBe(true);
		expect(isKnownPack("it")).toBe(true);
		expect(isKnownPack("zh")).toBe(false);
		expect(isKnownPack("en")).toBe(false);
		expect(isKnownPack("../evil")).toBe(false);
		expect(isKnownPack("")).toBe(false);
	});

	it("validatePack 拒绝坏包", () => {
		expect(validatePack(null, "ja").ok).toBe(false);
		expect(validatePack({}, "ja").ok).toBe(false);
		expect(validatePack({ ...PACK, code: "ko" }, "ja").ok).toBe(false);
		expect(validatePack({ ...PACK, strings: { a: 1 } }, "ja").ok).toBe(false);
		expect(validatePack({ ...PACK, strings: {} }, "ja").ok).toBe(false);
		const good = validatePack(PACK, "ja");
		expect(good.ok).toBe(true);
		if (good.ok) expect(good.pack.version).toBe("0.68.1");
	});

	it("install → list/read → remove 全链路（stub 网络，落盘隔离）", async () => {
		const dir = mkdtempSync(join(tmpdir(), "piweb-locales-"));
		try {
			expect(listPacks(dir).find((p) => p.code === "ja")).toMatchObject({ installed: false, version: null });
			const meta = await installPack(dir, "ja", { fetchFn: stubFetch(PACK), version: "0.68.1" });
			expect(meta).toMatchObject({ code: "ja", nativeName: "日本語" });
			expect(listPacks(dir).find((p) => p.code === "ja")).toMatchObject({ installed: true, version: "0.68.1" });
			expect(readPackFile(dir, "ja")).toMatchObject({ code: "ja" });
			expect(removePack(dir, "ja")).toBe(true);
			expect(removePack(dir, "ja")).toBe(false);
			expect(readPackFile(dir, "ja")).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("install 拒绝未知 code；404 会尝试 fallback 地址", async () => {
		const dir = mkdtempSync(join(tmpdir(), "piweb-locales-"));
		try {
			await expect(installPack(dir, "xx", { fetchFn: stubFetch(PACK) })).rejects.toThrow("unknown locale");
			const seen: string[] = [];
			const track = (async (url: string) => {
				seen.push(url);
				return stubFetch(url.includes("/main/") ? PACK : "nope", url.includes("/main/") ? 200 : 404)(url);
			}) as unknown as typeof fetch;
			await installPack(dir, "ja", { fetchFn: track, version: "9.9.9" });
			expect(seen).toEqual([
				expect.stringContaining("/v9.9.9/locales/ja.json"),
				expect.stringContaining("/main/locales/ja.json"),
			]);
			await expect(installPack(dir, "ja", { fetchFn: stubFetch("nope", 404) })).rejects.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("坏文件不炸 list（readPackFile 返回 null）", () => {
		const dir = mkdtempSync(join(tmpdir(), "piweb-locales-"));
		try {
			mkdirSync(dirname(packPath(dir, "ja")), { recursive: true });
			writeFileSync(packPath(dir, "ja"), "{broken");
			expect(readPackFile(dir, "ja")).toBeNull();
			expect(listPacks(dir).find((p) => p.code === "ja")).toMatchObject({ installed: false });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
