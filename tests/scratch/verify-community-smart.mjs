import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const PORT = 8974;
const serverPath = realpathSync(process.execPath);
const repoRoot = join(import.meta.dirname, "..", "..");
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-vsc-verify-"));
const workspace = join(dataDir, "workspace");
mkdirSync(join(workspace, ".vscode"), { recursive: true });

// 拷入用户的真实配置
cpSync("/Volumes/P/project/community_smart/.vscode/sftp.json", join(workspace, ".vscode", "sftp.json"));

const plugDst = join(dataDir, "plugins", "vscode-editor");
mkdirSync(plugDst, { recursive: true });
cpSync(join(repoRoot, "dev", "plugins", "vscode-editor", "manifest.json"), join(plugDst, "manifest.json"));
cpSync(join(repoRoot, "dev", "plugins", "vscode-editor", "index.mjs"), join(plugDst, "index.mjs"));
cpSync(join(repoRoot, "dev", "plugins", "vscode-editor", "client"), join(plugDst, "client"), { recursive: true });

let proc = null;
function cleanup() { try { proc && proc.kill("SIGTERM"); } catch {} try { rmSync(dataDir, { recursive: true, force: true }); } catch {} }
function connect() {
	return new Promise((resolve, reject) => {
		const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const t = setTimeout(() => reject(new Error("connect timeout")), 15_000);
		sock.on("open", () => sock.send(JSON.stringify({ type: "hello", clientId: "verify" })));
		sock.on("message", (raw) => { const m = JSON.parse(raw.toString()); if (m.type === "plugins") { clearTimeout(t); resolve(sock); } });
		sock.on("error", reject);
	});
}
function rpc(sock, payload) {
	return new Promise((resolve, reject) => {
		const reqId = `t${Math.random().toString(36).slice(2)}`;
		const t = setTimeout(() => reject(new Error("rpc timeout")), 10_000);
		const onMsg = (raw) => { const m = JSON.parse(raw.toString()); if (m.type === "plugin_data" && m.payload?.res && m.payload?.reqId === reqId) { clearTimeout(t); sock.off("message", onMsg); resolve(m.payload); } };
		sock.on("message", onMsg);
		sock.send(JSON.stringify({ type: "plugin_message", pluginId: "vscode-editor", payload: { ...payload, reqId } }));
	});
}

(async () => {
	proc = spawn(serverPath, [join(repoRoot, "dist", "server", "index.js")], { env: { ...process.env, PORT: String(PORT), PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: workspace }, stdio: ["ignore", "pipe", "pipe"] });
	proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
	await new Promise((r) => setTimeout(r, 2500));
	const sock = await connect();
	const r = await rpc(sock, { action: "sync_get" });
	console.log("同步配置归一化结果：");
	console.log(JSON.stringify(r.config, null, 2));
	if (!r.ok) { console.error("✗ sync_get 失败:", r.error); cleanup(); process.exit(1); }
	console.log("\n✓ 配置可被编辑器插件正确识别（configured =", r.config.configured + "）");
	cleanup();
	process.exit(0);
})().catch((e) => { console.error("✗", e?.message ?? e); cleanup(); process.exit(1); });
