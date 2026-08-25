/**
 * ssh 插件服务端入口 —— SSH/SFTP 远程管理后端。
 *
 * 依赖 ssh2 不随包分发：首次激活自动 npm 安装到插件目录（同 webmail 模式）。
 *
 * 职责：
 * - 主机配置 CRUD（存 host.dir/ssh-hosts.json，明文本机；回显脱敏只报 hasPass/hasKey）
 * - 连接池：connId → ssh2 Client，keepalive 保活；事件定向推给创建者 socket
 * - PTY shell：shell_open 打开通道，shell_input/resize/close 控制，输出 base64 流式转发
 * - exec：单命令执行，收齐输出与退出码后一次性返回
 * - SFTP：list/read/write/mkdir/rename/delete（文本读写有大小上限与二进制嗅探）
 *
 * 协议：上行 { action, reqId?, ... }；下行两类——
 *   响应 { res: true, reqId, ok, ... }（reqId 匹配）
 *   事件  { event: "conn_closed" | "shell_data" | "shell_exit", ... }（sendTo 创建者）
 */

import { join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFile as rf, writeFile as wf } from "node:fs/promises";

const CONFIG_FILE = "ssh-hosts.json";
const MAX_READ_BYTES = 1024 * 1024; // SFTP 单文件读取上限
const MAX_OUTPUT = 256 * 1024; // exec 输出截断上限
const MAX_HOSTS = 32;
const CONN_TIMEOUT_MS = 15000;

