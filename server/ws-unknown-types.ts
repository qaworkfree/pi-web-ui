/**
 * Unknown inbound WS message-type counter —— 独立成模块是为了可单测
 * （`server/index.ts` 起 WS + SDK，不适合在单测里 import）。
 *
 * 背景：`dispatch` 的 `switch (msg.type)` 的 `default:` 分支原来是空的，
 * 版本错位（旧前端/新服务端）或插件发错 type 时静默丢弃，只能抓包排查。
 * 这里只做计数 + 节流 warn，不改变任何已知类型的行为。
 */

/** 同一 type 两次 warn 之间最小间隔（防刷屏），可单测覆盖。 */
export const UNKNOWN_WS_WARN_INTERVAL_MS = 60_000;

const counts = new Map<string, number>();
const lastWarnAt = new Map<string, number>();

/**
 * 记录一次未知 type，计数永远 +1；同一 type 在 `UNKNOWN_WS_WARN_INTERVAL_MS`
 * 内只返回一次 `warn: true`（调用方决定是否 `console.warn`）。
 */
export function recordUnknownWsType(type: string, now: number = Date.now()): { count: number; warn: boolean } {
	const count = (counts.get(type) ?? 0) + 1;
	counts.set(type, count);
	const last = lastWarnAt.get(type) ?? -Infinity;
	if (now - last >= UNKNOWN_WS_WARN_INTERVAL_MS) {
		lastWarnAt.set(type, now);
		return { count, warn: true };
	}
	return { count, warn: false };
}

/** 只读快照（排障用，不暴露可变 Map）。 */
export function unknownWsCounts(): ReadonlyMap<string, number> {
	return counts;
}

/** 单测隔离用。 */
export function resetUnknownWsTypes(): void {
	counts.clear();
	lastWarnAt.clear();
}
