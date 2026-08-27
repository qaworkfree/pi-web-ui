#!/usr/bin/env node
/**
 * pi-web-ui CLI.
 *
 *   pi-web-ui                              启动生产服务器（前台，Ctrl+C 停止，自动打开浏览器）
 *   pi-web-ui --port 9000 --cwd /path      同上，覆盖端口 / 工作目录 / 数据目录
 *   pi-web-ui --no-browser                 启动但不自动打开浏览器
 *   pi-web-ui --version | --help
 *   pi-web-ui server install [选项]         安装系统服务（开机自启）并启动
 *   pi-web-ui server shortcut [选项]        在桌面创建「一键启动」图标（启动服务并打开浏览器）
 *   pi-web-ui server uninstall [选项]       卸载系统服务（同时移除桌面图标）
 *   pi-web-ui server start|stop|restart|status [选项]
 *   pi-web-ui install <源> [选项]           安装 GitHub 上的界面插件（见下方「界面插件」）
 *   pi-web-ui plugins / uninstall <id>      列出 / 卸载界面插件
 *
 * 系统服务：
 *   - macOS   → launchd 用户代理，label 默认 com.xingshuyin.pi-web-ui
 *              （--name 自定义时 com.<name>.server），无需 sudo
 *   - Linux   → systemd 单元 <name>.service（/etc/systemd/system/，自动 sudo）
 *   - Windows → 计划任务（Task Scheduler / schtasks，登录后自启，无需管理员），
 *              隐藏窗口启动（无黑窗）；PowerShell 启动脚本与任务 XML 生成在
 *              %APPDATA%\pi-web-ui\
 *
 * 环境变量（前台与系统服务均适用）：PORT / PI_WEB_CWD / PI_WEB_DATA_DIR /
 * PI_CODING_AGENT_DIR。
 */
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { get as httpGet } from "node:http";
import {
	ensureBackup as ensurePluginBackup,
	restoreBackup as restorePluginBackup,
	checkPluginUpdates,
	resolveRemoteSha,
} from "../dist/server/plugin-updater.js";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const BIN_DIR = dirname(fileURLToPath(import.meta.url));
/** <pkg>/dist/server/index.js — the actual server entry. */
const SERVER_ENTRY = join(BIN_DIR, "..", "dist", "server", "index.js");
const NODE = process.execPath;
let pkg = { version: "0.0.0" };
try {
	pkg = JSON.parse(readFileSync(join(BIN_DIR, "..", "package.json"), "utf8"));
} catch {
	// version is best-effort — the server itself doesn't need it
}

const HELP = `pi-web-ui v${pkg.version} — web chat for the pi coding agent

用法:
  pi-web-ui                               启动服务器（前台，Ctrl+C 停止，自动打开浏览器）
  pi-web-ui --port 9000 --cwd /path       启动并指定端口 / 工作目录 / 数据目录
  pi-web-ui --no-browser                  启动但不自动打开浏览器
  pi-web-ui server install [选项]         安装系统服务（开机自启）并启动
  pi-web-ui server shortcut [选项]        在桌面创建「一键启动」图标（启动服务并打开浏览器）
  pi-web-ui server uninstall [选项]       卸载系统服务（同时移除桌面图标）
  pi-web-ui server start|stop|restart|status [选项]
  pi-web-ui server quiesce [选项]          进入排空模式：拒绝新的对话/消息/编辑，存量运行继续跑完
  pi-web-ui server unquiesce [选项]        解除排空模式，恢复接收新工作
  pi-web-ui --version / --help

server 选项:
  --port <n>        端口（默认 8787，或 $PORT）
  --cwd <dir>       工作目录（默认 $PI_WEB_CWD 或当前目录）
  --data-dir <dir>  会话数据目录（默认 <cwd>/.pi-web）
  --name <name>     服务名（默认 pi-web-ui；macOS 的 launchd label
                    为 com.xingshuyin.pi-web-ui，自定义名时为 com.<name>.server）
  --print           只打印将生成的配置文件，不实际安装

平台: macOS → launchd 用户代理 · Linux → systemd · Windows → 计划任务（schtasks）
      （Windows 任务登录后自启、无需管理员、隐藏窗口运行；stop 停止，uninstall 移除）
快捷方式: Windows → 桌面 .lnk · macOS → 桌面 .command 启动器 · Linux → 桌面 .desktop 图标

界面插件（安装到 <data-dir>/plugins/，服务运行中刷新浏览器即生效）:
  pi-web-ui install <源>            从 GitHub 安装界面插件
  pi-web-ui uninstall <id>          卸载已安装的界面插件
  pi-web-ui plugins                 列出已安装的界面插件

  源写法: owner/repo · https://github.com/owner/repo · 本地目录路径
          URL 带 /tree/<分支>/<子目录> 可指定分支与仓库内子目录；任意写法
          末尾加 #<分支或tag> 也可指定分支（如 owner/repo#v1.2）
  install 选项: --name <id> 自定义插件目录名（默认取仓库名）
                --data-dir <dir> 数据目录（默认 ~/.pi-web）
                --force 目标已存在时覆盖

环境变量（前台与系统服务均适用）:
  PORT / PI_WEB_CWD / PI_WEB_DATA_DIR / PI_CODING_AGENT_DIR
`;

/** Minimum Node required by the pi SDK (its dist uses `import … with { type: "json" }`). */
const NODE_MIN = [22, 19, 0];
function checkNodeVersion() {
	const v = process.versions.node.split(".").map(Number);
	const tooOld =
		v[0] < NODE_MIN[0] ||
		(v[0] === NODE_MIN[0] && v[1] < NODE_MIN[1]) ||
		(v[0] === NODE_MIN[0] && v[1] === NODE_MIN[1] && v[2] < NODE_MIN[2]);
	if (tooOld) {
		console.error(
			`✖ pi-web-ui 需要 Node.js >= ${NODE_MIN.join(".")}（当前 ${process.versions.node}）。\n` +
				`  pi SDK 的代码使用了 import attributes（with）语法，旧版 Node 无法解析。\n` +
				`  请升级 Node：https://nodejs.org（或 nvm-windows / fnm）后重装：npm i -g pi-web-ui`,
		);
		process.exit(1);
	}
}

function fail(msg) {
	console.error(`✖ ${msg}`);
	process.exit(1);
}

/** Run a command, inheriting stdio; exits on failure unless ignoreError. */
function run(cmd, args, { ignoreError = false, silent = false } = {}) {
	const res = spawnSync(cmd, args, {
		stdio: silent ? ["inherit", "ignore", "ignore"] : "inherit",
	});
	if (!ignoreError && res.status !== 0) process.exit(res.status ?? 1);
	return res;
}

/** Parse --flag value / --flag=value options; returns { opts, positionals }. */
function parseFlags(argv) {
	const opts = {
		port: undefined,
		cwd: undefined,
		dataDir: undefined,
		name: undefined,
		print: false,
		noBrowser: false,
		force: false,
		checkUpdates: false,
		rollback: undefined,
		help: false,
	};
	const positionals = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const eq = a.indexOf("=");
		const key = eq >= 0 ? a.slice(0, eq) : a;
		const inline = eq >= 0 ? a.slice(eq + 1) : undefined;
		const take = (flag) => {
			if (inline !== undefined) return inline;
			if (i + 1 < argv.length) {
				i++;
				return argv[i];
			}
			fail(`缺少选项 ${flag} 的值`);
		};
		switch (key) {
			case "--port":
				opts.port = take("--port");
				break;
			case "--cwd":
				opts.cwd = take("--cwd");
				break;
			case "--data-dir":
				opts.dataDir = take("--data-dir");
				break;
			case "--name":
				opts.name = take("--name");
				break;
			case "--print":
				opts.print = true;
				break;
			case "--no-browser":
				opts.noBrowser = true;
				break;
			case "--force":
				opts.force = true;
				break;
			case "--check-updates":
				opts.checkUpdates = true;
				break;
			case "--rollback":
				opts.rollback = take("--rollback");
				break;
			case "--help":
			case "-h":
				opts.help = true;
				break;
			default:
				if (key.startsWith("-")) fail(`未知选项: ${key}`);
				positionals.push(a);
		}
	}
	return { opts, positionals };
}

// ---------------------------------------------------------------------------
// 前台启动
// ---------------------------------------------------------------------------

/** Open a URL in the OS default browser; failures are ignored (best-effort). */
function openBrowser(url) {
	let res;
	if (isMac) {
		res = spawnSync("open", [url], { stdio: "ignore" });
	} else if (isWin) {
		res = spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
	} else {
		res = spawnSync("xdg-open", [url], { stdio: "ignore" });
	}
	// spawnSync 不抛异常：命令缺失（headless 服务器）时在返回对象里带 error 字段。
	if (res?.error) {
		if (res.error.code === "ENOENT") {
			console.warn(
				`[browser] 未找到打开器 (${res.error.path || "command not found"})，` +
					"headless 服务器可用 --no-browser 关闭自动打开"
			);
		} else {
			console.warn("[browser] 打开浏览器失败:", res.error.message);
		}
	}
}

