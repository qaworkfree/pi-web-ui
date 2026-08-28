/**
 * pi-web-ui Electron 桌面版主进程。
 *
 * 架构：
 *   - 主进程 fork 一个隐藏子进程跑 server（ELECTRON_RUN_AS_NODE=1），
 *     server 使用 Electron 内置的 Node 运行时，node-pty 等原生模块
 *     在 electron-builder 打包时自动 rebuild 为 Electron ABI。
 *   - BrowserWindow 加载 http://127.0.0.1:{PORT}（server 就绪后）。
 *   - 托盘：关闭窗口 → 最小化到托盘；Quit → 真正退出（杀 server 子进程）。
 *   - 自动更新：electron-updater + GitHub Releases。
 *
 * 开发模式（npm run dev:electron）：
 *   先构建 web + server（npm run build），然后 electron . 即可。
 *   如有 Vite dev server (:5173)，优先加载它获取 HMR。
 */

import { app, BrowserWindow, Tray, Menu, nativeImage, dialog, Notification } from "electron";
import { fork } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { autoUpdater } from "electron-updater";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const isDev = !app.isPackaged || !!process.env.DEV;

// ── 状态 ──
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Tray | null} */
let tray = null;
/** @type {import("node:child_process").ChildProcess | null} */
let serverProcess = null;
let isQuitting = false;
let serverPort = 0;

// ── 路径 ──

/** 打包后 server 在 resources/dist/server/index.js */
function getServerPath() {
	if (isDev) return join(ROOT, "dist", "server", "index.js");
	return join(process.resourcesPath, "dist", "server", "index.js");
}

/** 打包后 themes 在 resources/themes/ */
function getPkgRoot() {
	if (isDev) return ROOT;
	return process.resourcesPath;
}

// ── 端口 ──

/** 找一个随机空闲端口（防止端口冲突） */
async function findFreePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.listen(0, "127.0.0.1", () => {
			const port = /** @type {import("node:net").AddressInfo} */ (srv.address()).port;
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

// ── 启动 Server 子进程 ──

async function startServer() {
	serverPort = await findFreePort();
	const serverPath = getServerPath();

	if (!existsSync(serverPath)) {
		dialog.showErrorBox(
			"pi-web-ui 启动失败",
			`找不到 server 入口：${serverPath}\n\n请先执行 npm run build，然后重试。`,
		);
		app.quit();
		return;
	}

	// 确保 ~/.pi-web 目录存在（server 需要）
	const dataDir = join(process.env.HOME || process.env.USERPROFILE || "~", ".pi-web");
	mkdirSync(dataDir, { recursive: true });

	serverProcess = fork(serverPath, [], {
		env: {
			...process.env,
			PORT: String(serverPort),
			PI_WEB_HOST: "127.0.0.1",
			PI_WEB_NO_BROWSER: "1", // 不要自动打开浏览器
			PI_WEB_PKG_ROOT: getPkgRoot(), // 告诉 server 去哪找 web/dist / themes
			ELECTRON_RUN_AS_NODE: "1", // 以 Node.js 模式运行（非 Electron）
		},
		stdio: ["ignore", "pipe", "pipe"],
		serialization: "json",
	});

	// 收集 stdout/stderr 用于调试
	let serverOut = "";
	serverProcess.stdout?.on("data", (chunk) => {
		const text = chunk.toString();
		serverOut += text;
		process.stdout.write(`[server] ${text}`);
	});
	serverProcess.stderr?.on("data", (chunk) => {
		const text = chunk.toString();
		serverOut += text;
		process.stderr.write(`[server:err] ${text}`);
	});

	// 等待 server 就绪：监听 stdout 中的 "⚡ pi-web-ui" 标记
	await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(
				new Error(
					`Server 启动超时（30s）。最后输出：\n${serverOut.slice(-500)}`,
				),
			);
		}, 30_000);

		const checkOutput = (chunk) => {
			const text = chunk.toString();
			if (text.includes("⚡ pi-web-ui") || text.includes("http://localhost")) {
				clearTimeout(timeout);
				resolve();
			}
		};

		serverProcess.stdout?.on("data", checkOutput);
		serverProcess.on("error", (err) => {
			clearTimeout(timeout);
			reject(err);
		});
		serverProcess.on("exit", (code) => {
			clearTimeout(timeout);
			if (code !== 0) {
				reject(new Error(`Server 退出了 (exit code=${code})`));
			}
		});
	});

	console.log(`[electron] server 就绪，端口 ${serverPort}`);
}

// ── 窗口 ──

function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1200,
		height: 800,
		minWidth: 800,
		minHeight: 600,
		title: "pi-web-ui",
		show: false,
		webPreferences: {
			preload: join(__dirname, "preload.mjs"),
			nodeIntegration: false,
			contextIsolation: true,
		},
		icon: join(__dirname, "icon.png"),
	});

	// 加载 localhost 上的 server
	const url = `http://127.0.0.1:${serverPort}`;
	mainWindow.loadURL(url);

	mainWindow.once("ready-to-show", () => {
		mainWindow.show();
	});

	// 关闭窗口 → 隐藏到托盘（不退出）
	mainWindow.on("close", (event) => {
		if (!isQuitting) {
			event.preventDefault();
			mainWindow.hide();
			return false;
		}
	});

	mainWindow.on("closed", () => {
		mainWindow = null;
	});

	// 开发模式打开 DevTools
	if (isDev) {
		mainWindow.webContents.openDevTools({ mode: "detach" });
	}
}

