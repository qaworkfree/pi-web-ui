// Real HTTP + WebSocket + browser auth checks; no model calls or credentials.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.argv[2] || 8996);
assert(port >= 8900);
const origin = `http://127.0.0.1:${port}`;
const temp = mkdtempSync(join(tmpdir(), "pi-web-auth-integration-"));
const agentDir = join(temp, "agent");
mkdirSync(agentDir);
let server;
let browser;
const sockets = [];
let output = "";
async function start(extra = {}) {
	server = spawn(process.execPath, ["dist/server/index.js"], {
		cwd: root,
		env: {
			...process.env,
			PI_WEB_PORT: String(port),
			PI_WEB_HOST: "127.0.0.1",
			PI_WEB_DATA_DIR: join(temp, "data"),
			PI_CODING_AGENT_DIR: agentDir,
			PI_WEB_CWD: temp,
			PI_WEB_AUTH_USERNAME: "admin",
			PI_WEB_AUTH_PASSWORD: "admin-password",
			PI_WEB_TOKEN: "integration-service-token",
			PI_WEB_TRUST_PROXY: "",
			PI_WEB_ALLOW_HOSTS: "",
			PI_WEB_ALLOW_ORIGINS: "",
			...extra,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	server.stdout.on("data", (chunk) => {
		output += chunk;
	});
	server.stderr.on("data", (chunk) => {
		output += chunk;
	});
	for (let i = 0; i < 100; i++) {
		if (server.exitCode !== null) throw new Error(`Server exited: ${output}`);
		try {
			if ((await fetch(`${origin}/api/health`)).ok) return;
		} catch {
			/* starting */
		}
		await delay(100);
	}
	throw new Error(`Server did not start: ${output}`);
}
async function stop() {
	if (server?.exitCode === null) {
		const exited = once(server, "exit");
		server.kill("SIGTERM");
		await exited;
	}
}
const request = (path, cookie, init = {}) =>
	fetch(`${origin}${path}`, {
		...init,
		headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...init.headers },
	});
async function login(user = "admin", password = "admin-password", headers = {}) {
	const response = await request("/api/auth/login", "", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify({ username: user, password }),
	});
	assert.equal(response.status, 200);
	assert(
		!response.headers.getSetCookie().some((cookie) => cookie.startsWith("pi_web_token=")),
		"password login cannot mint service-token cookie",
	);
	return {
		cookie: response.headers
			.getSetCookie()
			.find((cookie) => cookie.startsWith("pi_web_session="))
			.split(";", 1)[0],
		response,
	};
}
async function connect(cookie) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie, Origin: origin } });
	sockets.push(socket);
	await once(socket, "open");
	return socket;
}
try {
	await start();
	assert.equal((await request("/")).status, 200, "login shell available with password + token configured");
	assert.equal((await request("/api/auth/sessions")).status, 401);
	assert.equal(
		(
			await request("/api/auth/login", "", {
				method: "POST",
				headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
				body: JSON.stringify({ username: "admin", password: "admin-password" }),
			})
		).status,
		403,
	);
	const first = await login();
	assert(!first.response.headers.get("set-cookie").includes("Secure"));
	const spoofed = await login("admin", "admin-password", { "X-Forwarded-Proto": "https" });
	assert(!spoofed.response.headers.get("set-cookie").includes("Secure"), "untrusted proxy headers ignored");
	const protectedResponse = await request("/api/auth/sessions", first.cookie);
	assert.equal(protectedResponse.status, 200);
	assert(!protectedResponse.headers.getSetCookie().some((cookie) => cookie.startsWith("pi_web_token=")));
	assert.equal(
		(await fetch(`${origin}/api/auth/logout`, { method: "POST", headers: { Cookie: first.cookie } })).status,
		403,
		"cookie writes need origin metadata",
	);
	const socket = await connect(spoofed.cookie);
	const closed = once(socket, "close");
	const device = (await (await request("/api/auth/sessions", spoofed.cookie)).json()).current;
	assert.equal((await request(`/api/auth/sessions/${device.id}`, first.cookie, { method: "DELETE" })).status, 200);
	assert.equal((await closed)[0], 4001, "revocation closes an existing WebSocket");
	assert.equal((await request("/api/auth/sessions", spoofed.cookie)).status, 401);
	assert.equal(
		(
			await request("/api/auth/users", first.cookie, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ username: "bob", password: "bob-password" }),
			})
		).status,
		201,
	);
	const bob = await login("bob", "bob-password");
	assert.equal((await request("/api/auth/users", bob.cookie)).status, 403);
	assert.equal(
		(await request("/api/auth/sessions", bob.cookie)).status,
		200,
		"ordinary users manage their own devices",
	);
	assert.equal(
		(
			await request(
				`/api/auth/sessions/${(await (await request("/api/auth/sessions", first.cookie)).json()).current.id}`,
				bob.cookie,
				{ method: "DELETE" },
			)
		).status,
		404,
		"other users cannot revoke devices",
	);
	const bobSocket = await connect(bob.cookie);
	const bobClosed = once(bobSocket, "close");
	assert.equal((await request("/api/auth/users/bob", first.cookie, { method: "DELETE" })).status, 200);
	assert.equal((await bobClosed)[0], 4001);
	assert.equal((await request("/api/auth/logout", first.cookie, { method: "POST" })).status, 200);
	assert.equal((await request("/api/auth/sessions", first.cookie)).status, 401);
	const serviceStatus = await (
		await request("/api/auth/status", "", { headers: { Authorization: "Bearer integration-service-token" } })
	).json();
	assert.equal(serviceStatus.authenticated, true);
	// Exercise the actual frontend's login/logout in a narrow viewport.
	assert(CHROME_PATH, "Install Chrome or set PI_WEB_CHROME to run browser checks");
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
	const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
	await page.addInitScript(() => localStorage.setItem("pi-web-ui:lang", "en"));
	await page.goto(origin);
	await page.getByRole("textbox", { name: "Username", exact: true }).fill("admin");
	await page.getByLabel("Password", { exact: true }).fill("admin-password");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await page.waitForFunction(() => !document.querySelector(".auth-gate"));
	assert.equal((await page.request.get(`${origin}/api/auth/status`)).status(), 200);
	const cookies = await page.context().cookies();
	assert(cookies.some((cookie) => cookie.name === "pi_web_session" && cookie.httpOnly));
	assert(!cookies.some((cookie) => cookie.name === "pi_web_token"));
	// Use the normal settings action; also validate layout at desktop width.
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.locator('button[data-tip="Settings"]').first().click();
	const account = page.getByText("Account and devices", { exact: true });
	await account.first().click();
	await page.getByRole("button", { name: /Sign out/ }).click();
	await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
	await browser.close();
	browser = undefined;
	await stop();
	await start({ PI_WEB_TRUST_PROXY: "loopback", PI_WEB_ALLOW_HOSTS: "127.0.0.1,ui.example" });
	const trusted = await login("admin", "admin-password", {
		Origin: "https://ui.example",
		"X-Forwarded-Host": "ui.example",
		"X-Forwarded-Proto": "https",
	});
	assert(
		trusted.response.headers.get("set-cookie").includes("Secure"),
		"trusted TLS proxy creates Secure session cookie",
	);
	console.log(
		"PASS: HTTP auth, CSRF, session/device revocation, service-token separation, mobile login/logout and trusted proxy",
	);
} finally {
	for (const socket of sockets) socket.terminate();
	await browser?.close();
	await stop();
	rmSync(temp, { recursive: true, force: true });
}
