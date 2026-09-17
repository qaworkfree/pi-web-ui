import { Fragment, useEffect, useRef, type ReactNode } from "react";
import type { ChatState } from "../use-chat";
import { useT } from "../i18n";
import { useAppGlobals } from "../app-globals";
import { cacheMetrics, estimateStreamTokens, streamRate, trimRateSamples, type RateSample } from "../cache-stats";
import type { UiSlotEntry } from "../ui-slots";

interface FooterBarProps {
	/** 底栏条目（bottombar 槽位：内置 + 插件的最终结果，宿主已排好序）。 */
	bottombarItems?: import("../ui-slots").UiSlotEntry[];
	/** 点击一个条目：view 由宿主切视图，其余（action）交给贡献它的插件。 */
	onUiAction?: (item: import("../ui-slots").UiSlotEntry) => void;
	chat: ChatState;
}

/** 未接线时的回退顺序（= BUILTIN_UI_ITEMS 里 bottombar 槽位的默认次序）。 */
const FALLBACK_BOTTOMBAR = [
	"host:conn",
	"host:engine",
	"host:ctx",
	"host:cost",
	"host:cache",
	"host:msg-count",
	"host:plugin-status",
	"host:working",
	"host:host-metrics",
];

/**
 * Compact status bar: connection, context usage, cost, session, queue, and the
 * read-only workspace path.
 */
