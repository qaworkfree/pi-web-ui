import { useEffect, useState } from "react";

/**
 * 响应式媒体查询 Hook。
 *
 * 解决痛点：
 * 1. 【兼容性抹平】：自动兼容新版 `addEventListener("change")` 与旧版 `addListener`；
 * 2. 【SSR / jsdom 安全】：无 window 或 matchMedia 环境时优雅回退 false；
 * 3. 【实时跨断点响应】：屏幕尺寸跨越断点时实时触发重渲。
 *
 * @example
 * const isMobile = useMediaQuery("(max-width: 768px)");
 */
export function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState<boolean>(() => {
		if (typeof window === "undefined" || typeof window.matchMedia === "undefined") {
			return false;
		}
		try {
			return window.matchMedia(query).matches;
		} catch {
			return false;
		}
	});

	useEffect(() => {
		if (typeof window === "undefined" || typeof window.matchMedia === "undefined") {
			return;
		}

		let mq: MediaQueryList;
		try {
			mq = window.matchMedia(query);
		} catch {
			return;
		}

		const onChange = (e: MediaQueryListEvent) => {
			setMatches(e.matches);
		};

		if (typeof mq.addEventListener === "function") {
			mq.addEventListener("change", onChange);
		} else if (typeof mq.addListener === "function") {
			mq.addListener(onChange);
		}

		// 挂载后同步最新值（防止构建与挂载间隙发生尺寸变化）
		setMatches(mq.matches);

		return () => {
			if (typeof mq.removeEventListener === "function") {
				mq.removeEventListener("change", onChange);
			} else if (typeof mq.removeListener === "function") {
				mq.removeListener(onChange);
			}
		};
	}, [query]);

	return matches;
}
