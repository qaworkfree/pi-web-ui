/**
 * 用户钩子（user hooks）端到端回归：
 *
 *   save_user_hooks → settings_state.userHooks 回显（归一化后）
 *     → pre-tool blocking 钩子退出码 2 → bash 调用被拒（结果带钩子理由给模型）
 *     → 钩子停用后 bash 恢复放行
 *     → post-tool / turn-end 观察钩子真的跑了（落盘探针文件）
 *     → prompt-submit blocking 钩子退出码 2 → 消息被拦（warning notice，不进模型）
 *
 * 零 token：本地 mock LLM（openai-completions SSE），只验接线与闸门。
 */
import { createServer } from "node:http";
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { freePort, portUp } from "./lib/port-utils.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PORT = 8918;
const CLIENT_ID = "hooks-test-client";

let failures = 0;
function check(name, ok, extra = "") {
	console.log((ok ? "✓ " : "✗ ") + name + (extra ? " — " + extra : ""));
	if (!ok) failures++;
}

// ── mock LLM：按脚本依次回工具调用 / 文本 ────────────────────────────────
let script = [];
const delta = (model, d, finish = null) => ({
	id: "chatcmpl-mock",
	object: "chat.completion.chunk",
	created: Math.floor(Date.now() / 1000),
	model,
	choices: [{ index: 0, delta: d, finish_reason: finish }],
});
const sse = (res, chunks) => {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const c of chunks) res.write("data: " + JSON.stringify(c) + "\n\n");
	res.write(
		"data: " +
			JSON.stringify({
				id: "chatcmpl-mock",
				object: "chat.completion.chunk",
				created: Math.floor(Date.now() / 1000),
				model: "mock-model",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
			}) +
			"\n\n",
	);
	res.write("data: [DONE]\n\n");
	res.end();
};
const toolCall = (model, name, args) =>
	delta(model, {
		tool_calls: [
			{ index: 0, id: "call_" + name, type: "function", function: { name, arguments: JSON.stringify(args) } },
		],
	});

const mockServer = createServer((req, res) => {
	if (req.method === "GET") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ data: [] }));
		return;
	}
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		const payload = JSON.parse(body || "{}");
		const messages = Array.isArray(payload.messages) ? payload.messages : [];
		const model = payload.model ?? "mock-model";
		const lastUser = messages.map((m) => m.role).lastIndexOf("user");
		const tail = messages.slice(lastUser + 1);
		if (tail.some((m) => m.role === "tool")) {
			const toolMsg = [...tail].reverse().find((m) => m.role === "tool");
			sse(res, [delta(model, { content: "SEEN:" + String(toolMsg.content ?? "") }), delta(model, {}, "stop")]);
			return;
		}
		if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
			sse(res, [delta(model, { content: "ok" }), delta(model, {}, "stop")]);
			return;
		}
		const step = script.shift();
		if (!step) {
			sse(res, [delta(model, { content: "done" }), delta(model, {}, "stop")]);
			return;
		}
		sse(res, [toolCall(model, step.name, step.args), delta(model, {}, "tool_calls")]);
	});
});
await new Promise((r) => mockServer.listen(0, "127.0.0.1", r));
const MOCK_PORT = mockServer.address().port;

const baseDir = mkdtempSync(join(tmpdir(), "pi-hooks-test-"));
const workDir = join(baseDir, "work");
const dataDir = join(baseDir, "data");
const agentDir = join(baseDir, "agent");
mkdirSync(workDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

writeFileSync(join(workDir, "hello.txt"), "hello\n");
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "dummy" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:" + MOCK_PORT + "/v1",
				apiKey: "dummy",
				models: [{ id: "mock-model", name: "Mock Model" }],
			},
		},
	}),
);

// ── 钩子探针脚本（node，可跨平台；stdin 收 JSON 负载）────────────────────
const denyBashJs = join(baseDir, "deny-bash.cjs");
writeFileSync(
	denyBashJs,
	`let b="";process.stdin.on("data",(d)=>b+=d).on("end",()=>{
		const p=JSON.parse(b||"{}");
		if(p.tool==="bash"){console.error("blocked by test hook");process.exit(2);}
		process.exit(0);
	});`,
);
const postLog = join(baseDir, "post-log.txt");
const postLogJs = join(baseDir, "post-log.cjs");
writeFileSync(
	postLogJs,
	`let b="";process.stdin.on("data",(d)=>b+=d).on("end",()=>{
		const p=JSON.parse(b||"{}");
		require("fs").appendFileSync(${JSON.stringify(postLog)},(p.tool||"?")+"\\n");
	});`,
);
const turnLog = join(baseDir, "turn-log.txt");
const turnLogJs = join(baseDir, "turn-log.cjs");
writeFileSync(turnLogJs, `require("fs").appendFileSync(${JSON.stringify(turnLog)},"turn\\n");`);
const blockPromptJs = join(baseDir, "block-prompt.cjs");
writeFileSync(
	blockPromptJs,
	`let b="";process.stdin.on("data",(d)=>b+=d).on("end",()=>{
		const p=JSON.parse(b||"{}");
		if(String(p.prompt||"").includes("FORBIDDEN")){console.error("forbidden word");process.exit(2);}
		process.exit(0);
	});`,
);

const HOOKS = [
	{
		id: "deny-bash",
		enabled: true,
		event: "pre-tool",
		tools: ["bash"],
		command: `node "${denyBashJs}"`,
		timeoutMs: 15000,
		blocking: true,
		label: "deny bash",
	},
	{
		id: "post-log",
		enabled: true,
		event: "post-tool",
		tools: [],
		command: `node "${postLogJs}"`,
		timeoutMs: 15000,
		blocking: false,
	},
	{
		id: "turn-log",
		enabled: true,
		event: "turn-end",
		tools: [],
		command: `node "${turnLogJs}"`,
		timeoutMs: 15000,
		blocking: false,
	},
	{
		id: "block-prompt",
		enabled: true,
		event: "prompt-submit",
		tools: [],
		command: `node "${blockPromptJs}"`,
		timeoutMs: 15000,
		blocking: true,
	},
];

