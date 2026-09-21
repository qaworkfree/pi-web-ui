import { useEffect, useLayoutEffect, useRef } from "react";

export interface ParsedShortcut {
	key: string;
	mod: boolean;
	ctrl: boolean;
	meta: boolean;
	shift: boolean;
	alt: boolean;
}

export interface UseKeyboardShortcutOptions {
	/** 是否启用（默认 true）。 */
	enabled?: boolean;
	/**
	 * 是否允许在输入框（<input>, <textarea>, contenteditable）中触发。
	 * 默认 false（避免打字时误触发全局快捷键）。
	 */
	allowInInputs?: boolean;
	/** 是否自动调用 e.preventDefault()（默认 true）。 */
	preventDefault?: boolean;
	/** 是否自动调用 e.stopPropagation()（默认 true）。 */
	stopPropagation?: boolean;
	/** 是否在捕获期监听（默认 false）。 */
	capture?: boolean;
}

/**
 * 纯函数：解析快捷键字符串（如 "mod+k", "ctrl+shift+p", "Escape"）。
 */
export function parseShortcut(combo: string): ParsedShortcut {
	const parts = combo
		.toLowerCase()
		.split("+")
		.map((p) => p.trim())
		.filter(Boolean);

	let mod = false;
	let ctrl = false;
	let meta = false;
	let shift = false;
	let alt = false;
	let key = "";

	for (const part of parts) {
		if (part === "mod" || part === "cmd" || part === "command") {
			mod = true;
		} else if (part === "ctrl" || part === "control") {
			ctrl = true;
		} else if (part === "meta") {
			meta = true;
		} else if (part === "shift") {
			shift = true;
		} else if (part === "alt" || part === "option") {
			alt = true;
		} else {
			key = part;
		}
	}

	return { key, mod, ctrl, meta, shift, alt };
}

/**
 * 纯函数：判断当前平台是否为 macOS/iOS。
 */
export function isMacPlatform(): boolean {
	if (typeof navigator === "undefined") return false;
	return /(Mac|iPhone|iPod|iPad)/i.test(navigator.platform || navigator.userAgent);
}

/**
 * 纯函数：判断事件是否匹配给定的快捷键定义。
 */
export function matchShortcut(e: KeyboardEvent, def: ParsedShortcut, isMac: boolean = isMacPlatform()): boolean {
	if (e.key.toLowerCase() !== def.key) {
		return false;
	}

	// mod 键适配：Mac 下为 metaKey，其他平台为 ctrlKey
	const hasMod = isMac ? e.metaKey : e.ctrlKey;
	if (def.mod) {
		if (!hasMod) return false;
	} else {
		// 如果快捷键未声明 mod，但显式声明了 ctrl 或 meta
		if (def.ctrl !== e.ctrlKey) return false;
		if (def.meta !== e.metaKey) return false;
	}

	if (def.shift !== e.shiftKey) return false;
	if (def.alt !== e.altKey) return false;

	return true;
}

/**
 * 判断当前焦点是否在输入框、文本域或富文本编辑区。
 */
export function isEditableElement(el: EventTarget | null): boolean {
	if (!el || !(el instanceof Element)) return false;
	const tag = el.tagName.toLowerCase();
	if (tag === "input" || tag === "textarea") return true;
	if ((el as HTMLElement).isContentEditable) return true;
	return false;
}

/**
 * 跨平台快捷键绑定 Hook。
 *
 * 解决痛点：
 * 1. 【抹平平台差异】：`mod` 自动映射为 Mac Command 或 Windows/Linux Ctrl；
 * 2. 【输入冲突防御】：默认在 `<input>`、`<textarea>` 打字时静默放行，不误抢键；
 * 3. 【闭包安全】：callback 走 ref，闭包更新不触发全局事件监听器的解绑与重新挂载。
 */
export function useKeyboardShortcut(
	combo: string,
	callback: (e: KeyboardEvent) => void,
	options: UseKeyboardShortcutOptions = {},
): void {
	const {
		enabled = true,
		allowInInputs = false,
		preventDefault = true,
		stopPropagation = true,
		capture = false,
	} = options;

	const callbackRef = useRef(callback);
	useLayoutEffect(() => {
		callbackRef.current = callback;
	});

	const defRef = useRef<ParsedShortcut>(parseShortcut(combo));
	useLayoutEffect(() => {
		defRef.current = parseShortcut(combo);
	}, [combo]);

	useEffect(() => {
		if (!enabled) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			// 如果不允许在输入框中触发，检查焦点目标
			if (!allowInInputs && isEditableElement(e.target)) {
				return;
			}

			if (matchShortcut(e, defRef.current)) {
				if (preventDefault) e.preventDefault();
				if (stopPropagation) e.stopPropagation();
				callbackRef.current(e);
			}
		};

		window.addEventListener("keydown", handleKeyDown, capture);
		return () => {
			window.removeEventListener("keydown", handleKeyDown, capture);
		};
	}, [enabled, allowInInputs, preventDefault, stopPropagation, capture]);
}
