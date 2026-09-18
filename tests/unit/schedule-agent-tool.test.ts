/**
 * issue #193：schedule_task/list/cancel 三件套。
 * 时间解析纯函数 + 工具 execute 直调（真 SchedulerStore 落临时 dataDir，
 * 不起 server、不调模型）：建任务默认绑定发起对话＋单次，列表/取消闭环。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentService } from "../../server/agent-service.js";
import { SchedulerStore } from "../../server/scheduler-tasks.js";
import { makeScheduleTools, parseScheduleSpec, type ScheduleToolHost } from "../../server/schedule-agent-tool.js";
import { normalizeSchedulerInput } from "../../server/scheduler-tasks.js";

const CTX = { cwd: "/tmp" } as unknown as ExtensionContext;

function resultText(r: { content: { type: string; text?: string }[] }): string {
	return r.content.map((c) => c.text ?? "").join("\n");
}

describe("parseScheduleSpec", () => {
	it("5 字段走 cron（原样单空格）", () => {
		expect(parseScheduleSpec("0  *  * * *")).toEqual({ kind: "cron", spec: "0 * * * *" });
		expect(parseScheduleSpec("*/30 9 * * 1-5")).toEqual({ kind: "cron", spec: "*/30 9 * * 1-5" });
	});
	it("相对时间与裸时长走 interval（毫秒字符串）", () => {
		expect(parseScheduleSpec("in 30m")).toEqual({ kind: "interval", spec: String(30 * 60_000) });
		expect(parseScheduleSpec("in 1h")).toEqual({ kind: "interval", spec: String(3_600_000) });
		expect(parseScheduleSpec("in 2d")).toEqual({ kind: "interval", spec: String(2 * 86_400_000) });
		expect(parseScheduleSpec("45m")).toEqual({ kind: "interval", spec: String(45 * 60_000) });
		expect(parseScheduleSpec("in 90s")).toEqual({ kind: "interval", spec: String(90_000) });
		expect(parseScheduleSpec("30")).toEqual({ kind: "interval", spec: String(30 * 60_000) }); // 裸数字按分钟
	});
	it("非法写法抛错", () => {
		expect(() => parseScheduleSpec("")).toThrow();
		expect(() => parseScheduleSpec("明天早上")).toThrow();
		expect(() => parseScheduleSpec("0 0")).toThrow();
		expect(() => parseScheduleSpec("61 25 * * *")).toThrow(); // 5 段但非法 cron
	});
});

describe("normalizeSchedulerInput 新字段", () => {
	const base = { name: "t", cwd: "/tmp", kind: "interval" as const, spec: "600000", prompt: "hi" };
	it("conversationId/oneShot 透传（缺省 空/false）", () => {
		const t = normalizeSchedulerInput(base);
		expect(t.conversationId).toBe("");
		expect(t.oneShot).toBe(false);
		const t2 = normalizeSchedulerInput({ ...base, conversationId: "  c9 ", oneShot: true });
		expect(t2.conversationId).toBe("c9");
		expect(t2.oneShot).toBe(true);
	});
});

describe("AgentService.wakeConversation（无持有方路径）", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sched-wake-test-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});
	it("找不到对话回 ok:false；空参回错；quiesce 直接拒绝", async () => {
		const svc = new AgentService(dir, join(dir, "client-state.json"));
		const miss = await svc.wakeConversation("c-nope", "hi");
		expect(miss.ok).toBe(false);
		expect(miss.error).toContain("不在运行中");
		expect(await svc.wakeConversation("", "hi")).toMatchObject({ ok: false });
		svc.quiesce();
		const q = await svc.wakeConversation("c-nope", "hi");
		expect(q.ok).toBe(false);
		expect(q.error).toContain("quiesced");
	});
});

describe("schedule_* 工具闭环", () => {
	let dir: string;
	let store: SchedulerStore;
	let tools: ReturnType<typeof makeScheduleTools>;
	let host: ScheduleToolHost;

	const call = async (name: string, params: Record<string, unknown>) => {
		const tool = tools.find((t) => t.name === name)!;
		expect(tool, name).toBeTruthy();
		return tool.execute("call-1", params as never, undefined, undefined, CTX);
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sched-tool-test-"));
		store = new SchedulerStore(dir);
		host = {
			store: () => store,
			cwd: () => dir,
			activeConversationId: () => "c7",
		};
		tools = makeScheduleTools(host, "c7", () => "zh");
	});

	afterEach(() => {
		store.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	it("建单次任务：默认绑定发起对话＋oneShot，返回下次触发与取消方式", async () => {
		const r = await call("schedule_task", { schedule: "in 30m", prompt: "检查训练日志并汇报" });
		const text = resultText(r);
		expect(text).toContain("定时任务已创建");
		expect(text).toContain("单次，触发后自动删除");
		expect(text).toContain("schedule_cancel");
		const tasks = store.list();
		expect(tasks).toHaveLength(1);
		expect(tasks[0]!.conversationId).toBe("c7");
		expect(tasks[0]!.oneShot).toBe(true);
		expect(tasks[0]!.kind).toBe("interval");
		expect(tasks[0]!.cwd).toBe(dir);
	});

	it("recurring=true 建周期 cron 任务", async () => {
		const r = await call("schedule_task", {
			schedule: "0 * * * *",
			prompt: "每小时巡检",
			label: "巡检",
			recurring: true,
		});
		expect(resultText(r)).toContain("周期");
		const tasks = store.list();
		expect(tasks).toHaveLength(1);
		expect(tasks[0]!.oneShot).toBe(false);
		expect(tasks[0]!.kind).toBe("cron");
		expect(tasks[0]!.name).toBe("巡检");
	});

	it("非法输入给中文报错：坏时间/超短间隔/空 prompt", async () => {
		expect(resultText(await call("schedule_task", { schedule: "明天", prompt: "x" }))).toContain("非法");
		expect(resultText(await call("schedule_task", { schedule: "in 30s", prompt: "x" }))).toContain("最短 60s");
		expect(resultText(await call("schedule_task", { schedule: "in 30m", prompt: "  " }))).toContain("不能为空");
		expect(store.list()).toHaveLength(0);
	});

	it("list 展示全部任务，cancel 按 id 删除（删空报错）", async () => {
		await call("schedule_task", { schedule: "in 30m", prompt: "甲" });
		await call("schedule_task", { schedule: "in 1h", prompt: "乙", recurring: true });
		const list = resultText(await call("schedule_list", {}));
		expect(list).toContain("定时任务（2）");
		const id = store.list()[0]!.id;
		expect(resultText(await call("schedule_cancel", { id }))).toContain("已删除");
		expect(store.list()).toHaveLength(1);
		expect(resultText(await call("schedule_cancel", { id: "no-such" }))).toContain("没有");
		expect(resultText(await call("schedule_cancel", { id: "" }))).toContain("id");
	});

	it("store 未接入时直接报错（DSH 这类引擎）", async () => {
		const dead = makeScheduleTools({ ...host, store: () => undefined }, "c7", () => "zh");
		const t = dead.find((x) => x.name === "schedule_task")!;
		expect(
			resultText(await t.execute("c", { schedule: "in 30m", prompt: "x" } as never, undefined, undefined, CTX)),
		).toContain("不支持");
	});
});
