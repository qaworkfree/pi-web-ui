/**
 * PluginManager 纯单测（零依赖、毫秒级）：不启 server、不碰真模型。
 *
 * 覆盖：
 * - activate/deactivate 生命周期（目录删除后 dispose 调 deactivate）
 * - handleMessage 按 pluginId 路由，onMessage 回调带来源 clientId，可注销
 * - emitToolEvent 扇出 + 单个 handler 抛错被隔离
 * - notifyAll / sendTo 定向投递（fake sender）
 * - scan 跳过坏 manifest；epoch 在 reload 后递增且重激活
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManager, type PluginToolEvent } from "../../server/plugins.js";
import type { ServerMessage } from "../../server/protocol.js";

let dir: string;
let mgr: PluginManager;

function makePlugin(
	id: string,
	code: string,
	opts?: { client?: boolean; manifest?: Record<string, unknown> },
): void {
	const pdir = join(dir, "plugins", id);
	mkdirSync(pdir, { recursive: true });
	writeFileSync(
		join(pdir, "manifest.json"),
		JSON.stringify({ name: id, ...(opts?.manifest ?? {}) }),
	);
	writeFileSync(join(pdir, "index.mjs"), code);
	if (opts?.client) {
		mkdirSync(join(pdir, "client"), { recursive: true });
		writeFileSync(join(pdir, "client", "entry.mjs"), "export default {};");
	}
}

const ECHO_PLUGIN = `
export default {
	activate(host) {
		host.seen = [];
		return host.onMessage((payload, from) => {
			host.seen.push([payload, from]);
			if (payload?.action === "ping") host.broadcast({ pong: payload.value });
			if (payload?.action === "to") host.sendTo(payload.clientId, { private: true });
			if (payload?.action === "notify") host.notify("warning", "plugin says hi");
		});
	},
};`;
const THROW_PLUGIN = `export default { activate() { throw new Error("boom"); } };`;
const DEACT_PLUGIN = `
globalThis.__deact = globalThis.__deact || [];
export default {
	activate() { return () => { globalThis.__deact.push(1); }; },
};`;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "plugin-mgr-test-"));
	mgr = new PluginManager(dir, dir);
});

afterEach(() => {
	mgr.dispose();
	rmSync(dir, { recursive: true, force: true });
});

describe("PluginManager", () => {
	it("activate + onMessage routing with sender clientId", async () => {
		makePlugin("echo", ECHO_PLUGIN);
		const list = await mgr.ensureLoaded();
		expect(list.find((p) => p.id === "echo")?.error).toBeUndefined();

		const sent: ServerMessage[] = [];
		mgr.addSender((m) => sent.push(m), () => "client-1");
		mgr.handleMessage("echo", { action: "ping", value: 7 }, "client-1");
		expect(sent).toEqual([
			{ type: "plugin_data", pluginId: "echo", payload: { pong: 7 } },
		]);
	});

	it("handler exceptions are isolated and do not break other handlers", async () => {
		makePlugin(
			"thrower",
			`export default { activate(h) { h.onMessage(() => { throw new Error("nope"); }); } };`,
		);
		makePlugin("echo2", ECHO_PLUGIN);
		await mgr.ensureLoaded();
		const sent: ServerMessage[] = [];
		mgr.addSender((m) => sent.push(m), () => null);
		mgr.handleMessage("thrower", {}, undefined);
		mgr.handleMessage("echo2", { action: "ping", value: 1 }, undefined);
		expect(sent).toHaveLength(1);
	});

	it("emitToolEvent fans out; throwing handler is isolated", async () => {
		makePlugin("tools", `
			globalThis.__toolSeen = [];
			export default {
				activate(h) {
					const offBad = h.onToolEvent(() => { throw new Error("bad"); });
					const off = h.onToolEvent((ev) => { globalThis.__toolSeen.push(ev.phase); });
					return () => { off(); offBad(); };
				},
			};`);
		await mgr.ensureLoaded();
		const ev: PluginToolEvent = { phase: "start", toolName: "bash" };
		mgr.emitToolEvent(ev);
		mgr.emitToolEvent(ev);
		const g = globalThis as { __toolSeen?: string[] };
		expect(g.__toolSeen).toEqual(["start", "start"]);
	});

	it("notifyAll broadcasts a notice; sendTo targets one socket only", async () => {
		makePlugin("echo3", ECHO_PLUGIN);
		await mgr.ensureLoaded();
		const a: ServerMessage[] = [];
		const b: ServerMessage[] = [];
		mgr.addSender((m) => a.push(m), () => "a");
		mgr.addSender((m) => b.push(m), () => "b");
		mgr.handleMessage("echo3", { action: "notify" }, "a");
		mgr.handleMessage("echo3", { action: "to", clientId: "b" }, "b");
		expect(a).toContainEqual({
			type: "notice",
			level: "warning",
			text: "plugin says hi",
		});
		// 定向消息只进 b
		expect(a.filter((m) => m.type === "plugin_data")).toHaveLength(0);
		expect(b.filter((m) => m.type === "plugin_data")).toHaveLength(1);
	});

	it("scan skips bad manifests; epoch increments on reload; dispose deactivates", async () => {
		makePlugin("good", DEACT_PLUGIN);
		mkdirSync(join(dir, "plugins", "bad"), { recursive: true });
		writeFileSync(join(dir, "plugins", "bad", "manifest.json"), "{oops");
		const first = await mgr.ensureLoaded();
		expect(first.map((p) => p.id)).toEqual(["good"]);
		expect(mgr.epoch).toBe(0);

		const second = await mgr.reload();
		expect(second.map((p) => p.id)).toEqual(["good"]);
		expect(mgr.epoch).toBe(1);

		mgr.dispose();
		expect((globalThis as { __deact?: number[] }).__deact?.length).toBe(2);

		// 激活失败 → error 字段，不炸进程
		makePlugin("broken", THROW_PLUGIN);
		const third = await mgr.ensureLoaded();
		expect(third.find((p) => p.id === "broken")?.error).toContain("boom");
	});

	it("manifest icon/description surface in the catalog", async () => {
		makePlugin("pretty", "export default {};", {
			client: true,
			manifest: { name: "漂亮", icon: "✨", description: "desc" },
		});
		const list = await mgr.list();
		const p = list.find((x) => x.id === "pretty");
		expect(p?.icon).toBe("✨");
		expect(p?.description).toBe("desc");
		expect(p?.hasClient).toBe(true);
	});
});
