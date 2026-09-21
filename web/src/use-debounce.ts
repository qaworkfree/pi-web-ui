import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * 状态值防抖 Hook。
 *
 * 当值频繁变化时（如用户在搜索框中连续键入），延迟更新输出值，
 * 避免频繁触发过滤计算、高亮或重新渲染。
 *
 * @param value 输入值
 * @param delayMs 防抖等待时间（ms）
 * @returns 经过防抖后的值
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
	const [debouncedValue, setDebouncedValue] = useState<T>(value);

	useEffect(() => {
		if (delayMs <= 0) {
			setDebouncedValue(value);
			return;
		}

		const timer = setTimeout(() => {
			setDebouncedValue(value);
		}, delayMs);

		return () => {
			clearTimeout(timer);
		};
	}, [value, delayMs]);

	return debouncedValue;
}

/**
 * 回调函数防抖 Hook。
 *
 * 返回一个防抖包装后的函数，在最后一次调用经过 delayMs 后执行。
 * 内部走 ref，保持对最新 callback 的引用，不会因为闭包变动导致定时器被重置。
 */
export function useDebouncedCallback<TArgs extends unknown[]>(
	callback: (...args: TArgs) => void,
	delayMs: number,
): (...args: TArgs) => void {
	const callbackRef = useRef(callback);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useLayoutEffect(() => {
		callbackRef.current = callback;
	});

	useEffect(() => {
		return () => {
			if (timerRef.current !== null) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
		};
	}, []);

	return useCallback(
		(...args: TArgs) => {
			if (timerRef.current !== null) {
				clearTimeout(timerRef.current);
			}

			if (delayMs <= 0) {
				callbackRef.current(...args);
				return;
			}

			timerRef.current = setTimeout(() => {
				timerRef.current = null;
				callbackRef.current(...args);
			}, delayMs);
		},
		[delayMs],
	);
}
