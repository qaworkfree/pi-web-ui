/**
 * vscode-editor 服务端入口 —— 类 VSCode 编辑器插件的文件系统后端。
 *
 * 约定：ESM 默认导出 { activate(host) → deactivate? }。
 * 客户端上行 plugin_message：{ action, reqId, ... }，本插件用 host.sendTo
 * 定向回给发起请求的 socket（带 reqId 供并发匹配），不广播。
 *
 * 安全：
 * - 所有路径必须是相对 host.cwd（服务启动工作区）的相对路径，
 *   resolve 后必须仍落在 root 内，越界直接拒绝；
 * - 目录遍历跳过 node_modules/.git 等噪音目录与符号链接（防循环）；
 * - 读有 2MB 上限；写走 tmp + rename 原子落盘。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

/** 列目录时跳过的噪音条目名 */
const IGNORED = new Set([
	"node_modules", ".git", ".pi-web", ".next", ".nuxt",
	"dist", "build", "out", "venv", ".venv", "__pycache__",
	"coverage", ".cache", ".DS_Store", "Thumbs.db",
]);

const MAX_LIST_ENTRIES = 8000; // flatlist 总条目上限
const MAX_DEPTH = 12; // flatlist 最大深度
const MAX_READ_BYTES = 2 * 1024 * 1024; // 单文件读取上限

function toWire(p) {
	return p.split(path.sep).join("/");
}

