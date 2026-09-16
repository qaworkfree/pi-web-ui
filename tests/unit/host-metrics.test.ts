import { describe, expect, it } from "vitest";
import { calculateHostMetrics, createHostMetricsSampler } from "../../server/host-metrics.js";

describe("calculateHostMetrics", () => {
	it("正常输入：计算处理器与内存百分比", () => {
		const prev = { cpuIdle: 100, cpuTotal: 400, memoryFree: 250, memoryTotal: 1000 };
		const curr = { cpuIdle: 140, cpuTotal: 500, memoryFree: 250, memoryTotal: 1000 };
		const res = calculateHostMetrics(prev, curr);
		expect(res.cpuPercent).toBeCloseTo(60);
		expect(res.memoryPercent).toBeCloseTo(75);
	});

	it("总时间差为 0 时处理器结果为 null", () => {
		const prev = { cpuIdle: 100, cpuTotal: 400, memoryFree: 250, memoryTotal: 1000 };
		const curr = { cpuIdle: 100, cpuTotal: 400, memoryFree: 250, memoryTotal: 1000 };
		const res = calculateHostMetrics(prev, curr);
		expect(res.cpuPercent).toBeNull();
		expect(res.memoryPercent).toBeCloseTo(75);
	});

	it("异常输入不会越界：空闲差小于 0 或大于总时间差时 clamp 在 0-100", () => {
		// 空闲差小于 0（时钟回退等异常）：cpuPercent 不得超过 100
		const prev1 = { cpuIdle: 200, cpuTotal: 400, memoryFree: 250, memoryTotal: 1000 };
		const curr1 = { cpuIdle: 100, cpuTotal: 500, memoryFree: 250, memoryTotal: 1000 };
		const res1 = calculateHostMetrics(prev1, curr1);
		expect(res1.cpuPercent).toBe(100);

		// 空闲差大于总差：cpuPercent 不得小于 0
		const prev2 = { cpuIdle: 100, cpuTotal: 400, memoryFree: 250, memoryTotal: 1000 };
		const curr2 = { cpuIdle: 300, cpuTotal: 500, memoryFree: 250, memoryTotal: 1000 };
		const res2 = calculateHostMetrics(prev2, curr2);
		expect(res2.cpuPercent).toBe(0);
	});

	it("总内存为 0 时内存结果为 0", () => {
		const prev = { cpuIdle: 100, cpuTotal: 400, memoryFree: 0, memoryTotal: 0 };
		const curr = { cpuIdle: 140, cpuTotal: 500, memoryFree: 0, memoryTotal: 0 };
		const res = calculateHostMetrics(prev, curr);
		expect(res.memoryPercent).toBe(0);
	});
});

describe("createHostMetricsSampler", () => {
	it("可注入采样器连续读取三个快照，基线按次推进", () => {
		const snapshots = [
			{ cpuIdle: 100, cpuTotal: 400, memoryFree: 250, memoryTotal: 1000 },
			{ cpuIdle: 140, cpuTotal: 500, memoryFree: 250, memoryTotal: 1000 },
			{ cpuIdle: 160, cpuTotal: 600, memoryFree: 100, memoryTotal: 1000 },
		];
		let idx = 0;
		const readSnapshot = () => snapshots[idx++];
		const sampler = createHostMetricsSampler(readSnapshot);

		// 第一次调用：基于快照 0 与快照 1
		const res1 = sampler();
		expect(res1.cpuPercent).toBeCloseTo(60);
		expect(res1.memoryPercent).toBeCloseTo(75);

		// 第二次调用：基于快照 1 与快照 2
		const res2 = sampler();
		expect(res2.cpuPercent).toBeCloseTo(80);
		expect(res2.memoryPercent).toBeCloseTo(90);
	});
});
