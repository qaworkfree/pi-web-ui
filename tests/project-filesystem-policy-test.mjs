// Project policy scope, persistence and UI file enforcement through real WS.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const port = Number(process.argv[2] || 8997);
assert(port >= 8900);
const temp = mkdtempSync(join(tmpdir(), "pi-web-project-policy-"));
const project = join(temp, "project");
const other = join(temp, "other");
const dataDir = join(temp, "data");
for (const path of [project, other, dataDir, join(temp, "agent")]) mkdirSync(path);
writeFileSync(join(project, "file.txt"), "original");
mkdirSync(join(project, "private"));
writeFileSync(join(project, "private", "secret.html"), "private content");
writeFileSync(join(temp, "outside.html"), "outside content");
symlinkSync(join(temp, "outside.html"), join(project, "escape.html"));
const policyFile = join(dataDir, "filesystem-policy.json");
writeFileSync(
	policyFile,
	JSON.stringify({
		defaultPermissions: { read: "block", write: "block" },
		rules: [
			{ path: project, permissions: { read: "block", write: "block" } },
			{ path: other, permissions: { read: "allow" } },
			{ path: join(project, "private"), permissions: { read: "block" } },
		],
	}),
);
let server;
let browser;
let socket;
let output = "";
const inbox = [];
const waiting = [];
function next(test) {
	const index = inbox.findIndex(test);
	if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
	return new Promise((resolve, reject) => {
		const entry = { test, resolve, timer: undefined };
		entry.timer = setTimeout(() => {
			waiting.splice(waiting.indexOf(entry), 1);
			reject(new Error("Timed out waiting for project policy response"));
		}, 15_000);
		waiting.push(entry);
	});
}
const send = (message) => socket.send(JSON.stringify(message));
try {
	server = spawn(process.execPath, ["--import", "./dist/server/resolve-global-sdk.js", "dist/server/index.js"], {
		cwd: fileURLToPath(new URL("..", import.meta.url)),
		env: {
			...process.env,
			PI_WEB_PORT: String(port),
			PI_WEB_HOST: "127.0.0.1",
			PI_WEB_CWD: project,
			PI_WEB_DATA_DIR: dataDir,
			PI_CODING_AGENT_DIR: join(temp, "agent"),
			PI_WEB_TOKEN: "",
			PI_WEB_AUTH_USERNAME: "",
			PI_WEB_AUTH_PASSWORD: "",
			PI_WEB_TRUST_PROXY: "",
			PI_WEB_ALLOW_HOSTS: "",
			PI_WEB_ALLOW_ORIGINS: "",
			PI_WEB_PLUGIN_CATALOG_URL: "off",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	server.stdout.on("data", (chunk) => {
		output += chunk;
	});
	server.stderr.on("data", (chunk) => {
		output += chunk;
	});
	let ready = false;
	for (let i = 0; i < 100; i++) {
		if (server.exitCode !== null) throw new Error(output);
		try {
			if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) {
				ready = true;
				break;
			}
		} catch {
			/* starting */
		}
		await delay(100);
	}
	assert(ready, output);
	if (process.env.PI_WEB_SDK_DIR && process.env.PI_WEB_SDK !== "bundled") {
		const packagePath = join(process.env.PI_WEB_SDK_DIR, "package.json");
		const expected = JSON.parse(readFileSync(packagePath, "utf8"));
		const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
		assert.equal(health.piVersion, expected.version, "the running server must load the selected runtime");
		assert(health.piSdkCopies.some((copy) => copy.path === packagePath));
		assert(output.includes(packagePath), "the SDK hook must confirm the actual selected path");
	}
	socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	socket.on("message", (raw) => {
		const message = JSON.parse(raw);
		const index = waiting.findIndex((entry) => entry.test(message));
		if (index >= 0) {
			const [entry] = waiting.splice(index, 1);
			clearTimeout(entry.timer);
			entry.resolve(message);
		} else inbox.push(message);
	});
	await once(socket, "open");
	send({ type: "hello", clientId: "project-policy-test" });
	await next((message) => message.type === "snapshot");
	send({ type: "set_settings", defaultPermissionPreset: "danger-full-access" });
	send({ type: "read_file", path: "file.txt" });
	await next((message) => message.type === "notice" && /Permission denied/i.test(message.textEn ?? message.text));
	send({ type: "write_file", path: "file.txt", text: "blocked" });
	await next((message) => message.type === "notice" && /Permission denied/i.test(message.textEn ?? message.text));
	assert.equal(readFileSync(join(project, "file.txt"), "utf8"), "original");
	send({ type: "apply_project_filesystem_preset", preset: "read-only", path: temp });
	const readOnly = await next(
		(message) =>
			message.type === "filesystem_policy" &&
			message.policy.rules.some((rule) => rule.path === project && rule.permissions.read === "allow"),
	);
	assert.equal(readOnly.policy.defaultPermissions.read, "block");
	assert(readOnly.policy.rules.some((rule) => rule.path === other && rule.permissions.read === "allow"));
	assert(
		readOnly.policy.rules.some((rule) => rule.path === join(project, "private") && rule.permissions.read === "block"),
	);
	assert(!readOnly.policy.rules.some((rule) => rule.path === temp), "client cannot widen scope through a forged root");
	send({ type: "read_file", path: "file.txt" });
	assert.equal((await next((message) => message.type === "file_content")).text, "original");
	const base = `http://127.0.0.1:${port}`;
	assert.equal((await fetch(`${base}/api/file?path=file.txt&download=1&clientId=project-policy-test`)).status, 200);
	assert.equal(
		(await fetch(`${base}/api/file?path=private/secret.html&download=1&clientId=project-policy-test`)).status,
		403,
	);
	assert.equal((await fetch(`${base}/api/preview/private/secret.html?clientId=project-policy-test`)).status, 403);
	assert.equal((await fetch(`${base}/api/preview/escape.html?clientId=project-policy-test`)).status, 403);
	assert.equal(
		(await fetch(`${base}/api/file?${new URLSearchParams({ path: join(temp, "outside.html"), download: "1" })}`))
			.status,
		403,
	);
	const blockedUpload = await fetch(
		`${base}/api/file-transfer/upload?${new URLSearchParams({ dir: "private", name: "secret.html", clientId: "project-policy-test" })}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/octet-stream", "X-File-Operation": "1" },
			body: "denied",
		},
	);
	assert.equal(blockedUpload.status, 400);
	assert.equal(readFileSync(join(project, "private", "secret.html"), "utf8"), "private content");
	send({ type: "apply_project_filesystem_preset", preset: "development" });
	await next(
		(message) =>
			message.type === "filesystem_policy" &&
			message.policy.rules.some((rule) => rule.path === project && rule.permissions.write === "allow"),
	);
	send({ type: "write_file", path: "file.txt", text: "allowed" });
	for (let i = 0; i < 100 && readFileSync(join(project, "file.txt"), "utf8") !== "allowed"; i++) await delay(50);
	assert.equal(readFileSync(join(project, "file.txt"), "utf8"), "allowed");
	assert.equal(
		JSON.parse(readFileSync(policyFile, "utf8")).rules.find((rule) => rule.path === project).permissions.execute,
		"ask",
	);
	assert(CHROME_PATH);
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
	const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
	await page.addInitScript(() => localStorage.setItem("pi-web-ui:lang", "en"));
	await page.goto(`http://127.0.0.1:${port}`);
	await page.locator('button[data-tip="Settings"]').first().click();
	await page.getByText("Filesystem access", { exact: true }).first().click();
	await page.getByLabel("Current project scope", { exact: true }).selectOption("read-only");
	page.once("dialog", (dialog) => dialog.accept());
	await page.getByRole("button", { name: "Apply to this project", exact: true }).click();
	for (
		let i = 0;
		i < 100 &&
		JSON.parse(readFileSync(policyFile, "utf8")).rules.find((rule) => rule.path === project).permissions.execute !==
			"block";
		i++
	)
		await delay(50);
	assert.equal(
		JSON.parse(readFileSync(policyFile, "utf8")).rules.find((rule) => rule.path === project).permissions.execute,
		"block",
	);
	await page.setViewportSize({ width: 390, height: 844 });
	assert(await page.getByRole("button", { name: "Apply to this project", exact: true }).isVisible());
	console.log(
		"PASS: real-server project scope, preserved unrelated rules, persistence, file enforcement and browser preset control",
	);
} finally {
	for (const entry of waiting) clearTimeout(entry.timer);
	socket?.terminate();
	await browser?.close();
	if (server?.exitCode === null) {
		const stopped = once(server, "exit");
		server.kill("SIGTERM");
		await stopped;
	}
	rmSync(temp, { recursive: true, force: true });
}
