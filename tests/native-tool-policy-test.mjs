// Real server + selected SDK + deterministic local SSE; no model credentials.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

const port = Number(process.argv[2] || 8994);
assert(port >= 8900);
const temp = mkdtempSync(join(tmpdir(), "pi-native-policy-server-"));
const project = join(temp, "project");
const outside = join(temp, "outside");
const data = join(temp, "data");
const agent = join(temp, "agent");
for (const dir of [project, outside, data, agent, join(project, "nested")]) mkdirSync(dir);
writeFileSync(join(project, "nested", "file.txt"), "native-read-marker");
writeFileSync(join(outside, "secret.txt"), "DO-NOT-EXPOSE-SECRET");
let step;
let sequence = 0;
let requestTools = [];
let server;
let socket;
let output = "";
let state;
let ready = false;
const pending = [];
const text = (message) => (message?.content ?? []).map((part) => part.text ?? "").join("");
const mock = createServer(async (req, res) => {
	let body = "";
	for await (const chunk of req) body += chunk;
	const payload = JSON.parse(body || "{}");
	requestTools = payload.tools?.map((tool) => tool.function.name) ?? [];
	const messages = payload.messages ?? [];
	const lastUser = messages.map((message) => message.role).lastIndexOf("user");
	const tool = messages.slice(lastUser + 1).findLast((message) => message.role === "tool");
	const delta = tool
		? { content: `SEEN:${tool.content}` }
		: {
				tool_calls: [
					{
						index: 0,
						id: step.id,
						type: "function",
						function: { name: step.name, arguments: JSON.stringify(step.params) },
					},
				],
			};
	res.writeHead(200, { "Content-Type": "text/event-stream" });
	for (const [d, finish] of [
		[delta, null],
		[{}, tool ? "stop" : "tool_calls"],
	]) {
		res.write(
			`data: ${JSON.stringify({ id: "policy-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`,
		);
	}
	res.end("data: [DONE]\n\n");
});
const wait = async (test, description) => {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		if (test()) return;
		if (server?.exitCode !== null && server?.exitCode !== undefined) throw new Error(output);
		await delay(50);
	}
	throw new Error(`Timeout: ${description}\n${output}`);
};
const send = (message) => socket.send(JSON.stringify(message));
const policy = (read = "allow", rules = []) =>
	writeFileSync(
		join(data, "filesystem-policy.json"),
		JSON.stringify({
			defaultPermissions: {},
			rules: [{ path: project, permissions: { read, execute: "block" } }, ...rules],
		}),
	);
