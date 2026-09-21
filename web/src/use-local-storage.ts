import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface UseLocalStorageOptions<T> {
	/**
	 * 可选校验器：当从存储中读出的数据通过校验时才使用，否则回退默认值。
	 * 防止版本迭代字段变更引起的脏数据导致渲染崩溃。
	 */
	validator?: (value: unknown) => value is T;
	/**
	 * 是否监听其他标签页的变更并同步（默认 true）。
	 */
	syncTabs?: boolean;
}

const IN_PAGE_STORAGE_EVENT = "pi-web:local-storage-sync";

interface InPageStorageDetail {
	key: string;
	value: unknown;
}

/**
 * 安全读取 localStorage。
 */
export function readLocalStorage<T>(key: string, fallback: T, validator?: (value: unknown) => value is T): T {
	if (typeof window === "undefined" || !window.localStorage) {
		return fallback;
	}
	try {
		const raw = window.localStorage.getItem(key);
		if (raw === null) return fallback;

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			// 如果不是合法的 JSON 字符串，但在字符串类型下可以直接使用原始值
			parsed = raw;
		}

		if (validator) {
			return validator(parsed) ? parsed : fallback;
		}

		return parsed as T;
	} catch {
		return fallback;
	}
}

/**
 * 安全写入 localStorage，并通知同页面其他使用同一 key 的 hook 实例。
 */
export function writeLocalStorage<T>(key: string, value: T): boolean {
	if (typeof window === "undefined" || !window.localStorage) {
		return false;
	}
	try {
		const serialized = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value);
		window.localStorage.setItem(key, serialized);

		// 同一页面内派发同步事件（原生 storage 事件只在 OTHER 标签页触发）
		if (typeof window.dispatchEvent === "function") {
			window.dispatchEvent(
				new CustomEvent<InPageStorageDetail>(IN_PAGE_STORAGE_EVENT, {
					detail: { key, value },
				}),
			);
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * 安全删除 localStorage 项。
 */
export function removeLocalStorage(key: string): boolean {
	if (typeof window === "undefined" || !window.localStorage) {
		return false;
	}
	try {
		window.localStorage.removeItem(key);
		if (typeof window.dispatchEvent === "function") {
			window.dispatchEvent(
				new CustomEvent<InPageStorageDetail>(IN_PAGE_STORAGE_EVENT, {
					detail: { key, value: null },
				}),
			);
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * 响应式本地存储 Hook。
 *
 * 解决痛点：
 * 1. 【跨标签页与同页同步】：监听原生 `storage` 事件与页面内广播，A 标签页改了偏好设置，B 标签页秒级同步；
 * 2. 【防脏数据白屏】：支持传入 validator，脏数据自动回退默认值；
 * 3. 【无痕与异常安全】：Safari 无痕、配额超限时静默回退内存状态，不抛错；
 * 4. 【开箱即用】：接口与 `useState` 完全一致，支持传函数式 updater。
 */
export function useLocalStorage<T>(
	key: string,
	initialValue: T | (() => T),
	options: UseLocalStorageOptions<T> = {},
): [T, (valueOrUpdater: T | ((prev: T) => T)) => void, () => void] {
	const { validator, syncTabs = true } = options;

	const fallbackRef = useRef(initialValue);
	useLayoutEffect(() => {
		fallbackRef.current = initialValue;
	});

	const getInitial = (): T => {
		const fallback =
			typeof fallbackRef.current === "function" ? (fallbackRef.current as () => T)() : fallbackRef.current;
		return readLocalStorage(key, fallback, validator);
	};

	const [storedValue, setStoredValue] = useState<T>(getInitial);

	// 当 key 改变时重新读取
	useEffect(() => {
		setStoredValue(getInitial());
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key]);

	const setValue = useCallback(
		(valueOrUpdater: T | ((prev: T) => T)) => {
			setStoredValue((prev) => {
				const nextValue =
					typeof valueOrUpdater === "function" ? (valueOrUpdater as (prev: T) => T)(prev) : valueOrUpdater;

				writeLocalStorage(key, nextValue);
				return nextValue;
			});
		},
		[key],
	);

	const remove = useCallback(() => {
		removeLocalStorage(key);
		const fallback =
			typeof fallbackRef.current === "function" ? (fallbackRef.current as () => T)() : fallbackRef.current;
		setStoredValue(fallback);
	}, [key]);

	// 监听跨标签页同步与同页广播
	useEffect(() => {
		if (!syncTabs || typeof window === "undefined") return;

		const handleStorage = (e: StorageEvent) => {
			if (e.key !== key) return;
			const fallback =
				typeof fallbackRef.current === "function" ? (fallbackRef.current as () => T)() : fallbackRef.current;
			setStoredValue(readLocalStorage(key, fallback, validator));
		};

		const handleInPageSync = (e: Event) => {
			const detail = (e as CustomEvent<InPageStorageDetail>).detail;
			if (detail && detail.key === key) {
				const fallback =
					typeof fallbackRef.current === "function" ? (fallbackRef.current as () => T)() : fallbackRef.current;
				if (detail.value === null) {
					setStoredValue(fallback);
				} else if (validator) {
					setStoredValue(validator(detail.value) ? detail.value : fallback);
				} else {
					setStoredValue(detail.value as T);
				}
			}
		};

		window.addEventListener("storage", handleStorage);
		window.addEventListener(IN_PAGE_STORAGE_EVENT, handleInPageSync);

		return () => {
			window.removeEventListener("storage", handleStorage);
			window.removeEventListener(IN_PAGE_STORAGE_EVENT, handleInPageSync);
		};
	}, [key, syncTabs, validator]);

	return [storedValue, setValue, remove];
}
