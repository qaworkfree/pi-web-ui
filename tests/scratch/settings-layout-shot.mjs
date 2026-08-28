// 一次性调试脚本：设置弹窗侧边栏分页布局的视觉验证（截图）。
// 用法：npm run build && node tests/scratch/settings-layout-shot.mjs
import { chromium } from "playwright-core";
import { CHROME_PATH } from "../lib/chrome.mjs";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 35000 + Math.floor(Math.random() * 1000);
const URL = `http://127.0.0.1:${PORT}`;
const base = mkdtempSync(join(tmpdir(), "pi-web-setshot-"));
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
	await page.screenshot({ path: "tests/scratch/set-tab-prompt.png" });

	for (const label of ["技能", "界面插件", "视觉桥", "预设"]) {
		await page.locator(".settings-tab", { hasText: label }).click();
		await sleep(350);
		await page.screenshot({ path: `tests/scratch/set-tab-${label}.png` });
	}
	await browser.close();
	console.log("screenshots written to tests/scratch/set-tab-*.png");
} finally {
	try {
		process.kill(server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
}