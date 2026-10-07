// Real UI/SDK integration with a deterministic local model stub: no GGUF inference.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const root = process.argv[2] ?? "D:/pipipiPopopo";
const uiRepo = join(root, "pi-web-ui");
const base = mkdtempSync(join(root, "temp/document-integration-"));
const agent = join(base, "agent"),
	data = join(base, "data"),
	work = join(base, "work");
for (const path of [agent, data, work]) mkdirSync(path);
const requests = [],
	failures = [];
let ui;
let completed = false;
const model = createServer(async (req, res) => {
	if (req.url === "/test/status") {
		res.setHeader("Content-Type", "application/json");
		return res.end(JSON.stringify({ requests: requests.length, completed, failures, uiPort, modelPort, base }));
	}
	if (req.url === "/test/stop" && req.method === "POST") {
		res.end("Stopped isolated test servers.");
		if (ui?.pid) execFileSync("taskkill", ["/PID", String(ui.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		model.close();
		return;
	}
	if (!req.url?.endsWith("/chat/completions")) {
		res.writeHead(404);
		return res.end();
	}
	let raw = "";
	for await (const part of req) raw += part;
	const request = JSON.parse(raw);
	requests.push(request);
	const content = JSON.stringify(request.messages);
	res.writeHead(200, { "content-type": "text/event-stream" });
	const chunk = (delta, finish_reason = null) =>
		res.write(
			`data: ${JSON.stringify({ id: "document-integration", object: "chat.completion.chunk", created: 1, model: "text-only-document-test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
		);
	try {
		if (requests.length === 1) {
			assert(content.includes("742"), "Digital/scanned attachment preview did not reach the model.");
			assert(content.toLowerCase().includes("outubro"), "Portuguese OCR did not reach the model.");
			const read = request.tools?.find((tool) => tool.function?.name === "read");
			assert(read?.function.parameters.properties.pages, "read schema has no document paging.");
			const path = /<file path=\\"([^\"]*digital\.pdf)\\"/.exec(content)?.[1];
			assert(path, "No persisted digital PDF path in model context.");
			chunk({
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: "read-page-two",
						type: "function",
						function: { name: "read", arguments: JSON.stringify({ path, pages: "2" }) },
					},
				],
			});
			chunk({}, "tool_calls");
		} else {
			const toolResult = [...request.messages].reverse().find((message) => message.role === "tool");
			assert(JSON.stringify(toolResult).includes("915"), "Second-page read failed or was denied.");
			completed = true;
			chunk({
				role: "assistant",
				content:
					"Document integration test passed.\n\nThe uploaded scanned PDF says **Invoice total: 742 dollars** and **Relatorio de vendas: outubro**. Local OCR delivered this text to a text-only model.\n\nI used the read tool on page 2 of the digital PDF and received **Second page reference: 915**. PDF paging, OCR, uploads and filesystem permissions work through the live UI/SDK pipeline.\n\nThis is a deterministic local test; no GGUF model was invoked.",
			});
			chunk({}, "stop");
		}
	} catch (error) {
		failures.push(error.message);
		chunk({ role: "assistant", content: `Integration validation failed: ${error.message}` });
		chunk({}, "stop");
	}
	writeFileSync(
		join(root, "logs/document-ui-integration.json"),
		JSON.stringify(
			{
				passed: completed && failures.length === 0,
				modelRequests: requests.length,
				failures,
				checkedAt: new Date().toISOString(),
			},
			null,
			2,
		),
	);
	res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const modelPort = model.address().port;
assert(modelPort >= 8900);
const probe = createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const uiPort = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
assert(uiPort >= 8900);
writeFileSync(
	join(agent, "models.json"),
	JSON.stringify({
		providers: {
			local: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${modelPort}/v1`,
				apiKey: "test",
				models: [
					{
						id: "text-only-document-test",
						name: "Document Integration Test (text only)",
						input: ["text"],
						contextWindow: 8192,
						maxTokens: 1024,
					},
				],
			},
		},
	}),
);
writeFileSync(
	join(agent, "settings.json"),
	JSON.stringify({ defaultProvider: "local", defaultModel: "text-only-document-test" }),
);
const blocked = { read: "block", create: "block", write: "block", edit: "block", delete: "block", execute: "block" };
writeFileSync(
	join(data, "filesystem-policy.json"),
	JSON.stringify({
		defaultPermissions: blocked,
		rules: [
			{ path: join(data, "uploads"), permissions: { ...blocked, read: "allow" } },
			{ path: work, permissions: { ...blocked, read: "allow" } },
		],
	}),
);
const env = {
	...process.env,
	PI_WEB_ENGINE: "pi",
	PI_WEB_SDK: "global",
	PI_WEB_SDK_DIR: join(root, "pipipiPopopo/packages/coding-agent"),
	PI_CODING_AGENT_DIR: agent,
	PI_WEB_DATA_DIR: data,
	PI_WEB_CWD: work,
	PI_WEB_PORT: String(uiPort),
	PI_WEB_HOST: "127.0.0.1",
	PI_WEB_LOCALE: "en",
	PI_WEB_AUTO_RESUME: "0",
	PI_WEB_START_BLANK: "1",
	PI_WEB_OCR_CACHE: join(root, "ui-data/ocr-languages"),
	PI_WEB_PLUGIN_CATALOG_URL: "off",
	PI_WEB_AUTH_USERNAME: "",
	PI_WEB_AUTH_PASSWORD: "",
};
delete env.PI_WEB_LOCAL_MODEL_PROFILES;
delete env.PI_WEB_LOCAL_MODEL_PROFILE_SCRIPT;
ui = spawn(process.execPath, ["--import", "./dist/server/resolve-global-sdk.js", "dist/server/index.js"], {
	cwd: uiRepo,
	env,
	windowsHide: true,
	stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
ui.stdout.on("data", (d) => {
	output += d;
});
ui.stderr.on("data", (d) => {
	output += d;
});
let ready = false;
for (let attempt = 0; attempt < 100; attempt++) {
	try {
		ready = (await fetch(`http://127.0.0.1:${uiPort}/api/health`)).ok;
	} catch {}
	if (ready) break;
	await sleep(200);
}
assert(ready, output);
console.log(
	JSON.stringify({
		uiUrl: `http://127.0.0.1:${uiPort}`,
		statusUrl: `http://127.0.0.1:${modelPort}/test/status`,
		stopUrl: `http://127.0.0.1:${modelPort}/test/stop`,
		base,
	}),
);
process.on("SIGINT", () => {
	if (ui?.pid)
		try {
			execFileSync("taskkill", ["/PID", String(ui.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		} catch {}
	model.close();
});
