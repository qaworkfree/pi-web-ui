/**
 * PI_WEB_REQUIRE_PROJECT=1 regression (zero token, WS only): the deployment
 * starts with NO project selected and the user must explicitly pick the
 * folder(s) to expose — selection grants filesystem access.
 *
 *   1. First snapshot carries needsProject:true; the fallback cwd is NOT
 *      remembered as a recent project.
 *   2. prompt is refused with a "select a project folder first" notice.
 *   3. grant_folder_access on a junction folder writes the Development rule
 *      for BOTH the alias and the physical target and replies directory_result.
 *   4. set_cwd to the granted folder clears needsProject and listing works.
 *   5. A second grant adds another folder (one or more folders).
 *   6. Granting an already-readable folder leaves its custom rule untouched.
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
const PORT = 8926;

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log((ok ? "✓ " : "✗ ") + name + (extra ? " — " + extra : ""));
	if (!ok) failures++;
};

// ── fixtures ────────────────────────────────────────────────────────────────
const temp = mkdtempSync(join(tmpdir(), "pi-reqproj-"));
const fallback = join(temp, "fallback"); // technical startup cwd, no rule
const physicalA = join(temp, "WorkA");
const linkA = join(temp, "projectA"); // junction/symlink -> physicalA
const folderC = join(temp, "folderC"); // second grant target
const folderB = join(temp, "folderB"); // pre-existing CUSTOM rule
const dataDir = join(temp, "data");
const agentDir = join(temp, "agent");
for (const dir of [fallback, physicalA, folderC, folderB, dataDir, agentDir]) mkdirSync(dir, { recursive: true });
symlinkSync(physicalA, linkA, "junction");
writeFileSync(join(physicalA, "hello.txt"), "hi");
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
// Custom (non-preset) rule for folderB: must survive a re-grant untouched.
const customPermissions = { read: "allow", create: "allow" };
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
		rules: [{ path: folderB, permissions: customPermissions }],
	}),
);

try {
	await freePort(PORT);
} catch {
	/* ignore */
}
const server = spawn("node", [join(REPO_ROOT, "dist/server/index.js")], {
	cwd: fallback,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_CWD: fallback,
		PI_WEB_REQUIRE_PROJECT: "1",
		PI_WEB_START_BLANK: "1",
		PI_WEB_AUTO_RESUME: "0",
		PI_WEB_PLUGIN_CATALOG_URL: "",
	},
	stdio: ["ignore", "ignore", "pipe"],
});
let serverErr = "";
server.stderr.on("data", (chunk) => (serverErr += chunk.toString()));
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
	console.error(`server did not start (exitCode=${server.exitCode})\n${serverErr.trim() || "(no stderr)"}`);
	await cleanup();
	process.exit(1);
}

