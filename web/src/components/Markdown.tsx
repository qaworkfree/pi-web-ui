import { memo, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { PluggableList } from "unified";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import "katex/dist/katex.min.css";
import { CopyButton } from "./copy-button";
import { splitCodeLines } from "../code-lines";
import { childrenText, fenceLanguage } from "./mermaid";
import { getFenceRegistryVersion, hasFenceRenderer, hasMessageWidget, loadMessageWidget, subscribeFenceRegistry, widgetRegistry } from "../plugin-fence";
import type { FenceRenderContext } from "../plugin-loader";
import { PluginFenceBlock } from "./PluginFenceBlock";

interface MarkdownProps {
	text: string;
	/** 渲染原始 HTML（嵌在 markdown 里）。默认关闭：聊天消息的 markdown 镜像会
	 *  转义 HTML，提问对话框等信任模型的地方可开启以支持 HTML + markdown 混排。 */
	rawHtml?: boolean;
	/** 保留单个换行（\n → <br>）。CommonMark 的软换行在 <p> 里会被浏览器折叠成
	 *  空格，用户自己输入/粘贴的多行纯文本因此显示成一整串。默认关闭（助手输出
	 *  走标准 markdown 段落语义）；用户气泡开启以忠实呈现用户原文的换行。 */
	hardBreaks?: boolean;
}

/** Shared markdown pipeline + codeblock chrome (copy button). Exported so
 *  StreamMarkdown's per-segment renderers reuse the exact same configuration
 *  as this full-document renderer — streaming preview and final render must
 *  be visually identical. */
export const remarkPlugins = [remarkGfm, remarkMath];
/** Same pipeline + hard line breaks — used for USER bubbles so typed/pasted
 *  multi-line text keeps every line break (see MarkdownProps.hardBreaks). */
export const remarkPluginsHardBreaks = [remarkGfm, remarkBreaks, remarkMath];
export const rehypePlugins: PluggableList = [
	// KaTeX 在 highlight 之前：两者目标节点不相交（.math vs pre code），
	// 公式解析失败时只显示红色源码（throwOnError: false），不打断整条消息。
	[rehypeKatex, { strict: false, throwOnError: false }],
	[rehypeHighlight, { detect: true, ignoreMissing: true }],
];

export function MarkdownBody({
	text,
	rawHtml = false,
	hardBreaks = false,
}: {
	text: string;
	rawHtml?: boolean;
	hardBreaks?: boolean;
}) {
	// rawHtml 时在 highlight 之前插入 rehype-raw：先把它内嵌的原始 HTML 解析成
	// hast 节点，再统一交给 highlight 做代码高亮，顺序不可颠倒。
	const rh: PluggableList = rawHtml ? [rehypeRaw, ...rehypePlugins] : rehypePlugins;
	return (
		<ReactMarkdown
			remarkPlugins={hardBreaks ? remarkPluginsHardBreaks : remarkPlugins}
			rehypePlugins={rh}
			components={{ pre: PreWithCopy, a: MdLink }}
		>
			{text}
		</ReactMarkdown>
	);
}

/** GFM markdown with syntax highlighting; code blocks get a copy button. */
export const Markdown = memo(function Markdown({ text, rawHtml = false, hardBreaks = false }: MarkdownProps) {
	return (
		<div className="md">
			<MarkdownBody text={text} rawHtml={rawHtml} hardBreaks={hardBreaks} />
		</div>
	);
});

/** 正文里的外链一律新窗口打开（`target=_blank` + `rel`）。
 *
 * 两笔账都算得上：网页版里是「新标签页打开」这种更符合预期的行为（和界面里手写
 * 外链的写法一致）；桌面壳里 `target=_blank` 的点击走 `setWindowOpenHandler` 被
 * 转给系统浏览器 —— 而裸 `href` 会触发同帧导航把应用窗口带走（issue #154，
 * 桌面壳另有 `will-navigate` 守卫兜底脚本发起的跳转）。站内锚点（`#…`）与相对
 * 路径不动：它们本来就是应用内导航。 */
function MdLink({ href, children, ...rest }: JSX.IntrinsicElements["a"]) {
	const target = String(href ?? "");
	if (!/^(https?:|mailto:|tel:)/i.test(target)) {
		return (
			<a href={href} {...rest}>
				{children}
			</a>
		);
	}
	return (
		<a href={href} target="_blank" rel="noreferrer noopener" {...rest}>
			{children}
		</a>
	);
}

function PreWithCopy({ children, ...props }: JSX.IntrinsicElements["pre"]) {
	// fenced-code 渲染插件机制：有插件认领 ```lang 时交给它渲染（mermaid → SVG
	// 等），否则回退普通代码块（高亮 + 行号）。认领表由 server 的 plugins 清单 +
	// plugin-fence.ts 维护，插件命中才懒加载。
	//
	// 订阅注册表版本：attach 时历史消息快照先于 plugins 清单到达，清单一到版本
	// 变化 → 本组件（及整条渲染树）重渲染 → 未命中的 mermaid 围栏补挂插件宿主。
	// useSyncExternalStore 会绕过外层 memo 的 props 比较，无需穿透传参。
	// 第三参数提供同步 getServerSnapshot（= 当前版本），使 SSR/服务端渲染（renderToStaticMarkup）
	// 不因缺 getServerSnapshot 抛错 —— 提问对话框/预览的代码块在服务端渲染时也能正常出图。
	useSyncExternalStore(subscribeFenceRegistry, getFenceRegistryVersion, getFenceRegistryVersion);
	const lang = fenceLanguage(children);
	if (lang && hasFenceRenderer(lang)) {
		return <PluginFenceBlock lang={lang} code={childrenText(children)} />;
	}
	return <PlainCodeBlock children={children} {...props} />;
}

/** 普通代码块（高亮 + 行号 + 复制按钮）——无插件认领语言的默认展示。 */
function PlainCodeBlock({ children, ...props }: JSX.IntrinsicElements["pre"]) {
	// react-markdown 传进来的是 <pre><code …>…</code></pre> 里的 code 元素；
	// 按逻辑行切分的是它内部的 span/文本 children，而不是 code 元素本身
	// （否则每行会嵌套一个克隆的 <code>，且尾随空行无法被丢弃）。
	const inner =
		children && typeof children === "object" && "props" in children
			? (children as { props?: { children?: ReactNode } }).props?.children
			: children;
	const lines = splitCodeLines(inner);
	const multi = lines.length > 1;
	const numWidth = multi ? `${String(lines.length).length + 1}ch` : undefined;
	return (
		<div className="codeblock">
			<CopyButton text={codeText(children)} />
			<pre {...props}>
				{lines.map((nodes, i) => (
					<div className="code-line" key={i}>
						{multi && (
							<span className="code-num" style={numWidth ? { width: numWidth } : undefined}>
								{i + 1}
							</span>
						)}
						<code className="code-line-body hljs">{nodes}</code>
					</div>
				))}
			</pre>
		</div>
	);
}

function codeText(children: unknown): string {
	if (typeof children === "string") return children;
	if (Array.isArray(children)) return children.map(codeText).join("");
	if (children && typeof children === "object" && "props" in children) {
		const props = (children as { props?: { children?: unknown } }).props;
		return codeText(props?.children);
	}
	return "";
}

/**
 * 自定义消息类型（UiMessage.customType）的插件渲染宿主（messageWidget 泛化，
 * 见 plugin-fence.ts 的 loadMessageWidget/hasMessageWidget）。
 *
 * 仿 PluginFenceBlock 的懒加载模式：命中类型时才动态 import 插件 bundle，
 * 平常零开销。无认领 / 加载中 / 加载失败 / renderer 返回 null 时一律回退
 * children（原文默认渲染），绝不空白。fence 逻辑一字不改。
 */
export function PluginWidgetBlock({ type, code, children }: { type: string; code: string; children: ReactNode }) {
	const holderRef = useRef<HTMLDivElement>(null);
	const [el, setEl] = useState<HTMLElement | null>(null);
	useEffect(() => {
		let cancelled = false;
		setEl(null);
		if (!hasMessageWidget(type)) return;
		void loadMessageWidget(type).then(async (renderer) => {
			if (cancelled || !renderer) return;
			try {
				// 与 fence 同一套窄上下文；上行 send 暂为 no-op（fence 的 wsSend
				// 在 plugin-fence.ts 模块内，渲染层不碰它，后续收编时再接线）。
				const ctx: FenceRenderContext = {
					pluginId: widgetRegistry.get(type) ?? type,
					send: () => undefined,
					onData: () => () => undefined,
				};
				const result = await renderer(code, ctx);
				if (!cancelled && result instanceof HTMLElement) setEl(result);
			} catch (err) {
				console.error(`[plugin-widget:${type}] 渲染失败:`, err);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [type, code]);
	useEffect(() => {
		const holder = holderRef.current;
		if (holder) {
			holder.replaceChildren();
			if (el) holder.appendChild(el);
		}
	}, [el]);
	if (!el) return <>{children}</>;
	return <div className="plugin-widget" ref={holderRef} />;
}
