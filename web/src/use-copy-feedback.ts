import { useCallback, useEffect, useRef, useState } from "react";

export interface UseCopyFeedbackOptions {
	/** 成功状态持续时间（ms），默认 2000。 */
	duration?: number;
	/** 复制成功后的可选回调。 */
	onSuccess?: (text: string) => void;
	/** 复制失败后的可选回调。 */
	onError?: (error: unknown) => void;
}

export interface UseCopyFeedbackResult {
	/** 当前是否处于复制成功的展示状态。 */
	copied: boolean;
	/** 执行复制操作，返回是否成功。 */
	copy: (text: string) => Promise<boolean>;
	/** 提前重置复制状态。 */
	reset: () => void;
}

/**
 * 降级复制方案：用于非安全上下文（如 http://IP:PORT 访问）或 clipboard API 被阻断的环境。
 */
function fallbackCopyText(text: string): boolean {
	if (typeof document === "undefined") return false;
	try {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.style.position = "fixed";
		ta.style.left = "-9999px";
		ta.style.top = "-9999px";
		ta.setAttribute("readonly", "");
		document.body.appendChild(ta);
		ta.select();
		const ok = document.execCommand("copy");
		document.body.removeChild(ta);
		return ok;
	} catch {
		return false;
	}
}

/**
 * 统一复制反馈 Hook。
 *
 * 解决痛点：
 * 1. 【异常与非安全上下文兜底】：navigator.clipboard 抛错或不支持时自动降级 execCommand；
 * 2. 【卸载安全】：组件卸载时自动清理 timer，杜绝内存泄漏；
 * 3. 【连续点击防抖】：连续快速点击时自动续期 feedback 倒计时；
 * 4. 【样板代码消除】：无需再在业务组件中手写 useState + setTimeout。
 */
export function useCopyFeedback(options: UseCopyFeedbackOptions = {}): UseCopyFeedbackResult {
	const { duration = 2000, onSuccess, onError } = options;
	const [copied, setCopied] = useState(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clearTimer = useCallback(() => {
		if (timerRef.current !== null) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
	}, []);

	const reset = useCallback(() => {
		clearTimer();
		setCopied(false);
	}, [clearTimer]);

	// 卸载时清理定时器
	useEffect(() => {
		return () => {
			clearTimer();
		};
	}, [clearTimer]);

	const copy = useCallback(
		async (text: string): Promise<boolean> => {
			let ok = false;
			try {
				if (
					typeof navigator !== "undefined" &&
					navigator.clipboard &&
					typeof navigator.clipboard.writeText === "function"
				) {
					await navigator.clipboard.writeText(text);
					ok = true;
				} else {
					ok = fallbackCopyText(text);
				}
			} catch (err) {
				// clipboard API 失败时尝试 fallback
				ok = fallbackCopyText(text);
				if (!ok && onError) {
					onError(err);
				}
			}

			if (ok) {
				setCopied(true);
				clearTimer();
				timerRef.current = setTimeout(() => {
					setCopied(false);
					timerRef.current = null;
				}, duration);
				onSuccess?.(text);
			}

			return ok;
		},
		[duration, onSuccess, onError, clearTimer],
	);

	return { copied, copy, reset };
}
