import {
	useCallback,
	useDeferredValue,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type RefObject,
} from "react";
import { FiChevronDown, FiChevronUp, FiX } from "react-icons/fi";
import type { UiMessage } from "../types";
import { buildSearchHits } from "../search-text";
import { useT } from "../i18n";

/**
 * 会话内搜索栏（Ctrl+F / Cmd+F，浏览器 find 风格）。
 *
 * - 命中索引来自 search-text.ts 纯函数（消息级文本拼接）；
 * - 内联高亮走 **CSS Custom Highlight API**（CSS.highlights + ::highlight()）：
 *   直接在 DOM 文本节点上建 Range，不侵入 react-markdown 渲染树；
 *   不支持的浏览器自动降级为只跳转不内联高亮（消息仍有 flash 描边）；
 * - 跳转前经 onEnsureExpanded 同步展开折叠的旧消息，保证命中内容在 DOM 里。
 */

interface SearchBarProps {
	/** 消息滚动容器（.messages）——Range 收集与滚动都在其子树内。 */
	containerRef: RefObject<HTMLDivElement | null>;
	messages: readonly UiMessage[];
	open: boolean;
	onClose: () => void;
	/** 跳转目标若是折叠的旧消息，先同步展开（父组件 flushSync）。 */
	onEnsureExpanded: (messageId: string) => void;
}

/** 在容器子树里收集所有包含 query 的文本区间（大小写不敏感，节点内匹配）。 */
function collectRanges(
	root: HTMLElement,
	query: string,
): { byMsg: Map<string, Range[]>; all: Range[] } {
	const byMsg = new Map<string, Range[]>();
	const all: Range[] = [];
	const needle = query.toLowerCase();
	if (!needle) return { byMsg, all };
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			const el = node.parentElement;
			// 跳过搜索栏自身，避免高亮输入框里的查询文本
			if (!el || el.closest(".search-bar")) return NodeFilter.FILTER_REJECT;
			return (node.textContent ?? "").toLowerCase().includes(needle)
				? NodeFilter.FILTER_ACCEPT
				: NodeFilter.FILTER_SKIP;
		},
	});
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const lower = (node.textContent ?? "").toLowerCase();
		const owner = node.parentElement?.closest("[data-msg-id]");
		if (!owner) continue;
		const id = owner.getAttribute("data-msg-id") ?? "";
		let idx = lower.indexOf(needle);
		while (idx !== -1) {
			const r = document.createRange();
			r.setStart(node, idx);
			r.setEnd(node, idx + needle.length);
			all.push(r);
			const list = byMsg.get(id);
			if (list) list.push(r);
			else byMsg.set(id, [r]);
			idx = lower.indexOf(needle, idx + needle.length);
		}
	}
	return { byMsg, all };
}

function setHighlight(name: string, ranges: Range[]) {
	const css = CSS as unknown as { highlights?: Map<string, unknown> };
	if (!css.highlights) return;
	if (ranges.length === 0) {
		css.highlights.delete(name);
		return;
	}
	// Highlight 构造器在旧 lib.dom 里没有类型，运行时按特性检测使用。
	const Ctor = (
		window as unknown as { Highlight?: new (...r: Range[]) => unknown }
	).Highlight;
	if (Ctor) css.highlights.set(name, new Ctor(...ranges));
}

