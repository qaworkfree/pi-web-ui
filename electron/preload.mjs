/**
 * pi-web-ui Electron preload 脚本。
 * 当前不需要暴露任何 Electron API 给前端（前端与 server 通过 WS 通信）。
 * 预留用于未来需要桌面特有 API（文件对话框、通知等）时扩展。
 */
import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
	platform: process.platform,
	versions: {
		node: process.versions.node,
		electron: process.versions.electron,
		chrome: process.versions.chrome,
	},
});