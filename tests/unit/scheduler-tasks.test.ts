/**
 * 内置定时任务单测（issue #184）：输入归一化/校验、下次触发计算、
 * Store 的 CRUD + 开关 + 持久化往返。执行器（Agent 无头调用）与 ticker
 * 时序不进单测，覆盖靠 tests/run-smoke 聚合里的协议冒烟。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SchedulerStore,
	computeNextFire,
	describeIntervalMs,
	normalizeSchedulerInput,
} from "../../server/scheduler-tasks.js";

const BASE = {
	name: "每日巡检",
	cwd: process.platform === "win32" ? "C:\\tmp" : "/tmp",
	kind: "cron" as const,
	spec: "0 9 * * *",
	prompt: "审计依赖并报告",
};

describe("normalizeSchedulerInput", () => {
	it("cron 归一化（多余空白压缩）", () => {
		const t = normalizeSchedulerInput({ ...BASE, spec: "  0  9  *  *  * " });
		expect(t.spec).toBe("0 9 * * *");
		expect(t.enabled).toBe(true);
		expect(t.catchUp).toBe("skip");
	});

	it("非法 cron 抛错", () => {
		expect(() => normalizeSchedulerInput({ ...BASE, spec: "not a cron" })).toThrow();
		expect(() => normalizeSchedulerInput({ ...BASE, spec: "0 9 * *" })).toThrow();
	});

	it("interval 按毫秒归一化，过短拒绝", () => {
		const t = normalizeSchedulerInput({ ...BASE, kind: "interval", spec: "3600000" });
		expect(t.spec).toBe("3600000");
		expect(() => normalizeSchedulerInput({ ...BASE, kind: "interval", spec: "1000" })).toThrow();
		expect(() => normalizeSchedulerInput({ ...BASE, kind: "interval", spec: "abc" })).toThrow();
	});

	it("必填缺失抛错（名称/cwd/prompt）", () => {
		expect(() => normalizeSchedulerInput({ ...BASE, name: "  " })).toThrow();
		expect(() => normalizeSchedulerInput({ ...BASE, cwd: "" })).toThrow();
		expect(() => normalizeSchedulerInput({ ...BASE, prompt: "" })).toThrow();
	});

	it("prompt 超长拒绝（与 host.chat 同口径 8000）", () => {
		expect(() => normalizeSchedulerInput({ ...BASE, prompt: "x".repeat(8001) })).toThrow();
	});

	it("模型格式校验（provider/id）", () => {
		expect(normalizeSchedulerInput({ ...BASE, model: "openai/gpt-5" }).model).toBe("openai/gpt-5");
		expect(() => normalizeSchedulerInput({ ...BASE, model: "gpt-5" })).toThrow();
	});

	it("缺 id 自动生成合法 id", () => {
		const t = normalizeSchedulerInput({ ...BASE });
		expect(t.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
	});
});

describe("computeNextFire", () => {
	it("cron：每天 9 点从当天 8 点起算是今天 9 点", () => {
		// 2026-09-17 08:00 本地时区
		const from = new Date(2026, 8, 17, 8, 0, 0).getTime();
		const next = computeNextFire({ kind: "cron", spec: "0 9 * * *" }, from);
		const d = new Date(next!);
		expect(d.getHours()).toBe(9);
		expect(d.getMinutes()).toBe(0);
		expect(d.getDate()).toBe(17);
	});

	it("interval：fromMs + 毫秒", () => {
		expect(computeNextFire({ kind: "interval", spec: "3600000" }, 1000)).toBe(3601000);
	});

	it("非法回 null", () => {
		expect(computeNextFire({ kind: "cron", spec: "nope" }, Date.now())).toBeNull();
		expect(computeNextFire({ kind: "interval", spec: "0" }, Date.now())).toBeNull();
	});
});

describe("describeIntervalMs", () => {
	it("秒/分/时/天", () => {
		expect(describeIntervalMs(30_000)).toBe("每 30 秒");
		expect(describeIntervalMs(3_600_000)).toBe("每 1 小时");
		expect(describeIntervalMs(7_200_000)).toBe("每 2 小时");
		expect(describeIntervalMs(86_400_000)).toBe("每 1 天");
	});
});

describe("SchedulerStore", () => {
	let dir = "";
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "scheduler-test-"));
	});
	afterEach(() => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("upsert → list → 持久化往返（新 Store 读盘）", () => {
		const s = new SchedulerStore(dir, {});
		const task = s.upsert({ ...BASE, id: "daily" });
		expect(task.id).toBe("daily");
		const views = s.list();
		expect(views).toHaveLength(1);
		expect(views[0]!.nextFire).toBeGreaterThan(Date.now());
		expect(views[0]!.running).toBe(false);

		const s2 = new SchedulerStore(dir, {});
		s2.load();
		expect(s2.list()).toHaveLength(1);
		expect(s2.list()[0]!.prompt).toBe("审计依赖并报告");
	});

	it("坏文件当空表（不抛错）", () => {
		const s = new SchedulerStore(dir, {});
		s.upsert({ ...BASE, id: "a" });
		// 写坏文件
		writeFileSync(join(dir, "scheduler-tasks.json"), "{broken");
		const s2 = new SchedulerStore(dir, {});
		s2.load();
		expect(s2.list()).toHaveLength(0);
	});

	it("setEnabled 关 → nextFire 为 null；开 → 恢复", () => {
		const s = new SchedulerStore(dir, {});
		s.upsert({ ...BASE, id: "a" });
		s.setEnabled("a", false);
		expect(s.list()[0]!.enabled).toBe(false);
		expect(s.list()[0]!.nextFire).toBeNull();
		s.setEnabled("a", true);
		expect(s.list()[0]!.nextFire).toBeGreaterThan(Date.now());
	});

	it("remove 删任务；未知 id 回 false", () => {
		const s = new SchedulerStore(dir, {});
		s.upsert({ ...BASE, id: "a" });
		expect(s.remove("nope")).toBe(false);
		expect(s.remove("a")).toBe(true);
		expect(s.list()).toHaveLength(0);
	});

	it("runNow 无 executor 记失败（不抛错）", async () => {
		const s = new SchedulerStore(dir, {});
		s.upsert({ ...BASE, id: "a" });
		const r = await s.runNow("a");
		expect(r.ok).toBe(false);
		expect(s.list()[0]!.history).toHaveLength(1);
		expect(s.list()[0]!.lastRun!.ok).toBe(false);
	});

	it("runNow 调 executor 并记录成功 + 会话 id", async () => {
		const s = new SchedulerStore(dir, {
			executor: async () => ({ ok: true, conversationId: "conv-1" }),
		});
		s.upsert({ ...BASE, id: "a" });
		const r = await s.runNow("a");
		expect(r.ok).toBe(true);
		const v = s.list()[0]!;
		expect(v.lastRun!.ok).toBe(true);
		expect(v.lastRun!.conversationId).toBe("conv-1");
		expect(v.lastRun!.manual).toBe(true);
	});

	it("执行中 runNow 拒绝重入", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const s = new SchedulerStore(dir, {
			executor: async () => {
				await gate;
				return { ok: true };
			},
		});
		s.upsert({ ...BASE, id: "a" });
		const first = s.runNow("a");
		const second = await s.runNow("a");
		expect(second.ok).toBe(false);
		release();
		await first;
	});
});