/**
 * Poll `url` until the server answers (or ~15s pass), then open it in the
 * default browser. The foreground server runs in this process, so the first
 * HTTP response is the "listening" signal; if the server crashes meanwhile
 * (e.g. port already taken), the pending timers die with the process and
 * nothing is opened.
 */
function openBrowserWhenUp(url) {
	const deadline = Date.now() + 15_000;
	const attempt = () => {
		const req = httpGet(url, (res) => {
			res.resume();
			console.log(`  🌐 已自动打开浏览器：${url}（--no-browser 可关闭）`);
			openBrowser(url);
		});
		req.setTimeout(1000, () => {
			req.destroy();
			if (Date.now() < deadline) setTimeout(attempt, 150);
		});
		req.on("error", () => {
			if (Date.now() < deadline) setTimeout(attempt, 150);
		});
	};
	attempt();
}

async function startForeground(opts) {
	if (opts.port) process.env.PORT = opts.port;
	if (opts.cwd) process.env.PI_WEB_CWD = resolve(opts.cwd);
	if (opts.dataDir) process.env.PI_WEB_DATA_DIR = resolve(opts.dataDir);
	const url = `http://localhost:${String(
		opts.port ?? process.env.PORT ?? "8787",
	)}`;
	await import(pathToFileURL(SERVER_ENTRY).href);
	if (!opts.noBrowser) openBrowserWhenUp(url);
}

// ---------------------------------------------------------------------------
// 系统服务管理
// ---------------------------------------------------------------------------

const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";
const isWin = process.platform === "win32";

function uid() {
	try {
		return userInfo().uid;
	} catch {
		return process.getuid?.() ?? 501;
	}
}

/** launchd label / systemd unit name / Windows task name for a service name. */
function serviceLabel(name) {
	if (isMac) {
		return name === "pi-web-ui"
			? "com.xingshuyin.pi-web-ui"
			: `com.${name}.server`;
	}
	return name;
}

function launchAgentPlist(name) {
	return join(
		homedir(),
		"Library",
		"LaunchAgents",
		`${serviceLabel(name)}.plist`,
	);
}

function systemdUnitPath(name) {
	return `/etc/systemd/system/${name}.service`;
}

/** Windows: per-user config dir (%APPDATA%\pi-web-ui) holding the .cmd wrapper + task XML. */
function winServiceDir() {
	return join(
		process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
		"pi-web-ui",
	);
}

function winCmdPath(name) {
	return join(winServiceDir(), `${name}.cmd`);
}

function winPs1Path(name) {
	return join(winServiceDir(), `${name}.ps1`);
}

function winTaskXmlPath(name) {
	return join(winServiceDir(), `${name}.xml`);
}

function winLogPath() {
	return join(homedir(), "pi-web-ui.log");
}

/** True when a scheduled task with this name exists (schtasks exits 0). */
function winTaskExists(name) {
	return (
		spawnSync("schtasks", ["/Query", "/TN", name], { stdio: "ignore" })
			.status === 0
	);
}

// ---------------------------------------------------------------------------
// 桌面快捷方式（server shortcut）
// ---------------------------------------------------------------------------

const SHORTCUT_LNK_NAME = "pi-web-ui.lnk"; // Windows 桌面快捷方式
const SHORTCUT_MAC_NAME = "pi-web-ui.command"; // macOS 双击启动器
const SHORTCUT_LINUX_NAME = "pi-web-ui.desktop"; // Linux 桌面图标

/** 快捷方式图标（品牌 .ico，随包发布；.lnk / .desktop 指向它）。 */
const APP_ICO_NAME = "pi-web-ui-logo.ico"; // 复制到用户目录后的稳定文件名（避开 pi-web-ui.ico —— Windows 对该路径有损坏的图标缓存残留，见 issue #xxx）
const APP_ICO_SOURCE = join(BIN_DIR, "..", "web", "public", "icon.ico"); // 包内品牌图标源文件（10 帧多分辨率，DPI 密度帧保证桌面/任务栏各尺寸颜色不失真）
/** Branded SVG logo (source of truth: web/public/favicon.svg) — used on Linux. */
const APP_SVG_PACKAGE = join(BIN_DIR, "..", "web", "public", "favicon.svg");

/** Windows: per-user copy of the branded .ico (stable path for the .lnk icon). */
function winIcoPath() {
	return join(winServiceDir(), APP_ICO_NAME);
}

/** Full path to Windows PowerShell 5.1. */
function winPowershell() {
	return join(
		process.env.SystemRoot ?? "C:\\Windows",
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	);
}


/** Full path to wscript.exe — a console-free host (no conhost window, so no black
 * console box ever appears in the taskbar on double-click). Used as the .lnk target;
 * it launches the .ps1 hidden via a thin VBS launcher. */
function winWscript() {
	return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe");
}

/**
 * Resolve the real node binary. fnm/volta/nvm shims (e.g. fnm_multishells)
 * point into temp dirs that vanish when the installing shell exits — the
 * baked-in launcher scripts must use the stable real path instead.
 */
function realNode() {
	try {
		return realpathSync(process.execPath);
	} catch {
		return process.execPath;
	}
}

/** Windows: launcher ps1 the desktop .lnk runs (hidden). */
function winShortcutPs1Path(name) {
	return join(winServiceDir(), `${name}-shortcut.ps1`);
}


/** Windows: launcher vbs the desktop .lnk actually runs (wscript.exe, console-free). */
function winShortcutVbsPath(name) {
	return join(winServiceDir(), `${name}-shortcut.vbs`);
}

/** Windows: PID file of a shortcut-started (no scheduled task) instance. */
function winPidFilePath(name) {
	return join(winServiceDir(), `${name}.pid`);
}

