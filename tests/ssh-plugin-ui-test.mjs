/**
 * ssh 插件 — 浏览器 UI 冒烟测试（零 token、自包含）。
 *
 * 起隔离端口 server（临时 data-dir）+ 内嵌 mock SSH 远端，Chrome headless：
 * - 顶栏 🖥️ 插件 tab → 插件视图挂载
 * - 新建主机弹层 → 主机出现在列表
 * - 点击连接 → 工作区出现 xterm 终端
 * - 文件面板列出远端目录；打开远程文件编辑 + Ctrl+S 保存回远端（磁盘核对）
 * - 断开按钮
 *
 * 运行：先 npm run build:server，再 node tests/ssh-plugin-ui-test.mjs
 */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { portUp } from "./lib/port-utils.mjs";
import { startMockSsh, ensurePluginSsh2Dep } from "./lib/mock-ssh.mjs";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 8965;
const SSH_PORT = 22965;
const URL = `http://localhost:${PORT}`;
const REPO = realpathSync(new globalThis.URL("..", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ""));

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : " — " + extra}`);
	if (!ok) failures++;
}

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-ssh-ui-"));
const plugDst = join(dataDir, "plugins", "ssh");

// 种插件 + 离线依赖
mkdirSync(plugDst, { recursive: true });
cpSync(join(REPO, "dev/plugins/ssh/manifest.json"), join(plugDst, "manifest.json"));
cpSync(join(REPO, "dev/plugins/ssh/index.mjs"), join(plugDst, "index.mjs"));
cpSync(join(REPO, "dev/plugins/ssh/client"), join(plugDst, "client"), { recursive: true });
ensurePluginSsh2Dep(plugDst, join(REPO, "dev/plugins/ssh"));

let server = null;
let sshServer = null;
try {
	sshServer = await startMockSsh(plugDst, SSH_PORT);

	server = spawn(process.execPath, ["dist/server/index.js"], {
		cwd: REPO,
		env: { ...process.env, PORT: String(PORT), PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: REPO },
		stdio: ["ignore", "pipe", "pipe"],
	});
	server.stderr.on("data", () => {});
	for (let i = 0; i < 60 && !(await portUp(PORT)); i++) await sleep(250);
	if (!(await portUp(PORT))) throw new Error("server did not start");

	const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
	const page = await browser.newPage();
	page.on("pageerror", (e) => console.error("[pageerror]", e.message));
	await page.goto(URL);

	// -- 1. 插件 tab 出现并切换 -------------------------------------------------
	await page.waitForSelector("button.plugin-tab", { timeout: 20000 });
	await page.locator("button.plugin-tab", { hasText: "SSH" }).first().click();
	await page.waitForSelector(".sshx", { timeout: 15000 });
	check("插件视图挂载", true);

	// -- 2. 新建主机弹层 ----------------------------------------------------------
	await page.locator('.sshx-side-head button[data-act="add"]').click();
	await page.waitForSelector(".sshx-modal-bg:not(.hidden)", { timeout: 5000 });
	const form = page.locator(".sshx-modal");
	await form.locator('input[name="name"]').fill("mock-host");
	await form.locator('input[name="host"]').fill("127.0.0.1");
	await form.locator('input[name="port"]').fill(String(SSH_PORT));
	await form.locator('input[name="username"]').fill("tester");
	await form.locator('input[name="password"]').fill("secret123");
	await form.locator(".save-host").click();
	await page.waitForSelector(".sshx-hrow", { timeout: 8000 });
	const addr = await page.locator(".sshx-hrow .addr").innerText();
	check("主机保存后出现在列表", addr.includes("tester@127.0.0.1"), addr);

	// -- 3. 点击连接 → 终端工作区 ---------------------------------------------------
	await page.locator(".sshx-hrow").first().click();
	await page.waitForSelector(".sshx-term-wrap .xterm", { timeout: 25000 });
	check("连接成功且 xterm 终端渲染", true);
	const lbl = await page.locator(".sshx-topbar .lbl").innerText();
	check("顶栏显示主机名", lbl === "mock-host", lbl);

	// 敲一条命令进终端（输出渲染在 canvas 里不直接断言文本，只确保无报错状态条）
	await page.locator(".xterm-helper-textarea").fill("");
	await page.locator(".sshx-term-wrap").click();
	await page.keyboard.type("ui-smoke");
	await page.keyboard.press("Enter");
	await sleep(600);
	const errText = await page.locator(".sshx-err").innerText();
	check("终端输入后无错误提示", !errText, errText);

	// -- 4. 文件面板 ------------------------------------------------------------------
	await page.locator('.sshx-topbar .tab[data-tab="files"]').click();
	await sleep(800);
	const names = await page.locator(".sshx-ftable td:first-child").allInnerTexts();
	check("文件列表显示远端目录", names.some((n) => n.includes("a.txt")) && names.some((n) => n.includes("sub")), names.join(","));

	// 打开远程文件编辑器
	await page.locator(".sshx-ftable tr.frow", { hasText: "a.txt" }).first().click();
	await page.waitForSelector(".sshx-editor:not(.hidden)", { timeout: 8000 });
	const content = await page.locator(".sshx-editor textarea").inputValue();
	check("编辑器加载远端文件内容", content.includes("hello ssh"), JSON.stringify(content.slice(0, 40)));

	// 修改 + Ctrl+S 保存 → 远端内存 FS 核对
	await page.locator(".sshx-editor textarea").fill("hello ssh\n第二行\nui-edited-line\n");
	await page.keyboard.press("Control+s");
	await sleep(800);
	const st = await page.locator(".sshx-ed-head .st").innerText();
	check("保存后状态恢复干净", !st.includes("未保存"), st);
	const savedOnRemote = await import("./lib/mock-ssh.mjs").then((m) => m.files["/home/test/a.txt"]?.toString());
	check("修改已写回 mock 远端", savedOnRemote?.includes("ui-edited-line"), JSON.stringify(savedOnRemote));

	// 关闭编辑器（已保存，不应弹确认框）
	let dialogFired = false;
	page.on("dialog", (d) => { dialogFired = true; void d.dismiss(); });
	await page.locator(".sshx-ed-head .close").click();
	await sleep(300);
	check("已保存关闭不弹确认框", !dialogFired);

	// -- 5. 断开 ------------------------------------------------------------------------
	await page.locator(".disconnect").click();
	await sleep(1000);
	const phVisible = await page.locator(".sshx-placeholder").isVisible().catch(() => false);
	check("断开后回到占位视图", phVisible);

	await browser.close();
} catch (err) {
	failures++;
	console.error("test error:", err);
} finally {
	try {
		sshServer?.close();
		server?.kill("SIGTERM");
	} catch {}
	await sleep(400);
	rmSync(dataDir, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
