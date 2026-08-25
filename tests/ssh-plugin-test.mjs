/**
 * ssh 插件协议冒烟测试（零 token、自包含）。
 *
 * 用 ssh2 自带的 Server 在进程内起一个 mock SSH 远端（密码认证 + PTY shell
 * 回显 + exec + 内存 SFTP），把 dev/plugins/ssh 拷进临时 data-dir 并离线补装
 * ssh2（从本仓库构建目录拷贝 node_modules 子集），起隔离端口 server 验证：
 * - state / hosts_save（校验+脱敏）/ hosts_delete
 * - connect：错误密码拒绝、正确密码建立
 * - shell_open → 欢迎横幅；shell_input 回显
 * - exec 输出与退出码
 * - sftp list/read/write/mkdir/rename/delete 全链路（内存文件系统核对）
 * - disconnect → conn_closed 事件
 *
 * 运行：先 npm run build:server，再 node tests/ssh-plugin-test.mjs
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startMockSsh, dirs as mDirs, files as mFiles, ensurePluginSsh2Dep } from "./lib/mock-ssh.mjs";
import WebSocket from "ws";

const PORT = 8964;
const SSH_PORT = 22964;
const BASE = `http://127.0.0.1:${PORT}`;
const REPO = fileURLDirname(import.meta.url);

function fileURLDirname(u) {
	return realpathSync(new globalThis.URL("..", u).pathname.replace(/^\/(?=[A-Za-z]:)/, ""));
}

const serverPath = realpathSync(process.execPath);
let proc = null;
let sshServer = null;
let shells = [];
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-ssh-test-"));
const plugDst = join(dataDir, "plugins", "ssh");

// ---- 内存远端 FS -----------------------------------------------------------
const dirs = {
	"/": ["home"], "/home": ["test"],
	"/home/test": ["a.txt", "sub", "big.bin"], "/home/test/sub": [],
};
const files = {
	"/home/test/a.txt": Buffer.from("hello ssh\n第二行\n", "utf8"),
	"/home/test/big.bin": Buffer.from([0x00, 0x01, 0x02, 0x00]),
};

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exitCode = 1;
}

// ---- 种插件目录 + 离线补装 ssh2 --------------------------------------------
mkdirSync(plugDst, { recursive: true });
cpSync(join(REPO, "dev/plugins/ssh/manifest.json"), join(plugDst, "manifest.json"));
cpSync(join(REPO, "dev/plugins/ssh/index.mjs"), join(plugDst, "index.mjs"));
cpSync(join(REPO, "dev/plugins/ssh/client"), join(plugDst, "client"), { recursive: true });
// 准备 ssh2 依赖：离线拷本地构建目录；CI 上回退 npm install
ensurePluginSsh2Dep(plugDst, join(REPO, "dev/plugins/ssh"));

// ---- 内嵌 SSH mock 远端（共享库） -------------------------------------------

// ---- WS 工具 ----------------------------------------------------------------
function connect(clientId = "ssh-test") {
	return new Promise((resolve, reject) => {
		const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => reject(new Error("connect timeout")), 15_000);
		sock.on("open", () => sock.send(JSON.stringify({ type: "hello", clientId })));
		sock.on("message", (raw) => {
			if (JSON.parse(raw.toString()).type === "ready") {
				clearTimeout(timer);
				resolve(sock);
			}
		});
		sock.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

function rpc(sock, payload, timeoutMs = 25_000) {
	return new Promise((resolve, reject) => {
		const reqId = `t${Math.random().toString(36).slice(2)}`;
		const timer = setTimeout(() => reject(new Error(`rpc timeout: ${payload.action}`)), timeoutMs);
		const onMsg = (raw) => {
			const msg = JSON.parse(raw.toString());
			if (msg.type === "plugin_data" && msg.pluginId === "ssh" && msg.payload?.res && msg.payload?.reqId === reqId) {
				clearTimeout(timer);
				sock.off("message", onMsg);
				resolve(msg.payload);
			}
		};
		sock.on("message", onMsg);
		sock.send(JSON.stringify({ type: "plugin_message", pluginId: "ssh", payload: { ...payload, reqId } }));
	});
}

/** 收集事件直到谓词命中或超时。 */
function waitForEvent(sock, pred, label, timeoutMs = 15000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			sock.off("message", onMsg);
			reject(new Error(`timeout waiting for event: ${label}`));
		}, timeoutMs);
		const onMsg = (raw) => {
			const m = JSON.parse(raw.toString());
			if (m.type === "plugin_data" && m.pluginId === "ssh" && m.payload?.event && pred(m.payload)) {
				clearTimeout(timer);
				sock.off("message", onMsg);
				resolve(m.payload);
			}
		};
		sock.on("message", onMsg);
	});
}