const server = spawn("node", [join(REPO_ROOT, "dist/server/index.js")], {
	cwd: workDir,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_CWD: workDir,
		PI_WEB_PLUGIN_CATALOG_URL: "",
	},
	stdio: "ignore",
});

const cleanup = async () => {
	try {
		server.kill();
	} catch {
		/* ignore */
	}
	mockServer.close();
	await freePort(PORT);
};

for (let i = 0; i < 80 && !(await portUp(PORT)); i++) await sleep(250);

const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
let seq = 0;
const send = (msg) => ws.send(JSON.stringify({ ...msg, seq: ++seq }));

let snapshot = null;
let settings = null;
const notices = [];

ws.on("message", (d) => {
	let m;
	try {
		m = JSON.parse(d.toString());
	} catch {
		return;
	}
	if (m.type === "snapshot") snapshot = m.state;
	else if (m.type === "snapshot_delta") {
		if (snapshot && snapshot.rev === m.baseRev) {
			snapshot = { ...snapshot, ...m.state, messages: [...(snapshot.messages ?? []), ...m.appended] };
		}
	} else if (m.type === "settings_state") settings = m.settings;
	else if (m.type === "notice") notices.push(m.textEn || m.text || "");
});

const waitFor = async (pred, what, timeout = 20000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		if (pred()) return true;
		await sleep(100);
	}
	console.error(`TIMEOUT waiting for ${what}`);
	return false;
};
const msgText = (m) => (m?.content ?? []).map((b) => (typeof b?.text === "string" ? b.text : "")).join("");
const lastReply = () => [...(snapshot?.messages ?? [])].reverse().find((m) => m.role === "assistant");
let mark = 0;
const promptAndWait = async (text, what) => {
	mark = (snapshot?.messages ?? []).length;
	send({ type: "prompt", text });
	const ok = await waitFor(
		() => (snapshot?.messages ?? []).length > mark && /SEEN:|done|ok/.test(msgText(lastReply() ?? {})),
		what,
	);
	return ok ? msgText(lastReply()) : "";
};

await new Promise((r) => ws.on("open", r));
ws.send(JSON.stringify({ type: "hello", clientId: CLIENT_ID }));
await waitFor(() => snapshot !== null, "initial snapshot");
send({ type: "set_model", modelId: "mock/mock-model" });
await sleep(500);

try {
	// ── 1. 保存钩子 → settings_state.userHooks 回显 ───────────────────────
	send({ type: "save_user_hooks", hooks: HOOKS });
	await waitFor(() => Array.isArray(settings?.userHooks) && settings.userHooks.length === 4, "userHooks echoed");
	check(
		"save_user_hooks → settings_state.userHooks（4 条）",
		Array.isArray(settings?.userHooks) && settings.userHooks.length === 4,
	);
	check(
		"归一化保留 id/blocking",
		settings?.userHooks?.some((h) => h.id === "deny-bash" && h.blocking === true),
	);

	// ── 2. pre-tool blocking：bash 被钩子拒 ────────────────────────────────
	script = [{ name: "bash", args: { command: "git status" } }];
	const deniedReply = await promptAndWait("run something", "bash denied by hook");
	check(
		"bash 被 pre-tool 钩子拒（理由给模型）",
		/denied by a user hook/i.test(deniedReply) && /blocked by test hook/.test(deniedReply),
		deniedReply.slice(0, 160),
	);

	// ── 3. post-tool / turn-end 观察钩子真的跑了 ───────────────────────────
	// post-tool 只在工具真执行后发射（被 pre 拒的不算）→ 用放行的 read 触发。
	script = [{ name: "read", args: { path: "hello.txt" } }];
	await promptAndWait("read the file", "read allowed");
	await waitFor(() => existsSync(postLog), "post-tool probe file");
	check("post-tool 钩子落盘（read 执行后）", existsSync(postLog));
	await waitFor(() => existsSync(turnLog), "turn-end probe file");
	check("turn-end 钩子落盘", existsSync(turnLog));

	// ── 4. prompt-submit blocking：消息被拦（不进模型） ────────────────────
	mark = (snapshot?.messages ?? []).length;
	send({ type: "prompt", text: "this contains FORBIDDEN content" });
	const blocked = await waitFor(() => notices.some((n) => /blocked by hook/i.test(n)), "prompt blocked notice");
	check("prompt-submit 钩子拦消息（warning notice）", blocked);
	await sleep(800);
	check("被拦消息不进对话（无新消息）", (snapshot?.messages ?? []).length === mark);

	// ── 5. 停用钩子：bash 恢复放行 ────────────────────────────────────────
	send({
		type: "save_user_hooks",
		hooks: HOOKS.map((h) => ({ ...h, enabled: false })),
	});
	await waitFor(() => settings?.userHooks?.every((h) => h.enabled === false), "hooks disabled");
	script = [{ name: "bash", args: { command: "git status" } }];
	const allowedReply = await promptAndWait("run again", "bash allowed after disable");
	check(
		"停用后 bash 不再被钩子拒",
		allowedReply.includes("SEEN:") && !/denied by a user hook/i.test(allowedReply),
		allowedReply.slice(0, 160),
	);
} catch (e) {
	console.error("TEST ERROR:", e);
	failures++;
}

await cleanup();
console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