const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
const send = (msg) => ws.send(JSON.stringify(msg));
let snapshot = null;
const notices = [];
const directoryResults = [];
const policies = [];
const projects = [];
const filesMsgs = [];
ws.on("message", (raw) => {
	let m;
	try {
		m = JSON.parse(raw.toString());
	} catch {
		return;
	}
	if (m.type === "snapshot") snapshot = m.state;
	else if (m.type === "snapshot_delta" && snapshot && snapshot.rev === m.baseRev)
		snapshot = { ...snapshot, ...m.state, messages: [...(snapshot.messages ?? []), ...(m.appended ?? [])] };
	else if (m.type === "notice") notices.push(m);
	else if (m.type === "directory_result") directoryResults.push(m);
	else if (m.type === "filesystem_policy") policies.push(m.policy);
	else if (m.type === "projects") projects.push(m.projects ?? m.list ?? []);
	else if (m.type === "files") filesMsgs.push(m);
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
const normalize = (path) =>
	path
		.replace(/[\\/]+$/, "")
		.replaceAll("\\", "/")
		.toLowerCase();
const devShaped = (rule) =>
	rule !== undefined &&
	rule.permissions.read === "allow" &&
	rule.permissions.write === "allow" &&
	rule.permissions.delete === "ask" &&
	rule.permissions.execute === "ask";

await new Promise((r) => ws.on("open", r));
send({ type: "hello", clientId: "reqproj-test" });
await waitFor(() => snapshot !== null, "initial snapshot");

// ── 1) starts project-less ──────────────────────────────────────────────────
check("first snapshot carries needsProject:true", snapshot.needsProject === true);
check("fallback cwd is still the technical workspace", normalize(snapshot.cwd) === normalize(fallback));

// ── 2) prompt refused before selection ──────────────────────────────────────
send({ type: "prompt", text: "hello" });
await waitFor(
	() => notices.some((n) => (n.textEn ?? "").includes("Select a project folder first")),
	"prompt-refused notice",
);
check(
	"prompt before selection is refused with a notice",
	notices.some((n) => (n.textEn ?? "").includes("Select a project folder first")),
);
check("needsProject persists after the refused prompt", snapshot.needsProject === true);

// ── 3) grant on a junction writes alias + physical rules ────────────────────
const physicalResolved = realpathSync(linkA);
send({ type: "grant_folder_access", path: linkA, preset: "development", requestId: "grant-a" });
await waitFor(() => directoryResults.some((r) => r.requestId === "grant-a"), "grant directory_result");
const grantA = directoryResults.find((r) => r.requestId === "grant-a");
check("grant_folder_access replies directory_result without error", grantA !== undefined && !grantA.error);
await waitFor(
	() => policies.some((p) => p.rules.some((r) => normalize(r.path) === normalize(physicalResolved))),
	"policy push with physical rule",
);
const afterGrantA = policies.at(-1);
check(
	"grant writes a Development rule for the physical target",
	devShaped(afterGrantA?.rules.find((r) => normalize(r.path) === normalize(physicalResolved))),
);
check(
	"grant writes a Development rule for the alias (junction) too",
	normalize(linkA) === normalize(physicalResolved) ||
		devShaped(afterGrantA?.rules.find((r) => normalize(r.path) === normalize(linkA))),
	JSON.stringify(afterGrantA?.rules.map((r) => r.path)),
);

// ── 4) opening the granted folder clears needsProject, listing works ────────
send({ type: "set_cwd", path: linkA, requestId: "cwd-a" });
await waitFor(() => directoryResults.some((r) => r.requestId === "cwd-a" && r.path), "set_cwd directory_result");
await waitFor(() => snapshot.needsProject !== true && normalize(snapshot.cwd) === normalize(linkA), "cwd switch");
check("needsProject clears after picking a folder", snapshot.needsProject !== true);
const listMark = filesMsgs.length;
send({ type: "list_files", path: "" });
await waitFor(
	() => filesMsgs.slice(listMark).some((m) => m.path === "" && m.denied !== true),
	"listing of the granted folder",
);
const listed = filesMsgs.slice(listMark).find((m) => m.path === "" && m.denied !== true);
check("the granted folder lists its files", listed !== undefined && listed.entries.some((e) => e.name === "hello.txt"));

// ── 5) a second folder can be granted (one or more) ─────────────────────────
send({ type: "grant_folder_access", path: folderC, requestId: "grant-c" });
await waitFor(() => directoryResults.some((r) => r.requestId === "grant-c"), "second grant directory_result");
await waitFor(
	() => policies.some((p) => p.rules.some((r) => normalize(r.path) === normalize(folderC))),
	"policy push with second folder",
);
check(
	"a second folder gets its own Development rule",
	devShaped(policies.at(-1)?.rules.find((r) => normalize(r.path) === normalize(folderC))),
);

// ── 6) already-readable folder keeps its custom rule ────────────────────────
send({ type: "grant_folder_access", path: folderB, requestId: "grant-b" });
await waitFor(() => directoryResults.some((r) => r.requestId === "grant-b"), "already-allowed grant directory_result");
const grantB = directoryResults.find((r) => r.requestId === "grant-b");
send({ type: "get_filesystem_policy" });
await waitFor(() => policies.length > 0, "final policy push");
const finalRuleB = policies.at(-1)?.rules.find((r) => normalize(r.path) === normalize(folderB));
check("granting an already-readable folder succeeds", grantB !== undefined && !grantB.error);
check(
	"its custom rule is preserved (no Development overwrite)",
	finalRuleB !== undefined &&
		finalRuleB.permissions.read === "allow" &&
		finalRuleB.permissions.create === "allow" &&
		finalRuleB.permissions.write === undefined &&
		finalRuleB.permissions.delete === undefined,
	JSON.stringify(finalRuleB?.permissions),
);

// ── 7) the fallback cwd never became a recent project ───────────────────────
send({ type: "list_projects" });
await waitFor(() => projects.length > 0, "projects list");
const lastProjects = projects.at(-1);
check(
	"fallback cwd is not advertised as a recent project",
	!lastProjects.some((p) => normalize(p.path ?? p) === normalize(fallback)),
	JSON.stringify(lastProjects.map((p) => p.path ?? p)),
);

ws.close();
await cleanup();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