export default {
	activate(host) {
		const root = path.resolve(host.cwd);

		/** 相对路径 → 校验后的绝对路径；非法返回 null */
		function safeResolve(rel) {
			if (typeof rel !== "string") return null;
			const abs = path.resolve(root, rel); // "" = 工作区根本身，合法
			if (abs !== root && !abs.startsWith(root + path.sep)) return null;
			return abs;
		}

		function fail(reqId, error) {
			return { res: true, reqId, ok: false, error };
		}

		/** 单层目录列表（tree 动作用，惰性展开） */
		async function listDir(relDir) {
			const abs = safeResolve(relDir ?? "");
			if (!abs) throw new Error("路径越界");
			const dirents = await fs.readdir(abs === root ? root : abs, { withFileTypes: true });
			const entries = [];
			for (const d of dirents) {
				if (IGNORED.has(d.name)) continue;
				// 符号链接/junction 不跟随展开（防循环、防越界），只按名字显示类型
				if (d.isSymbolicLink()) continue;
				entries.push({
					name: d.name,
					type: d.isDirectory() ? "dir" : "file",
				});
			}
			entries.sort((a, b) =>
				a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name),
			);
			return entries;
		}

		/** 全仓扁平文件列表（Ctrl+P 快速打开用），BFS 带深度/数量上限 */
		async function flatList() {
			const files = [];
			let truncated = false;
			const queue = [root];
			while (queue.length && files.length < MAX_LIST_ENTRIES) {
				const dir = queue.shift();
				const depth = dir.slice(root.length).split(path.sep).filter(Boolean).length;
				if (depth >= MAX_DEPTH) continue;
				let dirents;
				try {
					dirents = await fs.readdir(dir, { withFileTypes: true });
				} catch {
					continue; // 权限等错误跳过该目录
				}
				for (const d of dirents) {
					if (files.length >= MAX_LIST_ENTRIES) {
						truncated = true;
						break;
					}
					if (IGNORED.has(d.name)) continue;
					if (d.isSymbolicLink()) continue;
					const full = path.join(dir, d.name);
					if (d.isDirectory()) queue.push(full);
					else if (d.isFile()) files.push(toWire(path.relative(root, full)));
				}
			}
			return { files, truncated };
		}

		/** 文件内容嗅探：无 NUL 且控制字符占比 <2% 视为文本 */
		function looksLikeText(buf) {
			const n = Math.min(buf.length, 8000);
			let ctrl = 0;
			for (let i = 0; i < n; i++) {
				const b = buf[i];
				if (b === 0) return false;
				if (b < 9 || (b > 13 && b < 32)) ctrl++;
			}
			return n === 0 || ctrl / n < 0.02;
		}

		/** 解码：严格 UTF-8 → GBK → latin1（与主应用 decodeText 同语义） */
		function decodeBuf(buf) {
			try {
				return new TextDecoder("utf-8", { fatal: true }).decode(buf);
			} catch {}
			try {
				return new TextDecoder("gbk", { fatal: true }).decode(buf);
			} catch {}
			return new TextDecoder("latin1").decode(buf);
		}

		async function readFile(rel) {
			const abs = safeResolve(rel);
			if (!abs) throw new Error("路径越界");
			const stat = await fs.stat(abs);
			if (!stat.isFile()) throw new Error("不是普通文件");
			if (stat.size > MAX_READ_BYTES) throw new Error(`文件超过 ${MAX_READ_BYTES / 1024 / 1024}MB 上限`);
			const buf = await fs.readFile(abs);
			if (!looksLikeText(buf)) return { binary: true, size: stat.size };
			return { text: decodeBuf(buf), encoding: "utf-8", size: stat.size };
		}

		async function writeFile(rel, text) {
			const abs = safeResolve(rel);
			if (!abs || abs === root) throw new Error("非法路径");
			await fs.mkdir(path.dirname(abs), { recursive: true });
			// 原子写：tmp + rename，防半截内容
			const tmp = abs + ".vsc-tmp-" + process.pid;
			await fs.writeFile(tmp, String(text ?? ""), "utf-8");
			await fs.rename(tmp, abs);
		}

		async function createEntry(rel, kind) {
			const abs = safeResolve(rel);
			if (!abs || abs === root) throw new Error("非法路径");
			try {
				if (kind === "dir") await fs.mkdir(abs);
				else {
					await fs.mkdir(path.dirname(abs), { recursive: true });
					await fs.writeFile(abs, "", { flag: "wx" }); // 已存在则报错
				}
			} catch (err) {
				if (err.code === "EEXIST") throw new Error("已存在同名文件/文件夹");
				throw err;
			}
		}

		async function renameEntry(rel, newName) {
			if (typeof newName !== "string" || !newName.trim()
				|| newName.includes("/") || newName.includes("\\") || newName.includes("..")) {
				throw new Error("非法新名称");
			}
			const abs = safeResolve(rel);
			if (!abs || abs === root) throw new Error("非法路径");
			await fs.access(abs); // 不存在直接抛
			await fs.rename(abs, path.join(path.dirname(abs), newName));
		}

		async function deleteEntry(rel) {
			const abs = safeResolve(rel);
			if (!abs || abs === root) throw new Error("拒绝删除根目录");
			await fs.rm(abs, { recursive: true, force: false });
		}

		const off = host.onMessage(async (payload, clientId) => {
			const msg = payload ?? {};
			const { action, reqId } = msg;
			try {
				switch (action) {
					case "list": // 单层目录（文件树惰性展开）
						host.sendTo(clientId, { res: true, reqId, ok: true, action,
							dir: toWire(msg.dir ?? ""), entries: await listDir(msg.dir) });
						break;
					case "flatlist":
						host.sendTo(clientId, { res: true, reqId, ok: true, action, ...(await flatList()) });
						break;
					case "read": {
						const r = await readFile(msg.path);
						host.sendTo(clientId, { res: true, reqId, ok: true, action, path: msg.path, ...r });
						break;
					}
					case "write":
						await writeFile(msg.path, msg.text);
						host.sendTo(clientId, { res: true, reqId, ok: true, action, path: msg.path });
						break;
					case "create":
						await createEntry(msg.path, msg.kind);
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					case "rename":
						await renameEntry(msg.path, msg.newName);
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					case "delete":
						await deleteEntry(msg.path);
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					default:
						host.log("unknown action:", action);
						host.sendTo(clientId, fail(reqId, `未知操作 ${action}`));
				}
			} catch (err) {
				host.sendTo(clientId, fail(reqId, err?.message ?? String(err)));
			}
		});

		host.log(`activated; workspace root: ${root}`);
		return () => {
			off();
			host.log("deactivated");
		};
	},
};

// 说明：host.cwd 是服务启动时的固定快照（PluginManager 构造注入），
// 编辑器始终以它为工作区根 —— 与底栏显示的工作目录语义一致。
