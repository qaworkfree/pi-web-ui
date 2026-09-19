/* 浏览器 E2E：notes 插件的浮窗/视图/提醒链路（真 Chrome + 真服务端，零 token）。
 *
 * 覆盖（这是客户端 bundle 唯一的真浏览器验证；单测只覆盖纯逻辑与假宿主）：
 *   - 顶栏 📌 按钮 → 可拖拽浮窗出现；拖动改位置、刷新后位置与开合状态保留
 *   - 快速捕获：待办（含「明天 18:00 #工作」解析）、提醒（「每天 9:00 」解析）、笔记（落库）
 *   - 最小化成小贴片、⤢ 切到完整视图（更宽的布局 + 导入导出按钮）
 *   - 提醒到点：服务端触发 → 长轮询把浏览器叫醒 → 客户端确认（fireCount=1、单次提醒自停、
 *     待送达队列被清空）—— 也就是说「服务端到点 → 浏览器弹提示」这条链路真的通
 *   - 完整视图里改条目写回库（待办编辑器切换重复档）、设置弹层
 *   - 插件热重载（plugins_reload）后旧实例被拆干净：页面里只剩一个浮窗（不会多出一条长轮询）
 *   - 页面无 JS 报错
 *
 * 缺 Chrome 自动 SKIP（与其它浏览器 E2E 同约定，不入 run-smoke）。运行：
 *   npm run build && node tests/notes-ui-test.mjs
 */
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import WebSocket from "ws";
import { CHROME_PATH } from "./lib/chrome.mjs";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "pi-notes-ui-"));
const WORK = join(base, "work");
const DATA_DIR = join(base, "data");
const PORT = 24000 + Math.floor(Math.random() * 3000);
const BASE = `http://localhost:${PORT}`;
mkdirSync(WORK, { recursive: true });
mkdirSync(join(DATA_DIR, "plugins"), { recursive: true });
cpSync(join(REPO, "plugins", "notes"), join(DATA_DIR, "plugins", "notes"), { recursive: true });

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

let server = null;
let browser = null;

