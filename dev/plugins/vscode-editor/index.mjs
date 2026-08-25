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
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

/** 列目录时跳过的噪音条目名 */
const IGNORED = new Set([
	"node_modules", ".git", ".pi-web", ".next", ".nuxt",
	"dist", "build", "out", "venv", ".venv", "__pycache__",
	"coverage", ".cache", ".DS_Store", "Thumbs.db",
]);

const MAX_LIST_ENTRIES = 8000; // flatlist 总条目上限
const MAX_DEPTH = 12; // flatlist 最大深度
const MAX_READ_BYTES = 2 * 1024 * 1024; // 单文件读取上限（本地与远程 SFTP 共用）
const MAX_SSH_HOSTS = 32;
const CONN_TIMEOUT_MS = 15000;
const MAX_EXEC_OUTPUT = 256 * 1024; // 远程 exec 输出截断上限

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

		// ------------------------------------------------------------------
		// SFTP 同步：把本地工作区与远端目录互传
		//
		// 配置存 <pluginDir>/sync-configs.json（按工作区根路径为 key，凭据明文本机、
		// 回显脱敏）；依赖 ssh2 不随包分发，首次使用自动 npm 补装到插件目录。
		// 方向：up 本地→远端；down 远端→本地。范围：file 单文件 / tree 子树 /
		// all 全仓。排除规则：内置 IGNORED + 配置的额外条目名。
		// ------------------------------------------------------------------
		const SYNC_STORE = path.join(host.dir, "sync-configs.json");
		let syncCfgs = null; // { [workspaceRoot]: {host,port,username,password,privateKey,remoteRoot,exclude,uploadOnSave} }
		let syncLoading = null;
		const syncConns = new Map(); // workspaceRoot → {client,sftp}
		const syncDeps = { mod: null, ok: false, installing: false, waiters: [] };

		function posixJoin(base, rel) {
			if (!rel) return base;
			return `${String(base).replace(/\/+$/, "")}/${String(rel).replace(/^\/+/g, "")}`;
		}

		async function ensureSyncCfgs() {
			if (syncCfgs) return syncCfgs;
			if (!syncLoading) {
				syncLoading = fs.readFile(SYNC_STORE, "utf8")
					.then((raw) => JSON.parse(raw))
					.catch(() => ({}))
					.then((obj) => (syncCfgs = obj ?? {}));
			}
			await syncLoading;
			return syncCfgs;
		}

		async function saveSyncCfgs() {
			await fs.writeFile(SYNC_STORE, JSON.stringify(syncCfgs, null, "\t"), "utf8");
		}

		function publicSync(cfg) {
			if (!cfg?.host) return { configured: false };
			return {
				configured: true,
				host: cfg.host,	port: cfg.port ?? 22,
				username: cfg.username ?? "root",
				remoteRoot: cfg.remoteRoot ?? "/",
				exclude: cfg.exclude ?? [],
				uploadOnSave: Boolean(cfg.uploadOnSave),
				hasPass: Boolean(cfg.password),
				hasKey: Boolean(cfg.privateKey),
			};
		}

		/** 惰性加载 ssh2；未安装时自动 npm 补装（同 ssh 插件模式）。 */
		function ensureSshMod() {
			if (syncDeps.ok) return Promise.resolve(syncDeps.mod);
			if (syncDeps.installing) return new Promise((res) => syncDeps.waiters.push(res));
			return new Promise(async (res) => {
				syncDeps.installing = true;
				try {
					const m = await import("ssh2");
					syncDeps.mod = m.default ?? m;
					syncDeps.ok = true;
				} catch {
					host.notify("info", "📝 编辑器同步：开始安装依赖（ssh2）…");
					let cli = null;
					try { cli = createRequire(import.meta.url).resolve("npm/bin/npm-cli.js"); } catch {}
					const args = ["--prefix", host.dir, "install", "ssh2@latest", "--no-audit", "--no-fund"];
					const child = cli
						? spawn(process.execPath, [cli, ...args], { stdio: "ignore" })
						: spawn("npm", args, { stdio: "ignore", shell: process.platform === "win32" });
					child.on("error", () => finish(false));
					child.on("exit", (code) => finish(code === 0));
					return;
					async function finish(ok) {
						syncDeps.installing = false;
						if (ok) {
							try {
								const m = await import("ssh2");
								syncDeps.mod = m.default ?? m;
								syncDeps.ok = true;
							} catch {}
						}
						host.notify(syncDeps.ok ? "success" : "error",
							syncDeps.ok ? "📝 编辑器同步依赖安装完成"
								: "📝 编辑器同步依赖安装失败——请在插件目录手动执行 npm install ssh2");
						for (const w of syncDeps.waiters.splice(0)) w(syncDeps.ok ? syncDeps.mod : null);
						broadcastSshState(); // 依赖状态变化 → 刷新前端主机栏的 ⚠ssh2 按钮（函数声明提升，安全）
						res(syncDeps.ok ? syncDeps.mod : null);
					}
				}
				syncDeps.installing = false;
				res(syncDeps.ok ? syncDeps.mod : null);
			});
		}

		function dropSyncConn(key) {
			const c = syncConns.get(key);
			if (!c) return;
			syncConns.delete(key);
			try { c.client.end(); } catch {}
		}

		async function getSyncSftp(cfg) {
			const mod = await ensureSshMod();
			if (!mod?.Client) throw new Error("ssh2 依赖未就绪");
			let entry = syncConns.get(root);
			if (entry) return entry.sftp;
			entry = await new Promise((resolve, reject) => {
				const client = new mod.Client();
				const opts = {
					host: cfg.host, port: Number(cfg.port) || 22,
					username: cfg.username || "root",
					readyTimeout: 15000,
					keepaliveInterval: 10000,
				};
				if (cfg.password) opts.password = cfg.password;
				else if (cfg.privateKey) opts.privateKey = cfg.privateKey;
				client.on("ready", () => {
					client.sftp((err, sftp) => {
						if (err) { try { client.end(); } catch {} return reject(err); }
						syncConns.set(root, { client, sftp });
						resolve({ client, sftp });
					});
				});
				client.on("error", (e) => { try { client.end(); } catch {} reject(e); });
				client.connect(opts);
			});
			return entry.sftp;
		}

		function isSyncExcluded(rel, cfg) {
			const bases = new Set(IGNORED);
			for (const e of cfg.exclude || []) if (e.trim()) bases.add(e.trim());
			return rel.split("/").some((seg) => bases.has(seg));
		}

		/** 收集要传输的相对文件列表（双方通用：只产出 rel 路径数组） */
		async function collectLocal(relBase, cfg) {
			const out = [];
			async function walk(absDir, relDir) {
				const dirents = await fs.readdir(absDir, { withFileTypes: true }).catch(() => []);
				for (const d of dirents) {
					const rel = relDir ? `${relDir}/${d.name}` : d.name;
					if (isSyncExcluded(rel, cfg)) continue;
					if (d.isSymbolicLink()) continue;
					if (d.isDirectory()) await walk(path.join(absDir, d.name), rel);
					else if (d.isFile()) out.push(rel);
				}
			}
			await walk(path.resolve(root, relBase || ""), relBase || "");
			return out;
		}

		function sftpCall(sftp, method, ...args) {
			return new Promise((resolve, reject) => sftp[method](...args, (err, r) => (err ? reject(err) : resolve(r))));
		}

		async function collectRemote(sftp, remoteBase, relBase, cfg) {
			const out = [];
			async function walk(rdir, relDir) {
				let list;
				try { list = await sftpCall(sftp, "readdir", rdir); }
				catch { return; } // 目录不存在视为空
				for (const f of list) {
					const rel = relDir ? `${relDir}/${f.filename}` : f.filename;
					if (isSyncExcluded(rel, cfg)) continue;
					if (f.attrs.isDirectory()) await walk(`${rdir}/${f.filename}`, rel);
					else if (f.attrs.isFile()) out.push(rel);
				}
			}
			await walk(remoteBase, relBase || "");
			return out;
		}

		async function mkdirpRemote(sftp, rpath) {
			const segs = rpath.split("/").filter(Boolean);
			let cur = rpath.startsWith("/") ? "" : ".";
			for (const s of segs) {
				cur = cur === "." ? s : `${cur}/${s}`;
				await sftpCall(sftp, "mkdir", cur).catch(() => {}); // 已存在会报错，忽略
			}
		}

		/** 执行一次同步任务；返回摘要。progress(onDone, name) 上报进度。 */
		async function runSyncTransfer(cfg, direction, scope, targetRel, onProgress) {
			const sftp = await getSyncSftp(cfg);
			let rels;
			if (scope === "file") {
				rels = [targetRel];
				if (isSyncExcluded(targetRel, cfg)) throw new Error(`「${targetRel}」在排除规则内`);
			} else {
				const baseRel = scope === "tree" ? String(targetRel || "") : "";
				rels = direction === "up"
					? await collectLocal(baseRel, cfg)
					: await collectRemote(sftp, posixJoin(cfg.remoteRoot || "/", baseRel), baseRel, cfg);
			}
			const failed = [];
			let done = 0;
			for (const rel of rels) {
				try {
					if (direction === "up") {
						const rp = posixJoin(cfg.remoteRoot || "/", rel);
						await mkdirpRemote(sftp, rp.split("/").slice(0, -1).join("/"));
						await sftpCall(sftp, "writeFile", rp, await fs.readFile(path.resolve(root, rel)));
					} else {
						const lp = path.resolve(root, rel);
						await fs.mkdir(path.dirname(lp), { recursive: true });
						await fs.writeFile(lp, await sftpCall(sftp, "readFile", posixJoin(cfg.remoteRoot || "/", rel)));
					}
				} catch (err) {
					failed.push({ rel, error: err?.message ?? String(err) });
				}
				done++;
				onProgress(done, rels.length, rel);
			}
			return { total: rels.length, failed };
		}

		// ------------------------------------------------------------------
		// SSH 远程主机（Remote-SSH 模式）
		//
		// 主机 CRUD（<pluginDir>/ssh-hosts.json，明文本机、回显脱敏；首次运行
		// 自动从旧版独立 ssh 插件的同名配置迁移）+ 连接池（keepalive 保活）+
		// PTY shell（base64 流式转发）+ exec。
		// 远程文件操作不设独立 action——客户端在 list/read/write/create/rename/
		// delete 上带 connId 即路由到该连接的 SFTP，与本地文件共用一套前端路径。
		// ssh2 依赖复用上方 ensureSshMod（未安装自动补装）。
		// 事件：shell_data / shell_exit / conn_closed 定向推送创建者 socket；
		// kind:"state" 广播主机/连接列表变化（凭据脱敏）。
		// ------------------------------------------------------------------
		const SSH_STORE = path.join(host.dir, "ssh-hosts.json");
		const LEGACY_SSH_STORE = path.join(host.dir, "..", "ssh", "ssh-hosts.json");
		let sshCfgs = null;
		const sshConns = new Map(); // connId → 连接记录
		let nextSshConn = 1;

		async function ensureSshCfgs() {
			if (sshCfgs) return sshCfgs;
			try {
				sshCfgs = JSON.parse(await fs.readFile(SSH_STORE, "utf8"));
			} catch {
				sshCfgs = {};
			}
			if (!Array.isArray(sshCfgs.hosts)) {
				try { // 迁移旧版独立 ssh 插件的主机列表（同格式直接搬）
					const legacy = JSON.parse(await fs.readFile(LEGACY_SSH_STORE, "utf8"));
					if (Array.isArray(legacy.hosts) && legacy.hosts.length) sshCfgs.hosts = legacy.hosts;
				} catch {}
			}
			if (!Array.isArray(sshCfgs.hosts)) sshCfgs.hosts = [];
			return sshCfgs;
		}

		async function saveSshCfgs() {
			await fs.writeFile(SSH_STORE, JSON.stringify(sshCfgs, null, "\t"), "utf8");
		}

		/** 脱敏回显：密码/私钥不回传，只报是否存在 */
		function publicSshHost(h) {
			return {
				id: h.id, name: h.name, host: h.host, port: h.port ?? 22,
				username: h.username ?? "root",
				hasPass: Boolean(h.password), hasKey: Boolean(h.privateKey),
			};
		}

		function publicSshState() {
			return {
				depsReady: syncDeps.ok,
				depsInstalling: syncDeps.installing,
				hosts: (sshCfgs?.hosts ?? []).map(publicSshHost),
				conns: [...sshConns.values()].map((c) => ({
					connId: c.connId, hostId: c.hostId, label: c.label, status: c.status,
				})),
			};
		}

		function broadcastSshState() {
			host.broadcast({ kind: "state", state: publicSshState() });
		}

		function getSshConn(connId) {
			const c = sshConns.get(connId);
			if (!c) throw new Error("连接不存在或已断开");
			return c;
		}

		function dropSshConn(c, reason) {
			if (!sshConns.has(c.connId)) return;
			sshConns.delete(c.connId);
			for (const [, stream] of c.streams) { try { stream.end(); } catch {} }
			c.streams.clear();
			try { c.client.end(); } catch {}
			host.sendTo(c.ownerId, { event: "conn_closed", connId: c.connId, reason: reason ?? "" });
			broadcastSshState();
		}

		async function connectSshHost(cfg, clientId, reqId) {
			try {
				const mod = await ensureSshMod();
				if (!mod?.Client) throw new Error("ssh2 依赖未就绪，稍候再试");
				const connId = `c${nextSshConn++}`;
				const c = {
					connId, client: new mod.Client(), ownerId: clientId, hostId: cfg.id,
					label: cfg.name || `${cfg.username}@${cfg.host}`,
					status: "connecting", streams: new Map(), nextShell: 1, sftp: null,
				};
				sshConns.set(connId, c);
				broadcastSshState();
				const opts = {
					host: cfg.host, port: Number(cfg.port) || 22,
					username: cfg.username || "root",
					readyTimeout: CONN_TIMEOUT_MS,
					keepaliveInterval: 10000, keepaliveCountMax: 3,
				};
				if (cfg.password) opts.password = cfg.password;
				else if (cfg.privateKey) opts.privateKey = cfg.privateKey;
				c.client
					.on("ready", () => {
						c.status = "connected";
						host.sendTo(clientId, { res: true, reqId, ok: true, action: "connect", connId, label: c.label });
						broadcastSshState();
					})
					.on("error", (err) => {
						const m = err?.level ? `[${err.level}] ${err.message}` : err?.message ?? String(err);
						if (c.status === "connecting") { // 首连失败不留半连接
							sshConns.delete(connId);
							broadcastSshState();
							host.sendTo(clientId, { res: true, reqId, ok: false, action: "connect", error: m });
						} else dropSshConn(c, m);
					})
					.on("close", () => dropSshConn(c, "连接已关闭"));
				c.client.connect(opts);
			} catch (err) {
				host.sendTo(clientId, { res: true, reqId, ok: false, action: "connect", error: err?.message ?? String(err) });
			}
		}

		function getSftp(c) {
			if (c.sftp) return Promise.resolve(c.sftp);
			return new Promise((resolve, reject) => {
				c.client.sftp((err, sftp) => {
					if (err) return reject(err);
					c.sftp = sftp;
					sftp.on("close", () => { if (c.sftp === sftp) c.sftp = null; });
					resolve(sftp);
				});
			});
		}

		// ---- 远程文件操作（经连接的 SFTP；错误统一抛给路由 catch） -----------------
		async function remoteList(c, dirPath) {
			const list = await sftpCall(await getSftp(c), "readdir", dirPath || "/");
			const entries = list.map((f) => ({
				name: f.filename,
				type: f.attrs.isDirectory() ? "dir" : f.attrs.isSymbolicLink() ? "link" : "file",
				size: Number(f.attrs.size ?? 0),
			}));
			entries.sort((a, b) =>
				(a.type === "file" ? 1 : 0) - (b.type === "file" ? 1 : 0) || a.name.localeCompare(b.name));
			return entries;
		}

		async function remoteRead(c, p) {
			const sftp = await getSftp(c);
			const stat = await sftpCall(sftp, "stat", p);
			if (stat.size > MAX_READ_BYTES) throw new Error(`文件超过 ${MAX_READ_BYTES / 1024 / 1024}MB 上限`);
			const buf = await sftpCall(sftp, "readFile", p);
			if (buf.includes(0)) return { binary: true, size: buf.length };
			return { text: decodeBuf(buf), encoding: "utf-8", size: buf.length };
		}

		async function remoteWrite(c, p, text) {
			await sftpCall(await getSftp(c), "writeFile", p, Buffer.from(String(text ?? ""), "utf8"));
		}

		async function remoteCreate(c, p, kind) {
			const sftp = await getSftp(c);
			if (kind === "dir") await sftpCall(sftp, "mkdir", p);
			else await sftpCall(sftp, "writeFile", p, Buffer.alloc(0));
		}

		async function remoteRename(c, p, newName) {
			if (typeof newName !== "string" || !newName.trim()
				|| newName.includes("/") || newName.includes("\\") || newName.includes("..")) {
				throw new Error("非法新名称");
			}
			const idx = p.lastIndexOf("/");
			const parent = idx >= 0 ? p.slice(0, idx) : "";
			await sftpCall(await getSftp(c), "rename", p, parent ? `${parent}/${newName}` : newName);
		}

		async function remoteDelete(c, p, isDir) {
			const sftp = await getSftp(c);
			if (isDir) await sftpCall(sftp, "rmdir", p);
			else await sftpCall(sftp, "unlink", p);
		}

		// ---- PTY shell 与 exec ---------------------------------------------------
		function sshOpenShell(c, msg, reqId, clientId) {
			c.ownerId = clientId; // 重连/多标签后：最新请求者接管该连接的终端输出流
			c.client.shell(
				{ cols: msg.cols ?? 80, rows: msg.rows ?? 24, term: "xterm-256color" },
				(err, stream) => {
					if (err) return void host.sendTo(clientId, { res: true, reqId, ok: false, action: "shell_open", error: err.message });
					const shellId = `s${c.nextShell++}`;
					c.streams.set(shellId, stream);
					const onData = (d) => host.sendTo(c.ownerId, {
						event: "shell_data", connId: c.connId, shellId, b64: d.toString("base64"),
					});
					stream.on("data", onData);
					stream.stderr.on("data", onData);
					stream.on("close", () => {
						c.streams.delete(shellId);
						host.sendTo(c.ownerId, { event: "shell_exit", connId: c.connId, shellId });
					});
					host.sendTo(clientId, { res: true, reqId, ok: true, action: "shell_open", shellId });
				},
			);
		}

		function sshExec(c, cmd, reqId, clientId) {
			c.client.exec(cmd, (err, stream) => {
				if (err) return void host.sendTo(clientId, { res: true, reqId, ok: false, action: "exec", error: err.message });
				const chunks = [];
				stream.on("data", (d) => chunks.push(d.toString("utf8")));
				stream.stderr.on("data", (d) => chunks.push(d.toString("utf8")));
				stream.on("close", (code) => {
					let out = chunks.join("");
					if (out.length > MAX_EXEC_OUTPUT) out = out.slice(0, MAX_EXEC_OUTPUT) + "\n…[截断]";
					host.sendTo(clientId, { res: true, reqId, ok: true, action: "exec", exitCode: code ?? 0, output: out });
				});
			});
		}

		const off = host.onMessage(async (payload, clientId) => {
			const msg = payload ?? {};
			const { action, reqId } = msg;
			try {
				switch (action) {
					case "list": // 单层目录（文件树惰性展开）；带 connId = 远程目录
						if (msg.connId) {
							host.sendTo(clientId, { res: true, reqId, ok: true, action,
								dir: String(msg.dir ?? "/"), entries: await remoteList(getSshConn(msg.connId), msg.dir) });
							break;
						}
						host.sendTo(clientId, { res: true, reqId, ok: true, action,
							dir: toWire(msg.dir ?? ""), entries: await listDir(msg.dir) });
						break;
					case "flatlist":
						host.sendTo(clientId, { res: true, reqId, ok: true, action, ...(await flatList()) });
						break;
					case "read": {
						const r = msg.connId
							? await remoteRead(getSshConn(msg.connId), String(msg.path ?? ""))
							: await readFile(msg.path);
						host.sendTo(clientId, { res: true, reqId, ok: true, action, path: msg.path, ...r });
						break;
					}
					case "write":
						if (msg.connId) await remoteWrite(getSshConn(msg.connId), String(msg.path ?? ""), msg.text);
						else await writeFile(msg.path, msg.text);
						host.sendTo(clientId, { res: true, reqId, ok: true, action, path: msg.path });
						break;
					case "create":
						if (msg.connId) await remoteCreate(getSshConn(msg.connId), String(msg.path ?? ""), msg.kind);
						else await createEntry(msg.path, msg.kind);
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					case "rename":
						if (msg.connId) await remoteRename(getSshConn(msg.connId), String(msg.path ?? ""), msg.newName);
						else await renameEntry(msg.path, msg.newName);
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					case "delete":
						if (msg.connId) await remoteDelete(getSshConn(msg.connId), String(msg.path ?? ""), Boolean(msg.isDir));
						else await deleteEntry(msg.path);
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					case "sync_get": { // 注意：不要与远程 SFTP 操作混用（远程走 list/read + connId）
						const cfgs = await ensureSyncCfgs();
						return void respond(action, reqId, clientId, { config: publicSync(cfgs[root]) });
					}
					case "sync_save": {
						const c = msg.config ?? {};
						if (!c.host || !String(c.host).trim()) throw new Error("主机地址不能为空");
						if (!c.remoteRoot || !String(c.remoteRoot).trim().startsWith("/")) throw new Error("远端根路径必须是绝对路径（以 / 开头）");
						const cfgs = await ensureSyncCfgs();
						const old = cfgs[root] ?? {};
						cfgs[root] = {
							host: String(c.host).trim(), port: Number(c.port) || 22,
							username: c.username ?? old.username ?? "root",
							// 凭据留空 = 沿用旧值；显式 null = 清除
							password: c.password === null ? undefined : (c.password || old.password),
							privateKey: c.privateKey === null ? undefined : (c.privateKey || old.privateKey),
							remoteRoot: String(c.remoteRoot).trim(),
							exclude: Array.isArray(c.exclude) ? c.exclude.map(String) : [],
							uploadOnSave: Boolean(c.uploadOnSave),
						};
						await saveSyncCfgs();
						dropSyncConn(root); // 配置变了，旧连接作废
						return void respond(action, reqId, clientId, { config: publicSync(cfgs[root]) });
					}
					case "sync_test": {
						const cfgs = await ensureSyncCfgs();
						const cfg = cfgs[root];
						if (!cfg?.host) throw new Error("尚未配置同步");
						const sftp = await getSyncSftp(cfg);
						// 探测远端根目录可达
						await sftpCall(sftp, "readdir", cfg.remoteRoot || "/");
						return void respond(action, reqId, clientId, {});
					}
					case "sync_run": {
						const cfgs = await ensureSyncCfgs();
						const cfg = cfgs[root];
						if (!cfg?.host) throw new Error("尚未配置同步——请先点 ☁ → 同步配置");
						const direction = msg.dir === "down" ? "down" : "up";
						const scope = ["file", "tree", "all"].includes(msg.scope) ? msg.scope : "file";
						if (scope === "file") {
							const abs = safeResolve(msg.path);
							if (!abs || abs === root) throw new Error("非法路径");
						}
						const summary = await runSyncTransfer(cfg, direction, scope, msg.path ?? "",
							(done, total, name) => host.sendTo(clientId, { event: "sync_progress", done, total, name }));
						return void respond(action, reqId, clientId, { ...summary, dir: direction, scope });
					}
					// ----------------------------------------------------------------
					// SSH 远程主机管理
					// ----------------------------------------------------------------
					case "state": // 插件状态：主机列表 / 连接列表 / ssh2 依赖状态（脱敏）
						await ensureSshCfgs();
						host.sendTo(clientId, { res: true, reqId, ok: true, action, state: publicSshState() });
						break;
					case "deps_install":
						ensureSshMod(); // 内部幂等，已在装则等待，装完广播 state
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					case "hosts_save": {
						await ensureSshCfgs();
						const h = msg.host ?? {};
						if (!h.host || !String(h.host).trim()) throw new Error("主机地址不能为空");
						if (h.id) {
							const i = sshCfgs.hosts.findIndex((x) => x.id === h.id);
							if (i < 0) throw new Error("主机不存在");
							const old = sshCfgs.hosts[i];
							sshCfgs.hosts[i] = {
								...old,
								name: h.name ?? old.name,
								host: String(h.host).trim() || old.host,
								port: Number(h.port) || old.port,
								username: h.username ?? old.username,
								// 凭据留空 = 沿用旧值；显式 null = 清除
								password: h.password === null ? undefined : (h.password || old.password),
								privateKey: h.privateKey === null ? undefined : (h.privateKey || old.privateKey),
							};
						} else {
							if (!h.password && !h.privateKey) throw new Error("请填写密码或私钥（留空无法认证）");
							if (sshCfgs.hosts.length >= MAX_SSH_HOSTS) throw new Error(`最多保存 ${MAX_SSH_HOSTS} 台主机`);
							sshCfgs.hosts.push({
								id: `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
								name: String(h.name || h.host),
								host: String(h.host).trim(),
								port: Number(h.port) || 22,
								username: String(h.username || "root"),
								password: h.password ? String(h.password) : undefined,
								privateKey: h.privateKey ? String(h.privateKey) : undefined,
							});
						}
						await saveSshCfgs();
						broadcastSshState();
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					}
					case "hosts_delete": {
						await ensureSshCfgs();
						const before = sshCfgs.hosts.length;
						sshCfgs.hosts = sshCfgs.hosts.filter((x) => x.id !== msg.id);
						if (sshCfgs.hosts.length === before) throw new Error("主机不存在");
						await saveSshCfgs();
						for (const c of [...sshConns.values()]) if (c.hostId === msg.id) dropSshConn(c, "主机已删除");
						broadcastSshState();
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					}
					case "connect": {
						await ensureSshCfgs();
						const cfg = sshCfgs.hosts.find((x) => x.id === msg.id);
						if (!cfg) throw new Error("主机不存在");
						void connectSshHost(cfg, clientId, reqId); // ready/error 异步回复，内部已兑底报错
						return;
					}
					case "disconnect":
						dropSshConn(getSshConn(msg.connId), "手动断开");
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					case "shell_open":
						return void sshOpenShell(getSshConn(msg.connId), msg, reqId, clientId);
					case "shell_close": {
						const c = getSshConn(msg.connId);
						c.streams.get(msg.shellId)?.end();
						c.streams.delete(msg.shellId);
						host.sendTo(clientId, { res: true, reqId, ok: true, action });
						break;
					}
					case "shell_input": // 无 reqId 的流式通道：失败静默，不占响应协议
						try { getSshConn(msg.connId).streams.get(msg.shellId)?.write(Buffer.from(String(msg.b64 ?? ""), "base64")); } catch {}
						return;
					case "shell_resize":
						try { getSshConn(msg.connId).streams.get(msg.shellId)?.setWindow(Number(msg.rows) || 24, Number(msg.cols) || 80, 0, 0); } catch {}
						return;
					case "exec":
						return void sshExec(getSshConn(msg.connId), String(msg.cmd ?? ""), reqId, clientId);
					default:
						host.log("unknown action:", action);
						host.sendTo(clientId, fail(reqId, `未知操作 ${action}`));
				}
			} catch (err) {
				host.sendTo(clientId, fail(reqId, err?.message ?? String(err)));
			}
		});

		host.log(`activated; workspace root: ${root}`);
		// 新客户端接入时主动推送完整状态（服务端唯一事实源，对齐主应用快照架构）。
		// host.onAttach 在旧版宿主（<0.35）上不存在——可选链兼容，客户端仍有
		// 带 reqId 的拉取兑底。
		const offAttach = host.onAttach?.((clientId) => {
			void ensureSshCfgs().then(() => {
				host.sendTo(clientId, { kind: "state", state: publicSshState() });
			});
		});
		void ensureSshCfgs().then(() => ensureSshMod()); // 预热：迁移旧 ssh 插件配置 + 预载/自动补装 ssh2（完成后广播 state）
		return () => {
			off();
			try { offAttach?.(); } catch {}
			for (const [, c] of syncConns) {
				try { c.client.end(); } catch {}
			}
			syncConns.clear();
			for (const c of sshConns.values()) {
				try { c.client.end(); } catch {}
			}
			sshConns.clear();
			host.log("deactivated");
		};
	},
};

// 说明：host.cwd 是服务启动时的固定快照（PluginManager 构造注入），
// 编辑器始终以它为工作区根 —— 与底栏显示的工作目录语义一致。