const run = async (name, params, approve) => {
	await wait(() => !state.isStreaming, "idle before prompt");
	const mark = state.messages.length;
	const pendingMark = pending.length;
	step = { name, params, id: `call_${++sequence}_${name}` };
	send({ type: "prompt", text: `Verify native ${name} permissions` });
	if (approve) {
		await wait(() => pending.length > pendingMark, "filesystem approval");
		const request = pending.at(-1);
		assert(request.category.id.startsWith("filesystem:"));
		send({ type: "tool_approval_response", id: request.id, decision: "approve", scope: "all" });
	}
	await wait(
		() =>
			!state.isStreaming &&
			state.messages.slice(mark).some((message) => message.role === "assistant" && text(message).startsWith("SEEN:")),
		"completed tool round",
	);
	assert(requestTools.includes(name), `native ${name} must actually be registered`);
	const result = state.messages
		.slice(mark)
		.find((message) => message.role === "toolResult" && message.toolName === name);
	assert(result, `native ${name} must produce a real SDK tool result`);
	return result;
};
try {
	await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
	writeFileSync(
		join(agent, "models.json"),
		JSON.stringify({
			providers: {
				fixture: {
					api: "openai-completions",
					baseUrl: `http://127.0.0.1:${mock.address().port}/v1`,
					apiKey: "fixture-only",
					models: [
						{
							id: "fixture",
							name: "Policy test fixture",
							contextWindow: 8192,
							maxTokens: 256,
							compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
						},
					],
				},
			},
		}),
	);
	policy();
	server = spawn(process.execPath, ["--import", "./dist/server/resolve-global-sdk.js", "dist/server/index.js"], {
		cwd: fileURLToPath(new URL("..", import.meta.url)),
		env: {
			...process.env,
			PI_WEB_PORT: String(port),
			PI_WEB_HOST: "127.0.0.1",
			PI_WEB_CWD: project,
			PI_WEB_DATA_DIR: data,
			PI_CODING_AGENT_DIR: agent,
			PI_WEB_TOKEN: "",
			PI_WEB_AUTH_USERNAME: "",
			PI_WEB_AUTH_PASSWORD: "",
			PI_WEB_ALLOW_HOSTS: "",
			PI_WEB_ALLOW_ORIGINS: "",
			PI_WEB_TRUST_PROXY: "",
			PI_WEB_PLUGIN_CATALOG_URL: "off",
			PI_OFFLINE: "1",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	server.stdout.on("data", (chunk) => {
		output += chunk;
	});
	server.stderr.on("data", (chunk) => {
		output += chunk;
	});
	await wait(asyncReady, "HTTP health");
	const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
	if (process.env.PI_WEB_SDK_DIR && process.env.PI_WEB_SDK !== "bundled") {
		const packagePath = join(process.env.PI_WEB_SDK_DIR, "package.json");
		assert.equal(health.piVersion, JSON.parse(readFileSync(packagePath, "utf8")).version);
		assert(health.piSdkCopies.some((copy) => copy.path === packagePath));
		assert(output.includes(packagePath));
	}
	socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	socket.on("message", (raw) => {
		const message = JSON.parse(raw);
		if (message.type === "snapshot") state = message.state;
		if (message.type === "snapshot_delta") {
			if (state?.rev === message.baseRev)
				state = { ...state, ...message.state, messages: [...state.messages, ...message.appended] };
			else send({ type: "get_state" });
		}
		if (message.type === "tool_approval_pending") pending.push(message);
	});
	await once(socket, "open");
	send({ type: "hello", clientId: "native-policy-test" });
	await wait(() => state, "initial snapshot");
	send({
		type: "set_settings",
		toolLazyLoading: false,
		toolApprovalEnabled: false,
		defaultPermissionPreset: "danger-full-access",
	});
	send({ type: "set_model", modelId: "fixture/fixture" });
	await wait(() => state.model?.id === "fixture" && state.tools.includes("powershell"), "model and native tools");
	for (const name of ["ls", "grep", "find"]) {
		const result = await run(name, { path: outside, pattern: "*" });
		assert.equal(result.isError, true);
		assert.match(text(result), /Permission Denied/);
		assert(!JSON.stringify(state.messages).includes("DO-NOT-EXPOSE-SECRET"));
	}
	for (const name of ["grep", "find"]) {
		policy("allow", [{ path: join(project, "nested", "file.txt"), permissions: { read: "block" } }]);
		assert.equal((await run(name, { pattern: "*" })).isError, true);
	}
	policy();
	const listing = await run("ls", { path: "nested" });
	assert.equal(listing.isError, false, text(listing));
	const grep = await run("grep", { pattern: "native-read-marker", path: "nested" });
	assert.equal(grep.isError, false);
	assert.match(text(grep), /native-read-marker/);
	symlinkSync(outside, join(project, "escape"), "dir");
	assert.equal((await run("ls", { path: "." })).isError, true);
	policy("ask");
	assert.equal((await run("ls", { path: "nested" }, true)).isError, false);
	assert.equal((await run("ls", { path: "nested" }, true)).isError, false);
	assert.equal(pending.length, 2, "scope=all and disabled risk approvals never suppress filesystem Ask");
	const shell = await run("powershell", { command: "Set-Content changed.txt forbidden" });
	assert.equal(shell.isError, true);
	assert.match(text(shell), /did not authorize execution/);
	assert(!existsSync(join(project, "changed.txt")), "denied PowerShell must not create its target");
	assert(!readFileSync(join(project, "nested", "file.txt"), "utf8").includes("forbidden"));
	console.log(
		`PASS: native policy through actual SDK ${health.piVersion}; registered tools, nested/physical blocks, real ls/rg, repeated Ask and PowerShell execution denial`,
	);
} finally {
	socket?.terminate();
	if (server?.exitCode === null) {
		const stopped = once(server, "exit");
		server.kill("SIGTERM");
		await stopped;
	}
	await new Promise((resolve) => mock.close(resolve));
	rmSync(temp, { recursive: true, force: true });
}
function asyncReady() {
	if (!ready)
		fetch(`http://127.0.0.1:${port}/api/health`)
			.then((response) => {
				ready = response.ok;
			})
			.catch(() => {});
	return ready;
}
