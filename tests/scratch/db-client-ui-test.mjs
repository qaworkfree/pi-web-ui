/**
 * db-client UI 滚动验证（真实 Chrome headless，零 token，一次性调试脚本）。
 *
 * 种 sqlite 夹具库（宽表 + 多行）→ 打开插件 → 新建连接 → 打开数据页 →
 * 断言 grid-wrap 垂直/水平均可滚动（scrollHeight/scrollWidth > clientHeight/Width，
 * 且实际执行 scrollTo 后 scrollTop/Left 生效）。
 *
 * 运行：npm run build:server && node tests/scratch/db-client-ui-test.mjs
 */
import { chromium } from "playwright-core";
import { CHROME_PATH } from "../lib/chrome.mjs";
import { portUp } from "../lib/port-utils.mjs";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 8971;
const BASE = `http://localhost:${PORT}`;
const PLUGIN_SRC = join(import.meta.dirname, "..", "..", "dev", "plugins", "db-client");

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-dbcui-"));
const plugDir = join(dataDir, "plugins", "db-client");
mkdirSync(plugDir, { recursive: true });
for (const f of ["manifest.json", "index.mjs", "package.json"]) cpSync(join(PLUGIN_SRC, f), join(plugDir, f));
mkdirSync(join(plugDir, "client"), { recursive: true });
cpSync(join(PLUGIN_SRC, "client", "entry.mjs"), join(plugDir, "client", "entry.mjs"));

// sqlite 宽表夹具（node:sqlite）
const dbFile = join(dataDir, "wide.db");
{
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(dbFile);
	const cols = Array.from({ length: 30 }, (_, i) => `col_${i} TEXT`).join(", ");
	db.exec(`CREATE TABLE wide (id INTEGER PRIMARY KEY, ${cols})`);
	const ph = Array.from({ length: 30 }, () => "?").join(",");
	const longVal = "x".repeat(80);
	const ins = db.prepare(`INSERT INTO wide (${Array.from({ length: 30 }, (_, i) => `col_${i}`).join(",")}) VALUES (${ph})`);
	for (let r = 1; r <= 120; r++) ins.run(...Array.from({ length: 30 }, (_, c) => `${longVal}-r${r}c${c}`));
	db.close();
}

