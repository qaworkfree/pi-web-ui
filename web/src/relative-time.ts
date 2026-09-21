import { useEffect, useState } from "react";

export type RelativeTimeLang = "zh" | "en";

/**
 * 纯函数：相对时间格式化（“刚刚 / N 分钟前 / N 小时前 / N 天前”）。
 *
 * 阈值口径与 `BgTasksModal.formatSince` 一致：
 * - < 1 分钟 → justNow；
 * - < 60 分钟 → N minutes；
 * - < 24 小时 → N hours；
 * - 否则 → N days。
 *
 * 自带 zh/en 双语，不依赖 i18n 上下文，可在任何纯函数单测中直接覆盖；
 * 需要其他语言时由调用方按返回值自行映射（或扩展本文件的 STRINGS 表）。
 */
export function formatRelativeTime(sinceMs: number, nowMs: number = Date.now(), lang: RelativeTimeLang = "zh"): string {
	const ms = Math.max(0, nowMs - sinceMs);
	const min = Math.floor(ms / 60_000);
	if (min < 1) return lang === "zh" ? "刚刚" : "just now";
	if (min < 60) return lang === "zh" ? `${min} 分钟前` : `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return lang === "zh" ? `${hr} 小时前` : `${hr}h ago`;
	const days = Math.floor(hr / 24);
	return lang === "zh" ? `${days} 天前` : `${days}d ago`;
}

/**
 * 响应式相对时间 Hook：返回值每分钟自动刷新一次
 * （如“1 分钟前”会在下一分钟变为“2 分钟前”，无需父组件轮询）。
 */
export function useRelativeTime(sinceMs: number, lang: RelativeTimeLang = "zh"): string {
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		const timer = setInterval(() => {
			setNow(Date.now());
		}, 60_000);
		return () => {
			clearInterval(timer);
		};
	}, []);

	return formatRelativeTime(sinceMs, now, lang);
}
