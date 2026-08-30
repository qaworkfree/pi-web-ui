import {
	useCallback,
	useDeferredValue,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type RefObject,
} from "react";
import { FiChevronDown, FiChevronUp, FiX } from "react-icons/fi";
import type { UiMessage } from "../types";
import { useT } from "../i18n";

/**
 * 会话内搜索栏（Ctrl+F / Cmd+F，浏览器 find 风格）。
 *
 * - 命中列表以 **DOM 实际渲染文本为准**：markdown 渲染、折叠的思考/工具卡、
 *   bash 命令行美化输出等都会让「序列化消息文本」与「页面文本」不一致，
 *   按序列化文本索引的 occurrence 序号会指错区间（跳过去却不知道高亮了什么、
 *   计数里出现 DOM 上根本不存在的命中）。直接收集渲染后的文本区间，
 *   计数 / 导航 / 高亮三者天然一致，跳转一定落在真实可见的文本上。
 * - 高亮走 **CSS Custom Highlight API**（CSS.highlights + ::highlight()）：
 *   直接在 DOM 文本节点上建 Range，不侵入 react-markdown 渲染树；
 *   不支持的浏览器自动降级为只跳转不内联高亮（滚动仍然可靠）。
 * - 跳转 = 把下一个命中区间设为 active 高亮，并按命中词矩形精确居中滚动
 *   （不是整条消息居中，长输出块里的词也保证可见）；流式更新时不抢用户滚动。
 */

interface SearchBarProps {
	/** 消息滚动容器（.messages）——Range 收集与滚动都在其子树内。 */
	containerRef: RefObject<HTMLDivElement | null>;
	/** 消息集（作为依赖）：新消息 / 内容更新时重新收集命中区间。 */
	messages: readonly UiMessage[];
	open: boolean;
	onClose: () => void;
}

/** 在容器子树里收集所有包含 query 的文本区间（大小写不敏感，节点内匹配，文档序）。 */
function collectRanges(root: HTMLElement, query: string): Range[] {
	const all: Range[] = [];
	const needle = query.toLowerCase();
	if (!needle) return all;
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
		// 只收消息气泡内的文本（[data-msg-id]），壳层文案（回到底部等）不参与命中
		if (!node.parentElement?.closest("[data-msg-id]")) continue;
		let idx = lower.indexOf(needle);
		while (idx !== -1) {
			const r = document.createRange();
			r.setStart(node, idx);
			r.setEnd(node, idx + needle.length);
			all.push(r);
			idx = lower.indexOf(needle, idx + needle.length);
		}
	}
	return all;
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

/** 把命中区间滚到容器视野中央（按区间矩形居中，而不是整条消息——长输出块里
 *  高亮词可能落在视野外）。区间已完整可见则不动，避免相邻命中间的无谓跳动。 */
function scrollRangeIntoView(wrap: HTMLElement, range: Range) {
	const rr = range.getBoundingClientRect();
	const wr = wrap.getBoundingClientRect();
	if (rr.height <= 0 || rr.width <= 0) return;
	// 已完整可见（留 6px 余量）——不打扰用户阅读位置
	if (rr.top >= wr.top + 6 && rr.bottom <= wr.bottom - 6) return;
	wrap.scrollTop += rr.top - wr.top - (wr.height - rr.height) / 2;
}

export function SearchBar({
	containerRef,
	messages,
	open,
	onClose,
}: SearchBarProps) {
	const t = useT();
	const inputRef = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	/** 命中总数（rAF 内更新，驱动计数显示与 step 取模）。 */
	const [total, setTotal] = useState(0);
	const deferredQuery = useDeferredValue(query);
	const q = open ? deferredQuery.trim() : "";

	// refs 镜像最新值，供 rAF 回调读取而不重建 effect
	const activeRef = useRef(active);
	activeRef.current = active;
	/** 上次 rAF 结束时的查询与 active —— 区分「用户主动导航/换查询」和
	 *  「内容被动更新（流式/新快照）」，后者只刷新高亮、绝不抢滚动。 */
	const lastQueryRef = useRef("");
	const lastActiveRef = useRef(-1);

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

	// 关闭/卸载/清空时清理高亮
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

	// 收集命中 + 设置 active 高亮 + 滚动。**active 必须进依赖**：
	// 每次 prev/next 都重跑这一段，高亮与滚动才会跟着「下一个」移动
	// （旧实现漏了 active，导致点按钮只有计数变、高亮纹丝不动）。
	// 滚动只在「用户导航或换了查询」时发生；流式更新消息内容时
	// （messages 引用变化）只重收集/重高亮，避免视图被反复拽走。
	useLayoutEffect(() => {
		if (!open || !q) {
			setTotal(0);
			setHighlight("msg-search", []);
			setHighlight("msg-search-active", []);
			lastActiveRef.current = -1;
			return;
		}
		const wrap = containerRef.current;
		if (!wrap) return;
		let cancelled = false;
		let raf = 0;
		raf = requestAnimationFrame(() => {
			if (cancelled) return;
			const all = collectRanges(wrap, q);
			setHighlight("msg-search", all);
			const n = all.length;
			setTotal(n);
			if (n === 0) {
				setActive(0);
				setHighlight("msg-search-active", []);
				lastActiveRef.current = -1;
				return;
			}
			const i = Math.min(activeRef.current, n - 1);
			setActive(i);
			const range = all[i];
			setHighlight("msg-search-active", [range]);
			const userMoved =
				i !== lastActiveRef.current || q !== lastQueryRef.current;
			lastActiveRef.current = i;
			lastQueryRef.current = q;
			if (userMoved) scrollRangeIntoView(wrap, range);
		});
		return () => {
			cancelled = true;
			cancelAnimationFrame(raf);
		};
	}, [open, q, messages, containerRef, active]);

	const step = useCallback(
		(dir: 1 | -1) => {
			if (total === 0) return;
			setActive((a) => (a + dir + total) % total);
		},
		[total],
	);

	if (!open) return null;
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