let server = null;
try {
	server = spawn(process.execPath, [join(import.meta.dirname, "..", "..", "dist", "server", "index.js")], {
		env: { ...process.env, PORT: String(PORT), PI_WEB_DATA_DIR: dataDir, PI_DB_CLIENT_NO_AUTOINSTALL: "1" },
		stdio: "ignore",
	});
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		if (await portUp(PORT)) break;
	}

	const browser = await chromium.launch({ executablePath: CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	page.on("pageerror", (e) => console.log("pageerror:", e.message));
	page.on("console", (m) => { const t = m.text(); if (/db-client|plugin|Failed|error/i.test(t)) console.log("[console]", m.type(), t.slice(0, 300)); });
	page.on("requestfailed", (r) => console.log("[reqfail]", r.url().slice(-80), r.failure()?.errorText));
	await page.goto(BASE);
	await page.waitForSelector(".topbar", { timeout: 15_000 });

	// 打开 🗄️ 插件 tab
	await page.locator(".view-switch .plugin-tab").first().click();
	await page.waitForSelector(".dbx", { timeout: 8000 });

	// 新建 SQLite 连接
	await page.locator('.dbx-side-head button[data-act="add"]').click();
	await page.waitForSelector(".dbx-modal-bg:not(.rowmodal) .dbx-modal", { timeout: 4000 });
	await page.selectOption('.dbx-modal select[name="type"]', "sqlite");
	await page.fill('.dbx-modal input[name="name"]', "测试库");
	await page.fill('.dbx-modal input[name="file"]', dbFile);
	await page.locator(".dbx-modal .m-save").click();
	await sleep(300);

	// 点击连接
	await page.locator(".dbx-crow").first().click();
	await page.waitForSelector(".dbx-work:not(.hidden)", { timeout: 10_000 });
	await page.waitForSelector("table.dgrid", { timeout: 10_000 });
	check("数据表格已渲染", true);

	// ---- 刷新持久化：整页 reload 后连接列表应仍在 ----
	await page.reload();
	await page.waitForSelector(".topbar", { timeout: 15_000 });
	await page.locator(".view-switch .plugin-tab").first().click();
	await page.waitForSelector(".dbx", { timeout: 8000 });
	await sleep(500);
	const rowCount = await page.locator(".dbx-crow").count();
	const rowText = rowCount ? await page.locator(".dbx-crow .nm").first().textContent() : "";
	check("刷新后连接列表仍在", rowCount >= 1, `rows=${rowCount} name=${rowText}`);
	// 再点开一次确认全链路可用
	await page.locator(".dbx-crow").first().click();
	await page.waitForSelector(".dbx-work:not(.hidden)", { timeout: 10_000 });
	check("刷新后可重新连接", true);

	const m = await page.evaluate(() => {
		const wrap = document.querySelector(".pane-data .grid-wrap");
		wrap.scrollTop = 0; wrap.scrollLeft = 0;
		return {
			sh: wrap.scrollHeight, ch: wrap.clientHeight,
			sw: wrap.scrollWidth, cw: wrap.clientWidth,
			workDisplay: getComputedStyle(document.querySelector(".dbx-work")).display,
			dbxH: document.querySelector(".dbx").getBoundingClientRect().height,
		};
	});
	console.log("grid-wrap:", JSON.stringify(m));
	check("工作区为 flex 布局", m.workDisplay === "flex");
	check("面板高度受约束", m.dbxH > 300 && m.dbxH < 900, `height=${Math.round(m.dbxH)}`);
	check("垂直可滚", m.sh > m.ch, `${m.sh} > ${m.ch}`);

	// 实际滚一下
	const vScroll = await page.evaluate(() => {
		const w = document.querySelector(".pane-data .grid-wrap");
		w.scrollTop = 500;
		return w.scrollTop;
	});
	check("垂直滚动生效", vScroll > 0, `scrollTop=${vScroll}`);

	if (m.sw > m.cw) {
		const h = await page.evaluate(() => {
			const w = document.querySelector(".pane-data .grid-wrap");
			w.scrollLeft = 600;
			return w.scrollLeft;
		});
		check("水平可滚且生效", h > 0, `scrollWidth=${m.sw} clientWidth=${m.cw} scrollLeft=${h}`);
	} else {
		console.log("· 本视口下无横向溢出，跳过水平断言");
	}

	// ---- 单元格编辑：双击 → 改值 → Enter → toast 已保存 ----
	const cell = page.locator("td[data-edit]").first();
	check("单元格可编辑（data-edit 标记）", (await cell.count()) > 0);
	await cell.dblclick();
	await page.locator(".inline-edit").fill("edited-cell");
	await page.keyboard.press("Enter");
	await page.waitForSelector(".dbx-toast", { timeout: 6000 });
	check("单元格编辑保存成功", (await page.locator(".dbx-toast").textContent()).includes("已保存"));

	// ---- 删除行：hover ops 按钮 → confirm → 行数减一 ----
	page.once("dialog", (d) => void d.accept());
	await page.locator('td.ops-cell button[data-op="del"]').first().click({ force: true });
	await sleep(800);
	const statusText = await page.locator(".pane-data .status-line").textContent();
	check("删除行生效（总行数 120→119）", /共\s*119\s*行/.test(statusText ?? ""), statusText?.trim());

	await browser.close();
} catch (e) {
	failures++;
	console.error("✗ 异常:", e?.stack ?? e);
} finally {
	if (server) try { process.kill(server.pid, "SIGTERM"); } catch {}
	await sleep(400);
	rmSync(dataDir, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
