/**
 * Auto-restart handoff test (foreground path):
 *
 * 1. start instance A on PORT
 * 2. start instance B with PI_WEB_RESTART_CHILD=1 on the same PORT — it must
 *    WAIT (not crash with EADDRINUSE) until A releases the port
 * 3. kill A → B takes over and serves /api/health
 */
import { execSync, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
const REPO_ROOT = new globalThis.URL("../", import.meta.url).pathname;

const PORT = 8898;
const PROJ = REPO_ROOT;

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

try {
	execSync("npm run build", { cwd: PROJ, stdio: "ignore" });
} catch {
	console.error("build failed");
	process.exit(1);
}
try {
	execSync(`lsof -ti :${PORT} -sTCP:LISTEN | xargs kill -9`, {
		stdio: "ignore",
	});
} catch {}
await sleep(400);

const env = { ...process.env, PORT: String(PORT), PI_WEB_CWD: PROJ };

// Instance A: the old process.
const a = spawn("node", ["dist/server/index.js"], {
	cwd: PROJ,
	env,
	stdio: "ignore",
});
const portUp = async () => {
	try {
		execSync(`lsof -ti :${PORT} -sTCP:LISTEN`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};
for (let i = 0; i < 40 && !(await portUp()); i++) await sleep(250);
check("instance A up", await portUp());
const health = await fetch(`http://localhost:${PORT}/api/health`).then((r) =>
	r.json().catch(() => null),
);
check("A answers health", health?.ok === true);

// Instance B: the auto-restart replacement. Must NOT crash — it waits.
const b = spawn("node", ["dist/server/index.js"], {
	cwd: PROJ,
	env: { ...env, PI_WEB_RESTART_CHILD: "1" },
	stdio: "ignore",
});
await sleep(2500);
check(
	"B did not crash while A holds the port",
	b.exitCode === null,
	`exitCode=${b.exitCode ?? "still running"}`,
);

// Kill A → B should take over the port.
a.kill("SIGKILL");
const t0 = Date.now();
let bUp = false;
while (Date.now() - t0 < 15000) {
	try {
		const r = await fetch(`http://localhost:${PORT}/api/health`);
		const j = await r.json().catch(() => null);
		if (j?.ok === true) {
			bUp = true;
			break;
		}
	} catch {
		/* not up yet */
	}
	await sleep(300);
}
check("B took over the port after A exited", bUp);
check("B still alive", b.exitCode === null, `exitCode=${b.exitCode}`);

// Cleanup.
try {
	b.kill("SIGKILL");
} catch {}
try {
	execSync(`lsof -ti :${PORT} -sTCP:LISTEN | xargs kill -9`, {
		stdio: "ignore",
	});
} catch {}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
