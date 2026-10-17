/**
 * web_search 单测 — 解析器纯函数 + 离线拒绝。
 *
 * 解析器不碰网络：喂一段最小化的 DuckDuckGo HTML fixture（内联，字段取自真实
 * 结果页结构：result__a 锚 + uddg 跳转 href + result__snippet），断言
 * title/url（uddg 解码）/snippet 提取、实体解码、广告跳过与 count 封顶。
 *
 * 离线拒绝走 env：offline-mode.ts 的 isOfflineMode() 每次调用都读
 * process.env.PI_WEB_OFFLINE，所以测试里设/还原该变量即可，无需注入。
 * 另 stub globalThis.fetch 断言「离线时根本不发请求」。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	decodeEntities,
	makeWebSearchTool,
	parseDuckDuckGoResults,
	resolveResultUrl,
	stripTags,
} from "../../server/web-search-tool.js";

// 最小化 DuckDuckGo HTML 结果页：第 1 条 uddg 跳转 + 实体；第 2 条广告
// （/y.js 无 uddg，应整条跳过）；第 3 条直链 + div 摘要；第 4 条无摘要。
const FIXTURE = `
<div class="results">
<div class="result results_links results_links_deep web-result">
	<h2 class="result__title">
		<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs%2Fnode&amp;rut=abc123">Node.js &amp; the <b>event</b> loop</a>
	</h2>
	<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs%2Fnode&amp;rut=abc123">Learn how Node&#x27;s loop&nbsp;works &lt;fast&gt;.</a>
</div>
<div class="result result--ad">
	<h2 class="result__title">
		<a rel="nofollow" class="result__a" href="/y.js?ad_provider=bing&amp;ad_domain=ads.example">Sponsored thing</a>
	</h2>
	<a class="result__snippet">An ad snippet.</a>
</div>
<div class="result">
	<h2 class="result__title"><a class="result__a" href="https://second.example.org/page">Second &quot;result&quot;</a></h2>
	<div class="result__snippet">Second snippet.</div>
</div>
<div class="result">
	<h2 class="result__title"><a class="result__a" href="/l/?uddg=https%3A%2F%2Fthird.example%2Fpage%3Fx%3D1%26y%3D2&amp;rut=zzz">Third</a></h2>
</div>
</div>`;

describe("web_search parser（DuckDuckGo HTML → {title,url,snippet}）", () => {
	it("提取 title/url/snippet：uddg 解码 + 实体解码 + 去标签", () => {
		const r = parseDuckDuckGoResults(FIXTURE, 10);
		expect(r[0]).toEqual({
			title: "Node.js & the event loop",
			url: "https://example.com/docs/node",
			snippet: "Learn how Node's loop works <fast>.",
		});
	});

	it("广告（无 uddg 又非 http 的 href）整条跳过，不占名额", () => {
		const r = parseDuckDuckGoResults(FIXTURE, 10);
		expect(r.map((x) => x.url)).toEqual([
			"https://example.com/docs/node",
			"https://second.example.org/page",
			"https://third.example/page?x=1&y=2",
		]);
		expect(r[1].title).toBe('Second "result"');
		expect(r[1].snippet).toBe("Second snippet.");
		expect(r[2].snippet).toBe(""); // 无 result__snippet → 空串，不伪造
	});

	it("count 封顶：上限 10、下限 1、fixture 内截取", () => {
		expect(parseDuckDuckGoResults(FIXTURE, 1)).toHaveLength(1);
		expect(parseDuckDuckGoResults(FIXTURE, 0)).toHaveLength(1);
		const many = Array.from(
			{ length: 12 },
			(_, i) =>
				`<a class="result__a" href="https://example.com/p${i}">T${i}</a><div class="result__snippet">S${i}</div>`,
		).join("\n");
		expect(parseDuckDuckGoResults(many, 99)).toHaveLength(10);
		expect(parseDuckDuckGoResults(many, 3)).toHaveLength(3);
	});

	it("实体解码与去标签（具名 + 十进制 + 十六进制；未知实体原样保留）", () => {
		expect(decodeEntities("&amp;&lt;&gt;&quot;&#x27;&nbsp;&#65;&bogus;")).toBe(`&<>"' A&bogus;`);
		expect(stripTags("a <b>b</b>\n <i>c</i>")).toBe("a b c");
	});

	it("resolveResultUrl：uddg 优先、直链放行、协议相对补 https、其余拒绝", () => {
		expect(resolveResultUrl("/l/?uddg=https%3A%2F%2Fa.example%2Fx&rut=1")).toBe("https://a.example/x");
		expect(resolveResultUrl("https://direct.example/")).toBe("https://direct.example/");
		expect(resolveResultUrl("//proto.example/p")).toBe("https://proto.example/p");
		expect(resolveResultUrl("/y.js?ad_domain=ads.example")).toBeUndefined();
		expect(resolveResultUrl("/l/?uddg=javascript%3Aalert(1)")).toBeUndefined();
	});
});

describe("web_search execute（离线拒绝 / 非法参数）", () => {
	const prevOffline = process.env.PI_WEB_OFFLINE;
	const realFetch = globalThis.fetch;
	afterEach(() => {
		if (prevOffline === undefined) delete process.env.PI_WEB_OFFLINE;
		else process.env.PI_WEB_OFFLINE = prevOffline;
		globalThis.fetch = realFetch;
	});

	it("离线模式直接拒绝（isError=true），且不发任何网络请求", async () => {
		process.env.PI_WEB_OFFLINE = "1";
		let fetchCalled = false;
		globalThis.fetch = (async () => {
			fetchCalled = true;
			throw new Error("network attempted");
		}) as any;
		const tool = makeWebSearchTool(() => "en");
		const res = (await tool.execute("t1", { query: "anything" } as any, undefined, undefined, {} as any)) as any;
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toBe("Web search is disabled: the server is in offline mode.");
		expect(fetchCalled).toBe(false);
	});

	it("非法 query（空/超长）报 isError，且不发请求", async () => {
		delete process.env.PI_WEB_OFFLINE;
		let fetchCalled = false;
		globalThis.fetch = (async () => {
			fetchCalled = true;
			throw new Error("network attempted");
		}) as any;
		const tool = makeWebSearchTool(() => "en");
		const blank = (await tool.execute("t2", { query: "   " } as any, undefined, undefined, {} as any)) as any;
		expect(blank.isError).toBe(true);
		const long = (await tool.execute("t3", { query: "x".repeat(300) } as any, undefined, undefined, {} as any)) as any;
		expect(long.isError).toBe(true);
		expect(fetchCalled).toBe(false);
	});

	it("反爬挑战页（HTTP 202 + anomaly.js）报「暂时不可用」而非「没有结果」", async () => {
		delete process.env.PI_WEB_OFFLINE;
		globalThis.fetch = (async () =>
			new Response('<form id="challenge-form" action="//duckduckgo.com/anomaly.js?sv=html"></form>', {
				status: 202,
				headers: { "content-type": "text/html" },
			})) as any;
		const tool = makeWebSearchTool(() => "en");
		const res = (await tool.execute("t5", { query: "ok" } as any, undefined, undefined, {} as any)) as any;
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("temporarily unavailable");
		expect(res.content[0].text).not.toContain("No results");
	});

	it("网络失败是普通文本结果（isError 不为 true），模型可改词重试", async () => {
		delete process.env.PI_WEB_OFFLINE;
		globalThis.fetch = (async () => {
			throw new Error("getaddrinfo ENOTFOUND html.duckduckgo.com");
		}) as any;
		const tool = makeWebSearchTool(() => "en");
		const res = (await tool.execute("t4", { query: "ok" } as any, undefined, undefined, {} as any)) as any;
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("Web search failed");
	});
});
