/**
 * 插件 SVG 图标渲染（manifest.json `iconSvg` / catalog `iconSvg`）。
 *
 * 服务端只做形状校验（见 server/icon-svg.ts），真正的 XSS 过滤在这里：
 * `sanitizeIconSvg` 白名单标签 + 属性，渲染经 `dangerouslySetInnerHTML`。
 * 有合法 iconSvg 就画 SVG，否则回落 emoji/字符（`icon`）。
 */
import type { JSX } from "react";

const ALLOWED_TAGS = new Set([
	"svg",
	"g",
	"path",
	"circle",
	"rect",
	"line",
	"polyline",
	"polygon",
	"ellipse",
	"use",
	"defs",
	"clipPath",
	"linearGradient",
	"radialGradient",
	"stop",
]);

const ALLOWED_ATTRS = new Set([
	"viewBox",
	"xmlns",
	"d",
	"fill",
	"stroke",
	"stroke-width",
	"stroke-linecap",
	"stroke-linejoin",
	"stroke-dasharray",
	"opacity",
	"x",
	"y",
	"x1",
	"y1",
	"x2",
	"y2",
	"cx",
	"cy",
	"r",
	"rx",
	"width",
	"height",
	"offset",
	"stop-color",
	"stop-opacity",
	"transform",
	"clip-path",
	"id",
	"href",
	"xlink:href",
	"gradientUnits",
	"gradientTransform",
]);

/**
 * 消毒内联 SVG：非白名单标签整个丢掉（含其内容，如果是 script/style/title/desc
 * 这类元标签；图形标签只丢标签本身、保留安全的子节点）；非白名单属性 / 事件
 * 处理器 / javascript: 一律剥掉。返回可注入的 SVG 字符串，非法返回 null。
 * 纯函数（有单测）。
 */
export function sanitizeIconSvg(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const s = raw.trim();
	if (!s || s.length > 8192) return null;
	if (!/^<svg[\s>]/.test(s.startsWith("<?xml") ? s.slice(s.indexOf("?>") + 2).trimStart() : s)) return null;
	// DOMParser 只在浏览器里有；SSR/单测（node）下退化为正则快检。
	if (typeof DOMParser === "undefined") {
		if (/<script[\s>]/i.test(s) || /\son\w+\s*=/i.test(s) || /javascript\s*:/i.test(s)) return null;
		return s;
	}
	const doc = new DOMParser().parseFromString(s, "image/svg+xml");
	if (doc.querySelector("parsererror")) return null;
	const root = doc.documentElement;
	if (root.tagName.toLowerCase() !== "svg") return null;
	const clean = (el: Element): void => {
		for (const child of [...el.children]) {
			const tag = child.tagName.toLowerCase();
			if (!ALLOWED_TAGS.has(tag)) {
				// 元标签整棵丢；未知图形标签展平（子节点上移，保留合法内容）。
				if (tag === "script" || tag === "style" || tag === "title" || tag === "desc" || tag === "foreignObject") {
					child.remove();
				} else {
					clean(child);
					child.replaceWith(...child.childNodes);
				}
				continue;
			}
			for (const attr of [...child.attributes]) {
				const name = attr.name.toLowerCase();
				if (!ALLOWED_ATTRS.has(name) || /^on/i.test(name) || /^(javascript|data|vbscript):/i.test(attr.value.trim())) {
					child.removeAttribute(attr.name);
				}
			}
			clean(child);
		}
	};
	for (const attr of [...root.attributes]) {
		const name = attr.name.toLowerCase();
		if (!ALLOWED_ATTRS.has(name) || /^on/i.test(name)) root.removeAttribute(attr.name);
	}
	clean(root);
	return new XMLSerializer().serializeToString(root);
}

/** 插件徽标：有合法 iconSvg 就画 SVG，否则把 `icon` 原样当文本画
 *  （与原来 `{entry.icon ? <span>{entry.icon}</span> : null}` 完全一致）。
 *  调用方若不想把宿主图标词表名（如 "mic"）当文字画出来，自行按
 *  isGlyphIcon 过滤后再传 icon（见 SlotTabs）。 */
export function PluginIcon({
	icon,
	iconSvg,
	className,
}: {
	icon?: string;
	iconSvg?: string;
	className?: string;
}): JSX.Element | null {
	const safe = sanitizeIconSvg(iconSvg);
	if (safe) {
		return <span className={className ?? "plugin-icon-svg"} aria-hidden dangerouslySetInnerHTML={{ __html: safe }} />;
	}
	if (icon) {
		return (
			<span className={className ? `${className} plugin-icon-glyph` : "plugin-icon-glyph"} aria-hidden>
				{icon}
			</span>
		);
	}
	return null;
}