/** Read the recorded PID of a shortcut-started Windows instance. */
function winReadPid(name) {
	try {
		const pid = Number(readFileSync(winPidFilePath(name), "utf8").trim());
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

/** True when a PID exists (signal 0; EPERM means exists but not ours). */
function pidAlive(pid) {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === "EPERM";
	}
}

/** Single-quote a string for embedding in a POSIX shell script. */
function shQuote(s) {
	return "'" + s.replace(/'/g, `'\\''`) + "'";
}

/**
 * Windows shortcut launcher. Double-click the .lnk → this script runs hidden:
 * server already up → just open the browser; scheduled task installed → start
 * it (manageable via `server stop`); otherwise run the server in the foreground
 * of this hidden window and record its PID so `server stop` / `server
 * uninstall` can terminate it too.
 */
function buildWinShortcutPs1(env, cwd, taskName, url, logPath, pidPath) {
	const sets = Object.entries(env)
		.map(([k, v]) => `$env:${k} = ${psQuote(v)}`)
		.join("\r\n");
	const node = realNode();
	return [
		"# Generated by: pi-web-ui server shortcut (rerun to change)",
		"# Runs hidden from the desktop shortcut: if the server is already up it",
		"# opens the browser; a scheduled task (if installed) is used; otherwise",
		"# the server runs in the foreground of this hidden window and its PID is",
		"# recorded so `server stop` / `server uninstall` can terminate it.",
		"$ErrorActionPreference = 'Continue'",
		`$url = ${psQuote(url)}`,
		`$health = ${psQuote(url + "/api/health")}`,
		`$taskName = ${psQuote(taskName)}`,
		`$pidFile = ${psQuote(pidPath)}`,
		`$log = ${psQuote(logPath)}`,
		"",
		"function Test-Up {",
		"  try { return (Invoke-WebRequest -Uri $health -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { return $false }",
		"}",
		"function Open-Browser { Start-Process $url | Out-Null }",
		"",
		"# 已在运行 → 直接打开浏览器",
		"if (Test-Up) { Open-Browser; exit 0 }",
		"",
		"# 已安装计划任务 → 走服务启动（server stop 可管理）",
		"if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {",
		"  schtasks /Run /TN $taskName | Out-Null",
		"  for ($i = 0; $i -lt 120; $i++) {",
		"    Start-Sleep -Milliseconds 250",
		"    if (Test-Up) { Open-Browser; exit 0 }",
		"  }",
		"  Write-Host ('✖ pi-web-ui 服务未在 30 秒内就绪，请查看日志: ' + $log)",
		"  exit 1",
		"}",
		"",
		"# 未安装服务 → 在本隐藏窗口中前台运行（记录 PID，server stop 可停止）",
		`$PID | Out-File -Encoding ascii $pidFile`,
		sets,
		`Set-Location ${psQuote(cwd)}`,
		"# 后台轮询，就绪后打开浏览器（与前台 node 并行）",
		"$job = Start-Job -ScriptBlock { param($u)",
		"  $h = $u + '/api/health'",
		"  for ($i = 0; $i -lt 120; $i++) {",
		"    Start-Sleep -Milliseconds 250",
		"    try { if ((Invoke-WebRequest -Uri $h -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { Start-Process $u | Out-Null; break } } catch {}",
		"  }",
		"} -ArgumentList $url",
		`& ${psQuote(node)} ${psQuote(SERVER_ENTRY)} *>> $log`,
		"Remove-Item $pidFile -ErrorAction SilentlyContinue",
		"",
	].join("\r\n");
}


/**
 * Build the tiny VBS launcher the desktop .lnk invokes. Its purpose is purely to
 * start the .ps1 *without* creating any console host: wscript.exe has no console,
 * and WScript.Shell.Run(…, 0, False) launches the child hidden and returns at once
 * (0 = hidden window, False = don't wait). Result: double-clicking the icon never
 * flashes a black box and no leftover console appears in the taskbar.
 */
function buildWinShortcutVbs(ps1Path) {
	const cmd = `${winPowershell()} -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ps1Path}"`;
	// VBScript 字符串没有 \" 转义（也没有 \uXXXX），内嵌引号必须写成 ""；
	// 不能用 JSON.stringify —— 它输出 \" 会在 VBScript 里提前结束字符串（语句未结束 800A0401），
	// 且会把非 ASCII 路径转成 \uXXXX 字面量（wscript 不识别，中文用户名直接变成乱码路径）。
	const vbsCmd = cmd.replace(/"/g, '""');
	return [
		"Option Explicit",
		"Dim sh, cmd",
		"Set sh = CreateObject(\"WScript.Shell\")",
		`cmd = "${vbsCmd}"`,
		"sh.Run cmd, 0, False",
		"Set sh = Nothing",
		"",
	].join("\r\n");
}

/**
 * Create the Windows desktop .lnk via WScript.Shell COM (correct Desktop path
 * even with OneDrive redirection). Target is powershell.exe with
 * -WindowStyle Hidden so nothing flashes on double-click.
 */
function installWinShortcut(opts) {
	const { name, port, cwd, dataDir } = serviceOptions(opts);
	const env = serviceEnv(port, cwd, dataDir);
	const url = `http://localhost:${port}`;
	const ps1Path = winShortcutPs1Path(name);
	const ps1 = buildWinShortcutPs1(
		env,
		cwd,
		name,
		url,
		winLogPath(),
		winPidFilePath(name),
	);
	if (opts.print) {
		console.log(`# ${ps1Path}\n${ps1}`);
		return;
	}
	mkdirSync(dirname(ps1Path), { recursive: true });
	writeFileSync(ps1Path, "\uFEFF" + ps1, "utf8"); // PS 5.1 需要 BOM
	// wscript host + VBS launcher: no console window / taskbar black box on double-click.
	const vbsPath = winShortcutVbsPath(name);
	writeFileSync(vbsPath, "\uFEFF" + buildWinShortcutVbs(ps1Path), "utf16le"); // wscript 只认 UTF-16/ANSI，UTF-8 BOM 会报“无效字符”，中文路径用 utf16le + BOM
	// 把品牌图标准备好：复制到用户目录（.lnk 图标指向稳定路径）
	if (existsSync(APP_ICO_SOURCE)) {
		copyFileSync(APP_ICO_SOURCE, winIcoPath());
	} else {
		console.log(`⚠ 未找到品牌图标 ${APP_ICO_SOURCE}，快捷方式将使用默认图标`);
	}
	const powershell = winPowershell();
	const ps = [
		"$ErrorActionPreference = 'Stop'",
		"$ws = New-Object -ComObject WScript.Shell",
		"$desktop = [Environment]::GetFolderPath('Desktop')",
		`$lnk = $ws.CreateShortcut((Join-Path $desktop ${psQuote(SHORTCUT_LNK_NAME)}))`,
		`$lnk.TargetPath = ${psQuote(winWscript())}`,
		`$lnk.Arguments = ${psQuote(vbsPath)}`,
		`$lnk.WorkingDirectory = ${psQuote(cwd)}`,
		"$lnk.Description = 'pi-web-ui — 双击启动服务并打开浏览器'",
		`$lnk.IconLocation = ${psQuote(winIcoPath())} + ',0'`,
		"$lnk.Save()",
		`Write-Output (Join-Path $desktop ${psQuote(SHORTCUT_LNK_NAME)})`,
	].join("\r\n");
	const res = spawnSync(
		powershell,
		[
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			ps,
		],
		{ encoding: "utf8" },
	);
	if (res.status !== 0) {
		fail(`创建桌面快捷方式失败: ${(res.stderr || res.stdout || "").trim()}`);
	}
	const lnk = (res.stdout ?? "").trim();
	console.log(`✅ 已创建桌面快捷方式: ${lnk}`);
	console.log(`   双击 : 服务未运行则启动（隐藏窗口，无黑窗），就绪后自动打开浏览器`);
	console.log(`   停止 : pi-web-ui server stop（快捷方式启动的实例也会一并停止）`);
	console.log(`   端口 : ${port}`);
	console.log(`   目录 : ${cwd}`);
}

/** macOS: double-clickable .command launcher (the .lnk equivalent). */
function buildMacShortcut(label, plist, url, env) {
	const exports = Object.entries(env)
		.map(([k, v]) => `export ${k}=${shQuote(v)}`)
		.join("\n");
	const node = realNode();
	return `#!/bin/bash
# pi-web-ui 启动器 — generated by: pi-web-ui server shortcut
# 双击运行：确保服务在运行，然后打开浏览器。
#   · 已安装 launchd 服务（登录自启）→ kickstart，图标主要用于「启动 + 打开」
#   · 未安装服务 → 在本终端前台运行（关闭窗口即停止）
LABEL=${shQuote(label)}
PLIST=${shQuote(plist)}
URL=${shQuote(url)}
LOG=/tmp/pi-web-ui-shortcut.log
NODE=${shQuote(node)}
ENTRY=${shQuote(SERVER_ENTRY)}
${exports}

if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  launchctl kickstart "gui/$(id -u)/$LABEL"
elif [ -f "$PLIST" ]; then
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
else
  # 未安装服务：在本终端前台运行服务器（关闭窗口即停止）
  "$NODE" "$ENTRY" >>"$LOG" 2>&1 &
  SERVER_PID=$!
  trap 'kill "$SERVER_PID" 2>/dev/null' EXIT
fi

# 等服务就绪后打开浏览器（最多约 30 秒）
for i in $(seq 1 120); do
  curl -sf "$URL/api/health" >/dev/null 2>&1 && break
  sleep 0.25
done
open "$URL"
if [ -n "\${SERVER_PID:-}" ]; then wait "$SERVER_PID"; fi
`;
}

function installMacShortcut(opts) {
	const { name, port, cwd, dataDir } = serviceOptions(opts);
	const url = `http://localhost:${port}`;
	const script = buildMacShortcut(
		serviceLabel(name),
		launchAgentPlist(name),
		url,
		serviceEnv(port, cwd, dataDir),
	);
	const path = join(homedir(), "Desktop", SHORTCUT_MAC_NAME);
	if (opts.print) {
		console.log(`# ${path}\n${script}`);
		return;
	}
	writeFileSync(path, script);
	chmodSync(path, 0o755);
	console.log(`✅ 已创建桌面启动器: ${path}`);
	console.log(`   双击 : 确保服务运行并打开浏览器；未安装服务时在本终端前台运行`);
	console.log(`   说明 : macOS 没有 Windows 式快捷方式，这是等价的 .command 启动器；`);
	console.log(`          launchd 服务登录自启，图标主要用于快速「启动 + 打开浏览器」`);
	console.log(`   端口 : ${port}`);
	console.log(`   目录 : ${cwd}`);
}

/** Linux: launcher script run by the .desktop icon. */
function buildLinuxStartScript(unitName, url) {
	const log = join(homedir(), ".local", "share", "pi-web-ui", "pi-web-ui.log");
	const node = realNode();
	return `#!/bin/bash
# pi-web-ui 启动器 — generated by: pi-web-ui server shortcut
# 双击运行：确保服务在运行，然后打开浏览器。
#   · systemd 单元已安装 → systemctl start（系统单元需要授权，失败则前台运行）
#   · 未安装 → 在本进程前台运行（终端关闭即停止）
LOG=${shQuote(log)}
URL=${shQuote(url)}
NODE=${shQuote(node)}
ENTRY=${shQuote(SERVER_ENTRY)}
UNIT=${shQuote(unitName)}.service

if ! curl -sf "$URL/api/health" >/dev/null 2>&1; then
  systemctl start "$UNIT" 2>/dev/null || true
  if ! curl -sf "$URL/api/health" >/dev/null 2>&1; then
    mkdir -p "$(dirname "$LOG")"
    "$NODE" "$ENTRY" >>"$LOG" 2>&1 &
    SERVER_PID=$!
    trap 'kill "$SERVER_PID" 2>/dev/null' EXIT
  fi
fi

for i in $(seq 1 120); do
  curl -sf "$URL/api/health" >/dev/null 2>&1 && break
  sleep 0.25
done
xdg-open "$URL" >/dev/null 2>&1 &
if [ -n "\${SERVER_PID:-}" ]; then wait "$SERVER_PID"; fi
`;
}

function installLinuxShortcut(opts) {
	const { name, port, cwd, dataDir } = serviceOptions(opts);
	const url = `http://localhost:${port}`;
	const scriptDir = join(homedir(), ".local", "share", "pi-web-ui");
	const scriptPath = join(scriptDir, `${name}-start.sh`);
	const desktopPath = join(homedir(), "Desktop", SHORTCUT_LINUX_NAME);
	const icoPath = join(scriptDir, APP_ICO_NAME); // 备用；优先 SVG
	const svgPath = join(scriptDir, "pi-web-ui.svg");
	const script = buildLinuxStartScript(name, url);
	const desktopIcon = existsSync(APP_SVG_PACKAGE) ? svgPath : APP_ICO_NAME;
	const desktop = `[Desktop Entry]
Version=1.0
Type=Application
Name=pi-web-ui
Comment=启动 pi-web-ui 服务并打开浏览器
Exec=${shQuote(scriptPath)}
Icon=${shQuote(desktopIcon)}
Terminal=false
Categories=Network;WebBrowser;
`;
	if (opts.print) {
		console.log(`# ${scriptPath}\n${script}`);
		console.log(`# ${desktopPath}\n${desktop}`);
		return;
	}
	mkdirSync(scriptDir, { recursive: true });
	// 品牌图标（缺失时跳过，桌面自动回退默认图标）
	if (existsSync(APP_SVG_PACKAGE)) copyFileSync(APP_SVG_PACKAGE, svgPath);
	else if (existsSync(APP_ICO_SOURCE)) copyFileSync(APP_ICO_SOURCE, icoPath);
	writeFileSync(scriptPath, script);
	chmodSync(scriptPath, 0o755);
	writeFileSync(desktopPath, desktop);
	chmodSync(desktopPath, 0o755);
	// GNOME 需要标记可信才能双击运行
	run("gio", ["set", desktopPath, "metadata::trusted", "true"], {
		ignoreError: true,
		silent: true,
	});
	console.log(`✅ 已创建桌面图标: ${desktopPath}`);
	console.log(`   GNOME 若提示「不受信任的应用程序」，右键选择 Allow Launching`);
	console.log(`   端口 : ${port}`);
	console.log(`   目录 : ${cwd}`);
}

/** Remove desktop shortcut artifacts created by `server shortcut`. */
function removeShortcut(name) {
	if (isWin) {
		for (const f of [winShortcutPs1Path(name), winShortcutVbsPath(name), winPidFilePath(name), winIcoPath()]) {
			if (existsSync(f)) rmSync(f);
		}
		spawnSync(
			winPowershell(),
			[
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				`$d=[Environment]::GetFolderPath('Desktop');$p=Join-Path $d ${psQuote(SHORTCUT_LNK_NAME)};if(Test-Path $p){Remove-Item $p -Force}`,
			],
			{ stdio: "ignore" },
		);
	} else if (isMac) {
		const p = join(homedir(), "Desktop", SHORTCUT_MAC_NAME);
		if (existsSync(p)) rmSync(p);
	} else if (isLinux) {
		const p = join(homedir(), "Desktop", SHORTCUT_LINUX_NAME);
		if (existsSync(p)) rmSync(p);
		rmSync(join(homedir(), ".local", "share", "pi-web-ui"), {
			recursive: true,
			force: true,
		});
	}
}

/** Single-quote a string for embedding in a generated PowerShell script. */
function psQuote(s) {
	return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * Build the PowerShell launcher the scheduled task runs. Task Scheduler
 * launches it with -WindowStyle Hidden, so the console window is created
 * hidden (SW_HIDE) — no black cmd window stays open while the server runs,
 * and there is nothing to accidentally close/kill. The script sets the env,
 * cd's to the workspace, then runs node in the foreground with output
 * appended to the log, so the task instance IS the powershell process and
 * `schtasks /End` still stops the whole tree.
 */
function buildWinStartPs1(env, cwd, logPath) {
	const sets = Object.entries(env)
		.map(([k, v]) => `$env:${k} = ${psQuote(v)}`)
		.join("\r\n");
	return [
		"# Generated by: pi-web-ui server install (rerun to change)",
		"# Starts the server with a hidden console window (no black cmd box).",
		sets,
		`Set-Location ${psQuote(cwd)}`,
		`& ${psQuote(NODE)} ${psQuote(SERVER_ENTRY)} *>> ${psQuote(logPath)}`,
		"",
	].join("\r\n");
}

/**
 * Build the Task Scheduler XML for a user task: LogonTrigger (starts at logon,
 * like a launchd agent — no admin needed), InteractiveToken, auto-restart on
 * failure. The task runs the PowerShell launcher via
 * powershell.exe -WindowStyle Hidden, so no console window ever appears.
 */
function buildWinTaskXml(ps1Path, cwd) {
	const powershell = winPowershell();
	return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>pi-web-ui — web chat for the pi coding agent (auto-start at logon)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${esc(powershell)}</Command>
      <Arguments>-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${esc(ps1Path)}"</Arguments>
      <WorkingDirectory>${esc(cwd)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function esc(s) {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Build the launchd plist XML. */
function buildPlist(label, cwd, env) {
	const entries = Object.entries(env)
		.map(([k, v]) => `    <key>${esc(k)}</key>\n    <string>${esc(v)}</string>`)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by: pi-web-ui server install (do not edit by hand — rerun to change) -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(label)}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${esc(NODE)}</string>
    <string>${esc(SERVER_ENTRY)}</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <!-- Restart if it crashes -->
  <key>KeepAlive</key>
  <true/>

  <key>WorkingDirectory</key>
  <string>${esc(cwd)}</string>

  <key>EnvironmentVariables</key>
  <dict>
${entries}
  </dict>

  <key>StandardOutPath</key>
  <string>/tmp/pi-web-ui.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/pi-web-ui.err</string>
</dict>
</plist>
`;
}

/** Build the systemd unit file. */
function buildUnit(cwd, env) {
	const envLines = Object.entries(env)
		.map(([k, v]) => `Environment=${k}=${v}`)
		.join("\n");
	return `# Generated by: pi-web-ui server install (do not edit by hand — rerun to change)
[Unit]
Description=pi-web-ui — web chat for the pi coding agent
After=network.target

[Service]
Type=simple
User=${process.env.SUDO_USER ?? userInfo().username}
WorkingDirectory=${cwd}
${envLines}
ExecStart=${JSON.stringify(NODE)} ${JSON.stringify(SERVER_ENTRY)}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

/** If not root on Linux, re-exec the same server command through sudo. */
function ensureRootForSystemctl() {
	if (typeof process.getuid === "function" && process.getuid() === 0) return;
	// process.argv = [node, <bin>, "server", <action>, ...rest] — forward
	// everything after "server" so flags like --port/--cwd survive.
	const res = spawnSync(
		"sudo",
		[NODE, fileURLToPath(import.meta.url), "server", ...process.argv.slice(3)],
		{ stdio: "inherit" },
	);
	process.exit(res.status ?? 1);
}

/** Shared option normalization for install. */
function serviceOptions(opts) {
	const name = opts.name ?? "pi-web-ui";
	const port = String(opts.port ?? process.env.PORT ?? "8787");
	if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
		fail(`无效端口: ${port}`);
	}
	const cwd = resolve(opts.cwd ?? process.env.PI_WEB_CWD ?? process.cwd());
	if (!existsSync(cwd)) fail(`工作目录不存在: ${cwd}`);
	let dataDir;
	if (opts.dataDir) {
		dataDir = resolve(opts.dataDir);
	} else if (process.env.PI_WEB_DATA_DIR) {
		dataDir = resolve(process.env.PI_WEB_DATA_DIR);
	}
	return { name, port, cwd, dataDir };
}

function serviceEnv(port, cwd, dataDir) {
	const env = {
		PORT: port,
		PI_WEB_CWD: cwd,
	};
	// Interactive Windows tasks inherit the user's PATH; only systemd/launchd
	// run with a minimal environment that needs an explicit PATH.
	if (!isWin) env.PATH = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
	// Same for the locale: launchd/systemd drop LANG/LC_ALL, and a C-locale
	// shell garbles multibyte input in the terminal (UTF-8 continuation
	// bytes 0x80–0x9F rendered as C1 control chars). Bake the installing
	// shell's locale into the service env so spawned terminals are UTF-8.
	if (!isWin && process.env.LANG) env.LANG = process.env.LANG;
	if (!isWin && process.env.LC_ALL) env.LC_ALL = process.env.LC_ALL;
	if (dataDir) env.PI_WEB_DATA_DIR = dataDir;
	return env;
}

function installLaunchd(opts) {
	const { name, port, cwd, dataDir } = serviceOptions(opts);
	const label = serviceLabel(name);
	const plist = launchAgentPlist(name);
	const content = buildPlist(label, cwd, serviceEnv(port, cwd, dataDir));
	if (opts.print) {
		console.log(`# ${plist}\n${content}`);
		return;
	}
	// Unload any existing instance (ignore "not loaded"), then (re)install.
	run("launchctl", ["bootout", `gui/${uid()}/${label}`], {
		ignoreError: true,
		silent: true,
	});
	mkdirSync(dirname(plist), { recursive: true });
	writeFileSync(plist, content);
	run("launchctl", ["bootstrap", `gui/${uid()}`, plist]);
	console.log(`✅ 已安装并启动 launchd 服务 ${label}`);
	console.log(`   端口 : ${port}`);
	console.log(`   目录 : ${cwd}`);
	console.log(`   访问 : http://localhost:${port}`);
	console.log(`   日志 : /tmp/pi-web-ui.log  /tmp/pi-web-ui.err`);
	console.log(`   管理 : pi-web-ui server status|restart|stop|uninstall`);
	console.log(`   提示 : pi-web-ui server shortcut 可在桌面创建「一键启动」图标`);
}

function installSystemd(opts) {
	const { name, port, cwd, dataDir } = serviceOptions(opts);
	const content = buildUnit(cwd, serviceEnv(port, cwd, dataDir));
	const unitPath = systemdUnitPath(name);
	if (opts.print) {
		console.log(`# ${unitPath}\n${content}`);
		return;
	}
	ensureRootForSystemctl();
	writeFileSync(unitPath, content);
	run("systemctl", ["daemon-reload"]);
	run("systemctl", ["enable", "--now", `${name}.service`]);
	console.log(`✅ 已安装并启动 systemd 服务 ${name}.service`);
	console.log(`   端口 : ${port}`);
	console.log(`   目录 : ${cwd}`);
	console.log(`   访问 : http://localhost:${port}`);
	console.log(`   日志 : journalctl -u ${name}.service -f`);
	console.log(`   管理 : pi-web-ui server status|restart|stop|uninstall`);
	console.log(`   提示 : pi-web-ui server shortcut 可在桌面创建「一键启动」图标`);
}

function uninstallLaunchd(opts) {
	const name = opts.name ?? "pi-web-ui";
	const label = serviceLabel(name);
	const plist = launchAgentPlist(name);
	run("launchctl", ["bootout", `gui/${uid()}/${label}`], {
		ignoreError: true,
		silent: true,
	});
	if (existsSync(plist)) rmSync(plist);
	removeShortcut(name);
	console.log(`🗑  已卸载 ${label}（plist 已删除，不再开机自启）`);
	console.log(`🗑  已移除桌面快捷方式`);
}

function uninstallSystemd(opts) {
	const name = opts.name ?? "pi-web-ui";
	ensureRootForSystemctl();
	run("systemctl", ["disable", "--now", `${name}.service`], {
		ignoreError: true,
	});
	const unitPath = systemdUnitPath(name);
	if (existsSync(unitPath)) rmSync(unitPath);
	run("systemctl", ["daemon-reload"]);
	removeShortcut(name);
	console.log(`🗑  已卸载 ${name}.service（不再开机自启）`);
	console.log(`🗑  已移除桌面快捷方式`);
}

function installWindows(opts) {
	const { name, port, cwd, dataDir } = serviceOptions(opts);
	const env = serviceEnv(port, cwd, dataDir);
	const ps1Path = winPs1Path(name);
	const xmlPath = winTaskXmlPath(name);
	const ps1 = buildWinStartPs1(env, cwd, winLogPath());
	const xml = buildWinTaskXml(ps1Path, cwd);
	if (opts.print) {
		console.log(`# ${ps1Path}\n${ps1}`);
		console.log(`# ${xmlPath}\n${xml}`);
		return;
	}
	mkdirSync(dirname(ps1Path), { recursive: true });
	// UTF-8 with BOM: Windows PowerShell 5.1 misreads BOM-less UTF-8 as ANSI.
	writeFileSync(ps1Path, "\uFEFF" + ps1, "utf8");
	// Remove the old-style .cmd wrapper from previous installs.
	if (existsSync(winCmdPath(name))) rmSync(winCmdPath(name));
	// schtasks /Create /XML requires a UTF-16 file (with BOM).
	writeFileSync(xmlPath, "\uFEFF" + xml, "utf16le");
	if (winTaskExists(name)) {
		run("schtasks", ["/Delete", "/TN", name, "/F"], {
			ignoreError: true,
			silent: true,
		});
	}
	run("schtasks", ["/Create", "/TN", name, "/XML", xmlPath, "/F"]);
	run("schtasks", ["/Run", "/TN", name], { ignoreError: true });
	console.log(`✅ 已安装并启动计划任务 ${name}（隐藏窗口运行，无黑窗）`);
	console.log(`   端口 : ${port}`);
	console.log(`   目录 : ${cwd}`);
	console.log(`   访问 : http://localhost:${port}`);
	console.log(`   日志 : ${winLogPath()}`);
	console.log(
		`   说明 : 登录后自启（与 launchd 用户代理一致）；stop 停止，uninstall 移除`,
	);
	console.log(`   管理 : pi-web-ui server status|restart|stop|uninstall`);
	console.log(`   提示 : pi-web-ui server shortcut 可在桌面创建「一键启动」图标`);
}

function uninstallWindows(opts) {
	const name = opts.name ?? "pi-web-ui";
	if (winTaskExists(name)) {
		run("schtasks", ["/Delete", "/TN", name, "/F"], { ignoreError: true });
	}
	for (const f of [winCmdPath(name), winPs1Path(name), winTaskXmlPath(name)]) {
		if (existsSync(f)) rmSync(f);
	}
	// 快捷方式启动的隐藏实例
	const pid = winReadPid(name);
	if (pid && pidAlive(pid)) {
		run("taskkill", ["/PID", String(pid), "/T", "/F"], {
			ignoreError: true,
			silent: true,
		});
	}
	removeShortcut(name);
	console.log(`🗑  已卸载 ${name}（计划任务已删除，不再自启）`);
	console.log(`🗑  已移除桌面快捷方式`);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Local control socket (status / quiesce / unquiesce). The server listens on
// a mode-0600 Unix socket (POSIX) or a named pipe (Windows) under its data
// dir; same path rules as server/control-socket.ts so the CLI and server
// always agree without sharing code.
// ---------------------------------------------------------------------------

/** Resolve the control socket path for the given options. */
function controlPath(opts) {
	const dir = opts.dataDir
		? resolve(opts.dataDir)
		: process.env.PI_WEB_DATA_DIR
			? resolve(process.env.PI_WEB_DATA_DIR)
			: join(homedir(), ".pi-web");
	return isWin
		? `\\\\.\\pipe\\pi-web-ui-${String(opts.port ?? process.env.PORT ?? "8787")}`
		: join(dir, "pi-web-ui.sock");
}

/** Send one control command to a RUNNING server; resolves null if unreachable. */
function controlCommand(opts, cmd) {
	const path = controlPath(opts);
	return new Promise((resolvePromise) => {
		const sock = createConnection(path);
		let done = false;
		const finish = (v) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			sock.destroy();
			resolvePromise(v);
		};
		const timer = setTimeout(() => finish(null), 3000);
		let buf = "";
		sock.on("connect", () => sock.write(JSON.stringify({ cmd }) + "\n"));
		sock.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			const nl = buf.indexOf("\n");
			if (nl >= 0) {
				try {
					finish(JSON.parse(buf.slice(0, nl)));
				} catch {
					finish(null);
				}
			}
		});
		sock.on("error", () => finish(null));
		sock.on("close", () => finish(null));
	});
}

/** Append the live server status (via the control socket) to `server status`. */
async function printLiveStatus(opts) {
	const st = await controlCommand(opts, "status");
	if (!st || !st.ok) {
		console.log("   (服务器未运行或控制通道不可达 — 启动后可查 server status 实时信息)");
		return;
	}
	console.log("   --- 实时状态 (control socket) ---");
	console.log(`   版本 : ${st.version} · PID ${st.pid}`);
	console.log(`   目录 : ${st.cwd}`);
	console.log(
		`   排空 : ${st.quiesced ? `是（自 ${new Date(st.quiescedSince).toLocaleString()}）` : "否"}`,
	);
	console.log(
		`   连接 : ${st.connectedClients} 个浏览器 · ${st.activeConversations} 个运行中对话 · ${st.pendingMessages} 条排队消息`,
	);
}

/** `server quiesce|unquiesce` — toggle the admission gate on a RUNNING server. */
async function setQuiesce(opts, on) {
	const st = await controlCommand(opts, on ? "quiesce" : "unquiesce");
	if (!st || !st.ok) {
		fail(`服务器未运行或控制通道不可达（${controlPath(opts)}）`);
	}
	console.log(
		on
			? "⏸  已进入排空模式（quiesce）：拒绝新的对话/消息/编辑，存量运行继续跑完。\n" +
				"    跑完后用 pi-web-ui server unquiesce 恢复。"
			: "▶  已解除排空模式（unquiesce）：恢复接收新的对话/消息/编辑。",
	);
}

function controlService(action, opts) {
	const name = opts.name ?? "pi-web-ui";

	if (isMac) {
		const label = serviceLabel(name);
		const target = `gui/${uid()}/${label}`;
		const loaded = () =>
			spawnSync("launchctl", ["print", target], { stdio: "ignore" }).status ===
			0;

		if (action === "status") {
			if (loaded()) {
				const res = spawnSync("launchctl", ["print", target], {
					encoding: "utf8",
				});
				const state = (res.stdout.match(/state = (\w+)/) ?? [])[1] ?? "loaded";
				console.log(`${label}: ${state}（已加载，开机自启中）`);
			} else {
				console.log(`${label}: 未安装（运行 pi-web-ui server install 安装）`);
			}
			return;
		}

		if (action === "start") {
			if (loaded()) {
				run("launchctl", ["kickstart", target]);
			} else {
				const plist = launchAgentPlist(name);
				if (!existsSync(plist)) {
					fail(`找不到 ${plist}，请先运行 pi-web-ui server install`);
				}
				run("launchctl", ["bootstrap", `gui/${uid()}`, plist]);
			}
			console.log(`✅ 已启动 ${label}`);
			return;
		}

		if (action === "restart") {
			if (!loaded()) fail(`${label} 未加载，请先 pi-web-ui server start`);
			run("launchctl", ["kickstart", "-k", target]);
			console.log(`✅ 已重启 ${label}`);
			return;
		}

		if (action === "stop") {
			run("launchctl", ["bootout", target], {
				ignoreError: true,
				silent: true,
			});
			console.log(`⏹  已停止 ${label}（已卸载，不再开机自启；start 恢复）`);
			return;
		}

		fail(`未知操作: ${action}`);
	}

	if (isLinux) {
		ensureRootForSystemctl();
		if (action === "status") {
			run("systemctl", ["status", `${name}.service`, "--no-pager"]);
			return;
		}
		run("systemctl", [action, `${name}.service`]);
		console.log(`✅ ${action} ${name}.service`);
		return;
	}

	if (isWin) {
		const exists = winTaskExists(name);

		if (action === "status") {
			const pid = winReadPid(name);
			const instAlive = pid && pidAlive(pid);
			if (!exists) {
				console.log(`${name}: 未安装（运行 pi-web-ui server install 安装）`);
				if (instAlive) console.log(`   快捷方式实例 : 运行中 (PID ${pid})`);
				return;
			}
			// Get-ScheduledTask outputs English state enums — locale-independent,
			// unlike `schtasks /Query` tables on localized Windows.
			const ps = spawnSync(
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					"$t=Get-ScheduledTask -TaskName '" +
						name +
						"' -ErrorAction SilentlyContinue;" +
						"if(!$t){'NOT_INSTALLED';exit}" +
						"$i=$t|Get-ScheduledTaskInfo;" +
						"'State: '+$t.State;" +
						"'LastRunTime: '+$i.LastRunTime;" +
						"'LastTaskResult: '+$i.LastTaskResult",
				],
				{ encoding: "utf8" },
			);
			if (ps.status !== 0 || (ps.stdout ?? "").includes("NOT_INSTALLED")) {
				console.log(`${name}: 未安装（运行 pi-web-ui server install 安装）`);
				return;
			}
			console.log(`${name}: 计划任务\n${(ps.stdout ?? "").trim()}`);
			if (pid) {
				if (instAlive) console.log(`   快捷方式实例 : 运行中 (PID ${pid})`);
				else console.log(`   快捷方式实例 : 已退出 (PID ${pid})`);
			}
			return;
		}

		if (action === "start") {
			if (!exists) fail(`${name} 不存在，请先运行 pi-web-ui server install`);
			run("schtasks", ["/Run", "/TN", name]);
			console.log(`✅ 已启动 ${name}`);
			return;
		}

		if (action === "restart") {
			if (!exists) fail(`${name} 不存在，请先运行 pi-web-ui server install`);
			run("schtasks", ["/End", "/TN", name], {
				ignoreError: true,
				silent: true,
			});
			run("schtasks", ["/Run", "/TN", name]);
			console.log(`✅ 已重启 ${name}`);
			return;
		}

		if (action === "stop") {
			run("schtasks", ["/End", "/TN", name], {
				ignoreError: true,
				silent: true,
			});
			const pid = winReadPid(name);
			if (pid) {
				if (pidAlive(pid)) {
					run("taskkill", ["/PID", String(pid), "/T", "/F"], {
						ignoreError: true,
						silent: true,
					});
					console.log(`⏹  已停止快捷方式实例 (PID ${pid})`);
				}
				rmSync(winPidFilePath(name), { force: true });
			}
			console.log(`⏹  已停止 ${name}（自启保留；uninstall 移除）`);
			return;
		}

		fail(`未知操作: ${action}`);
	}

	fail(
		`不支持的系统服务平台: ${process.platform}（仅 macOS / Linux / Windows）`,
	);
}

// ---------------------------------------------------------------------------
// 界面插件管理（<dataDir>/plugins/，从 GitHub 安装）
// ---------------------------------------------------------------------------

/** 合法插件 id（同 server/plugins.ts 的 ID_RE）。 */
const PLUGIN_ID_RE = /^[A-Za-z0-9_-]+$/;

const PLUGIN_HELP = `用法:
  pi-web-ui install <源> [选项]     安装 GitHub 上的界面插件
  pi-web-ui uninstall <id> [选项]   卸载已安装的界面插件
  pi-web-ui plugins [选项]          列出已安装的界面插件

源写法（任选其一）:
  owner/repo                                        简写
  https://github.com/owner/repo                     完整 URL（.git 可省）
  https://github.com/o/r/tree/dev/sub/dir           指定分支 + 仓库内子目录
  以上任意写法末尾加 #分支或tag                      指定分支/tag（如 owner/repo#v1.2）
  /path/to/plugin-dir                               本地目录直接安装（开发调试用）

install 选项:
  --name <id>       插件目录名/id（默认取仓库名或 manifest.id，仅限字母数字-_）
  --data-dir <dir>  数据目录（默认 ~/.pi-web 或 $PI_WEB_DATA_DIR）
  --force           目标目录已存在时覆盖（覆盖前自动备份旧版本）

plugins 选项:
  --check-updates   逐个对比最近安装版本与远端 HEAD，列出可更新插件
  --rollback <id>   回滚到最近一份更新前备份（<dataDir>/plugin-backups/）
`;

function pluginDataDir(opts) {
	return resolve(opts.dataDir ?? process.env.PI_WEB_DATA_DIR ?? join(homedir(), ".pi-web"));
}

/** 解析安装源为 { owner, repo, ref, subpath, cloneUrl } 或本地路径；非法输入直接退出。 */
function parsePluginSource(rawSpec) {
	let spec = rawSpec.trim();
	let ref;
	const hash = spec.indexOf("#");
	if (hash >= 0) {
		ref = spec.slice(hash + 1).trim();
		if (!ref) fail(`无效的源 "${rawSpec}"：# 后缺少分支/tag 名`);
		spec = spec.slice(0, hash).replace(/\/+$/, "");
	}
	// ssh 形式转 https 拉取（不要求本机配 ssh key）；URL 去掉协议前缀统一按路径段解析
	const ssh = spec.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
	if (ssh) [, , spec] = ssh;
	else {
		const url = spec.match(/^https?:\/\/(?:www\.)?github\.com\/(.+?)(?:\.git)?\/?$/i);
		if (url) [, spec] = url;
	}
	const segs = spec.split("/").filter(Boolean);
	if (segs.length < 2)
		fail(`无法识别的插件源 "${rawSpec}"\n${PLUGIN_HELP}`);
	for (const s of segs) {
		if (s === "." || s === "..") fail(`无效的源 "${rawSpec}"：路径段不能是 . 或 ..`);
	}
	const [owner, repo] = segs;
	let subpath;
	if (segs[2] === "tree" || segs[2] === "blob") {
		if (!ref && segs.length > 3) ref = segs[3];
		subpath = segs.slice(4).join("/") || undefined;
	} else if (segs.length > 2) {
		subpath = segs.slice(2).join("/"); // owner/repo/sub/dir —— 子目录写法
	}
	return { owner, repo, ref, subpath, cloneUrl: `https://github.com/${owner}/${repo}.git` };
}

/** 把仓库拉到 tmpDir 并返回检出根目录。优先 git clone --depth 1，失败回退 codeload tarball + 系统 tar。 */
async function acquireRepo(src, tmpDir) {
	const dst = join(tmpDir, "src");
	const hasGit = spawnSync("git", ["--version"], { stdio: "ignore", timeout: 10_000 }).status === 0;
	if (hasGit) {
		const args = ["clone", "--depth", "1", "--single-branch"];
		if (src.ref) args.push("--branch", src.ref);
		args.push(src.cloneUrl, dst);
		console.log(`· git clone --depth 1 ${src.cloneUrl}${src.ref ? ` (${src.ref})` : ""}`);
		const res = spawnSync("git", args, {
			stdio: "inherit",
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
			timeout: 300_000,
		});
		if (res.status === 0 && existsSync(dst)) return dst;
		console.log("· git clone 失败，回退到 tarball 直连下载…");
	}
	const url = `https://codeload.github.com/${src.owner}/${src.repo}/tar.gz/${src.ref || "HEAD"}`;
	console.log(`· 下载 ${url}`);
	// 注意：这里不用 fail()/process.exit —— async 上下文里还有未关闭的 socket 时
	// 直接退出会触发 Windows libuv "UV_HANDLE_CLOSING" 断言崩溃；改为 throw，
	// 由 pluginInstallCmd 捕获后设 exitCode 让事件循环自然排空。
	let res;
	try {
		res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
	} catch (err) {
		throw new Error(`下载失败：${err?.message ?? err}\n  请检查网络/代理后重试。`);
	}
	if (!res.ok)
		throw new Error(
			`下载失败 HTTP ${res.status}：${url}` +
				(res.status === 404
					? "\n  仓库/分支不存在，或为私有仓库（私有仓库请先在本机配置好 git 凭据再重试，会优先走 git clone）。"
					: ""),
		);
	writeFileSync(join(tmpDir, "src.tar.gz"), Buffer.from(await res.arrayBuffer()));
	const extractTo = join(tmpDir, "tar");
	mkdirSync(extractTo, { recursive: true });
	// 相对路径解压：win32 的 GNU tar 会把 "C:\..." 里的 C: 当远程主机（Cannot connect to C:）
	const tarRes = spawnSync("tar", ["-xzf", "src.tar.gz", "-C", "tar"], {
		cwd: tmpDir,
		stdio: "inherit",
	});
	if (tarRes.status !== 0) fail("tar 解压失败（可重试，或手动下载 release 包解压）");
	const entries = readdirSync(extractTo);
	if (entries.length !== 1) fail("tarball 解压结果异常（顶层应只有一个目录）");
	return join(extractTo, entries[0]);
}

/** 在检出树里找包含 manifest.json 的目录（深度 ≤3，跳过 .git/node_modules）。 */
function findManifestDirs(root) {
	const hits = [];
	const walk = (dir, depth) => {
		if (existsSync(join(dir, "manifest.json"))) {
			hits.push(dir);
			return; // 目录本身是插件就不再往下搜嵌套插件
		}
		if (depth >= 3) return;
		for (const ent of readdirSync(dir, { withFileTypes: true })) {
			if (!ent.isDirectory() || ent.name === ".git" || ent.name === "node_modules") continue;
			walk(join(dir, ent.name), depth + 1);
		}
	};
	walk(root, 0);
	return hits;
}

/** 定位插件根目录：显式子路径 > 根目录 manifest > 全树搜索（唯一命中才继续）。 */
function locatePluginRoot(checkout, subpath, repoLabel) {
	if (subpath) {
		const dir = join(checkout, ...subpath.split("/"));
		if (!existsSync(join(dir, "manifest.json")))
			fail(`子目录 "${subpath}" 里没有 manifest.json`);
		return dir;
	}
	if (existsSync(join(checkout, "manifest.json"))) return checkout;
	const hits = findManifestDirs(checkout);
	if (hits.length === 0)
		fail(`"${repoLabel}" 里没找到 manifest.json —— 不是 pi-web-ui 界面插件`);
	if (hits.length > 1)
		fail(
			`${repoLabel} 里有多个插件（多个 manifest.json），请用子目录写法指定其中一个:\n  ` +
				hits.map((h) => `${repoLabel}/${relative(checkout, h).split(/[\\/]/).join("/")}`).join("\n  "),
		);
	console.log(`· 插件位于子目录: ${relative(checkout, hits[0]).split(/[\\/]/).join("/")}`);
	return hits[0];
}

async function pluginInstallCmd(argv) {
	const { opts, positionals } = parseFlags(argv);
	if (opts.help) {
		console.log(PLUGIN_HELP);
		return;
	}
	if (positionals.length !== 1)
		fail(`用法: pi-web-ui install <源> [--name <id>] [--data-dir <dir>] [--force]\n${PLUGIN_HELP}`);
	const rawSpec = positionals[0];
	const pluginsDir = join(pluginDataDir(opts), "plugins");
	// 本地目录直接装（离线开发调试），否则从 GitHub 拉取
	const localCandidate = resolve(rawSpec.replace(/^file:\/\//, ""));
	const isLocal = existsSync(localCandidate);
	const src = isLocal ? null : parsePluginSource(rawSpec);
	const tmp = mkdtempSync(join(tmpdir(), "pi-web-ui-plugin-"));
	let backupTs = null;
	try {
		let checkout;
		try {
			checkout = isLocal ? localCandidate : await acquireRepo(src, tmp);
		} catch (err) {
			console.error(`✖ ${err?.message ?? err}`);
			process.exitCode = 1;
			return;
		}
		const repoLabel = isLocal ? localCandidate : `${src.owner}/${src.repo}`;
		const pluginRoot = locatePluginRoot(checkout, src?.subpath, repoLabel);
		let manifest;
		try {
			manifest = JSON.parse(readFileSync(join(pluginRoot, "manifest.json"), "utf8"));
		} catch (err) {
			fail(`manifest.json 不是合法 JSON：${err?.message ?? err}`);
		}
		// 默认 id：子目录名 > 仓库名 > 本地目录名
		const sourceName = src?.subpath
			? src.subpath.split("/").pop()
			: (src?.repo ?? localCandidate.split(/[\\/]/).pop());
		const fallbackId =
			String(manifest.id ?? sourceName)
				.replace(/[^A-Za-z0-9_-]/g, "-")
				.replace(/^-+|-+$/g, "") || "plugin";
		const id = opts.name ?? fallbackId;
		if (!PLUGIN_ID_RE.test(id))
			fail(`非法插件 id "${id}"（仅限字母数字-_，可用 --name <id> 自定义）`);
		const target = join(pluginsDir, id);
		let prevConfig = null;
		const CONFIG_NAME = "config.json";
		if (existsSync(target)) {
			if (!opts.force)
				fail(`插件目录已存在：${target}\n  加 --force 覆盖，或用 --name <id> 换个名字。`);
			// 更新前备份旧版本（<dataDir>/plugin-backups/<id>-<ts>/，保留最近 3 份），
			// 失败时自动回滚。备份与安装同 filter：不带 .git/node_modules。
			backupTs = ensurePluginBackup(pluginDataDir(opts), id, { source: rawSpec });
			// 插件凭据/配置不因升级丢失：先取出旧 config.json，拷完新文件后原样放回
			try {
				prevConfig = readFileSync(join(target, CONFIG_NAME), "utf8");
			} catch {
				/* 无配置文件 */
			}
			rmSync(target, { recursive: true, force: true });
		}
		mkdirSync(target, { recursive: true });
		try {
			cpSync(pluginRoot, target, {
				recursive: true,
				filter: (s) => !/(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(s),
			});
		} catch (err) {
			// 拷贝失败 → 有备份则自动回滚，保持旧版本可用
			if (backupTs && restorePluginBackup(pluginDataDir(opts), id)) {
				fail(`插件更新失败：${err?.message ?? err}\n  已自动回滚到更新前版本。`);
			}
			fail(`插件更新失败：${err?.message ?? err}\n  （无可用备份，请重新 install --force）`);
		}
		if (prevConfig !== null && !existsSync(join(target, CONFIG_NAME))) {
			writeFileSync(join(target, CONFIG_NAME), prevConfig);
		}
		// 记录安装来源：设置面板「更新」按钮据此重跑同一条安装命令（--force 覆盖）。
		try {
			writeFileSync(
				join(target, ".pi-source.json"),
				JSON.stringify({ source: rawSpec }, null, 2) + "\n",
			);
		} catch {
			/* 尽力而为：没有来源信息只是不显示更新按钮 */
		}
		// 记录本次安装的远端 sha（git ls-remote HEAD，离线也支持本地 git 源）：
		// 供 `pi-web-ui plugins --check-updates` 对比更新。失败静默（无 sha = 保守可更新）。
		try {
			const sha = await resolveRemoteSha(rawSpec);
			if (sha) writeFileSync(join(target, ".pi-git-sha"), sha + "\n");
		} catch {
			/* 尽力而为 */
		}
		console.log(
			`✔ 已安装插件 ${id}${manifest.name && manifest.name !== id ? `（${manifest.name}）` : ""}${manifest.version ? ` v${manifest.version}` : ""}`,
		);
		if (manifest.description) console.log(`  ${manifest.description}`);
		console.log(`  位置: ${target}`);
		console.log(`  生效: 服务运行中刷新浏览器即可加载；未运行则下次启动生效。卸载: pi-web-ui uninstall ${id}`);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

function pluginUninstallCmd(argv) {
	const { opts, positionals } = parseFlags(argv);
	if (opts.help || positionals.length !== 1) {
		console.log(PLUGIN_HELP);
		if (!opts.help) process.exit(1);
		return;
	}
	const id = positionals[0];
	if (!PLUGIN_ID_RE.test(id)) fail(`非法插件 id: ${id}`);
	const target = join(pluginDataDir(opts), "plugins", id);
	if (!existsSync(target)) fail(`未安装插件 "${id}"（pi-web-ui plugins 查看已装列表）`);
	rmSync(target, { recursive: true, force: true });
	console.log(`✔ 已卸载插件 ${id} —— 运行中的服务刷新浏览器后消失。`);
}

function pluginListCmd(argv) {
	const { opts, positionals } = parseFlags(argv);
	if (opts.help) {
		console.log(PLUGIN_HELP);
		return;
	}
	const dataDir = pluginDataDir(opts);
	// --rollback <id>：回滚到最近一份更新前备份
	if (opts.rollback) {
		const id = String(opts.rollback);
		if (!PLUGIN_ID_RE.test(id)) fail(`非法插件 id: ${id}`);
		const target = join(dataDir, "plugins", id);
		if (!existsSync(target)) fail(`未安装插件 "${id}"（pi-web-ui plugins 查看已装列表）`);
		const ts = restorePluginBackup(dataDir, id);
		if (!ts) fail(`插件 "${id}" 没有更新备份（从未覆盖安装 / 备份已用完）`);
		console.log(`✔ 已回滚插件 ${id} 到 ${ts} 的快照 —— 运行中的服务刷新浏览器后生效。`);
		return;
	}
	// --check-updates：对比各插件记录的最后安装 sha 与远端 HEAD（git ls-remote）
	if (opts.checkUpdates) {
		return checkUpdatesCmd(dataDir).then(() => {});
	}
	const pluginsDir = join(dataDir, "plugins");
	const rows = [];
	let names = [];
	try {
		names = readdirSync(pluginsDir).sort();
	} catch {
		/* 目录不存在 = 未安装任何插件 */
	}
	for (const n of names) {
		if (!PLUGIN_ID_RE.test(n)) continue;
		try {
			const m = JSON.parse(readFileSync(join(pluginsDir, n, "manifest.json"), "utf8"));
			rows.push(`  ${n.padEnd(24)} ${[m.name, m.version ? `v${m.version}` : "", m.description].filter(Boolean).join("  ")}`);
		} catch {
			continue; // 坏目录跳过
		}
	}
	if (rows.length === 0) {
		console.log(`尚未安装任何界面插件（目录: ${pluginsDir}）\n安装示例: pi-web-ui install owner/repo`);
		return;
	}
	console.log(`已安装的界面插件（${pluginsDir}）:\n${rows.join("\n")}`);
}

async function checkUpdatesCmd(dataDir) {
	console.log("检查界面插件更新（git ls-remote 对比最近安装版本）…\n");
	let rows;
	try {
		rows = await checkPluginUpdates(dataDir);
	} catch (err) {
		fail(`更新检查失败：${err?.message ?? err}`);
	}
	if (rows.length === 0) {
		console.log(`尚未安装任何带来源记录的界面插件（目录: ${join(dataDir, "plugins")}）`);
		return;
	}
	let any = false;
	for (const r of rows) {
		const label = r.name && r.name !== r.id ? `${r.id}（${r.name}）` : r.id;
		if (r.updatable) {
			console.log(`  🔄 ${label}${r.version ? ` v${r.version}` : ""}  可更新（已装 ${r.localSha ?? "未知"} → 远端 ${r.remoteSha}）`);
			console.log(`     更新: pi-web-ui install ${r.source} --name ${r.id} --force`);
			any = true;
		} else if (r.remoteSha) {
			console.log(`  ✓ ${label}${r.version ? ` v${r.version}` : ""}  已是最新（${r.remoteSha}）`);
		} else {
			console.log(`  ? ${label}  ${r.error ?? "无法检查"}（来源: ${r.source}）`);
		}
	}
	if (!any) console.log("\n全部插件均为最新版本。");
}

async function serverCmd(argv) {
	const { opts, positionals } = parseFlags(argv);
	if (opts.help) {
		console.log(HELP);
		return;
	}
	if (positionals.length === 0) {
		console.log(HELP);
		console.log("--- 当前服务状态 ---");
		controlService("status", opts);
		return;
	}
	const action = positionals[0];
	if (positionals.length > 1)
		fail(`多余的参数: ${positionals.slice(1).join(" ")}`);
	switch (action) {
		case "shortcut": {
			if (isWin) {
				installWinShortcut(opts);
			} else if (isMac) {
				installMacShortcut(opts);
			} else if (isLinux) {
				installLinuxShortcut(opts);
			} else {
				fail(`不支持的系统服务平台: ${process.platform}`);
			}
			break;
		}
		case "install": {
			if (isMac) {
				installLaunchd(opts);
			} else if (isLinux) {
				installSystemd(opts);
			} else if (isWin) {
				installWindows(opts);
			} else {
				fail(`不支持的系统服务平台: ${process.platform}`);
			}
			break;
		}
		case "uninstall": {
			if (isMac) {
				uninstallLaunchd(opts);
			} else if (isLinux) {
				uninstallSystemd(opts);
			} else if (isWin) {
				uninstallWindows(opts);
			} else {
				fail(`不支持的系统服务平台: ${process.platform}`);
			}
			break;
		}
		case "start":
		case "stop":
		case "restart":
			controlService(action, opts);
			break;
		case "status":
			controlService("status", opts);
			await printLiveStatus(opts);
			break;
		case "quiesce":
			await setQuiesce(opts, true);
			break;
		case "unquiesce":
			await setQuiesce(opts, false);
			break;
		default:
			fail(
				`未知操作: ${action}（install / shortcut / uninstall / start / stop / restart / status / quiesce / unquiesce）`,
			);
	}
}

async function main() {
	checkNodeVersion();
	const argv = process.argv.slice(2);
	if (argv.length === 0) {
		await startForeground({});
		return;
	}
	const first = argv[0];
	if (first === "--version" || first === "-v") {
		console.log(pkg.version);
		return;
	}
	if (first === "--help" || first === "-h") {
		console.log(HELP);
		return;
	}
	if (first === "server") {
		await serverCmd(argv.slice(1));
		return;
	}
	if (first === "install") {
		await pluginInstallCmd(argv.slice(1));
		return;
	}
	if (first === "uninstall") {
		pluginUninstallCmd(argv.slice(1));
		return;
	}
	if (first === "plugins" || first === "plugin") {
		pluginListCmd(argv.slice(1));
		return;
	}
	// One-shot server with optional --port/--cwd/--data-dir overrides.
	const { opts, positionals } = parseFlags(argv);
	if (opts.help) {
		console.log(HELP);
		return;
	}
	if (positionals.length > 0)
		fail(`未知命令: ${positionals[0]}（--help 查看用法）`);
	await startForeground(opts);
}

main().catch((err) => {
	console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
