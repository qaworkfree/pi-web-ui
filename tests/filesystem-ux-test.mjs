/**
 * Filesystem-access UX regression (zero token, WS only):
 *
 *   1. A cwd with NO policy rule (the shipped default-block) must answer
 *      list_files with `denied: true` (inline blocked panel) and emit the
 *      "Permission denied" notice exactly ONCE — the file tree re-polls every
 *      10s, and before the dedupe fix every poll re-toasted the same denial
 *      ("permission error on every new chat" as reported).
 *   2. apply_project_filesystem_preset on a junction/symlink cwd must write
 *      the preset rule for BOTH the logical cwd (what the panel shows) and
 *      the physical path (what policy decisions resolve to) — a stale alias
 *      block would otherwise shadow the physical allow.
 *   3. After the preset, listing works (entries, no denied flag).
 *   4. Switching to another unruled folder re-toasts ONCE (new path key),
 *      and further polls stay silent.
 *   5. new_chat emits no permission notices.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { freePort, portUp } from "./lib/port-utils.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PORT = 8925;

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log((ok ? "✓ " : "✗ ") + name + (extra ? " — " + extra : ""));
	if (!ok) failures++;
};

// ── fixtures: junction cwd + unruled sibling + default-block policy ─────────
const temp = mkdtempSync(join(tmpdir(), "pi-fsux-"));
const physical = join(temp, "Workspace");
const project = join(temp, "project"); // junction/symlink -> physical
const unruled = join(temp, "unruled");
const dataDir = join(temp, "data");
const agentDir = join(temp, "agent");
for (const dir of [physical, unruled, dataDir, agentDir]) mkdirSync(dir, { recursive: true });
// On win32 a junction needs no privilege (symlinks do); the type is ignored on posix.
symlinkSync(physical, project, "junction");
writeFileSync(join(physical, "hello.txt"), "hi");
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "dummy" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			fixture: {
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1",
				apiKey: "fixture-only",
				models: [{ id: "fixture-model", name: "Fixture" }],
			},
		},
	}),
);
// The shipped default: block everything, no rules. Folder selection must NOT
// grant access, so listing any folder is denied until the user adds a rule.
writeFileSync(
	join(dataDir, "filesystem-policy.json"),
	JSON.stringify({
		defaultPermissions: {
			read: "block",
			create: "block",
			write: "block",
			edit: "block",
			delete: "block",
			execute: "block",
		},
		rules: [],
	}),
);

try {
	await freePort(PORT);
} catch {
	/* ignore */
}
const server = spawn("node", [join(REPO_ROOT, "dist/server/index.js")], {
	cwd: project,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_CWD: project,
		PI_WEB_START_BLANK: "1",
		PI_WEB_AUTO_RESUME: "0",
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
	await freePort(PORT);
};
for (let i = 0; i < 80 && !(await portUp(PORT)); i++) await sleep(250);
if (!(await portUp(PORT))) {
	console.error("server did not start");
	await cleanup();
	process.exit(1);
}

const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
const send = (msg) => ws.send(JSON.stringify(msg));
let snapshot = null;
const filesMsgs = [];
const policies = [];
const permissionNotices = [];
ws.on("message", (raw) => {
	let m;
	try {
		m = JSON.parse(raw.toString());
	} catch {
		return;
	}
	if (m.type === "snapshot") snapshot = m.state;
	else if (m.type === "files") filesMsgs.push(m);
	else if (m.type === "filesystem_policy") policies.push(m.policy);
	else if (m.type === "notice" && (m.textEn ?? m.text ?? "").includes("Permission denied")) permissionNotices.push(m);
});
const waitFor = async (pred, what, timeout = 15000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		if (pred()) return true;
		await sleep(100);
	}
	console.error(`TIMEOUT waiting for ${what}`);
	return false;
};
await new Promise((r) => ws.on("open", r));
send({ type: "hello", clientId: "fsux-test" });
await waitFor(() => snapshot !== null, "initial snapshot");

// ── 1) unruled cwd: denied listing + exactly ONE deduped notice ─────────────
send({ type: "list_files", path: "" });
await waitFor(() => filesMsgs.some((m) => m.path === "" && m.denied === true), "denied files message");
const denied = filesMsgs.find((m) => m.path === "" && m.denied === true);
check("blocked cwd answers list_files with denied:true", denied !== undefined);
check("denied listing carries no entries", denied !== undefined && denied.entries.length === 0);
// Simulate the RightPanel 10s poll: three more rounds must not re-toast.
for (let i = 0; i < 3; i++) {
	send({ type: "list_files", path: "" });
	await sleep(600);
}
check(
	"exactly one Permission denied notice across repeated polls",
	permissionNotices.length === 1,
	`got ${permissionNotices.length}`,
);

// ── 2) preset on a junction cwd writes BOTH alias and physical rules ────────
const normalize = (path) =>
	path
		.replace(/[\\/]+$/, "")
		.replaceAll("\\", "/")
		.toLowerCase();
const logical = snapshot.cwd; // what the server/panel show (the junction)
const resolved = realpathSync(logical); // what policy decisions resolve to
send({ type: "apply_project_filesystem_preset", preset: "development" });
await waitFor(
	() => policies.some((p) => p.rules.some((r) => normalize(r.path) === normalize(resolved))),
	"filesystem_policy with the physical rule",
);
const policy = policies.at(-1);
const devShaped = (rule) =>
	rule !== undefined &&
	rule.permissions.read === "allow" &&
	rule.permissions.write === "allow" &&
	rule.permissions.delete === "ask" &&
	rule.permissions.execute === "ask";
const ruleFor = (path) => policy?.rules.find((r) => normalize(r.path) === normalize(path));
check("preset writes a development rule for the physical path", devShaped(ruleFor(resolved)));
check(
	"preset writes a development rule for the logical (junction) cwd too",
	normalize(logical) === normalize(resolved) || devShaped(ruleFor(logical)),
	JSON.stringify(policy?.rules.map((r) => r.path)),
);

// ── 3) listing works after the preset ───────────────────────────────────────
const before = filesMsgs.length;
send({ type: "list_files", path: "" });
await waitFor(
	() => filesMsgs.slice(before).some((m) => m.path === "" && m.denied !== true),
	"allowed listing after preset",
);
const listed = filesMsgs.slice(before).find((m) => m.path === "" && m.denied !== true);
check(
	"after the preset the cwd lists its files",
	listed !== undefined && listed.entries.some((e) => e.name === "hello.txt"),
	listed ? listed.entries.map((e) => e.name).join(",") : "no listing",
);

// ── 4) another unruled folder toasts once, further polls stay silent ────────
const noticesBefore = permissionNotices.length;
send({ type: "set_cwd", path: unruled, requestId: "fsux-cwd" });
await waitFor(() => permissionNotices.length > noticesBefore, "denied notice for the unruled folder");
for (let i = 0; i < 2; i++) {
	send({ type: "list_files", path: "" });
	await sleep(600);
}
check(
	"switching to an unruled folder emits exactly one new notice",
	permissionNotices.length === noticesBefore + 1,
	`got ${permissionNotices.length - noticesBefore}`,
);

// ── 5) new_chat stays quiet ─────────────────────────────────────────────────
const noticesAtNewChat = permissionNotices.length;
send({ type: "new_chat" });
await sleep(1500);
check("new_chat emits no permission notices", permissionNotices.length === noticesAtNewChat);

ws.close();
await cleanup();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
