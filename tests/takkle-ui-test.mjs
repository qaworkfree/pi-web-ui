// Real UI/server/auth/SDK test with local Supabase and model fixtures, no live data.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import WebSocket from "ws";

if (!CHROME_PATH) {
	console.log("SKIP: Takkle browser test needs Chrome; set PI_WEB_CHROME.");
	process.exit(0);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.argv[2] || 8993);
assert(port >= 8900);
const temp = mkdtempSync(join(tmpdir(), "pi-web-takkle-"));
const data = join(temp, "data");
const plugin = join(data, "plugins", "takkle");
const origin = `http://127.0.0.1:${port}`;
const calendarId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const userId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const records = [
	{
		workspace_id: calendarId,
		collection: "projects",
		id: "p1",
		data: { id: "p1", name: "Fixture board", position: 0 },
	},
	{
		workspace_id: calendarId,
		collection: "columns",
		id: "c1",
		data: { id: "c1", projectId: "p1", name: "To Do", position: 0 },
	},
	{
		workspace_id: calendarId,
		collection: "columns",
		id: "done",
		data: { id: "done", projectId: "p1", name: "Completed", system: "done", isDone: true, position: 1 },
	},
	{
		workspace_id: calendarId,
		collection: "tasks",
		id: "t1",
		data: {
			id: "t1",
			projectId: "p1",
			columnId: "c1",
			title: "Fixture card",
			dueDate: "2026-10-07",
			priority: "high",
			position: 1024,
		},
	},
].map((r) => ({ ...r, updated_at: "2026-10-06T00:00:00Z", deleted: false }));
let writes = 0;
let server, browser, socket, state, step;
let sequence = 0;
let pluginEpoch = 0;
let requestTools = [];
let logs = "";
const model = createServer(async (req, res) => {
	if (req.method === "GET" && req.url?.endsWith("/models")) {
		res.setHeader("Content-Type", "application/json");
		return res.end(JSON.stringify({ data: [{ id: "fixture" }] }));
	}
	if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
		res.writeHead(404);
		return res.end();
	}
	let raw = "";
	for await (const chunk of req) raw += chunk;
	const payload = JSON.parse(raw || "{}");
	requestTools = payload.tools?.map((t) => t.function.name) || [];
	const messages = payload.messages || [];
	const lastUser = messages.map((m) => m.role).lastIndexOf("user");
	const result = messages.slice(lastUser + 1).findLast((m) => m.role === "tool");
	const delta = result
		? { content: `SEEN:${result.content}` }
		: {
				tool_calls: [
					{
						index: 0,
						id: `takkle_call_${sequence}`,
						type: "function",
						function: { name: step.name, arguments: JSON.stringify(step.params) },
					},
				],
			};
	res.writeHead(200, { "Content-Type": "text/event-stream" });
	for (const [d, finish] of [
		[delta, null],
		[{}, result ? "stop" : "tool_calls"],
	])
		res.write(
			`data: ${JSON.stringify({ id: "takkle-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`,
		);
	res.end("data: [DONE]\n\n");
});
const wait = async (check, message) => {
	for (let i = 0; i < 400; i++) {
		if (check()) return;
		await delay(50);
	}
	throw new Error(`Timeout: ${message}`);
};
const send = (message) => socket.send(JSON.stringify(message));
async function runTool(name, params) {
	await wait(() => state && !state.isStreaming, "idle");
	const start = state.messages.length;
	step = { name, params };
	sequence++;
	send({ type: "prompt", text: `Test ${name} through the Takkle integration` });
	await wait(
		() =>
			!state.isStreaming &&
			state.messages
				.slice(start)
				.some((m) => m.role === "assistant" && m.content?.some((c) => c.text?.startsWith("SEEN:"))),
		"real SDK tool result",
	);
	assert(requestTools.includes(name), `${name} registered in the actual SDK`);
	const result = state.messages.slice(start).find((m) => m.role === "toolResult" && m.toolName === name);
	assert(result, `${name} produced a tool result`);
	return result;
}
const fixture = createServer(async (req, res) => {
	try {
		assert.equal(req.headers.apikey, "sb_secret_fixture_only");
		const u = new URL(req.url, "http://fixture");
		let result;
		if (u.pathname === "/auth/v1/admin/users") result = { users: [{ id: userId, email: "account@example.com" }] };
		else if (u.pathname === "/rest/v1/access_requests") result = [{ status: "approved" }];
		else if (u.pathname === "/rest/v1/workspace_members") {
			assert.equal(u.searchParams.get("user_id"), `eq.${userId}`);
			result = [{ workspace_id: calendarId, role: "owner" }];
		} else if (u.pathname === "/rest/v1/workspaces") {
			assert.equal(u.searchParams.get("id"), `eq.${calendarId}`);
			result = [{ id: calendarId, name: "My calendar", kind: "personal" }];
		} else if (u.pathname === "/rest/v1/records") {
			if (req.method === "GET") {
				assert.equal(u.searchParams.get("workspace_id"), `eq.${calendarId}`);
				result = records.slice(
					Number(u.searchParams.get("offset")),
					Number(u.searchParams.get("offset")) + Number(u.searchParams.get("limit")),
				);
			} else {
				let raw = "";
				for await (const chunk of req) raw += chunk;
				const body = JSON.parse(raw);
				writes++;
				if (req.method === "POST") {
					result = body.map((r) => {
						assert.equal(r.workspace_id, calendarId);
						if (r.collection === "tasks") r.data.number = 1;
						const record = { ...r, updated_at: new Date().toISOString() };
						records.push(record);
						return record;
					});
				} else {
					assert.equal(req.method, "PATCH");
					const row = records.find(
						(r) =>
							r.id === u.searchParams.get("id")?.slice(3) &&
							r.updated_at === u.searchParams.get("updated_at")?.slice(3),
					);
					result = row ? [Object.assign(row, body, { updated_at: new Date().toISOString() })] : [];
				}
			}
		} else throw new Error("Unexpected fixture route");
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(result));
	} catch {
		res.writeHead(500);
		res.end("Fixture assertion failed");
	}
});

