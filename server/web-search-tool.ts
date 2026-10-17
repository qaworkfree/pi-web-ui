// ---------------------------------------------------------------------------
// web-search-tool.ts — 网页搜索（DuckDuckGo HTML 端点，零新依赖）
// ---------------------------------------------------------------------------
// 背景：模型常要核对「本地文件之外」的事实（时事、库版本、报错原因），此前只能
// 让用户自己去搜。本工具请求 DuckDuckGo 的纯 HTML 端点（html.duckduckgo.com，
// 无需 API key），用小型正则/字符串解析器提取 title/url/snippet，不引入任何
// npm 依赖。解析器与实体解码为导出纯函数（tests/unit/web-search.test.ts 直接喂
// fixture，不碰网络）。
//
// 边界：
//  - 只外发查询词本身，绝不把文件内容塞进 URL；
//  - 离线模式（isOfflineMode，调用时读 process.env）直接拒绝，不发任何网络
//    请求（isError=true；与 offline-mode.ts 的 fetch 闸门双保险）；
//  - 网络失败 / 非 200 / 零结果 → 普通文本说明（isError=false，模型可换词重试）；
//  - 输出全文 8000 字符封顶；details 只带小结构 { query, results }（远低于
//    serialize.ts 的 64KB 上限）。
//
// 文案约定：工具 definition（description/promptSnippet/promptGuidelines）为纯
// 英文；per-call 返回文本按 lang 取 pick(lang, zh, en, key)，缺表回落英文内联。
// ---------------------------------------------------------------------------

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pick, type ServerLang } from "./i18n.js";
import { isOfflineMode } from "./offline-mode.js";
import { WEB_SEARCH_TOOL_NAME } from "./tool-manager.js";

/** DuckDuckGo 纯 HTML 搜索端点（无 JS、无 API key；结果页结构稳定多年）。 */
const SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/";
/** 桌面 UA（端点对无 UA/爬虫 UA 的请求会回空壳页）。 */
const DESKTOP_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
/** 请求超时（与预设分享的抓取收口同一量级）。 */
const FETCH_TIMEOUT_MS = 10_000;
/** 查询词长度上限。 */
export const WEB_SEARCH_QUERY_MAX = 256;
/** 结果条数：默认 / 上限。 */
export const WEB_SEARCH_COUNT_DEFAULT = 5;
export const WEB_SEARCH_COUNT_MAX = 10;
/** 单字段截断（标题/摘要）与输出全文封顶。 */
const TITLE_CAP = 150;
const SNIPPET_CAP = 300;
const OUTPUT_CAP = 8000;

export interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
}

interface WebSearchDetails {
	query: string;
	results: WebSearchResult[];
}

