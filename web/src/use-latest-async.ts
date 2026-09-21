import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface UseLatestAsyncOptions<T> {
	/** 防抖延迟（ms）。若传大于 0 的数值，调用 run 时会自动防抖。 */
	debounceMs?: number;
	/** 成功回调（仅最新一次请求会触发）。 */
	onSuccess?: (data: T) => void;
	/** 失败回调（仅最新一次请求会触发）。 */
	onError?: (error: unknown) => void;
}

export interface UseLatestAsyncResult<TArgs extends unknown[], TResult> {
	/** 触发异步操作。若有 debounceMs 则自动防抖。 */
	run: (...args: TArgs) => void;
	/** 取消当前正在进行的请求（丢弃后续响应）。 */
	cancel: () => void;
	/** 当前是否正在执行中。 */
	loading: boolean;
	/** 最新一次成功返回的数据。 */
	data: TResult | undefined;
	/** 最新一次失败的错误对象。 */
	error: unknown;
}

/**
 * 异步防抖与时序竞态取消 Hook。
 *
 * 解决痛点：
 * 1. 【时序竞态（Race Condition）】：先发出的慢请求若迟于后发出的快请求返回，自动丢弃慢请求响应，绝不覆盖最新结果；
 * 2. 【内置防抖】：开箱支持防抖，连续输入时自动合并；
 * 3. 【卸载安全】：组件卸载时自动阻断未完成请求的 state 更新，杜绝 React 卸载组件更新警告。
 */
export function useLatestAsync<TArgs extends unknown[], TResult>(
	asyncFn: (...args: TArgs) => Promise<TResult>,
	options: UseLatestAsyncOptions<TResult> = {},
): UseLatestAsyncResult<TArgs, TResult> {
	const { debounceMs = 0, onSuccess, onError } = options;

	const [loading, setLoading] = useState(false);
	const [data, setData] = useState<TResult | undefined>(undefined);
	const [error, setError] = useState<unknown>(undefined);

	const reqIdRef = useRef(0);
	const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const fnRef = useRef(asyncFn);
	const onSuccessRef = useRef(onSuccess);
	const onErrorRef = useRef(onError);

	useLayoutEffect(() => {
		fnRef.current = asyncFn;
		onSuccessRef.current = onSuccess;
		onErrorRef.current = onError;
	});

	const cancel = useCallback(() => {
		if (debounceTimerRef.current !== null) {
			clearTimeout(debounceTimerRef.current);
			debounceTimerRef.current = null;
		}
		// 递增 reqId，使所有正在执行中的 promise 回调失效
		reqIdRef.current++;
		setLoading(false);
	}, []);

	// 卸载时清理
	useEffect(() => {
		return () => {
			if (debounceTimerRef.current !== null) {
				clearTimeout(debounceTimerRef.current);
				debounceTimerRef.current = null;
			}
			reqIdRef.current++;
		};
	}, []);

	const execute = useCallback((currentReqId: number, args: TArgs) => {
		setLoading(true);
		setError(undefined);

		fnRef
			.current(...args)
			.then((result) => {
				// 只有当前请求仍是最新的请求时才更新状态
				if (currentReqId === reqIdRef.current) {
					setData(result);
					setLoading(false);
					onSuccessRef.current?.(result);
				}
			})
			.catch((err) => {
				if (currentReqId === reqIdRef.current) {
					setError(err);
					setLoading(false);
					onErrorRef.current?.(err);
				}
			});
	}, []);

	const run = useCallback(
		(...args: TArgs) => {
			if (debounceTimerRef.current !== null) {
				clearTimeout(debounceTimerRef.current);
				debounceTimerRef.current = null;
			}

			const currentReqId = ++reqIdRef.current;

			if (debounceMs > 0) {
				debounceTimerRef.current = setTimeout(() => {
					debounceTimerRef.current = null;
					execute(currentReqId, args);
				}, debounceMs);
			} else {
				execute(currentReqId, args);
			}
		},
		[debounceMs, execute],
	);

	return { run, cancel, loading, data, error };
}