export function FooterBar({ chat, bottombarItems, onUiAction }: FooterBarProps) {
	const t = useT();
	// 引擎徽标：走全局（web/src/app-globals.ts），不依赖 chat 整体对象。
	const { engine } = useAppGlobals();
	const state = chat.state;

	// Live generation-speed samples (tokens/sec). Kept in a ref so pushing a
	// sample never triggers a re-render. The SDK only commits a turn's usage
	// counters at message_end, so `stats.tokens.output` is FLAT while streaming —
	// instead we estimate tokens from the in-flight message content (text +
	// thinking), which grows every token. Sample at most every 250ms; baseline
	// resets the moment streaming stops.
	const samplesRef = useRef<RateSample[]>([]);
	const streamingNow = state?.isStreaming ?? false;
	const streamEst = state?.streamingMessage ? estimateStreamTokens(state.streamingMessage.content) : 0;
	useEffect(() => {
		if (!streamingNow) {
			samplesRef.current = [];
			return;
		}
		const now = Date.now();
		const prev = samplesRef.current;
		const last = prev[prev.length - 1];
		if (last && now - last.t < 250) return; // throttle
		samplesRef.current = trimRateSamples([...prev, { t: now, out: streamEst }], now);
	}, [streamingNow, streamEst]);

	if (!state) return null;
	const s = state.stats;

	const cache = cacheMetrics(s.tokens);
	const hitPct = cache.hitRate * 100;
	const hitClass = cache.totalInput === 0 ? "" : cache.hitRate >= 0.7 ? "ok" : cache.hitRate >= 0.4 ? "mid" : "warn";
	const hitText = cache.totalInput > 0 ? `${hitPct.toFixed(1)}%` : "—";
	const rate = streamingNow ? streamRate(samplesRef.current) : 0;

	const connClass = chat.ready ? "ok" : chat.status === "closed" ? "error" : "busy";
	const connLabel = chat.ready ? t("connected") : chat.status === "closed" ? t("reconnecting") : t("connecting");

	const context = s.contextUsage;
	const ctxText =
		context.tokens !== null && context.percent !== null
			? `${context.estimated ? "~" : ""}${formatTokens(context.tokens)} / ${formatTokens(context.contextWindow)}`
			: "—";
	const ctxPercent = context.percent ?? null;
	const ctxBarClass = ctxPercent === null ? "" : ctxPercent >= 80 ? "warn" : ctxPercent >= 50 ? "mid" : "ok";

	const queueTotal = state.queue.steering.length + state.queue.followUp.length;

	/**
	 * 宿主内置条目的**节点工厂**（issue #146 的「位置登记」真正落地）：底栏的可见性与顺序
	 * 完全由 `bottombarItems`（= `buildUiSlots` 的结果）决定 —— 用户在设置面板「界面布局」里
	 * 隐藏一条、或在 ↑↓ 里挪一条，这里就少画一个 / 换位置（以前宿主条目写死在 JSX 里，
	 * 布局页那几个勾选框是摆设）。
	 *
	 * 条件渲染（引擎徽标只在非 pi 引擎、插件状态只在有状态、工作中只在流式时）留在各工厂里：
	 * 条件不满足 → 返回 null → 那一条**连同分隔符**一起不画（不留孤零零的 `·`）。
	 */
	const hostNodes: Record<string, ReactNode> = {
		"host:conn": (
			<span className={`status-item status-conn ${connClass}`} title={connLabel}>
				<span className={`status-dot ${connClass}`} />
				<span className="status-conn-label">{connLabel}</span>
			</span>
		),
		"host:engine":
			engine !== "pi" ? (
				<span className={`status-item engine-badge engine-${engine}`} title={`${t("engineBadge")}: ${engine}`}>
					{engine === "dsh" ? "DSH" : engine}
				</span>
			) : null,
		"host:ctx": (
			<span className="status-item status-ctx" title={t("contextUsage")}>
				{/* 窄屏（≤420px）只留进度条 + 数字，标签由 CSS 收起 */}
				<span className="ctx-label">{t("context")}</span>
				<span className={`ctx-bar ${ctxBarClass}`}>
					{ctxPercent !== null && <span className="ctx-bar-fill" style={{ width: `${Math.min(ctxPercent, 100)}%` }} />}
				</span>
				{ctxText}
			</span>
		),
		"host:cost": (
			<span className="status-item" title={t("cumulativeCost")}>
				${formatCost(s.cost)}
			</span>
		),
		"host:cache": (
			<span
				className="status-item status-cache"
				title={t("cacheHitTip", {
					read: formatTokens(cache.read),
					write: formatTokens(cache.write),
					miss: formatTokens(cache.miss),
					input: formatTokens(cache.totalInput),
				})}
			>
				{t("cacheHit")}
				<b className={`cache-pct ${hitClass}`}>{hitText}</b>
			</span>
		),
		"host:msg-count": (
			<span className="status-item" title={t("sessionMessages")}>
				{t("messages")} {s.totalMessages}
			</span>
		),
		"host:plugin-status":
			chat.statuses.length > 0 ? (
				<span className="status-item ext-status" title={t("pluginStatus")}>
					{chat.statuses.map((st) => st.text).join(" · ")}
				</span>
			) : null,
		"host:working": state.isStreaming ? (
			<>
				<span className="status-item working">
					<span className="working-spin" />
					{t("working")}
					{queueTotal > 0 && (
						<span className="status-queue">
							⏳ {queueTotal} {t("queued")}
						</span>
					)}
				</span>
				<span className="status-item status-rate" title={t("rateTip")}>
					{/* 手机上「工作中」文案被隐藏，这里给个小转圈（仅窄屏显示） */}
					<span className="working-spin rate-spin" />
					{rate > 0 ? `${Math.round(rate)}${t("tps")}` : "…"}
				</span>
			</>
		) : null,
		"host:host-metrics": (() => {
			const metrics = chat.hostMetrics;
			if (!metrics) return null;
			const cpu =
				metrics.cpuPercent === null || !Number.isFinite(metrics.cpuPercent)
					? "—"
					: `${Math.round(metrics.cpuPercent)}%`;
			const memory = Number.isFinite(metrics.memoryPercent) ? `${Math.round(metrics.memoryPercent)}%` : "—";
			return (
				<span
					className="status-item status-host-metrics"
					title={`${t("hostResourcesTip")}\n${t("hostProcessor")}: ${cpu} · ${t("hostMemory")}: ${memory}`}
				>
					{t("hostProcessor")} {cpu} · {t("hostMemory")} {memory}
				</span>
			);
		})(),
	};

	/**
	 * 按 slot 顺序落成要画的一串：宿主条目查节点工厂，插件条目画按钮。
	 *
	 * `bottombarItems` 没给（未接线 / 单测）时**回退到内置默认顺序**：没拿到 slot 数据就把整个
	 * 底栏清空是最糟的降级（与 TopBar 的 hostOn 同口径）。
	 */
	const entries: { id: string; entry: UiSlotEntry | null }[] = bottombarItems
		? bottombarItems.map((e) => ({ id: e.id, entry: e }))
		: FALLBACK_BOTTOMBAR.map((id) => ({ id, entry: null }));
	const leftItems: { key: string; node: ReactNode }[] = [];
	const rightItems: { key: string; node: ReactNode }[] = [];
	for (const { id, entry } of entries) {
		if (entry?.hidden) continue;
		let node: ReactNode = null;
		if (id.startsWith("host:")) {
			node = hostNodes[id];
		} else if (entry) {
			node = (
				<button
					type="button"
					className="status-action"
					title={entry.hint ?? entry.label}
					onClick={() => onUiAction?.(entry)}
				>
					{entry.icon ? `${entry.icon} ` : ""}
					{entry.label}
					{entry.badge ? <span className="status-badge">{entry.badge}</span> : null}
				</button>
			);
		}
		if (!node) continue;
		if (id === "host:host-metrics") {
			rightItems.push({ key: id, node });
		} else {
			leftItems.push({ key: id, node });
		}
	}

	const renderGroup = (groupItems: { key: string; node: ReactNode }[]) =>
		groupItems.map((it, i) => (
			<Fragment key={it.key}>
				{/* 分隔符只在「前面真画了东西」时插：条件不满足的宿主条目不留孤儿 `·`。 */}
				{i > 0 && <span className="status-sep">·</span>}
				{it.node}
			</Fragment>
		));

	return (
		<footer className="statusbar">
			<div className="statusbar-left">{renderGroup(leftItems)}</div>
			<div className="statusbar-right">{renderGroup(rightItems)}</div>
		</footer>
	);
}

function formatTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
	return String(n);
}

function formatCost(cost: number): string {
	if (cost <= 0) return "0";
	if (cost < 0.0001) return "<0.0001";
	return cost.toFixed(4).replace(/\.?0+$/, "");
}