/** 基本 HTML 实体解码（数字/十六进制 + 常用具名实体；未知实体原样保留）。 */
export function decodeEntities(s: string): string {
	const named: Record<string, string> = {
		amp: "&",
		lt: "<",
		gt: ">",
		quot: '"',
		apos: "'",
		nbsp: " ",
	};
	const fromCode = (code: number, whole: string): string =>
		Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
	return s
		.replace(/&#x([0-9a-f]+);/gi, (whole, hex: string) => fromCode(Number.parseInt(hex, 16), whole))
		.replace(/&#(\d+);/g, (whole, dec: string) => fromCode(Number.parseInt(dec, 10), whole))
		.replace(/&([a-z]+);/gi, (whole, name: string) => named[name.toLowerCase()] ?? whole);
}

/** 去标签 + 压缩空白（先去标签再解实体，解码出的 <…> 字面量不会被误删）。 */
export function stripTags(s: string): string {
	return s
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function cleanText(html: string): string {
	return decodeEntities(stripTags(html));
}

function clip(s: string, cap: number): string {
	return s.length <= cap ? s : `${s.slice(0, cap)}…`;
}

/**
 * 结果链接还原：result__a 的 href 通常是 /l/?uddg=<编码后真实 URL>&rut=…
 * 跳转（也见 //duckduckgo.com/l/?uddg=…），解出 uddg 才是真实地址；直链
 * http(s) 原样放行。广告（/y.js?… 无 uddg 又非 http）返回 undefined，调用方跳过。
 */
export function resolveResultUrl(href: string): string | undefined {
	const raw = decodeEntities(href.trim());
	const m = raw.match(/[?&]uddg=([^&]+)/);
	if (m) {
		try {
			const real = decodeURIComponent(m[1]);
			return /^https?:\/\//i.test(real) ? real : undefined;
		} catch {
			return undefined;
		}
	}
	if (/^https?:\/\//i.test(raw)) return raw;
	if (raw.startsWith("//")) return `https:${raw}`;
	return undefined;
}

/**
 * DuckDuckGo HTML 结果页 → 最多 count 条 {title, url, snippet}。
 * 口径：class 含 result__a 的 <a> 是结果标题锚（属性顺序不定，先配 <a> 再验
 * class）；本锚点之后、下一锚点之前首个 class 含 result__snippet 的元素是摘要。
 * 还原不出真实 URL 的条目（广告/站内跳转）整条跳过，不占 count 名额。
 */
export function parseDuckDuckGoResults(html: string, count: number): WebSearchResult[] {
	const max = Math.min(WEB_SEARCH_COUNT_MAX, Math.max(1, Math.floor(count)));
	const out: WebSearchResult[] = [];
	interface AnchorHit {
		href: string;
		titleHtml: string;
		start: number;
		end: number;
	}
	const hits: AnchorHit[] = [];
	const anchorRe = /<a\b[^>]*>/gi;
	let m: RegExpExecArray | null;
	while ((m = anchorRe.exec(html)) !== null) {
		const tag = m[0];
		if (!/class="[^"]*\bresult__a\b[^"]*"/.test(tag)) continue;
		const hrefMatch = tag.match(/href="([^"]*)"/);
		if (!hrefMatch) continue;
		const close = html.indexOf("</a>", anchorRe.lastIndex);
		if (close === -1) continue;
		hits.push({
			href: hrefMatch[1],
			titleHtml: html.slice(anchorRe.lastIndex, close),
			start: m.index,
			end: close + "</a>".length,
		});
	}
	for (let i = 0; i < hits.length && out.length < max; i++) {
		const hit = hits[i];
		const url = resolveResultUrl(hit.href);
		if (!url) continue;
		const title = clip(cleanText(hit.titleHtml), TITLE_CAP);
		if (!title) continue;
		const chunkEnd = i + 1 < hits.length ? hits[i + 1].start : html.length;
		const chunk = html.slice(hit.end, chunkEnd);
		const sm = chunk.match(/class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span|td)>/i);
		const snippet = sm ? clip(cleanText(sm[1]), SNIPPET_CAP) : "";
		out.push({ title, url, snippet });
	}
	return out;
}

export function makeWebSearchTool(getLang: () => ServerLang): ToolDefinition {
	const text = (
		t: string,
		details: WebSearchDetails,
		isError?: boolean,
	): { content: { type: "text"; text: string }[]; details: WebSearchDetails; isError?: boolean } => ({
		content: [{ type: "text", text: t }],
		details,
		...(isError ? { isError: true } : {}),
	});
	return defineTool({
		name: WEB_SEARCH_TOOL_NAME,
		label: "Web search",
		description:
			"Search the public web via DuckDuckGo's HTML endpoint and return up to 10 results (title, URL, snippet). " +
			"Read-only; the only data sent over the network is the query string. " +
			"Unavailable in offline mode (refuses without making any request).",
		promptSnippet: "current events, package versions, or facts beyond local files need checking",
		promptGuidelines: [
			"Prefer one focused query, then refine terms from what came back instead of firing many broad variations.",
			"Treat snippets as pointers: fetch the promising page (curl via bash, or browser_page) before relying on details.",
			"Never put file contents, secrets, or other private data in the query.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search terms (1-256 chars)." }),
			count: Type.Optional(Type.Number({ description: "Max results, 1-10. Default 5." })),
		}),
		execute: async (_id, p, signal) => {
			const L = getLang();
			// 离线闸门最先行：不校验参数、不碰网络（fetch 闸门是兜底，不该被打到）。
			if (isOfflineMode()) {
				return text(
					pick(
						L,
						"网页搜索已禁用：服务器处于离线模式。",
						"Web search is disabled: the server is in offline mode.",
						"websearch.offline",
					),
					{ query: typeof p.query === "string" ? p.query : "", results: [] },
					true,
				);
			}
			const query = typeof p.query === "string" ? p.query.trim() : "";
			if (!query || query.length > WEB_SEARCH_QUERY_MAX) {
				return text(
					pick(
						L,
						`query 非法：需要 1-${WEB_SEARCH_QUERY_MAX} 字符的非空字符串。`,
						`Invalid query: must be a non-empty string of 1-${WEB_SEARCH_QUERY_MAX} characters.`,
						"websearch.bad.query",
					),
					{ query, results: [] },
					true,
				);
			}
			const count =
				typeof p.count === "number" && Number.isFinite(p.count)
					? Math.min(WEB_SEARCH_COUNT_MAX, Math.max(1, Math.floor(p.count)))
					: WEB_SEARCH_COUNT_DEFAULT;
			let html: string;
			let status = 0;
			try {
				const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
				const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
				const res = await fetch(`${SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}`, {
					signal: combined,
					redirect: "follow",
					headers: { "User-Agent": DESKTOP_USER_AGENT, Accept: "text/html" },
				});
				status = res.status;
				if (!res.ok) {
					// 非 200 不算工具错误（isError 只留给离线拒绝/非法参数）：模型可改词重试。
					return text(
						pick(L, `网页搜索失败：HTTP ${res.status}。`, `Web search failed: HTTP ${res.status}.`, "websearch.http", {
							status: res.status,
						}),
						{ query, results: [] },
					);
				}
				html = await res.text();
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return text(pick(L, `网页搜索失败：${msg}`, `Web search failed: ${msg}`, "websearch.fail", { msg }), {
					query,
					results: [],
				});
			}
			// 端点的反爬挑战页（HTTP 202 + anomaly.js / challenge-form）：这不是
			// 「没有结果」——误报会让模型白白换词重试。诚实报告「暂时不可用」；
			// 绝不尝试绕过检测（不换 UA、不解题、不重放）。
			if (status === 202 || /duckduckgo\.com\/anomaly\.js|id="challenge-form"/i.test(html)) {
				return text(
					pick(
						L,
						"网页搜索暂时不可用：搜索端点正在限流本机请求（稍后再试，或换用浏览器工具）。",
						"Web search is temporarily unavailable: the search endpoint is rate-limiting requests from this machine (try again later, or use the browser tool).",
						"websearch.limited",
					),
					{ query, results: [] },
				);
			}
			const results = parseDuckDuckGoResults(html, count);
			if (results.length === 0) {
				return text(
					pick(
						L,
						`「${query}」没有搜索结果（换个关键词再试）。`,
						`No results for "${query}" (try different terms).`,
						"websearch.empty",
						{ query },
					),
					{ query, results: [] },
				);
			}
			const head = pick(L, `「${query}」的搜索结果：`, `Results for "${query}":`, "websearch.head", { query });
			const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`);
			let body = `${head}\n${lines.join("\n")}`;
			if (body.length > OUTPUT_CAP) body = `${body.slice(0, OUTPUT_CAP)}\n… [truncated]`;
			return text(body, { query, results });
		},
	});
}
