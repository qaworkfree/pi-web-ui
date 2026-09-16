import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { freePort, portUp } from "./lib/port-utils.mjs";

if (!CHROME_PATH) {
	console.log("SKIP: 未找到 Chrome 可执行文件");
	process.exit(0);
}

const REPO = fileURLToPath(new URL("../", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "pi-host-metrics-ui-"));
const WORK = join(base, "work");
const DATA_DIR = join(base, "data");
const AGENT_DIR = join(base, "agent");
const PORT = 30000 + Math.floor(Math.random() * 9000);

mkdirSync(WORK, { recursive: true });
mkdirSync(DATA_DIR, { recursive: true });
const sessionDir = join(AGENT_DIR, "sessions");
mkdirSync(sessionDir, { recursive: true });

// 种入会话，防止触发首次配置向导弹窗遮挡
const seedFile = join(sessionDir, "2026-08-04T00-00-00-000Z_ui-seed.jsonl");
writeFileSync(
	seedFile,
	[
		JSON.stringify({ type: "session", version: 3, id: "ui-seed", timestamp: "2026-08-04T00:00:00.000Z", cwd: WORK }),
		JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-08-04T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1722700801000 },
		}),
	].join("\n") + "\n",
);

let passed = 0;
let failed = 0;
const check = (name, cond, extra = "") => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		failed++;
		console.error(`  ✗ FAIL: ${name}${extra ? ` — ${extra}` : ""}`);
		process.exitCode = 1;
	}
};

let server;
let browser;

function cleanup() {
	if (browser) {
		try {
			browser.close();
		} catch {}
	}
	if (server) {
		try {
			server.kill("SIGTERM");
		} catch {}
	}
	freePort(PORT);
	try {
		rmSync(base, { recursive: true, force: true });
	} catch {}
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
	cleanup();
	process.exit(1);
});

try {
	server = spawn("node", ["dist/server/index.js"], {
		cwd: REPO,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_CWD: WORK,
			PI_WEB_DATA_DIR: DATA_DIR,
			PI_CODING_AGENT_SESSION_DIR: sessionDir,
		},
		stdio: "ignore",
		windowsHide: true,
	});

	let up = false;
	for (let i = 0; i < 60; i++) {
		await sleep(250);
		try {
			if (await portUp(PORT)) {
				up = true;
				break;
			}
		} catch {}
	}
	if (!up) throw new Error("服务未能启动");

	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

	await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
	await page.waitForSelector(".statusbar", { timeout: 30000 });

	// 1. 等待 .status-host-metrics 出现
	const metricsEl = page.locator(".status-host-metrics");
	await metricsEl.waitFor({ state: "visible", timeout: 15000 });

	// 2. 文本同时包含处理器标签、0–100% 数值、内存标签、0–100% 数值
	const text = (await metricsEl.textContent()) ?? "";
	const hasProcessor = /处理器|CPU/.test(text);
	const hasMemory = /内存|Memory/.test(text);
	const hasPercent = /\d+%/.test(text);
	check("文本包含处理器标签", hasProcessor, text);
	check("文本包含内存标签", hasMemory, text);
	check("文本包含百分比数值", hasPercent, text);

	// 3. title 包含“运行 pi-web-ui 服务的主机”语义
	const title = (await metricsEl.getAttribute("title")) ?? "";
	check("title 包含主机服务语义", /运行 pi-web-ui 服务的主机|Host running pi-web-ui/.test(title), title);

	// 4. .statusbar-left 和 .statusbar-right 都存在
	const hasLeft = (await page.locator(".statusbar .statusbar-left").count()) > 0;
	const hasRight = (await page.locator(".statusbar .statusbar-right").count()) > 0;
	check(".statusbar-left 容器存在", hasLeft);
	check(".statusbar-right 容器存在", hasRight);

	// 5. 指标与工作目录都在 .statusbar-right 内
	const inRight = (await page.locator(".statusbar-right .status-host-metrics").count()) > 0;
	const cwdInRight = (await page.locator(".statusbar-right .status-cwd").count()) > 0;
	check("指标位于 .statusbar-right 内", inRight);
	check("工作目录位于 .statusbar-right 内", cwdInRight);

	// 6. 指标的水平位置在工作目录左边
	const metricsBox = await metricsEl.boundingBox();
	const cwdBox = await page.locator(".statusbar-right .status-cwd").boundingBox();
	check("指标水平位置在工作目录左侧", !!metricsBox && !!cwdBox && metricsBox.x < cwdBox.x);

	// 7. 视口宽度设为 520 像素时指标隐藏，工作目录仍可见
	await page.setViewportSize({ width: 520, height: 800 });
	await sleep(500);
	const hiddenAt520 = await metricsEl.isHidden();
	const cwdVisibleAt520 = await page.locator(".status-cwd").isVisible();
	check("520px 视口下指标隐藏", hiddenAt520);
	check("520px 视口下工作目录仍可见", cwdVisibleAt520);

	// 8. 恢复桌面宽度后指标重新出现
	await page.setViewportSize({ width: 1440, height: 900 });
	await sleep(500);
	const visibleRestored = await metricsEl.isVisible();
	check("恢复桌面宽度后指标重新显示", visibleRestored);

	console.log(`\nUI 测试完成: ${passed} passed, ${failed} failed`);
} catch (err) {
	console.error("UI 测试失败:", err);
	process.exitCode = 1;
	if (browser) {
		try {
			mkdirSync("tests/scratch", { recursive: true });
			const pages = browser.contexts()[0]?.pages();
			if (pages?.[0]) {
				await pages[0].screenshot({ path: "tests/scratch/host-metrics-ui-fail.png" });
			}
		} catch {}
	}
} finally {
	cleanup();
}
