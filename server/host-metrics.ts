import os from "node:os";
import type { UiHostMetrics } from "./protocol.js";

export interface HostResourceSnapshot {
	cpuIdle: number;
	cpuTotal: number;
	memoryFree: number;
	memoryTotal: number;
}

export function defaultReadSnapshot(): HostResourceSnapshot {
	const cpus = os.cpus();
	let cpuIdle = 0;
	let cpuTotal = 0;
	for (const cpu of cpus) {
		const t = cpu.times;
		const total = (t.user ?? 0) + (t.nice ?? 0) + (t.sys ?? 0) + (t.idle ?? 0) + (t.irq ?? 0);
		cpuIdle += t.idle ?? 0;
		cpuTotal += total;
	}
	return {
		cpuIdle,
		cpuTotal,
		memoryFree: os.freemem(),
		memoryTotal: os.totalmem(),
	};
}

export function calculateHostMetrics(previous: HostResourceSnapshot, current: HostResourceSnapshot): UiHostMetrics {
	const totalDelta = current.cpuTotal - previous.cpuTotal;
	const idleDelta = current.cpuIdle - previous.cpuIdle;

	let cpuPercent: number | null = null;
	if (totalDelta > 0) {
		const rawPercent = (1 - idleDelta / totalDelta) * 100;
		cpuPercent = Math.max(0, Math.min(100, rawPercent));
	}

	const memTotal = current.memoryTotal;
	const memFree = current.memoryFree;
	const memUsed = Math.max(0, memTotal - memFree);
	const memoryPercent = memTotal > 0 ? Math.max(0, Math.min(100, (memUsed / memTotal) * 100)) : 0;

	return {
		cpuPercent,
		memoryPercent,
	};
}

export function createHostMetricsSampler(
	readSnapshot: () => HostResourceSnapshot = defaultReadSnapshot,
): () => UiHostMetrics {
	let previous: HostResourceSnapshot | null = null;
	try {
		previous = readSnapshot();
	} catch {
		// 初始基线读取异常时不击穿服务启动，待后续心跳重试
		previous = null;
	}

	return () => {
		const current = readSnapshot();
		if (!previous) {
			previous = current;
			const memTotal = current.memoryTotal;
			const memFree = current.memoryFree;
			const memUsed = Math.max(0, memTotal - memFree);
			const memoryPercent = memTotal > 0 ? Math.max(0, Math.min(100, (memUsed / memTotal) * 100)) : 0;
			return {
				cpuPercent: null,
				memoryPercent,
			};
		}
		const metrics = calculateHostMetrics(previous, current);
		previous = current;
		return metrics;
	};
}