async function waitServer() {
	for (let i = 0; i < 120; i++) {
		try {
			if ((await fetch(`${BASE}/api/health`)).ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(250);
	}
	throw new Error("server did not start");
}

async function store() {
	const r = await fetch(`${BASE}/plugins-api/notes/store`);
	return (await r.json()).store;
}

async function main() {
	if (!CHROME_PATH) {
		console.log("⏭ SKIP：未找到 Chrome（设 PI_WEB_CHROME 或安装 Chrome/playwright chromium）");
		return;
	}
	server = spawn(process.execPath, [join(REPO, "dist", "server", "index.js")], {
		cwd: REPO,
		env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_CWD: WORK, PI_WEB_DATA_DIR: DATA_DIR },
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));
	await waitServer();

	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text());
	});

	await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
	// 顶栏插件条目（📌 笔记）
	const topbarBtn = page.locator(".plugin-topbar-item", { hasText: "笔记" }).first();
	await topbarBtn.waitFor({ timeout: 20000 });
	check("顶栏出现笔记按钮", await topbarBtn.isVisible());
	// 关掉顶栏文字后只剩图标 —— 图标必须在、且是内联 SVG（不能是空 span，否则用户只看到一个点）
	const iconInfo = await topbarBtn.evaluate((el) => {
		const svg = el.querySelector("svg");
		const r = svg?.getBoundingClientRect();
		const ds = [...(svg?.querySelectorAll("path") ?? [])].map((p) => p.getAttribute("d") ?? "");
		return {
			hasSvg: !!svg,
			hasRect: !!svg?.querySelector("rect"),
			w: r ? Math.round(r.width) : 0,
			h: r ? Math.round(r.height) : 0,
			// 「日历打勾」那版：日历方框 + 一个对勾（不是旧的图钉，也不是纯清单）
			isCalendarCheck: ds.some((d) => d.startsWith("m9 15")),
		};
	});
	check("按钮内联 SVG 图标（14px 级仍然可辨）", iconInfo.hasSvg && iconInfo.w >= 10 && iconInfo.h >= 10);
	check("图标是「日历打勾」那版（方框 + 对勾）", iconInfo.hasRect && iconInfo.isCalendarCheck);

	// -- 开浮窗 -------------------------------------------------------------------
	await topbarBtn.click();
	await page.waitForSelector(".nt-panel", { timeout: 10000 });
	check("点击后浮窗出现且置顶可拖拽", await page.locator(".nt-panel").isVisible());
	check(
		"浮窗带拖拽把手与缩放柄",
		(await page.locator(".nt-panel-head").count()) === 1 && (await page.locator(".nt-grip").count()) === 1,
	);

	// -- 快速捕获：待办（自然语言） ---------------------------------------------------
	const quick = page.locator(".nt-panel .nt-quick input").first();
	await quick.fill("交周报 明天 18:00 #工作");
	await quick.press("Enter");
	await page.waitForSelector('.nt-panel .nt-item:has-text("交周报")', { timeout: 8000 });
	const todoText = await page.locator(".nt-panel .nt-item").first().innerText();
	check("待办从快速输入落进列表", todoText.includes("交周报"));
	check("「明天 18:00」被解析成截止时间", /明天 18:00/.test(todoText));
	check("#工作 被解析成标签", todoText.includes("#工作"));

	// -- 拖动 + 位置/开合状态持久化 ---------------------------------------------------
	const before = await page.locator(".nt-panel").boundingBox();
	const head = await page.locator(".nt-panel-head .nt-panel-title").boundingBox();
	await page.mouse.move(head.x + 20, head.y + 8);
	await page.mouse.down();
	await page.mouse.move(head.x + 20 - 140, head.y + 8 + 120, { steps: 8 });
	await page.mouse.up();
	await sleep(300);
	const after = await page.locator(".nt-panel").boundingBox();
	check("拖动真的移动了浮窗", Math.abs(after.x - before.x) > 60 && Math.abs(after.y - before.y) > 60);

	await page.reload({ waitUntil: "domcontentloaded" });
	await sleep(2500);
	const restored = await page
		.locator(".nt-panel")
		.boundingBox()
		.catch(() => null);
	check(
		"刷新后浮窗自动恢复（位置记忆）",
		!!restored && Math.abs(restored.x - after.x) < 40 && Math.abs(restored.y - after.y) < 40,
	);

	// -- 快速捕获：提醒（重复档位解析） -----------------------------------------------
	await page.locator(".nt-panel .nt-tab", { hasText: "提醒" }).first().click();
	const quick2 = page.locator(".nt-panel .nt-quick input").first();
	await quick2.fill("每天 9:00 吃药");
	await quick2.press("Enter");
	await page.waitForSelector('.nt-panel .nt-item:has-text("吃药")', { timeout: 8000 });
	const remText = await page.locator(".nt-panel .nt-item").first().innerText();
	check("提醒「每天 9:00」解析成每天 09:00", remText.includes("每天") && remText.includes("09:00"));

	// -- 笔记：新建 → 编辑器改写 → 落库 ----------------------------------------------
	await page.locator(".nt-panel .nt-tab", { hasText: "笔记" }).first().click();
	const quick3 = page.locator(".nt-panel .nt-quick input").first();
	await quick3.fill("会议要点");
	await quick3.press("Enter");
	await page.waitForSelector(".nt-panel .nt-editor textarea", { timeout: 8000 });
	const titleInput = page.locator(".nt-panel .nt-editor input.nt-input").first();
	check("笔记回车后打开编辑器并带标题", (await titleInput.inputValue()) === "会议要点");
	await page.locator(".nt-panel .nt-editor textarea").first().fill("1. 排期\n2. 风险");
	await sleep(900); // 输入即存（debounce 400ms）
	let s = await store();
	check(
		"笔记正文落库（输入即存）",
		s.notes.some((n) => n.body.includes("排期")),
	);

	// -- 提醒到点：服务端 → 长轮询 → 浏览器确认 ----------------------------------------
	const at = new Date(Date.now() + 6000);
	const pad = (n) => String(n).padStart(2, "0");
	const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
	await fetch(`${BASE}/plugins-api/notes/op`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ op: "reminder.save", item: { text: "喝水", schedule: { type: "once", at: stamp } } }),
	});
	let fired = null;
	for (let i = 0; i < 40; i++) {
		await sleep(1000);
		s = await store();
		fired = s.reminders.find((r) => r.text === "喝水");
		if (fired?.fireCount >= 1) break;
	}
	check("一次性提醒到点被触发（fireCount=1）", fired?.fireCount >= 1);
	check("一次性提醒触发后自动停用", fired?.enabled === false);
	check("浏览器收到并确认了提醒（待送达队列清空）", s.meta.pending.length === 0);

	// -- 浮窗里「点开一条 → 切 tab」不能变成全空面板（回归：nt-editing 类漏摘） -----------------
	await page.locator(".nt-panel .nt-tab", { hasText: "待办" }).first().click();
	await page.locator('.nt-panel .nt-item:has-text("交周报")').first().click();
	await sleep(300);
	check(
		"浮窗里点开一行进入编辑态（列表让位给编辑器）",
		(await page.locator(".nt-panel .nt-app.nt-editing").count()) === 1,
	);
	await page.locator(".nt-panel .nt-tab", { hasText: "笔记" }).first().click();
	await sleep(300);
	const rowsAfterTabSwitch = await page.locator(".nt-panel .nt-item").count();
	const stillEditing = await page.locator(".nt-panel .nt-app.nt-editing").count();
	check("切 tab 后列表回来、编辑态退出（不出现全空面板）", rowsAfterTabSwitch > 0 && stillEditing === 0);

	// -- 勾一个通知开关不能重建面板（否则正在打的字会丢） ---------------------------------
	const noteQuick = page.locator(".nt-panel .nt-quick input").first();
	await noteQuick.fill("切语言前的草稿");
	let langSelCount = 0;
	await page.locator(".nt-panel-head .nt-pill-hide").first().click(); // ⚙
	await sleep(300);
	langSelCount = await page.locator(".nt-panel .nt-settings select").count();
	await page.locator(".nt-panel .nt-settings .nt-checkline input").first().click(); // 站内通知条开关
	await sleep(300);
	check("浮窗设置能开（开关 + 语言下拉）", langSelCount > 0);
	check("切换偏好不会重建浮窗（输入框里的字还在）", (await noteQuick.inputValue()) === "切语言前的草稿");
	await page.locator(".nt-panel-head .nt-pill-hide").first().click(); // 收起设置

	// -- 最小化 / 完整视图 ------------------------------------------------------------
	await page.locator(".nt-panel-head button[title*='收起']").first().click();
	await sleep(200);
	check("最小化成小贴片（数量角标）", (await page.locator(".nt-panel.nt-pill").count()) === 1);
	check("小贴片显示待处理数量", /\d/.test(await page.locator(".nt-pill-count").first().innerText()));

	await page.locator(".nt-panel-head button[title*='完整视图']").first().click();
	await page.waitForSelector(".plugin-view .nt-app", { timeout: 10000 });
	await sleep(500);
	const viewText = await page.locator(".plugin-view .nt-app").first().innerText();
	check(
		"⤢ 切到完整视图（四个 tab）",
		["待办", "笔记", "提醒", "议程"].every((x) => viewText.includes(x)),
	);
	// -- 月视图日历（重复提醒要画在当月每一天） --------------------------------------------
	await page.locator(".plugin-view .nt-tab", { hasText: "日历" }).first().click();
	await sleep(600);
	const cells = await page.locator(".plugin-view .nt-cal-cell").count();
	const chips = await page.locator(".plugin-view .nt-cal-chip").count();
	const calText = await page.locator(".plugin-view .nt-cal-detail").first().innerText();
	check("日历画出 6×7 = 42 天格子", cells === 42);
	check("「每天 9:00 吃药」在当月多天都有条目（chip 数 > 5）", chips > 5);
	check("日历下方给出选中日的清单", /\d{4}-\d{2}-\d{2}/.test(calText));
	// 点另一天 → 详情跟着换
	const dayIndex = await page.evaluate(() => {
		const all = [...document.querySelectorAll(".plugin-view .nt-cal-cell")];
		return all.findIndex((c) => !c.classList.contains("nt-today") && !c.classList.contains("nt-out"));
	});
	await page.locator(".plugin-view .nt-cal-cell").nth(dayIndex).click();
	await sleep(400);
	const selText = await page.locator(".plugin-view .nt-cal-detail").first().innerText();
	check("点别的日期会切到那一天的清单", selText !== calText);
	// 下个月按钮
	const titleBefore = await page.locator(".plugin-view .nt-cal-title").first().innerText();
	await page.locator('.plugin-view .nt-cal-head button[title*="下个月"]').first().click();
	await sleep(400);
	const titleAfter = await page.locator(".plugin-view .nt-cal-title").first().innerText();
	check("能翻到下个月", titleAfter !== titleBefore && (await page.locator(".plugin-view .nt-cal-cell").count()) === 42);

	// -- 完整视图的设置弹层（通知开关 / 语言 / 导入导出都在这里，与浮窗同一份表单） --------
	await page.locator('.plugin-view .nt-head button[title*="设置"]').first().click();
	await sleep(200);
	const settingsText = await page.locator(".plugin-view .nt-settings").first().innerText();
	check(
		"完整视图的 ⚙ 打开设置（四个开关 + 语言 + 导入导出）",
		["站内通知条", "桌面通知", "提示音", "语言"].every((x) => settingsText.includes(x)) &&
			settingsText.includes("导出") &&
			settingsText.includes("导入"),
	);

	// -- 完整视图里改一条：待办编辑器写回库（切换重复档） -------------------------------
	await page.locator(".plugin-view .nt-tab", { hasText: "待办" }).first().click();
	await page.locator('.plugin-view .nt-item:has-text("交周报")').first().click();
	await page.waitForSelector(".plugin-view .nt-editor select", { timeout: 8000 });
	await page.locator(".plugin-view .nt-editor select").nth(1).selectOption("weekly"); // 第 1 个是优先级，第 2 个是重复
	await sleep(900);
	s = await store();
	check("待办编辑器改动写回库（重复=每周）", s.todos.find((t) => t.text === "交周报")?.repeat === "weekly");

	// -- 插件热重载后旧实例必须收干净（否则会多出一个浮窗 + 第二条长轮询） -----------------
	const reloadSock = new WebSocket(`ws://localhost:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		reloadSock.on("open", () => resolve());
		reloadSock.on("error", reject);
	});
	reloadSock.send(JSON.stringify({ type: "plugins_reload" }));
	await sleep(4000);
	const panels = await page.locator(".nt-panel").count();
	const apps = await page.locator(".plugin-view .nt-app").count();
	check("热重载后只剩一个浮窗（旧实例已拆干净）", panels === 1 && apps <= 1);
	reloadSock.close();

	await sleep(300);
	const realErrors = errors.filter((e) => !/favicon|ResizeObserver loop/i.test(e));
	check("页面无 JS 报错", realErrors.length === 0);
	if (realErrors.length) console.log(realErrors.slice(0, 6).join("\n"));

	console.log(`\n${process.exitCode ? "✗ 有失败项" : "all ok"}（${passed} checks）`);
}

try {
	await main();
} catch (err) {
	console.error(`✗ ${err?.stack ?? err}`);
	process.exitCode = 1;
} finally {
	try {
		await browser?.close();
	} catch {
		/* ignore */
	}
	if (server?.pid) {
		try {
			process.kill(-server.pid, "SIGTERM");
		} catch {
			try {
				process.kill(server.pid, "SIGTERM");
			} catch {
				/* ignore */
			}
		}
	}
	await sleep(600);
	rmSync(base, { recursive: true, force: true });
}
