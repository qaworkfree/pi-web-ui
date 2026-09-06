/**
 * mermaid renderer 插件 —— fenced-code 渲染插件机制的第一个实现。
 *
 * 约定：ESM 默认导出 { renderers }，`renderers["mermaid"]` 是一个
 * (code, ctx) → HTMLElement|null 工厂，把 ```mermaid 围栏渲染成 SVG。
 * 返回 null = 不渲染（回退普通代码块）。
 *
 * 引擎加载（本地优先，CDN 回退）：
 * - 优先 `./vendor/mermaid.bundle.mjs`（构建产物，见 scripts/build-mermaid-vendor
 *   .mjs）——插件目录自带引擎时**完全离线**渲染，不碰网络；
 * - 缺 vendor 文件（比如只拷了 manifest/entry.mjs）→ 回退 CDN（esm.sh）。可用
 *   镜像/版本改 CDN_URL；生产内网可下拉 vendor 后不再走这里。
 *
 * 渲染由插件认领决定：manifest 的 renderers 认领 "mermaid"，主应用 fence 注册表
 * 命中即渲染（懒加载）；不需要时卸载/删除插件目录即回退普通代码块——无主应用开关。
 * 复用了主应用 styles.css 的 .mermaid-block 类名（白色纸面卡片），不额外注入
 * 样式；本文件是纯 DOM，不共享 React 实例。
 */

/** CDN 回退入口（vendor 缺失时使用。内网镜像直接替换这里）。 */
const CDN_URL = "https://esm.sh/mermaid@11";

// 模块级单例：同一页面只加载/初始化一次，后续复用。
let mermaidPromise = null;

/** 动态 import 包装：归一化 default 导出（vendor bundle 与 esm.sh 都是 default）。
 *  相对路径按 entry.mjs 所在目录解析；绝对 URL 原样交给浏览器。 */
function importModule(url) {
	return import(/* @vite-ignore */ url).then((mod) => mod.default ?? mod);
}

async function loadMermaid() {
	if (!mermaidPromise) {
		// 1) 本地 vendor（随插件分发的打包引擎，完全离线）→ 2) CDN 回退。
		/* vendor 与 entry.mjs 同在 client/ 子树（静态服务只暴露 client/*） */
		mermaidPromise = importModule("./vendor/mermaid.bundle.mjs").catch(() =>
			importModule(CDN_URL),
		);
		mermaidPromise = mermaidPromise.then((mermaid) => {
			mermaid.initialize({
				startOnLoad: false,
				securityLevel: "strict",
				theme: "base",
				themeVariables: {
					background: "#ffffff",
					primaryColor: "#f1edfe",
					primaryTextColor: "#1f2430",
					primaryBorderColor: "#8b5cf6",
					lineColor: "#6b7280",
					secondaryColor: "#eef2ff",
					tertiaryColor: "#f8fafc",
					textColor: "#1f2430",
					fontFamily: "var(--mono, monospace)",
				},
			});
			return mermaid;
		});
	}
	return mermaidPromise;
}

let seq = 0;

/** 给 SVG 一个确定的像素宽度（从 viewBox 取），避免移动端被挤压到不可读。 */
function preserveSvgWidth(svg) {
	const match = svg.match(/<svg\b([^>]*)>/i);
	if (!match) return svg;
	const attrs = match[1];
	const viewBox = attrs.match(/\bviewBox=(['"])([^'"]+)\1/i)?.[2];
	if (!viewBox) return svg;
	const values = viewBox
		.trim()
		.split(/[\s,]+/)
		.map(Number);
	const width = values.length === 4 ? values[2] : Number.NaN;
	if (!Number.isFinite(width) || width <= 0) return svg;
	const existingStyle = attrs.match(/\sstyle=(['"])(.*?)\1/i)?.[2] ?? "";
	const cleanStyle = existingStyle.replace(/(?:^|;)\s*(?:max-)?width\s*:[^;]*/gi, "").replace(/^\s*;|;\s*$/g, "");
	const sizedAttrs = attrs.replace(/\swidth=(['"])[^'"]*\1/i, "").replace(/\sstyle=(['"])(.*?)\1/i, "");
	const style = cleanStyle ? `${cleanStyle}; max-width:none` : "max-width:none";
	return svg.replace(match[0], `<svg${sizedAttrs} width="${width}" style="${style}">`);
}

async function renderMermaid(code) {
	const mermaid = await loadMermaid();
	const renderId = `mermaid-fence-${++seq}-${Date.now().toString(36)}`;
	const { svg } = await mermaid.render(renderId, code);
	const el = document.createElement("div");
	el.className = "mermaid-block";
	el.innerHTML = preserveSvgWidth(svg);
	return el;
}

export default {
	renderers: {
		mermaid: renderMermaid,
	},
};