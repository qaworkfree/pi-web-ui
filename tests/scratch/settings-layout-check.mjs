// 一次性调试脚本：设置弹窗侧边栏布局的 DOM 断言。
// 用法：npm run build && node tests/scratch/settings-layout-check.mjs
import { chromium } from "playwright-core";
import { CHROME_PATH } from "../lib/chrome.mjs";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 36000 + Math.floor(Math.random() * 1000);
const URL = `http://127.0.0.1:${PORT}`;
const base = mkdtempSync(join(tmpdir(), "pi-web-setck-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [workdir, dataDir, agentDir]) mkdirSync(d, { recursive: true });

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ main: { type: "api_key", key: "k" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			main: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1",
				apiKey: "k",
				models: [{ id: "deepseek-main", input: ["text"] }],
			},
		},
	}),
);

const NODE = realpathSync(process.execPath);
const server = spawn(NODE, ["dist/server/index.js"], {
	env: {
		...process.env,
		PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: "ignore",
	windowsHide: true,
});
process.on("exit", () => {
	try {
		process.kill(server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
});

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

try {
	for (let i = 0; i < 60; i++) {
		try {
			const r = await fetch(`${URL}/`);
			if (r.ok) break;
		} catch {
			/* retry */
		}
		await sleep(250);
	}
	const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	await page.goto(URL);
	await page.waitForSelector(".chat-input, .inputbar, textarea", { timeout: 30000 });
	await page.locator('[title*="设置"], [title*="Settings"]').first().click();
	await page.waitForSelector(".settings-modal", { timeout: 10000 });
	await sleep(400);

	// 侧边栏结构
	const tabLabels = await page.locator(".settings-tab-label").allTextContents();
	check("rail has 9 tabs", tabLabels.length === 9, JSON.stringify(tabLabels));
	const activeFirst = await page
		.locator(".settings-tab.active .settings-tab-label")
		.textContent();
	check("first tab active by default", activeFirst === "系统提示词", activeFirst ?? "");

	// 长说明不再平铺：modal-desc 移除，改为标题旁的「？」悬浮
	const descCount = await page.locator(".settings-modal .modal-desc").count();
	check("long desc removed from layout", descCount === 0);
	const headTip = await page.locator(".settings-modal .modal-head .set-tip").count();
	check("head has ? tip", headTip === 1);
	await page.locator(".settings-modal .modal-head .set-tip").hover();
	await sleep(300);
	const bubbleVisible = await page
		.locator(".settings-modal .modal-head .set-tip-bubble")
		.evaluate((el) => getComputedStyle(el).display !== "none");
	check("hover shows desc bubble", bubbleVisible);

	// 弹窗高度固定且不矮：内容极少与内容较多的 tab 高度一致
	const hTiny = await page.locator(".settings-modal").evaluate((el) => el.getBoundingClientRect().height);
	await page.locator(".settings-tab", { hasText: "提示词" }).first().click();
	await sleep(200);
	const hTall = await page.locator(".settings-modal").evaluate((el) => el.getBoundingClientRect().height);
	check("modal height stable across tabs", Math.abs(hTiny - hTall) < 2, `${hTiny} vs ${hTall}`);
	check("modal not too short (>=420px)", hTall >= 420, String(hTall));

	// 默认只渲染激活组
	const sections0 = await page.locator(".settings-modal .modal-body .set-section").count();
	check("only active section rendered (1)", sections0 === 1, String(sections0));

	// 切换 tab：激活态跟随 + 区块唯一 + 内容区回顶
	for (const label of ["目标审查", "预设", "终端工具"]) {
		await page.locator(".settings-tab", { hasText: label }).click();
		await sleep(200);
		const active = await page
			.locator(".settings-tab.active .settings-tab-label")
			.textContent();
		check(`tab switch → ${label} active`, active === label, active ?? "");
		const n = await page.locator(".settings-modal .modal-body .set-section").count();
		check(`only one section on ${label}`, n === 1, String(n));
	}
	// 内容超高时在固定高度内滚动（人工撑高内容验证），切 tab 后回顶
	await page.locator(".settings-tab", { hasText: "提示词" }).click();
	await sleep(200);
	await page.locator(".set-view-prompt-btn").click(); // 展开完整提示词
	await sleep(200);
	await page
		.locator(".set-prompt-input")
		.evaluate((el) => (el.style.minHeight = "900px")); // 人工撑高
	await sleep(200);
	const body = page.locator(".settings-modal .modal-body");
	const canScroll = await body.evaluate((el) => el.scrollHeight > el.clientHeight);
	check("tall content scrolls inside fixed-height modal", canScroll);
	if (canScroll) {
		await body.evaluate((el) => el.scrollTo(0, 99999));
		const scrolled = await body.evaluate((el) => el.scrollTop);
		check("body actually scrolled", scrolled > 0, String(scrolled));
		await page.locator(".settings-tab", { hasText: "技能" }).click();
		await sleep(200);
		const afterSwitch = await body.evaluate((el) => el.scrollTop);
		check("switch resets body scroll to top", afterSwitch === 0, String(afterSwitch));
	}
	// 计数徽标存在（技能/扩展/插件/预设 有，提示词没有）
	const promptBadge = await page.locator(".settings-tab .set-count").count();
	// 提示词 tab 是第一个，无徽标
	const firstTabBadge = await page
		.locator(".settings-tab")
		.first()
		.locator(".set-count")
		.count();
	check("prompt tab has no badge", firstTabBadge === 0);
	check("some tabs carry count badges", promptBadge >= 4, String(promptBadge));

	await browser.close();
	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
	process.exit(failures === 0 ? 0 : 1);
} catch (err) {
	console.error("ERROR:", err.message);
	process.exit(1);
} finally {
	try {
		process.kill(server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
}