export default {
	activate(host) {
		const st = {
			hosts: [], // [{id,name,host,port,username,password,privateKey}]
			conns: new Map(), // connId → conn 记录
			nextConn: 1,
			deps: null, // ssh2 module
			depsOk: false,
			depsInstalling: false,
		};

		// ------------------------------------------------------------------
		// 主机配置
		// ------------------------------------------------------------------
		async function loadConfig() {
			try {
				const cfg = JSON.parse(await rf(join(host.dir, CONFIG_FILE), "utf8"));
				st.hosts = Array.isArray(cfg.hosts) ? cfg.hosts : [];
			} catch {
				st.hosts = [];
			}
		}
		async function saveConfig() {
			await wf(join(host.dir, CONFIG_FILE), JSON.stringify({ hosts: st.hosts }, null, "\t"), "utf8");
		}

		/** 脱敏回显：密码/私钥不回传，只报是否存在 */
		function publicHost(h) {
			return {
				id: h.id, name: h.name, host: h.host, port: h.port ?? 22,
				username: h.username ?? "root",
				hasPass: Boolean(h.password), hasKey: Boolean(h.privateKey),
			};
		}

		function publicState() {
			return {
				depsOk: st.depsOk,
				depsInstalling: st.depsInstalling,
				hosts: st.hosts.map(publicHost),
				conns: [...st.conns.values()].map((c) => ({
					connId: c.connId, hostId: c.hostId, label: c.label, status: c.status,
				})),
			};
		}

		function broadcastAll() {
			host.broadcast({ kind: "state", state: publicState() });
		}

		function respond(action, reqId, clientId, extra = {}) {
			host.sendTo(clientId, { res: true, reqId, ok: true, action, ...extra });
		}
		function fail(action, reqId, clientId, error) {
			host.sendTo(clientId, { res: true, reqId, ok: false, action, error });
		}

		// ------------------------------------------------------------------
		// 依赖加载 / 自动安装（ssh2）
		// ------------------------------------------------------------------
		async function loadDeps() {
			try {
				const mod = await import("ssh2");
				st.deps = mod.default ?? mod;
				st.depsOk = Boolean(st.deps?.Client);
			} catch (err) {
				host.log("依赖 ssh2 未就绪:", err?.message ?? err);
				st.depsOk = false;
			}
			return st.depsOk;
		}

		function resolveNpmCli() {
			try {
				return createRequire(import.meta.url).resolve("npm/bin/npm-cli.js");
			} catch {
				return null;
			}
		}

		function installDeps(auto = false) {
			if (st.depsInstalling || st.depsOk) return;
			st.depsInstalling = true;
			host.log(`installing deps: ssh2${auto ? " (auto)" : ""}`);
			host.notify("info", "🖥️ SSH 插件：开始安装依赖（ssh2）…");
			const npmCli = resolveNpmCli();
			const args = ["--prefix", host.dir, "install", "ssh2@latest", "--no-audit", "--no-fund"];
			const child = npmCli
				? spawn(process.execPath, [npmCli, ...args], { stdio: "ignore" })
				: spawn("npm", args, { stdio: "ignore", shell: process.platform === "win32" });
			let done = false;
			child.on("error", (err) => finish(false, err.message));
			child.on("exit", (code) => finish(code === 0, `npm exit ${code}`));
			async function finish(ok, why) {
				if (done) return;
				done = true;
				st.depsInstalling = false;
				if (ok) await loadDeps();
				host.notify(
					ok ? "success" : "error",
					ok
						? "🖥️ SSH 插件依赖安装完成"
						: `🖥️ SSH 插件依赖安装失败（${why}）——请在插件目录手动执行 npm install ssh2`,
				);
				broadcastAll();
			}
		}

		// ------------------------------------------------------------------
		// 连接池
		// ------------------------------------------------------------------
		function getConn(connId) {
			const c = st.conns.get(connId);
			if (!c) throw new Error(`连接不存在或已断开：${connId}`);
			return c;
		}

		function dropConn(c, reason) {
			if (!st.conns.has(c.connId)) return;
			st.conns.delete(c.connId);
			for (const [, stream] of c.streams) {
				try { stream.end(); } catch {}
			}
			c.streams.clear();
			try { c.client?.end(); } catch {}
			host.sendTo(c.ownerId, { event: "conn_closed", connId: c.connId, reason: reason ?? "" });
			broadcastAll();
		}

		function connectHost(cfg, clientId, reqId) {
			if (!st.depsOk) throw new Error("依赖 ssh2 未就绪，稍候再试或点「安装依赖」");
			const connId = `c${st.nextConn++}`;
			const client = new st.deps.Client();
			const c = {
				connId, client, ownerId: clientId, hostId: cfg.id,
				label: cfg.name || `${cfg.username}@${cfg.host}`,
				status: "connecting", streams: new Map(), nextShell: 1, sftp: null,
			};
			st.conns.set(connId, c);

			const opts = {
				host: cfg.host,
				port: Number(cfg.port) || 22,
				username: cfg.username || "root",
				readyTimeout: CONN_TIMEOUT_MS,
				keepaliveInterval: 10000,
				keepaliveCountMax: 3,
			};
			if (cfg.password) opts.password = cfg.password;
			else if (cfg.privateKey) opts.privateKey = cfg.privateKey;

			client
				.on("ready", () => {
					c.status = "connected";
					host.sendTo(clientId, { res: true, reqId, ok: true, action: "connect", connId, label: c.label });
					broadcastAll();
				})
				.on("error", (err) => {
					const msgText = err?.level ? `[${err.level}] ${err.message}` : err?.message ?? String(err);
					if (c.status === "connecting") {
						st.conns.delete(connId); // 首连失败不留半连接
						broadcastAll();
						fail("connect", reqId, clientId, msgText);
					} else {
						dropConn(c, msgText);
					}
				})
				.on("close", () => dropConn(c, "连接已关闭"));

			client.connect(opts);
			return c;
		}

		// ------------------------------------------------------------------
		// PTY shell
		// ------------------------------------------------------------------
		function openShell(c, msg, reqId, clientId) {
			c.client.shell(
				{ cols: msg.cols ?? 80, rows: msg.rows ?? 24, term: "xterm-256color" },
				(err, stream) => {
					if (err) return fail("shell_open", reqId, clientId, err.message);
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

		function execCmd(c, cmd, reqId, clientId) {
			c.client.exec(cmd, (err, stream) => {
				if (err) return fail("exec", reqId, clientId, err.message);
				const chunks = [];
				stream.on("data", (d) => chunks.push(d.toString("utf8")));
				stream.stderr.on("data", (d) => chunks.push(d.toString("utf8")));
				stream.on("close", (code) => {
					let out = chunks.join("");
					if (out.length > MAX_OUTPUT) out = out.slice(0, MAX_OUTPUT) + "\n…[截断]";
					host.sendTo(clientId, {
						res: true, reqId, ok: true, action: "exec",
						exitCode: code ?? 0, output: out,
					});
				});
			});
		}

		// ------------------------------------------------------------------
		// SFTP
		// ------------------------------------------------------------------
		function withSftp(c, cb) {
			if (c.sftp) return cb(null, c.sftp);
			c.client.sftp((err, sftp) => {
				if (!err) {
					c.sftp = sftp;
					sftp.on("close", () => { if (c.sftp === sftp) c.sftp = null; });
				}
				cb(err, sftp);
			});
		}

		function looksBinary(buf) {
			const n = Math.min(buf.length, 8000);
			for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
			return false;
		}

		const sftpHandlers = {
			list(c, msg, reply) {
				withSftp(c, (err, sftp) => {
					if (err) return reply(err);
					sftp.readdir(msg.path || ".", (e2, list) => {
						if (e2) return reply(e2);
						const entries = list.map((f) => ({
							name: f.filename,
							type: f.attrs.isDirectory() ? "dir" : f.attrs.isSymbolicLink() ? "link" : "file",
							size: Number(f.attrs.size ?? 0),
							mtime: Number(f.attrs.mtime ?? 0) * 1000,
						}));
						entries.sort((a, b) =>
							(a.type === "file" ? 1 : 0) - (b.type === "file" ? 1 : 0)
							|| a.name.localeCompare(b.name));
						reply(null, { path: msg.path || ".", entries });
					});
				});
			},
			read(c, msg, reply) {
				withSftp(c, (err, sftp) => {
					if (err) return reply(err);
					sftp.stat(msg.path, (e1, stat) => {
						if (e1) return reply(e1);
						if (stat.size > MAX_READ_BYTES) return reply(new Error(`文件超过 ${MAX_READ_BYTES / 1024 / 1024}MB 上限`));
						sftp.readFile(msg.path, (e2, buf) => {
							if (e2) return reply(e2);
							if (looksBinary(buf)) return reply(null, { binary: true, size: buf.length });
							reply(null, { text: buf.toString("utf8"), size: buf.length });
						});
					});
				});
			},
			write(c, msg, reply) {
				withSftp(c, (err, sftp) => {
					if (err) return reply(err);
					sftp.writeFile(msg.path, String(msg.text ?? ""), "utf8", (e) => reply(e, { path: msg.path }));
				});
			},
			mkdir(c, msg, reply) {
				withSftp(c, (err, sftp) => sftp.mkdir(msg.path, (e) => reply(e)));
			},
			rename(c, msg, reply) {
				const nn = String(msg.newName ?? "");
				if (!nn.trim() || nn.includes("/") || nn.includes("\\")) return reply(new Error("非法新名称"));
				withSftp(c, (err, sftp) => {
					if (err) return reply(err);
					const idx = msg.path.lastIndexOf("/");
					const parent = idx >= 0 ? msg.path.slice(0, idx) : "";
					sftp.rename(msg.path, parent ? `${parent}/${nn}` : nn, (e) => reply(e));
				});
			},
			delete(c, msg, reply) {
				withSftp(c, (err, sftp) => {
					if (err) return reply(err);
					const done = (e) => reply(e);
					if (msg.isDir) sftp.rmdir(msg.path, done);
					else sftp.unlink(msg.path, done);
				});
			},
		};

		// ------------------------------------------------------------------
		// 消息路由
		// ------------------------------------------------------------------
		const off = host.onMessage(async (payload, clientId) => {
			const msg = payload ?? {};
			const { action, reqId } = msg;

			// 无 reqId 的流式通道：终端输入 / 缩放（失败静默，不占响应协议）
			switch (action) {
				case "shell_input": {
					try {
						const c = getConn(msg.connId);
						c.streams.get(msg.shellId)?.write(Buffer.from(String(msg.b64 ?? ""), "base64"));
					} catch {}
					return;
				}
				case "shell_resize": {
					try {
						const c = getConn(msg.connId);
						c.streams.get(msg.shellId)?.setWindow(Number(msg.rows) || 24, Number(msg.cols) || 80, 0, 0);
					} catch {}
					return;
				}
				default:
					break;
			}

			const reply = (err, extra) =>
				err ? fail(action, reqId, clientId, err?.message ?? String(err))
					: respond(action, reqId, clientId, extra ?? {});
			try {
				switch (action) {
					case "state":
						return void respond(action, reqId, clientId, { state: publicState() });
					case "deps_install":
						installDeps(false);
						return void respond(action, reqId, clientId, {});
					case "hosts_save": {
						const h = msg.host ?? {};
						if (!h.host || !String(h.host).trim()) throw new Error("主机地址不能为空");
						if (h.id) {
							const i = st.hosts.findIndex((x) => x.id === h.id);
							if (i < 0) throw new Error("主机不存在");
							const old = st.hosts[i];
							st.hosts[i] = {
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
							if (st.hosts.length >= MAX_HOSTS) throw new Error(`最多保存 ${MAX_HOSTS} 台主机`);
							if (!h.password && !h.privateKey && h.useAgent !== true) {
								throw new Error("请填写密码或私钥（留空无法认证）");
							}
							st.hosts.push({
								id: `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
								name: String(h.name || h.host),
								host: String(h.host).trim(),
								port: Number(h.port) || 22,
								username: String(h.username || "root"),
								password: h.password ? String(h.password) : undefined,
								privateKey: h.privateKey ? String(h.privateKey) : undefined,
							});
						}
						await saveConfig();
						broadcastAll();
						return void respond(action, reqId, clientId, {});
					}
					case "hosts_delete": {
						const before = st.hosts.length;
						st.hosts = st.hosts.filter((x) => x.id !== msg.id);
						if (st.hosts.length === before) throw new Error("主机不存在");
						await saveConfig();
						for (const c of [...st.conns.values()]) if (c.hostId === msg.id) dropConn(c, "主机已删除");
						broadcastAll();
						return void respond(action, reqId, clientId, {});
					}
					case "connect": {
						const cfg = st.hosts.find((x) => x.id === msg.id);
						if (!cfg) throw new Error("主机不存在");
						connectHost(cfg, clientId, reqId);
						return; // ready/error 异步回复
					}
					case "disconnect": {
						dropConn(getConn(msg.connId), "手动断开");
						return void respond(action, reqId, clientId, {});
					}
					case "shell_open": {
						const c = getConn(msg.connId);
						return openShell(c, msg, reqId, clientId);
					}
					case "shell_close": {
						const c = getConn(msg.connId);
						c.streams.get(msg.shellId)?.end();
						c.streams.delete(msg.shellId);
						return void respond(action, reqId, clientId, {});
					}
					case "exec": {
						const c = getConn(msg.connId);
						return execCmd(c, String(msg.cmd ?? ""), reqId, clientId);
					}
					case "sftp_list":
					case "sftp_read":
					case "sftp_write":
					case "sftp_mkdir":
					case "sftp_rename":
					case "sftp_delete": {
						const c = getConn(msg.connId);
						return sftpHandlers[action.slice(5)](c, msg, reply);
					}
					default:
						return void fail(action, reqId, clientId, `未知操作 ${action}`);
				}
			} catch (err) {
				fail(action, reqId, clientId, err?.message ?? String(err));
			}
		});

		void loadConfig().then(async () => {
			const ok = await loadDeps();
			if (!ok) installDeps(true);
		});

		host.log("activated");
		return () => {
			off();
			for (const c of st.conns.values()) {
				try { c.client.end(); } catch {}
			}
			st.conns.clear();
		};
	},
};