export function SearchBar({
	containerRef,
	messages,
	open,
	onClose,
	onEnsureExpanded,
}: SearchBarProps) {
	const t = useT();
	const inputRef = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const deferredQuery = useDeferredValue(query);

	// 命中列表：随消息集或查询变化重算（useMemo 保持引用稳定）
	const q = open ? deferredQuery.trim() : "";
	const hits = useMemo(
		() => (open ? buildSearchHits(messages, q) : []),
		// eslint-disable-next-line react-hooks/exhaustive-deps -- messages 数组引用稳定（服务端缓存），q/open 为原始值
		[messages, q, open],
	);
	// refs 镜像最新值，供 rAF 回调读取而不重建 effect
	const hitsRef = useRef(hits);
	hitsRef.current = hits;
	const activeRef = useRef(active);
	activeRef.current = active;

	// 打开时聚焦输入框；若消息区有选中文本则预填
	useEffect(() => {
		if (!open) return;
		setActive(0);
		requestAnimationFrame(() => inputRef.current?.select());
	}, [open]);

	// 打开期间拦截 Esc 关闭
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [open, onClose]);

	// 关闭/卸载时清理高亮
	useEffect(() => {
		if (!open) {
			setHighlight("msg-search", []);
			setHighlight("msg-search-active", []);
		}
		return () => {
			setHighlight("msg-search", []);
			setHighlight("msg-search-active", []);
		};
	}, [open]);

	const flashMsg = useCallback(
		(messageId: string) => {
			const wrap = containerRef.current;
			if (!wrap) return;
			const el = wrap.querySelector<HTMLElement>(
				`[data-msg-id="${messageId}"]`,
			);
			if (!el) return;
			el.classList.remove("msg-flash");
			void el.offsetWidth; // 重启动画
			el.classList.add("msg-flash");
		},
		[containerRef],
	);

	// 高亮 + 滚动到当前命中。DOM 可能刚因展开而更新 —— rAF 后再收集。
	useLayoutEffect(() => {
		if (!open || !q) return;
		const wrap = containerRef.current;
		if (!wrap) return;
		let cancelled = false;
		let raf = 0;
		raf = requestAnimationFrame(() => {
			if (cancelled) return;
			const { byMsg, all } = collectRanges(wrap, q);
			setHighlight("msg-search", all);
			const list = hitsRef.current;
			const hit = list[Math.min(activeRef.current, list.length - 1)];
			if (!hit) return;
			const range = byMsg.get(hit.messageId)?.[hit.occurrence];
			if (range) {
				setHighlight("msg-search-active", [range]);
				const startEl =
					range.startContainer.parentElement ??
					wrap.querySelector(`[data-msg-id="${hit.messageId}"]`);
				startEl?.scrollIntoView({ block: "center" });
			} else {
				// 命中在索引里有、DOM 里没有（如流式更新导致节点重建）——退回消息级跳转
				flashMsg(hit.messageId);
			}
		});
		return () => {
			cancelled = true;
			cancelAnimationFrame(raf);
		};
	}, [open, q, hits, containerRef, flashMsg]);

	const step = useCallback(
		(dir: 1 | -1) => {
			const list = hitsRef.current;
			if (list.length === 0) return;
			const next = (activeRef.current + dir + list.length) % list.length;
			setActive(next);
			// 折叠的旧消息先同步展开，下一轮 layout effect 才能在 DOM 中找到它
			onEnsureExpanded(list[next].messageId);
		},
		[onEnsureExpanded],
	);

	if (!open) return null;
	const total = hits.length;
	return (
		<div className="search-bar" role="search">
			<input
				ref={inputRef}
				className="search-input"
				type="text"
				value={query}
				placeholder={t("searchPlaceholder")}
				onChange={(e) => {
					setQuery(e.target.value);
					setActive(0);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						step(e.shiftKey ? -1 : 1);
					}
				}}
			/>
			<span className={`search-count ${total === 0 ? "empty" : ""}`}>
				{total === 0
					? t("searchNoResults")
					: `${Math.min(active + 1, total)}/${total}`}
			</span>
			<button
				type="button"
				className="search-btn"
				title={t("searchPrev")}
				disabled={total === 0}
				onClick={() => step(-1)}
			>
				<FiChevronUp />
			</button>
			<button
				type="button"
				className="search-btn"
				title={t("searchNext")}
				disabled={total === 0}
				onClick={() => step(1)}
			>
				<FiChevronDown />
			</button>
			<button
				type="button"
				className="search-btn"
				title={t("searchClose")}
				onClick={onClose}
			>
				<FiX />
			</button>
		</div>
	);
}