/** 等到某条 shell_data 的累计输出里出现指定文本。 */
async function expectShellText(sock, connId, text, timeoutMs = 15000) {
	let acc = "";
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			sock.off("message", onMsg);
			reject(new Error(`shell 未出现「${text}」，实际累计：${JSON.stringify(acc.slice(-300))}`));
		}, timeoutMs);
		const onMsg = (raw) => {
			const m = JSON.parse(raw.toString());
			const p = m.payload;
			if (m.type === "plugin_data" && p?.event === "shell_data" && p.connId === connId) {
				acc += Buffer.from(p.b64, "base64").toString("utf8");
				if (acc.includes(text)) {
					clearTimeout(timer);
					sock.off("message", onMsg);
					resolve(acc);
				}
			}
		};
		sock.on("message", onMsg);
	});
}

// ---- 主流程 ------------------------------------------------------------------
try {
	sshServer = await startMockSsh(plugDst, SSH_PORT);

	proc = spawn(serverPath, [join(REPO, "dist", "server", "index.js")], {
		env: { ...process.env, PORT: String(PORT), PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: dataDir },
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

	await new Promise((resolve, reject) => {
		const t0 = Date.now();
		const probe = async () => {
			try {
				const r = await fetch(`${BASE}/api/health`);
				if (r.ok) return resolve();
			} catch {}
			if (Date.now() - t0 > 20_000) return reject(new Error("server not ready"));
			setTimeout(probe, 300);
		};
		void probe();
	});

	let sock = await connect();

	// -- 1. state：初始状态 + 依赖已就绪（我们拷了 ssh2） ------------------------
	let r = await rpc(sock, { action: "state" });
	if (!r.ok || !Array.isArray(r.state?.hosts)) fail(`state 异常: ${JSON.stringify(r)}`);
	else if (!r.state.depsOk) fail("deps 应已就绪（已离线拷贝 ssh2）");
	else console.log("✓ state 初始返回，ssh2 依赖就绪");

	// -- 2. 主机配置：校验 + 脱敏 -------------------------------------------------
	r = await rpc(sock, { action: "hosts_save", host: { name: "", host: "" } });
	if (r.ok) fail("空主机地址应被拒绝");
	else console.log("✓ 空 host 校验拒绝");

	r = await rpc(sock, {
		action: "hosts_save",
		host: { name: "bad", host: "127.0.0.1", port: SSH_PORT, username: "tester", password: "wrong" },
	});
	if (!r.ok) fail(`hosts_save bad 失败: ${r.error}`);

	r = await rpc(sock, {
		action: "hosts_save",
		host: { name: "local", host: "127.0.0.1", port: SSH_PORT, username: "tester", password: "secret123" },
	});
	if (!r.ok) fail(`hosts_save 失败: ${r.error}`);
	r = await rpc(sock, { action: "state" });
	const goodHost = r.state.hosts.find((h) => h.name === "local");
	const badHost = r.state.hosts.find((h) => h.name === "bad");
	if (!goodHost || !goodHost.hasPass || goodHost.password !== undefined) fail(`主机回显应脱敏: ${JSON.stringify(goodHost)}`);
	else console.log("✓ hosts_save 落盘 + 回显脱敏（password 不回传）");

	// 配置文件确实写盘且含真实密码（本机明文约定）
	const cfgRaw = readFileSync(join(dataDir, "plugins", "ssh", "ssh-hosts.json"), "utf8");
	if (!cfgRaw.includes("secret123")) fail("配置未落盘");
	else console.log("✓ ssh-hosts.json 落盘（本机明文约定）");

	// -- 3. 连接：错误密码拒绝 ----------------------------------------------------
	r = await rpc(sock, { action: "connect", id: badHost.id }, 30_000);
	if (r.ok) fail("错误密码不应连上");
	else console.log(`✓ 错误密码连接被拒（${r.error.slice(0, 40)}…）`);

	// -- 4. 正确密码连接 ----------------------------------------------------------
	r = await rpc(sock, { action: "connect", id: goodHost.id }, 30_000);
	if (!r.ok || !r.connId) fail(`connect 失败: ${JSON.stringify(r)}`);
	else console.log(`✓ 连接成功 connId=${r.connId}`);
	const connId = r.connId;

	// -- 5. PTY shell：横幅 + 输入回显 ---------------------------------------------
	r = await rpc(sock, { action: "shell_open", connId, cols: 120, rows: 30 });
	if (!r.ok || !r.shellId) fail(`shell_open 失败: ${JSON.stringify(r)}`);
	const banner = await expectShellText(sock, connId, "welcome-to-mock");
	console.log("✓ shell 打开并收到欢迎横幅");

	sock.send(JSON.stringify({
		type: "plugin_message", pluginId: "ssh",
		payload: { action: "shell_input", connId, shellId: r.shellId, b64: Buffer.from("ping-test\r").toString("base64") },
	}));
	await expectShellText(sock, connId, "echo:ping-test");
	console.log("✓ 终端输入回显正常");

	// -- 6. exec --------------------------------------------------------------------
	r = await rpc(sock, { action: "exec", connId, cmd: 'echo abc-123' });
	if (!r.ok || r.exitCode !== 0 || !r.output.includes("abc-123")) fail(`exec 异常: ${JSON.stringify(r)}`);
	else console.log("✓ exec 输出与退出码 0");

	r = await rpc(sock, { action: "exec", connId, cmd: "fail-now" });
	if (!r.ok || r.exitCode !== 7 || !r.output.includes("boom")) fail(`exec 失败命令异常: ${JSON.stringify(r)}`);
	else console.log("✓ exec 非零退出码 + stderr 合并");

	// -- 7. SFTP list ------------------------------------------------------------------
	r = await rpc(sock, { action: "sftp_list", connId, path: "/home/test" });
	if (!r.ok) fail(`sftp_list 失败: ${r.error}`);
	else {
		const names = r.entries.map((e) => e.name);
		if (!(names.includes("a.txt") && names.includes("sub") && names.includes("big.bin"))) fail(`列表缺项: ${names}`);
		else if (r.entries[r.entries.length - 1].type !== "file") fail("文件应排在目录后");
		else console.log(`✓ sftp_list ${names.join(", ")}`);
	}

	// -- 8. SFTP read --------------------------------------------------------------------
	r = await rpc(sock, { action: "sftp_read", connId, path: "/home/test/a.txt" });
	if (!r.ok || r.text !== "hello ssh\n第二行\n") fail(`sftp_read 文本异常: ${JSON.stringify(r)}`);
	else console.log("✓ sftp_read 文本内容");

	r = await rpc(sock, { action: "sftp_read", connId, path: "/home/test/big.bin" });
	if (!r.ok || r.binary !== true) fail(`二进制嗅探异常: ${JSON.stringify(r)}`);
	else console.log("✓ sftp_read 二进制标记（NUL 嗅探）");

	// -- 9. SFTP write → 读回核对 ---------------------------------------------------------
	r = await rpc(sock, { action: "sftp_write", connId, path: "/home/test/b.txt", text: "written-by-test 中文" });
	if (!r.ok) fail(`sftp_write 失败: ${r.error}`);
	r = await rpc(sock, { action: "sftp_read", connId, path: "/home/test/b.txt" });
	if (!r.ok || r.text !== "written-by-test 中文") fail(`write→read 不一致: ${JSON.stringify(r)}`);
	else console.log("✓ sftp_write 写入后读回一致（UTF-8）");

	// -- 10. mkdir / rename / delete --------------------------------------------------------
	r = await rpc(sock, { action: "sftp_mkdir", connId, path: "/home/test/newdir" });
	if (!r.ok || !mDirs["/home/test/newdir"]) fail(`mkdir 异常: ${JSON.stringify(r)}`);
	else console.log("✓ sftp_mkdir");

	r = await rpc(sock, { action: "sftp_rename", connId, path: "/home/test/b.txt", newName: "renamed.txt" });
	if (!r.ok || !mFiles["/home/test/renamed.txt"] || mFiles["/home/test/b.txt"]) fail(`rename 异常: ${JSON.stringify(r)}`);
	else console.log("✓ sftp_rename");

	r = await rpc(sock, { action: "sftp_delete", connId, path: "/home/test/renamed.txt", isDir: false });
	if (!r.ok || mFiles["/home/test/renamed.txt"]) fail(`delete 异常: ${JSON.stringify(r)}`);
	else console.log("✓ sftp_delete 文件");

	// rename 含路径分隔符应拒绝
	r = await rpc(sock, { action: "sftp_rename", connId, path: "/home/test/sub", newName: "../evil" });
	if (r.ok) fail("rename ../ 应拒绝");
	else console.log("✓ rename 非法名称拒绝");

	// -- 11. disconnect → conn_closed --------------------------------------------------------
	const closedP = waitForEvent(sock, (p) => p.event === "conn_closed" && p.connId === connId, "conn_closed");
	await rpc(sock, { action: "disconnect", connId });
	await closedP;
	console.log("✓ disconnect 触发 conn_closed 事件");

	// -- 12. hosts_delete --------------------------------------------------------------------
	r = await rpc(sock, { action: "hosts_delete", id: badHost.id });
	if (!r.ok) fail(`hosts_delete 失败: ${r.error}`);
	r = await rpc(sock, { action: "state" });
	if (r.state.hosts.some((h) => h.id === badHost.id)) fail("主机未删除");
	else console.log("✓ hosts_delete");

	// -- 13. 未知 action ------------------------------------------------------------------------
	r = await rpc(sock, { action: "no-such" });
	if (r.ok) fail("未知 action 应失败");
	else console.log("✓ 未知 action 报错不崩");

	sock.close();
} catch (err) {
	fail(err.message);
	console.error(err);
} finally {
	try {
		for (const s of shells) try { s.end(); } catch {}
		sshServer?.close();
		if (proc?.pid) process.kill(proc.pid, "SIGTERM");
	} catch {}
	await sleep(500);
	rmSync(dataDir, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
