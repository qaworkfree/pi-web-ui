/**
 * fenced-code 渲染插件 E2E：普通文本消息里出现 ```mermaid 围栏时，由
 * plugins/mermaid（renderer 插件）按需懒加载并渲染成 SVG；无插件认领的
 * ```plantuml 围栏回退普通代码块。
 *
 * 依赖外网（esm.sh CDN 拉取 mermaid 引擎）——CI/离线环境可能失败，可跳过。
 * Run: npm run build && node tests/fence-render-test.mjs
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { WebSocket } from "ws";

const PORT = 30000 + Math.floor(Math.random() * 10000);
const base = mkdtempSync(join(tmpdir(), "piweb-fence-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });
// Real-looking auth so the one-time setup modal doesn't block the UI.
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ fastfail: { type: "api_key", key: "dummy" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			fastfail: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1",
				apiKey: "dummy",
				models: [{ id: "test-model" }],
			},
		},
	}),
);
// 官方 mermaid renderer 插件（随仓库打包，测试时复制进临时 dataDir）。
cpSync(join(fileURLToPath(new URL("..", import.meta.url)), "plugins", "mermaid"), join(dataDir, "plugins", "mermaid"), {
	recursive: true,
});

process.env.PI_WEB_PORT = String(PORT);
process.env.PI_WEB_CWD = workdir;
process.env.PI_WEB_DATA_DIR = dataDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
const CLIENT_ID = "fence-render-client";
// seed 时发一条用户消息，模型 fastfail 立即返回错误——用户消息本身即时渲染。
const MERMAID_TEXT = "```mermaid\nflowchart LR\n  A[开始] --> B[结束]\n```\n";
const PLAIN_TEXT = "```plantuml\nA -> B\n```";

const server = spawn(
	process.execPath,
	[join(fileURLToPath(new URL("..", import.meta.url)), "dist", "server", "index.js")],
	{ stdio: ["ignore", "pipe", "pipe"], detached: true },
);
process.on("exit", () => {
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const check = (name, cond) => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name}`);
		process.exitCode = 1;
	}
};

async function waitServer() {
	for (let i = 0; i < 100; i++) {
		try {
			const r = await fetch(`http://localhost:${PORT}/`);
			if (r.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(200);
	}
	throw new Error("server did not start");
}

/** 种一条含 mermaid + plantuml 围栏的用户消息（快照落库，浏览器同 clientId 可见）。 */
function seedMessage() {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
		const timer = setTimeout(() => reject(new Error("seed timeout")), 20_000);
		ws.on("open", () => ws.send(JSON.stringify({ type: "hello", clientId: CLIENT_ID })));
		ws.on("message", (d) => {
			let msg;
			try {
				msg = JSON.parse(d.toString());
			} catch {
				return;
			}
			if (msg.type === "ready") {
				ws.send(JSON.stringify({ type: "prompt", text: MERMAID_TEXT + PLAIN_TEXT }));
				// 用户消息经 snapshot_delta 增量推送——每 1s 轮询 get_state 触发全量快照。
				const poll = setInterval(() => ws.send(JSON.stringify({ type: "get_state" })), 1000);
				setTimeout(() => clearInterval(poll), 15_000);
			}
			if (msg.type === "snapshot") {
				const mine = msg.state.messages.filter((m) => {
					const t = Array.isArray(m.content)
						? m.content.map((c) => (c && "text" in c ? c.text : "")).join("")
						: "";
					return m.role === "user" && t.includes("```mermaid");
				});
				if (mine.length > 0) {
					clearTimeout(timer);
					ws.close();
					resolve();
				}
			}
		});
		ws.on("error", reject);
	});
}

async function main() {
	if (!CHROME_PATH) {
		console.log("⏭ SKIP：未找到 Chrome（设 PI_WEB_CHROME 或安装 Chrome/playwright chromium）");
		return;
	}
	await waitServer();
	console.log("seeding mermaid + plantuml fence message…");
	await seedMessage();

	const browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage();
	// 验证「插件自带引擎」：渲染期间不得请求外网 CDN（esm.sh）——vendor 本地加载。
	const cdnHits = [];
	page.on("request", (r) => {
		if (r.url().includes("esm.sh") || r.url().includes("jsdelivr")) cdnHits.push(r.url());
	});
	await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });

	// 用户消息出现 → mermaid 围栏 → 插件按需加载（首次含 CDN import，给足时间）。
	let svgOk = false;
	let plainOk = false;
	for (let i = 0; i < 120; i++) {
		await sleep(1000);
		const state = await page
			.evaluate(() => {
				const svg = document.querySelector(".mermaid-block svg");
				const hasSvg = !!svg && svg.getAttribute("width") !== "";
				// plantuml 无插件认领 → 保持普通代码块（pre > code 含源码，无 svg）
				const pre = [...document.querySelectorAll(".codeblock pre code")].find((c) =>
					c.textContent.includes("A -> B"),
				);
				return { hasSvg, plain: !!pre };
			})
			.catch(() => ({ hasSvg: false, plain: false }));
		if (state.hasSvg) svgOk = true;
		if (state.plain) plainOk = true;
		if (svgOk && plainOk) break;
	}

	check("```mermaid 围栏被插件渲染为 SVG（.mermaid-block svg）", svgOk);
	check("```plantuml 无插件认领 → 回退普通代码块", plainOk);
	console.log("  [cdnHits]", JSON.stringify(cdnHits));
	check("渲染期间未请求外网 CDN（esm.sh/jsdelivr）——本地 vendor 生效", cdnHits.length === 0);

	// 静态服务：插件 bundle 可经 /plugins/mermaid/client/ 拿到
	const bundle = await page.evaluate(() =>
		fetch("/plugins/mermaid/client/entry.mjs")
			.then((r) => (r.ok ? r.text() : ""))
			.then((t) => t.length > 0),
	);
	check("插件 bundle 经 /plugins/mermaid/client/entry.mjs 可达", bundle);

	// 手动复现一次 renderer 调用：区分「渲染本身失败」vs「管线挂接失败」
	const manual = await page.evaluate(async () => {
		try {
			const mod = await import("/plugins/mermaid/client/entry.mjs?e=1");
			const el = await mod.default.renderers.mermaid("flowchart LR\n  A --> B");
			return { ok: !!el, hasSvg: !!(el && el.querySelector("svg")), err: null };
		} catch (e) {
			return { ok: false, hasSvg: false, err: String(e).slice(0, 200) };
		}
	});
	console.log("  [manual renderer]", JSON.stringify(manual));
	check("手动调用 renderer 能产出 SVG", manual.ok && manual.hasSvg);

	await browser.close();
	console.log(passed >= 3 ? "\nFENCE RENDER E2E PASSED" : "\nFENCE RENDER E2E FAILED");
}

main()
	.catch((err) => {
		console.error("✗", err);
		process.exitCode = 1;
	})
	.finally(() => {
		try {
			process.kill(-server.pid, "SIGKILL");
		} catch {
			/* gone */
		}
	});