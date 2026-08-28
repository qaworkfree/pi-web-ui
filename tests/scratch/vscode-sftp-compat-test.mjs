/**
 * 一次性验证：vscode-sftp / Natizyskunk.sftp 风格的 .vscode/sftp.json
 * 能被编辑器插件正确识别（~ 密钥路径、watcher.autoUpload、name、agent 占位符）。
 * 零 token，自起隔离端口 server。运行：node tests/scratch/vscode-sftp-compat-test.mjs
 */
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const PORT = 8973;
const BASE = `http://127.0.0.1:${PORT}`;
const serverPath = realpathSync(process.execPath);
const repoRoot = join(import.meta.dirname, "..", "..");
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-vsc-compat-"));
const workspace = join(dataDir, "workspace");
mkdirSync(join(workspace, ".vscode"), { recursive: true });

// 写入一个 vscode-sftp 风格配置（用 ~ 密钥路径 + 旧版 watcher.autoUpload）
const cfg = {
	name: "prod",
	host: "203.0.113.10",
	port: 22,
	username: "deploy",
	privateKeyPath: "~/.ssh/id_rsa",
	remotePath: "/srv/www",
	protocol: "sftp",
	watcher: { files: "**/*", autoUpload: true },
	ignore: [".vscode", "node_modules", "dist/*.map"],
};
writeFileSync(join(workspace, ".vscode", "sftp.json"), JSON.stringify(cfg, null, 2));

const plugDst = join(dataDir, "plugins", "vscode-editor");
mkdirSync(plugDst, { recursive: true });
cpSync(join(repoRoot, "dev", "plugins", "vscode-editor", "manifest.json"), join(plugDst, "manifest.json"));
cpSync(join(repoRoot, "dev", "plugins", "vscode-editor", "index.mjs"), join(plugDst, "index.mjs"));
cpSync(join(repoRoot, "dev", "plugins", "vscode-editor", "client"), join(plugDst, "client"), { recursive: true });

let proc = null;
function fail(m) { console.error("✗", m); cleanup(); process.exit(1); }
function cleanup() { try { proc && proc.kill("SIGTERM"); } catch {} try { rmSync(dataDir, { recursive: true, force: true }); } catch {} }

function connect() {
	return new Promise((resolve, reject) => {
		const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const t = setTimeout(() => reject(new Error("connect timeout")), 15_000);
		sock.on("open", () => { sock.send(JSON.stringify({ type: "hello", clientId: "compat" })); });
		sock.on("message", (raw) => {
			const m = JSON.parse(raw.toString());
			if (m.type === "plugins") { clearTimeout(t); resolve(sock); }
		});
		sock.on("error", reject);
	});
}
function rpc(sock, payload) {
	return new Promise((resolve, reject) => {
		const reqId = `t${Math.random().toString(36).slice(2)}`;
		const t = setTimeout(() => reject(new Error("rpc timeout")), 10_000);
		const onMsg = (raw) => {
			const m = JSON.parse(raw.toString());
			if (m.type === "plugin_data" && m.payload?.res && m.payload?.reqId === reqId) {
				clearTimeout(t); sock.off("message", onMsg); resolve(m.payload);
			}
		};
		sock.on("message", onMsg);
		sock.send(JSON.stringify({ type: "plugin_message", pluginId: "vscode-editor", payload: { ...payload, reqId } }));
	});
}

(async () => {
	proc = spawn(serverPath, [join(repoRoot, "dist", "server", "index.js")], {
		env: { ...process.env, PORT: String(PORT), PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: workspace },
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
	// 等 WS 就绪
	await new Promise((r) => setTimeout(r, 2500));
	const sock = await connect();

	const r = await rpc(sock, { action: "sync_get" });
	if (!r.ok) fail(`sync_get 失败: ${r.error}`);
	const c = r.config;
	console.log("normalize 结果:", JSON.stringify(c, null, 2));

	if (c.name !== "prod") fail(`name 未保留: ${c.name}`);
	if (c.uploadOnSave !== true) fail(`watcher.autoUpload 未映射到 uploadOnSave: ${c.uploadOnSave}`);
	if (c.remoteRoot !== "/srv/www") fail(`remoteRoot 错: ${c.remoteRoot}`);
	if (!Array.isArray(c.exclude) || !c.exclude.includes("node_modules")) fail(`exclude 错: ${JSON.stringify(c.exclude)}`);
	if (c.privateKeyPath !== "~/.ssh/id_rsa") fail(`privateKeyPath 不应被展开: ${c.privateKeyPath}`);

	// 回写（带 agent）再读，验证 round-trip 不丢字段
	const save = await rpc(sock, { action: "sync_save", config: {
		host: "203.0.113.10", port: 22, username: "deploy",
		privateKeyPath: "~/.ssh/id_rsa", remoteRoot: "/srv/www",
		exclude: [".vscode", "node_modules"], uploadOnSave: true,
		name: "prod", agent: "$SSH_AUTH_SOCK",
	} });
	if (!save.ok) fail(`sync_save 失败: ${save.error}`);
	const r2 = await rpc(sock, { action: "sync_get" });
	if (r2.config.agent !== "$SSH_AUTH_SOCK") fail(`agent 未回写: ${r2.config.agent}`);
	if (r2.config.name !== "prod") fail(`name 未回写: ${r2.config.name}`);

	// 磁盘落盘内容应为 vscode-sftp 兼容写法
	const onDisk = JSON.parse(readFileSync(join(workspace, ".vscode", "sftp.json"), "utf8"));
	console.log("落盘内容:", JSON.stringify(onDisk));
	if (onDisk.agent !== "$SSH_AUTH_SOCK") fail(`落盘丢失 agent: ${JSON.stringify(onDisk)}`);
	if (onDisk.name !== "prod") fail(`落盘丢失 name: ${JSON.stringify(onDisk)}`);
	if (onDisk.uploadOnSave !== true) fail(`落盘丢失 uploadOnSave`);

	console.log("✓ vscode-sftp 兼容配置正确识别 / 回写 / 落盘");
	cleanup();
	process.exit(0);
})().catch((e) => fail(e?.message ?? String(e)));
