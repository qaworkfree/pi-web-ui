/**
 * 左栏删除功能协议冒烟（零 token）：
 *   - delete_session：删除 <agentDir>/sessions/ 下的会话文件（磁盘验证 + sessions 列表刷新）
 *   - delete_session 越界路径（会话目录之外）：报错且不动文件
 *   - remove_project：把工作区从最近项目列表移出（projects 消息不再包含）
 * 自起编译后的 server（隔离端口 8967 + 临时 data-dir + 临时 agent-dir），自行清理。
 */
import { portUp } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = 8967;
const URL = `ws://localhost:${PORT}/ws`;

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

// 两个工作区：workDir 是 PI_WEB_CWD；otherDir 只作为最近项目条目存在
const baseTmp = mkdtempSync(join(tmpdir(), "pi-web-lp-del-"));
const workDir = join(baseTmp, "proj");
const otherDir = join(baseTmp, "other");
mkdirSync(workDir, { recursive: true });
mkdirSync(otherDir, { recursive: true });
writeFileSync(join(workDir, "a.txt"), "keep me");

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-lp-del-data-"));
const agentDir = join(baseTmp, "agent");

// 种两个会话文件（workDir 一条 + otherDir 一条），格式与 pi CLI/TUI 相同
function seedSession(dirName, id, cwd, text) {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const dir = join(agentDir, "sessions", dirName ?? safePath);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `2026-08-04T00-00-00-000Z_${id}.jsonl`);
	writeFileSync(
		file,
		[
			JSON.stringify({
				type: "session",
				version: 3,
				id,
				timestamp: "2026-08-04T00:00:00.000Z",
				cwd,
			}),
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "2026-08-04T00:00:01.000Z",
				message: {
					role: "user",
					content: [{ type: "text", text }],
					timestamp: 1722700801000,
				},
			}),
		].join("\n") + "\n",
	);
	return file;
}
const sess1 = seedSession(null, "del-target", workDir, "要删除的对话");
const sess2 = seedSession(null, "del-keep", workDir, "要保留的对话");
const sessOther = seedSession(null, "del-other", otherDir, "另一个项目的对话");

let server = null;

async function startServer() {
	server = spawn("node", ["dist/server/index.js"], {
		cwd: REPO_ROOT,
		env: {
			...process.env,
			PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_CODING_AGENT_DIR: agentDir,
			PI_WEB_CWD: workDir,
		},
		stdio: "ignore",
	});
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		try {
			if (await portUp(PORT)) return;
		} catch {
			// not up yet
		}
	}
	throw new Error("server did not start");
}

function connect() {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(URL);
		const inbox = [];
		const waiters = [];
		const api = {
			ws,
			async next(pred, what, ms = 8000) {
				const existing = inbox.findIndex(pred);
				if (existing >= 0) return inbox.splice(existing, 1)[0];
				return new Promise((res, rej) => {
					const t = setTimeout(
						() => rej(new Error(`timeout waiting for ${what}`)),
						ms,
					);
					waiters.push((m) => {
						if (pred(m)) {
							clearTimeout(t);
							res(m);
							return true;
						}
						return false;
					});
				});
			},
			send(m) {
				ws.send(JSON.stringify(m));
			},
		};
		ws.onopen = () => {
			api.send({ type: "hello", clientId: "lp-del-test" });
			resolve(api);
		};
		ws.onmessage = (ev) => {
			let msg;
			try {
				msg = JSON.parse(String(ev.data));
			} catch {
				return;
			}
			inbox.push(msg);
			for (let i = 0; i < waiters.length; i++) {
				if (waiters[i](msg)) {
					waiters.splice(i, 1);
					i--;
				}
			}
		};
		ws.onerror = reject;
	});
}

async function run() {
	await startServer();
	await sleep(300);
	const c = await connect();

	// 1) list_sessions 发现种下的两条（当前项目 workDir）
	c.send({ type: "list_sessions" });
	const s1 = await c.next((m) => m.type === "sessions", "sessions #1");
	const paths1 = (s1.sessions ?? []).map((x) => x.path);
	check("list_sessions 命中两条种子会话", paths1.includes(sess1) && paths1.includes(sess2), paths1.join(","));

	// 2) delete_session 删除一条 → 磁盘消失 + 列表刷新只剩一条
	// （attach 后有防抖的后台重复推送，必须等“确实不含被删项”的那一份）
	c.send({ type: "delete_session", path: sess1 });
	const s2 = await c.next(
		(m) =>
			m.type === "sessions" &&
			!(m.sessions ?? []).some((x) => x.path === sess1),
		"sessions #2（不含被删项）",
	);
	const paths2 = (s2.sessions ?? []).map((x) => x.path);
	check("删除后文件从磁盘消失", !existsSync(sess1), sess1);
	check("删除后列表不再包含该会话", !paths2.includes(sess1), paths2.join(","));
	check("另一条会话仍在", paths2.includes(sess2));

	// 3) 越界路径拒绝：会话目录之外的文件不能删
	c.send({ type: "delete_session", path: join(workDir, "a.txt") });
	const n1 = await c.next(
		(m) => m.type === "notice" && m.level === "error",
		"error notice",
	);
	check("越界删除返回错误提示", typeof n1.text === "string" && n1.text.length > 0, n1.text);
	check("越界文件未被删除", existsSync(join(workDir, "a.txt")));

	// 4) remove_project：最近项目列表移除 otherDir
	c.send({ type: "list_projects" });
	const p1 = await c.next((m) => m.type === "projects", "projects #1");
	const projPaths1 = (p1.projects ?? []).map((x) => x.path);
	check("初始最近项目含 otherDir", projPaths1.includes(otherDir), projPaths1.join(","));

	c.send({ type: "remove_project", path: otherDir });
	const p2 = await c.next(
		(m) =>
			m.type === "projects" &&
			!(m.projects ?? []).some((x) => x.path === otherDir),
		"projects #2（不含 otherDir）",
	);
	const projPaths2 = (p2.projects ?? []).map((x) => x.path);
	check("移除后最近项目不含 otherDir", !projPaths2.includes(otherDir), projPaths2.join(","));
	check("移除只动 UI 状态，目录仍在磁盘", existsSync(otherDir));

	// 5) 移除是持久的：重连后再查一次
	const c2 = await connect();
	c2.send({ type: "list_projects" });
	const p3 = await c2.next((m) => m.type === "projects", "projects #3");
	check(
		"重连后 otherDir 仍不在最近项目里",
		!(p3.projects ?? []).some((x) => x.path === otherDir),
	);

	c.ws.close();
	c2.ws.close();
}

try {
	await run();
} catch (err) {
	console.error("FATAL:", err?.message ?? err);
	failures++;
} finally {
	if (server?.pid) process.kill(server.pid, "SIGTERM");
	await sleep(500);
}
process.exit(failures === 0 ? 0 : 1);