try {
	fixture.listen(0, "127.0.0.1");
	await once(fixture, "listening");
	const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;
	model.listen(0, "127.0.0.1");
	await once(model, "listening");
	mkdirSync(join(temp, "agent"));
	writeFileSync(
		join(temp, "agent", "models.json"),
		JSON.stringify({
			providers: {
				fixture: {
					api: "openai-completions",
					baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
					apiKey: "fixture-only",
					models: [
						{
							id: "fixture",
							name: "Takkle fixture",
							contextWindow: 8192,
							maxTokens: 256,
							compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
						},
					],
				},
			},
		}),
	);
	mkdirSync(join(data, "plugins"), { recursive: true });
	cpSync(join(root, "plugins", "takkle"), plugin, { recursive: true });
	writeFileSync(
		join(plugin, "storage.json"),
		JSON.stringify({
			settings: {
				supabaseUrl: "https://exampleproject.supabase.co",
				accountEmail: "account@example.com",
				allowWrites: true,
			},
		}),
	);
	// Only this disposable process redirects the fixed Supabase URL to the local HTTP fixture.
	const preload = join(temp, "fixture.mjs");
	writeFileSync(
		preload,
		`const original = globalThis.fetch; globalThis.fetch = (url, init) => original(String(url).replace('https://exampleproject.supabase.co', ${JSON.stringify(fixtureUrl)}), init);`,
	);
	server = spawn(
		process.execPath,
		[
			"--import",
			pathToFileURL(preload).href,
			"--import",
			"./dist/server/resolve-global-sdk.js",
			"dist/server/index.js",
		],
		{
			cwd: root,
			env: {
				...process.env,
				HTTP_PROXY: "",
				HTTPS_PROXY: "",
				ALL_PROXY: "",
				PI_WEB_HOST: "127.0.0.1",
				PI_WEB_PORT: String(port),
				PI_WEB_DATA_DIR: data,
				PI_WEB_UPLOAD_DIR: join(data, "uploads"),
				PI_WEB_ATTACHMENT_DIR: join(data, "attachments"),
				PI_WEB_AUTO_RESUME: "0",
				PI_WEB_START_BLANK: "1",
				PI_WEB_CWD: temp,
				PI_CODING_AGENT_DIR: join(temp, "agent"),
				PI_WEB_AUTH_USERNAME: "admin",
				PI_WEB_AUTH_PASSWORD: "fixture-password",
				PI_WEB_TOKEN: "",
				PI_WEB_TRUST_PROXY: "",
				PI_WEB_ALLOW_HOSTS: "",
				PI_WEB_ALLOW_ORIGINS: "",
				PI_WEB_PLUGIN_CATALOG_URL: "off",
				TAKKLE_SUPABASE_SECRET_KEY: "sb_secret_fixture_only",
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	server.stdout.on("data", (chunk) => (logs += chunk));
	server.stderr.on("data", (chunk) => (logs += chunk));
	let ready = false;
	for (let i = 0; i < 600; i++) {
		if (server.exitCode !== null) throw new Error(`UI fixture exited (${server.exitCode}): ${logs.slice(-4000)}`);
		try {
			if ((await fetch(`${origin}/api/health`)).ok) {
				ready = true;
				break;
			}
		} catch {}
		await delay(100);
	}
	assert(ready, `UI fixture readiness: ${logs.slice(-4000)}`);
	if (process.env.PI_WEB_SDK_DIR) {
		const expected = JSON.parse(readFileSync(join(process.env.PI_WEB_SDK_DIR, "package.json"), "utf8"));
		assert.equal((await (await fetch(`${origin}/api/health`)).json()).piVersion, expected.version);
	}
	assert.equal((await fetch(`${origin}/plugins-api/takkle/snapshot`)).status, 401);
	assert(CHROME_PATH);
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	await page.addInitScript(() => localStorage.setItem("pi-web-ui:lang", "en"));
	await page.goto(origin);
	await page.getByRole("textbox", { name: "Username", exact: true }).fill("admin");
	await page.getByLabel("Password", { exact: true }).fill("fixture-password");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await page.waitForFunction(() => !document.querySelector(".auth-gate"));
	const cookies = await page.context().cookies();
	const cookie = cookies
		.filter((c) => c.name === "pi_web_session")
		.map((c) => `${c.name}=${c.value}`)
		.join("; ");
	assert(cookie);
	socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie, Origin: origin } });
	socket.on("message", (raw) => {
		const message = JSON.parse(raw);
		if (message.type === "plugins") pluginEpoch++;
		if (message.type === "snapshot") state = message.state;
		if (message.type === "snapshot_delta") {
			if (state?.rev === message.baseRev)
				state = { ...state, ...message.state, messages: [...state.messages, ...message.appended] };
			else send({ type: "get_state" });
		}
	});
	await once(socket, "open");
	send({ type: "hello", clientId: "takkle-agent-fixture" });
	await wait(() => state, "authenticated WS snapshot");
	send({ type: "set_settings", toolLazyLoading: false, toolApprovalEnabled: false });
	send({ type: "set_model", modelId: "fixture/fixture" });
	await wait(() => state.model?.id === "fixture", "fixture model");
	let snapshotResponse;
	for (let i = 0; i < 100; i++) {
		snapshotResponse = await page.request.get(`${origin}/plugins-api/takkle/snapshot`);
		if (snapshotResponse.status() !== 404) break;
		await delay(100);
	}
	assert.equal(
		snapshotResponse.status(),
		200,
		`${await snapshotResponse.text()}\n${logs
			.split("\n")
			.filter((line) => /plugin|takkle/i.test(line))
			.join("\n")}`,
	);
	await wait(() => logs.includes("registered AI tool: takkle_write"), "Takkle tool registration");
	const readResult = await runTool("takkle_read", { action: "projects" });
	assert(!readResult.isError);
	assert(JSON.stringify(readResult).includes("Fixture board"));
	const createdResult = await runTool("takkle_write", {
		action: "create_card",
		calendarId,
		projectId: "p1",
		title: "Agent created card",
	});
	assert(!createdResult.isError);
	assert(records.some((r) => r.data.title === "Agent created card"));
	const writesBeforeReadOnly = writes;
	send({ type: "dsh_permission_set", preset: "read-only" });
	await delay(100);
	const previousPluginEpoch = pluginEpoch;
	send({ type: "plugins_reload" });
	await wait(() => pluginEpoch > previousPluginEpoch, "plugin reload");
	await delay(100);
	const denied = await runTool("takkle_write", {
		action: "create_card",
		calendarId,
		projectId: "p1",
		title: "Should not exist",
	});
	assert(denied.isError);
	assert.equal(writes, writesBeforeReadOnly);
	send({ type: "dsh_permission_set", preset: "workspace-write-never" });
	await delay(100);
	send({ type: "set_plan_mode", enabled: true });
	await delay(100);
	const planningDenied = await runTool("takkle_write", {
		action: "create_project",
		calendarId,
		name: "Should not exist",
	});
	assert(planningDenied.isError);
	assert.equal(writes, writesBeforeReadOnly);
	send({ type: "set_plan_mode", enabled: false });
	const crossOrigin = await fetch(`${origin}/plugins-api/takkle/write`, {
		method: "POST",
		headers: { Cookie: cookie, Origin: "https://other.example", "Content-Type": "application/json" },
		body: JSON.stringify({ action: "create_project", calendarId, name: "CSRF" }),
	});
	assert.equal(crossOrigin.status, 403);
	assert.equal(writes, writesBeforeReadOnly);
	const tab = page.getByRole("tab", { name: /Takkle/ });
	if (await tab.count()) await tab.click();
	else {
		await page.locator(".plugin-topbar-more > button").click();
		await page.getByRole("menuitem", { name: /Takkle/ }).click();
	}
	const view = page.locator(".takkle-view");
	await view.getByLabel("Calendar", { exact: true }).waitFor();
	assert.equal(await view.locator(".takkle-day").count(), 42);
	assert(!(await page.content()).includes("sb_secret_fixture_only"));
	await view.getByRole("button", { name: "New project", exact: true }).click();
	await view.getByLabel("Project name", { exact: true }).fill("Browser created board");
	await view.getByRole("button", { name: "Create", exact: true }).click();
	await view
		.getByLabel("Project filter")
		.getByRole("option", { name: "Browser created board" })
		.waitFor({ state: "attached" });
	await view.getByLabel("Project filter").selectOption({ label: "Browser created board" });
	await view.getByRole("button", { name: "New card", exact: true }).click();
	await view.getByLabel("Card title").fill("Browser created card");
	await view.getByLabel("Due date").fill("2026-10-09");
	await view.getByRole("button", { name: "Create", exact: true }).click();
	await view.getByRole("button", { name: "Board", exact: true }).click();
	await view.getByRole("button", { name: "Browser created card", exact: true }).click();
	await view.getByLabel("Card title").fill("Edited card");
	await view.getByLabel("Column", { exact: true }).selectOption({ label: "Completed" });
	await view.getByRole("button", { name: "Save changes", exact: true }).click();
	await view.getByRole("button", { name: "Edited card", exact: true }).waitFor();
	assert(records.some((r) => r.collection === "tasks" && r.data.title === "Edited card" && r.data.completedAt));
	assert.equal(writes, writesBeforeReadOnly + 3);
	if (process.env.PI_WEB_TAKKLE_SCREENSHOT_DIR) {
		while (await page.locator(".notice-close").count()) await page.locator(".notice-close").first().click();
		mkdirSync(process.env.PI_WEB_TAKKLE_SCREENSHOT_DIR, { recursive: true });
		await page.screenshot({ path: join(process.env.PI_WEB_TAKKLE_SCREENSHOT_DIR, "takkle-board.png") });
	}
	await page.setViewportSize({ width: 390, height: 844 });
	await view.getByRole("button", { name: "Calendar", exact: true }).click();
	assert(await view.locator(".takkle-calendar").evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
	assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
	// Environment credentials stay out of plugin storage and browser responses.
	assert(!readFileSync(join(plugin, "storage.json"), "utf8").includes("sb_secret_fixture_only"));
	assert(!logs.includes("sb_secret_fixture_only"));
	if (process.env.PI_WEB_TAKKLE_SCREENSHOT_DIR)
		await page.screenshot({ path: join(process.env.PI_WEB_TAKKLE_SCREENSHOT_DIR, "takkle-mobile-calendar.png") });
	console.log(
		"PASS: real fork-backed Takkle agent reads/writes, read-only denial after plugin reload and plan denial, tab, login/CSRF protection, server-side credentials, project/card creation, conditional update/completion and mobile calendar via local HTTP/SSE fixtures",
	);
} finally {
	await browser?.close();
	socket?.close();
	if (server?.exitCode === null) {
		const exited = once(server, "exit");
		server.kill("SIGTERM");
		await exited;
	}
	await new Promise((resolve) => fixture.close(resolve));
	await new Promise((resolve) => model.close(resolve));
	rmSync(temp, { recursive: true, force: true });
}