// ── 托盘 ──

function createTray() {
	// 用 16x16 的图标，从 nativeImage 创建
	// 如果没有图标，用 nativeImage.createEmpty()
	const icon = nativeImage.createEmpty();
	tray = new Tray(icon);
	tray.setToolTip("pi-web-ui");

	const contextMenu = Menu.buildFromTemplate([
		{
			label: "显示窗口",
			click: () => {
				if (mainWindow) {
					mainWindow.show();
					mainWindow.focus();
				}
			},
		},
		{ type: "separator" },
		{
			label: "关于 pi-web-ui",
			click: () => {
				dialog.showMessageBox({
					type: "info",
					title: "关于 pi-web-ui",
					message: `pi-web-ui v${app.getVersion()}`,
					detail: "Web chat interface for the pi coding agent.",
				});
			},
		},
		{ type: "separator" },
		{
			label: "退出",
			click: () => {
				isQuitting = true;
				app.quit();
			},
		},
	]);

	tray.setContextMenu(contextMenu);

	// 点击托盘图标 → 显示/隐藏窗口
	tray.on("click", () => {
		if (mainWindow) {
			if (mainWindow.isVisible()) {
				mainWindow.hide();
			} else {
				mainWindow.show();
				mainWindow.focus();
			}
		}
	});
}

// ── 菜单 ──

function createAppMenu() {
	const template = [
		{
			label: "pi-web-ui",
			submenu: [
				{
					label: "关于 pi-web-ui",
					click: () => {
						dialog.showMessageBox({
							type: "info",
							title: "关于 pi-web-ui",
							message: `pi-web-ui v${app.getVersion()}`,
							detail: "Web chat interface for the pi coding agent.",
						});
					},
				},
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ role: "unhide" },
				{ type: "separator" },
				{
					label: "退出",
					accelerator: "CmdOrCtrl+Q",
					click: () => {
						isQuitting = true;
						app.quit();
					},
				},
			],
		},
		{
			label: "编辑",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "selectAll" },
			],
		},
		{
			label: "视图",
			submenu: [
				{ role: "reload" },
				{ role: "forceReload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{
			label: "窗口",
			submenu: [
				{ role: "minimize" },
				{ role: "close" },
			],
		},
	];

	// macOS 需要第一个菜单项是应用名
	const menu = Menu.buildFromTemplate(template);
	Menu.setApplicationMenu(menu);
}

// ── 自动更新 ──

function setupAutoUpdater() {
	if (isDev) return; // 开发模式不检查更新

	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = true;

	// 检查更新（启动后延迟 5s）
	setTimeout(() => {
		autoUpdater.checkForUpdates().catch(() => {
			// 静默失败（无网络 / 超时等）
		});
	}, 5000);

	autoUpdater.on("update-available", (info) => {
		const notification = new Notification({
			title: "pi-web-ui 更新可用",
			body: `版本 ${info.version} 可下载（当前 ${app.getVersion()}）`,
		});
		notification.on("click", () => {
			autoUpdater.downloadUpdate();
		});
		notification.show();
	});

	autoUpdater.on("update-downloaded", () => {
		const result = dialog.showMessageBoxSync({
			type: "info",
			title: "更新已下载",
			message: "新版本已下载完成，是否立即重启以安装更新？",
			buttons: ["立即重启", "稍后"],
		});
		if (result === 0) {
			autoUpdater.quitAndInstall();
		}
	});
}

// ── 应用生命周期 ──

app.setAppUserModelId("com.xingshuyin.pi-web-ui");

// 确保只有一个实例
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
} else {
	app.on("second-instance", () => {
		if (mainWindow) {
			if (mainWindow.isMinimized()) mainWindow.restore();
			mainWindow.show();
			mainWindow.focus();
		}
	});
}

app.whenReady().then(async () => {
	try {
		await startServer();
	} catch (err) {
		dialog.showErrorBox("pi-web-ui 启动失败", err.message);
		app.quit();
		return;
	}

	createAppMenu();
	createWindow();
	createTray();
	setupAutoUpdater();

	app.on("activate", () => {
		if (!mainWindow) createWindow();
		if (mainWindow) {
			mainWindow.show();
			mainWindow.focus();
		}
	});
});

app.on("window-all-closed", () => {
	// macOS 不退出（dock 图标还在）
	// 其他平台退出
	if (process.platform !== "darwin") {
		isQuitting = true;
		app.quit();
	}
});

app.on("before-quit", () => {
	isQuitting = true;
});

app.on("will-quit", () => {
	// 杀 server 子进程
	if (serverProcess) {
		try {
			serverProcess.kill("SIGTERM");
		} catch {
			// 可能已经退出
		}
		serverProcess = null;
	}
	if (tray) {
		tray.destroy();
		tray = null;
	}
});