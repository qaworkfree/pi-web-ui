import os from "node:os";
import type { UiHostMetrics } from "./protocol.js";

export interface HostResourceSnapshot {
	cpuIdle: number;
	cpuTotal: number;
	memoryFree: number;
	memoryTotal: number;
}

function calculateMemoryPercent(snapshot: HostResourceSnapshot): number {
	const memoryUsed = Math.max(0, snapshot.memoryTotal - snapshot.memoryFree);
	return snapshot.memoryTotal > 0
		? Math.max(0, Math.min(100, (memoryUsed / snapshot.memoryTotal) * 100))
		: 0;
}

export function defaultReadSnapshot(): HostResourceSnapshot {
	const cpus = os.cpus();
	let cpuIdle = 0;
	let cpuTotal = 0;
	for (const cpu of cpus) {
		const times = cpu.times;
		const total = (times.user ?? 0) + (times.nice ?? 0) + (times.sys ?? 0) + (times.idle ?? 0) + (times.irq ?? 0);
		cpuIdle += times.idle ?? 0;
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

	const memoryPercent = calculateMemoryPercent(current);

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
			return {
				cpuPercent: null,
				memoryPercent: calculateMemoryPercent(current),
			};
		}
		const metrics = calculateHostMetrics(previous, current);
		previous = current;
		return metrics;
	};
}
