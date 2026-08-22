// PI_WEB_TOKEN optional auth — protocol smoke test (zero token).
//
// When PI_WEB_TOKEN is set on the server:
//   1. /api/health stays open (monitoring probes)
//   2. HTTP requests without a valid token → 401
//   3. ?token= query param accepted + Set-Cookie pi_web_token issued
//   4. Authorization: Bearer / X-PI-Token headers accepted
//   5. WS upgrade without token → rejected; with ?token= → connects
// Without PI_WEB_TOKEN everything behaves as before (no auth middleware).
//
// Usage: npm run build && node tests/token-auth-test.mjs [port]
import WebSocket from "ws";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";

const PORT = Number(process.argv[2] || 8975);
const TOKEN = "s3cret-token-xyz";
const base = mkdtempSync(join(tmpdir(), "pi-web-tokenauth-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(workdir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const NODE = realpathSync(process.execPath);
const server = spawn(NODE, ["dist/server/index.js"], {
	env: {
		...process.env,
		PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workdir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_TOKEN: TOKEN,
	},
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
});
server.stdout.on("data", () => {});
server.stderr.on("data", () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
	if (cond) {
		passed++;
		console.log(`  ok - ${name}`);
	} else {
		failed++;
		console.error(`  FAIL - ${name} ${extra}`);
	}
}
const url = (p) => `http://127.0.0.1:${PORT}${p}`;

async function waitReady() {
	for (let i = 0; i < 60; i++) {
		try {
			const res = await fetch(url("/api/health"));
			if (res.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(300);
	}
	throw new Error("server did not become ready");
}

/** WS connect that resolves only when the socket opens; rejects otherwise. */
function wsTry(path) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`);
		const timer = setTimeout(() => {
			ws.terminate();
			reject(new Error("timeout"));
		}, 4000);
		ws.on("open", () => {
			clearTimeout(timer);
			ws.close();
			resolve(true);
		});
		ws.on("error", (err) => {
			clearTimeout(timer);
			resolve({ error: err.message }); // upgrade rejection surfaces here
		});
	});
}

try {
	await waitReady();

	// 1. health is open even with token auth enabled
	const h = await fetch(url("/api/health"));
	check("health open without token", h.status === 200);

	// 2. protected route rejects missing/invalid token
	const r1 = await fetch(url("/"));
	check("GET / without token → 401", r1.status === 401);
	const r2 = await fetch(url("/?token=wrong"));
	check("GET / with wrong token → 401", r2.status === 401);
	const api = await fetch(url("/api/themes"));
	check("GET /api/themes without token → 401", api.status === 401);

	// 3. query-param token accepted and cookie issued
	const r3 = await fetch(url(`/?token=${encodeURIComponent(TOKEN)}`));
	check("GET / with ?token= → 200", r3.status === 200);
	const setCookie = r3.headers.get("set-cookie") ?? "";
	check(
		"Set-Cookie issues HttpOnly pi_web_token",
		setCookie.includes("pi_web_token=") && setCookie.toLowerCase().includes("httponly"),
		setCookie,
	);

	// 4. header-based tokens accepted
	const r4 = await fetch(url("/"), { headers: { authorization: `Bearer ${TOKEN}` } });
	check("Authorization: Bearer accepted", r4.status === 200);
	const r5 = await fetch(url("/"), { headers: { "x-pi-token": TOKEN } });
	check("X-PI-Token header accepted", r5.status === 200);

	// 5. WS handshake enforcement
	const wsNoToken = await wsTry("/ws");
	check("WS without token rejected", typeof wsNoToken === "object", JSON.stringify(wsNoToken));
	const wsOk = await wsTry(`/ws?token=${encodeURIComponent(TOKEN)}`);
	check("WS with ?token= connects", wsOk === true, JSON.stringify(wsOk));
	const wsBad = await wsTry("/ws?token=nope");
	check("WS with wrong token rejected", typeof wsBad === "object");

	console.log(`\n${passed} passed, ${failed} failed`);
} catch (err) {
	failed++;
	console.error("test crashed:", err);
} finally {
	if (server.pid) process.kill(server.pid, "SIGTERM");
	await sleep(500);
	process.exit(failed === 0 ? 0 : 1);
}
