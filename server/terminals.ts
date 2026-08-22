/**
 * TerminalManager — conversation-owned PTY sessions (node-pty) bridged over
 * the WebSocket protocol, plus the user command list persisted in
 * `<workspaceRoot>/.pi/commands.json`.
 *
 * Each conversation gets its own manager; terminals are shared across browser
 * tabs through the session emit. A socket drop does not kill them: the
 * conversation owns their lifecycle and releases them on disposal.
 *
 * Commands file format:
 *   { "commands": [ { "name": "dev", "command": "npm run dev", "cwd": "${pwd}" } ] }
 * `${pwd}` inside cwd/command resolves to the agent session's current working
 * directory (the same directory the agent operates in — see set_cwd).
 */
import { chmodSync, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
// MUST run before node-pty is required: rewrites the installed node-pty copies
// so their worker/agent handlers tolerate Node `--watch`'s IPC traffic (see the
// module itself for details).
import "./patch-node-pty.js";
import { spawn, type IPty } from "node-pty";
import {
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CommandDef, ServerMessage, TerminalInfo } from "./protocol.js";

// ---------------------------------------------------------------------------
// .pi/commands.json
// ---------------------------------------------------------------------------

export interface CommandsFile {
	commands: CommandDef[];
}

/** Location of the command list for a project: <workspaceRoot>/.pi/commands.json */
export function commandsFilePath(workspaceRoot: string): string {
	return join(workspaceRoot, ".pi", "commands.json");
}

/** Expand ${pwd} (and ~) in a cwd/command string against the session's cwd. */
export function expandPwd(input: string, pwd: string): string {
	let out = input.replace(/\$\{pwd\}/g, pwd);
	if (out === "~") return homedir();
	if (out.startsWith("~/")) out = join(homedir(), out.slice(2));
	return out;
}

/** Resolve a command's directory: default to the session cwd, expand ${pwd}/~, resolve relative paths. */
export function resolveCommandCwd(
	cwd: string | undefined,
	pwd: string,
): string {
	if (!cwd || cwd.trim() === "") return pwd;
	const expanded = expandPwd(cwd.trim(), pwd);
	return isAbsolute(expanded) ? expanded : resolve(pwd, expanded);
}

/** Read the command list; missing file → empty list; malformed → empty list + warning text. */
export async function loadCommands(
	workspaceRoot: string,
): Promise<{ commands: CommandDef[]; path: string; warning?: string }> {
	const path = commandsFilePath(workspaceRoot);
	const { commands, warning } = await readCommandsFile(path);
	return { commands, path, warning };
}

async function readCommandsFile(
	path: string,
): Promise<{ commands: CommandDef[]; warning?: string }> {
	if (!existsSync(path)) return { commands: [] };
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (err) {
		return {
			commands: [],
			warning: `读取命令文件失败：${(err as Error).message}`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { commands: [], warning: `命令文件不是有效 JSON：${path}` };
	}
	if (Array.isArray(parsed)) {
		// Tolerate a bare array: [{name, command, cwd}]
		return {
			commands: parsed
				.filter(
					(c): c is CommandDef =>
						typeof c === "object" &&
						c !== null &&
						typeof (c as CommandDef).name === "string" &&
						typeof (c as CommandDef).command === "string",
				)
				.map((c) => ({ name: c.name, command: c.command, cwd: c.cwd })),
		};
	}
	const obj = parsed as { commands?: unknown };
	if (obj && Array.isArray(obj.commands)) {
		return {
			commands: obj.commands
				.filter(
					(c): c is CommandDef =>
						typeof c === "object" &&
						c !== null &&
						typeof (c as CommandDef).name === "string" &&
						typeof (c as CommandDef).command === "string",
				)
				.map((c) => ({ name: c.name, command: c.command, cwd: c.cwd })),
		};
	}
	return { commands: [], warning: `命令文件格式不正确：${path}` };
}

/** Persist the command list, creating .pi/ if needed. */
export async function saveCommandsFile(
	workspaceRoot: string,
	commands: CommandDef[],
): Promise<{ path: string; error?: string }> {
	const path = commandsFilePath(workspaceRoot);
	try {
		await mkdir(join(workspaceRoot, ".pi"), { recursive: true });
		const payload: CommandsFile = { commands };
		await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
		return { path };
	} catch (err) {
		return { path, error: `保存命令文件失败：${(err as Error).message}` };
	}
}

// ---------------------------------------------------------------------------
// TerminalManager
// ---------------------------------------------------------------------------

interface TermEntry {
	id: string;
	pty: IPty;
	title: string;
	cwd: string;
	cols: number;
	rows: number;
	exited: boolean;
	exitCode: number | null;
	command?: CommandDef;
	/** Append-only output window. The cursor is an absolute character offset. */
	output: string;
	outputOffset: number;
	waiters: Set<() => void>;
}

const isWindows = process.platform === "win32";
const MAX_TERMINALS = 16;
const MAX_TERMINAL_HISTORY = 32;
const MAX_OUTPUT = 200_000;
const MAX_INPUT = 64 * 1024;
const MAX_ID = 80;

/** `-i` makes bash interactive; cmd.exe / powershell.exe are interactive on their own. */
function bashArgs(shell: string): string[] {
	return /[\\/]bash(\.exe)?$/i.test(shell) ? ["-i"] : [];
}

/**
 * Interactive shell for PTYs.
 * - Windows: prefer bash — it matches the SDK's bash tool, so the agent and
 *   the terminal speak the same shell language (no more PowerShell/bash
 *   混用 that leaves heredocs / `&&` / `<<` hanging or erroring). Order:
 *   1. PI_WEB_SHELL (explicit override)
 *   2. $SHELL when it exists on disk (user launched from a Git Bash session)
 *   3. Git Bash install paths (ProgramFiles / ProgramFiles(x86))
 *   4. busybox-w32 fallback in <home>/.pi-web/bin/bash.exe (ensure-bash.ts
 *      downloads it automatically when 2–3 are absent)
 *   5. $COMSPEC (cmd.exe — always set)
 *   6. powershell.exe (last resort)
 * - POSIX: the user's login shell, falling back to bash.
 * Resolved per terminal spawn (not at module load) so a busybox download that
 * finishes after startup is picked up by the next terminal.
 */
function resolveShell(): { shell: string; args: string[] } {
	if (isWindows) {
		const explicit = process.env.PI_WEB_SHELL;
		if (explicit) return { shell: explicit, args: bashArgs(explicit) };
		const she = process.env.SHELL;
		if (she && existsSync(she)) return { shell: she, args: bashArgs(she) };
		const pf = process.env.ProgramFiles;
		const pf86 = process.env["ProgramFiles(x86)"];
		for (const cand of [
			pf ? join(pf, "Git", "bin", "bash.exe") : "",
			pf86 ? join(pf86, "Git", "bin", "bash.exe") : "",
		]) {
			if (cand && existsSync(cand)) return { shell: cand, args: ["-i"] };
		}
		const busybox = join(homedir(), ".pi-web", "bin", "bash.exe");
		if (existsSync(busybox)) return { shell: busybox, args: ["-i"] };
		return { shell: process.env.COMSPEC || "powershell.exe", args: [] };
	}
	return { shell: process.env.SHELL || "bash", args: ["-i"] };
}

/**
 * Environment for spawned shells. System services (launchd/systemd) run with
 * no locale variables, which puts the shell in the C locale: its line editor
 * then renders UTF-8 continuation bytes 0x80–0x9F as C1 control characters
 * (e.g. `�<0091><0098>` for 员), garbling Chinese input in the terminal.
 * Default a UTF-8 locale so multibyte text round-trips.
 */
function shellEnv(): Record<string, string> {
	const env: Record<string, string> = {
		...process.env,
		TERM: "xterm-256color",
	};
	if (!env.LANG && !env.LC_ALL) env.LANG = "en_US.UTF-8";
	return env;
}

// ---------------------------------------------------------------------------
// node-pty ConoutConnection warning noise (Node --watch)
// ---------------------------------------------------------------------------
// node-pty's ConoutConnection warns about every unknown message from its ConPTY
// worker thread. Under `node --watch` (the dev server: `node --watch --import
// tsx`), Node's watch mode pushes `watch:require` / `watch:import` messages over
// the worker's message channel to track module dependencies; node-pty doesn't
// recognize them and logs one `Unexpected ConoutWorkerMessage { … }` per message
// — hundreds of lines per terminal (the SCM panel's hidden query PTY triggers it
// on every git-view open). The messages are harmless: the worker only ever sends
// its READY sentinel, which the handler does process. Filter that exact warning
// at the console boundary so dev output stays readable. Production runs without
// --watch and never produces these.
const originalWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
	if (args[0] === "Unexpected ConoutWorkerMessage") return;
	originalWarn(...args);
};

// ---------------------------------------------------------------------------
// spawn-helper permission repair (node-pty macOS prebuilds)
// ---------------------------------------------------------------------------
// node-pty 1.1.0 publishes its macOS prebuilds with `spawn-helper` lacking the
// execute bit (mode 0644 in the npm tarball), so posix_spawn fails with EACCES
// and node-pty throws the generic "posix_spawnp failed". Locally-built
// copies (build/Release) are fine; every `npm install` that picks the prebuild
// — e.g. `npm i -g pi-web-ui`, which is what system-service installs run — is
// broken until the bit is restored. Self-heal at startup AND lazily before
// every spawn (an `npm i -g` while the server is running replaces the helper
// under the running process, so the startup-only repair misses it).
// Best-effort: a read-only node_modules just keeps the old failure.

const require = createRequire(import.meta.url);

/** Absolute paths of every node-pty spawn-helper this install can exec. */
function spawnHelperPaths(): string[] {
	try {
		// require.resolve("node-pty") → <pkg>/lib/index.js → package root is two up.
		const pkgDir = dirname(dirname(require.resolve("node-pty")));
		const out: string[] = [];
		const built = join(pkgDir, "build", "Release", "spawn-helper");
		if (existsSync(built)) out.push(built);
		const prebuildsDir = join(pkgDir, "prebuilds");
		if (existsSync(prebuildsDir)) {
			for (const entry of readdirSync(prebuildsDir)) {
				const p = join(prebuildsDir, entry, "spawn-helper");
				if (existsSync(p)) out.push(p);
			}
		}
		return out;
	} catch {
		return [];
	}
}

/** Restore the +x bit on node-pty's spawn-helper binaries (idempotent). */
function repairSpawnHelperPermissions(): void {
	if (isWindows) return;
	for (const p of spawnHelperPaths()) {
		try {
			if ((statSync(p).mode & 0o111) === 0) chmodSync(p, 0o755);
		} catch {
			// best-effort; a read-only node_modules just keeps the old failure
		}
	}
}
repairSpawnHelperPermissions();

/** Path of a still-broken helper, for the error hint ("" when none). */
function brokenSpawnHelper(): string {
	if (isWindows) return "";
	for (const p of spawnHelperPaths()) {
		try {
			if ((statSync(p).mode & 0o111) === 0) return p;
		} catch {
			// ignore
		}
	}
	return "";
}

// ---------------------------------------------------------------------------
// macOS TCC camera/mic warning (launchd-spawned servers)
// ---------------------------------------------------------------------------
// TCC attributes camera/mic access to the process chain's "responsible
// process". When pi-web-ui runs as a launchd LaunchAgent (node ← launchd),
// the responsible process is node itself — a bare CLI binary with no app
// bundle / Info.plist / NSCameraUsageDescription — so TCC silently denies
// camera access (no prompt, nothing to tick in System Settings) and
// ffmpeg-style grabbers hang on frame capture. The identical command works
// from a terminal app that already holds the camera grant. Detect the
// "no GUI ancestor" case (ppid === 1 on macOS) and warn in the terminal.
const TCC_HINT = [
	"\x1b[33m[提示] 本终端由后台服务（launchd）启动，macOS 隐私权限（相机/麦克风/屏幕录制等）对此类进程不可用。\x1b[0m",
	"\x1b[90m  · 需要隐私权限的命令会被系统静默拒绝：不弹授权窗，系统设置里也无法勾选，表现多为卡死或无输出。",
	"  · 这类任务请在你自己已授权的前台终端里运行。",
	"  · 本终端内可运行不需要隐私权限的命令（如文件处理、网络请求、远程设备流）。",
	"  · 若改在前台终端里运行 pi-web-ui，本提示即不再出现。\x1b[0m",
].join("\r\n") + "\r\n";

/** True when this server was spawned by launchd (or orphaned) on macOS — no GUI app in the ancestry, so camera/mic TCC grants are unavailable. */
function launchdSpawnedOnMac(): boolean {
	return process.platform === "darwin" && process.ppid === 1;
}

// ---------------------------------------------------------------------------
// Key encoding (pure — byte-exact assertions live in terminal-smoke-test.mjs)
// ---------------------------------------------------------------------------
/** A key translated to the exact byte sequence for the PTY, or an error. */
export type TerminalKeyEncoding = { data: string } | { error: string };

/**
 * Translate a logical key (named key or single character) plus modifiers into
 * the exact byte sequence a PTY expects. Named keys are routed by NAME, so a
 * Ctrl/Alt combo is NEVER derived from the key's first letter: Ctrl+ArrowUp
 * must produce `ESC[1;5A`, not Ctrl+A, and Ctrl+Enter `ESC[13;5u`, not Ctrl+E.
 *  - arrows / F1–F4 / Home / End keep their plain form when unmodified and
 *    gain the xterm modifier parameter (`ESC[1;<m>X`) under Shift/Alt/Ctrl;
 *  - other named keys (Enter/Tab/Backspace/Escape/Insert/Delete/PageUp/PageDown)
 *    fall back to the CSI-u form (`ESC[<code>;<m>u`) once modified;
 *  - plain characters: Ctrl maps A–Z to 0x01–0x1A (error for non-letters),
 *    Shift uppercases, Alt prefixes with ESC.
 */
export function encodeTerminalKey(
	key: string,
	modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
): TerminalKeyEncoding {
	const named: Record<string, string> = {
		Enter: "\r", Return: "\r", Tab: "\t", Backspace: "\x7f", Escape: "\x1b",
		Up: "\x1b[A", ArrowUp: "\x1b[A", Down: "\x1b[B", ArrowDown: "\x1b[B",
		Left: "\x1b[D", ArrowLeft: "\x1b[D", Right: "\x1b[C", ArrowRight: "\x1b[C",
		Home: "\x1b[H", End: "\x1b[F", Delete: "\x1b[3~", Insert: "\x1b[2~",
		PageUp: "\x1b[5~", PageDown: "\x1b[6~", F1: "\x1bOP", F2: "\x1bOQ", F3: "\x1bOR", F4: "\x1bOS",
	};
	let data = named[key] ?? (key.length === 1 ? key : "");
	if (!data) return { error: `不支持的终端按键：${key}` };
	// xterm modifier encoding: 1=plain, 2=Shift, 3=Alt, 5=Ctrl,
	// 6=Ctrl+Shift, 7=Ctrl+Alt, 8=Ctrl+Alt+Shift.
	const modifier = 1 + (modifiers.shift ? 1 : 0) + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
	const arrow = /^\x1b\[([A-DHF])$/.exec(data);
	const functionKey = /^\x1bO([P-S])$/.exec(data);
	const namedCode: Record<string, number> = {
		Enter: 13, Return: 13, Tab: 9, Backspace: 127, Escape: 27,
		Insert: 2, Delete: 3, Home: 1, End: 4, PageUp: 5, PageDown: 6,
	};
	if (arrow && modifier !== 1) {
		data = `\x1b[1;${modifier}${arrow[1]}`;
	} else if (functionKey && modifier !== 1) {
		data = `\x1b[1;${modifier}${functionKey[1]}`;
	} else if (namedCode[key] !== undefined && modifier !== 1) {
		// CSI-u keeps named keys identifiable. In particular, Ctrl+Enter and
		// Ctrl+Tab must not be derived from the first letter of "Enter"/"Tab".
		data = `\x1b[${namedCode[key]};${modifier}u`;
	} else {
		if (modifiers.ctrl) {
			if (key.length !== 1) return { error: `Ctrl 组合键无效：${key}` };
			const code = key.toUpperCase().charCodeAt(0);
			if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64);
			else return { error: `Ctrl 组合键无效：${key}` };
		} else if (modifiers.shift && key.length === 1) {
			data = key.toUpperCase();
		}
		if (modifiers.alt) data = "\x1b" + data;
	}
	return { data };
}

/**
 * Owns one or more PTYs for a conversation. All output is forwarded as
 * `terminal_output` messages through the provided emit (broadcast to every
 * socket attached to the client session). Failed spawns emit an error notice and
 * terminal_exit instead of throwing into the WebSocket dispatcher.
 */
export class TerminalManager {
	/** Live PTYs only. Exited entries move to history so they no longer consume
	 * the live-terminal limit while their output remains readable/replayable. */
	private terms = new Map<string, TermEntry>();
	private history = new Map<string, TermEntry>();
	private seq = 0;
	private tccHintShown = false;

	constructor(
		private emit: (msg: ServerMessage) => void,
		private readonly workspaceRoot: string,
	) {}

	/** Start a plain interactive shell in the given directory. */
	create(
		id: string,
		cwd: string,
		cols: number,
		rows: number,
		fallbackCwd: string,
		title?: string,
	): TerminalInfo | null {
		const valid = this.validateId(id);
		if (valid) {
			this.fail(id, valid);
			return null;
		}
		if (this.terms.has(id)) return this.info(this.terms.get(id)!);
		// Every spawn path shares the same admission rule (ensureSpawnAllowed):
		// a NEW live PTY needs a free slot under the cap. Reusing an exited name
		// starts a fresh PTY and discards its old history — but only after the
		// slot check, so a rejected request keeps its retained output.
		if (!this.ensureSpawnAllowed(id)) return null;
		this.history.delete(id);
		const safeCwd = this.safeCwd(cwd || fallbackCwd);
		if (!safeCwd) {
			this.fail(id, "终端工作目录必须位于当前工作区内");
			return null;
		}
		if (this.spawnShell(id, safeCwd, cols, rows, title || `终端 ${++this.seq}`)) {
			this.maybeEmitTccHint(id);
			this.emitList();
			return this.info(this.terms.get(id)!);
		}
		return null;
	}

	/** Warn about unavailable camera/mic TCC grants in a fresh terminal, once per client. */
	private maybeEmitTccHint(id: string): void {
		if (this.tccHintShown || !launchdSpawnedOnMac()) return;
		this.tccHintShown = true;
		this.writeOut(id, TCC_HINT);
	}

	/**
	 * Start a shell in the command's directory and run the command in it.
	 *
	 * If a terminal with this id already exists it is RESTARTED in place: the
	 * running process is killed and a fresh shell runs the command again in the
	 * same terminal (used when re-running a command by clicking its entry).
	 */
	runCommand(
		id: string,
		def: CommandDef,
		cols: number,
		rows: number,
		pwd: string,
	): void {
		const invalidId = this.validateId(id);
		if (invalidId) {
			this.fail(id, invalidId);
			return;
		}
		const existing = this.terms.get(id);
		// Same admission rule as create(): a live terminal may be restarted in
		// place, but a NEW live PTY needs a free slot — an id sitting in history
		// (exited) does NOT grant one, or re-running exited terminals while at
		// the cap could push the live count past MAX_TERMINALS.
		if (!existing && !this.ensureSpawnAllowed(id)) return;
		const hasHistory = this.history.has(id);
		const rawDir = resolveCommandCwd(def.cwd, pwd);
		const dir = this.safeCwd(rawDir);
		const command = expandPwd(def.command.trim(), pwd);
		const title = def.name || command || `终端 ${++this.seq}`;
		if (!dir) {
			this.fail(id, "终端工作目录必须位于当前工作区内");
			return;
		}

		if (existing) {
			// Re-run in place: interrupt the current process (kill the PTY's
			// process group) and start a fresh shell with the same id. Keep the
			// last known size so the replacement matches the xterm's dimensions.
			if (!existing.exited) {
				existing.exited = true;
				try {
					existing.pty.kill();
				} catch {
					// already dead
				}
			}
			cols = existing.cols || cols;
			rows = existing.rows || rows;
			this.terms.delete(id);
		}
		this.history.delete(id);

		const ok = this.spawnShell(id, dir, cols, rows, title, def);
		if (!ok) return;
		this.emitList();
		// Clear the previous run's output, then show a banner and run the command
		// (the PTY input buffer holds it until the shell is ready).
		const banner =
			"\x1b[2J\x1b[3J\x1b[H" +
			`\x1b[90m> ${command}\x1b[0m  \x1b[90m(${dir})\x1b[0m\r\n`;
		const fresh = this.terms.get(id);
		if (fresh) this.appendOutput(fresh, banner);
		this.writeOut(id, banner);
		this.maybeEmitTccHint(id);
		if (command) this.input(id, command + "\r");
	}

	/** Spawn the user's shell as a PTY. Returns false when the spawn failed. */
	private spawnShell(
		id: string,
		cwd: string,
		cols: number,
		rows: number,
		title: string,
		command?: CommandDef,
	): boolean {
		let abs = cwd;
		if (!abs) abs = homedir();
		else if (!isAbsolute(abs)) abs = resolve(abs);
		try {
			if (!existsSync(abs) || !statSync(abs).isDirectory()) {
				this.fail(id, `目录不存在或不是目录：${abs}`);
				return false;
			}
		} catch {
			this.fail(id, `无法访问终端目录：${abs}`);
			return false;
		}
		// node-pty's spawn-helper may have lost its +x bit since the last repair
		// (e.g. a global npm install replaced the helper while this server runs).
		repairSpawnHelperPermissions();
		let pty: IPty;
		try {
			const { shell, args } = resolveShell();
			pty = spawn(shell, args, {
				name: "xterm-256color",
				cols: Math.max(2, Math.floor(cols) || 80),
				rows: Math.max(2, Math.floor(rows) || 24),
				cwd: abs,
				env: shellEnv(),
			});
		} catch (err) {
			const helper = brokenSpawnHelper();
			this.fail(
				id,
				helper
					? `启动终端失败：${(err as Error).message}（node-pty 的 spawn-helper 缺少执行权限，请运行：chmod +x "${helper}"）`
					: `启动终端失败：${(err as Error).message}`,
			);
			return false;
		}
		const entry: TermEntry = {
			id,
			pty,
			title,
			cwd: abs,
			cols: Math.max(2, Math.floor(cols) || 80),
			rows: Math.max(2, Math.floor(rows) || 24),
			exited: false,
			exitCode: null,
			command,
			output: "",
			outputOffset: 0,
			waiters: new Set(),
		};
		this.terms.set(id, entry);
		// The closures capture `entry`: after a restart the map points at the
		// replacement, so a late event from the OLD pty must be ignored.
		pty.onData((data) => {
			if (this.terms.get(id) !== entry) return;
			this.appendOutput(entry, data);
			this.writeOut(id, data);
		});
		pty.onExit(({ exitCode }) => {
			if (this.terms.get(id) !== entry) return;
			this.exit(id, exitCode);
		});
		return true;
	}

	private writeOut(id: string, data: string): void {
		const entry = this.terms.get(id);
		if (!entry) return;
		this.emit({ type: "terminal_output", terminalId: id, data });
	}

	private appendOutput(entry: TermEntry, data: string): void {
		entry.output += data;
		if (entry.output.length > MAX_OUTPUT) {
			const drop = entry.output.length - MAX_OUTPUT;
			entry.output = entry.output.slice(drop);
			entry.outputOffset += drop;
		}
		for (const wake of entry.waiters) wake();
		entry.waiters.clear();
	}

	private validateId(id: string): string | null {
		if (!id || id.length > MAX_ID || !/^[A-Za-z0-9._:-]+$/.test(id)) {
			return "终端名称无效：只能使用字母、数字、.-、_ 或 :（最长 80 字符）";
		}
		return null;
	}

	/**
	 * Admission control for EVERY spawn path (create / runCommand): spawning a
	 * NEW live PTY is only allowed while the live count is below MAX_TERMINALS.
	 * Restarting an id that is ALREADY live is always allowed (no extra slot).
	 * History entries (exited terminals) do not reserve a slot — re-spawning
	 * one while at the cap is rejected with the standard error feedback.
	 */
	private ensureSpawnAllowed(id: string): boolean {
		if (this.terms.has(id)) return true;
		if (this.terms.size >= MAX_TERMINALS) {
			this.fail(id, `终端数量已达上限（${MAX_TERMINALS}）`);
			return false;
		}
		return true;
	}

	private safeCwd(raw: string): string | null {
		try {
			const root = realpathSync(resolve(this.workspaceRoot));
			const candidate = realpathSync(isAbsolute(raw) ? resolve(raw) : resolve(root, raw));
			const rel = relative(root, candidate);
			if (rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel))) {
				return candidate;
			}
		} catch {
			// Missing directories and broken symlinks are rejected by the boundary.
		}
		return null;
	}

	private info(entry: TermEntry): TerminalInfo {
		return {
			id: entry.id,
			title: entry.title,
			cwd: entry.cwd,
			cols: entry.cols,
			rows: entry.rows,
			running: !entry.exited,
			exitCode: entry.exitCode,
			command: entry.command,
		};
	}

	has(id: string): boolean {
		return this.terms.has(id) || this.history.has(id);
	}

	private find(id: string): TermEntry | undefined {
		return this.terms.get(id) ?? this.history.get(id);
	}

	list(): TerminalInfo[] {
		return [...this.terms.values(), ...this.history.values()].map((entry) => this.info(entry));
	}

	private emitList(): void {
		this.emit({ type: "terminal_list", terminals: this.list() });
	}

	/** Replay the retained output window after switching back to this conversation. */
	replay(): { terminalId: string; data: string }[] {
		return [...this.terms.values(), ...this.history.values()]
			.filter((entry) => entry.output.length > 0)
			.map((entry) => ({ terminalId: entry.id, data: entry.output }));
	}

	/** Read output after an absolute cursor. */
	read(id: string, cursor = 0, maxBytes = 20_000): { data: string; cursor: number; running: boolean; exitCode: number | null } | null {
		const entry = this.find(id);
		if (!entry) return null;
		const start = Math.max(entry.outputOffset, Math.min(cursor, entry.outputOffset + entry.output.length));
		const end = Math.min(start + Math.max(1, Math.floor(maxBytes) || 20_000), entry.outputOffset + entry.output.length);
		return { data: entry.output.slice(start - entry.outputOffset, end - entry.outputOffset), cursor: end, running: !entry.exited, exitCode: entry.exitCode };
	}

	async waitForOutput(id: string, cursor: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
		const current = this.read(id, cursor, 1);
		if (!current || current.cursor > cursor || !current.running) return;
		await new Promise<void>((resolvePromise) => {
			const entry = this.find(id);
			if (!entry) return resolvePromise();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const done = () => {
				if (timer) clearTimeout(timer);
				entry.waiters.delete(done);
				signal?.removeEventListener("abort", done);
				resolvePromise();
			};
			entry.waiters.add(done);
			timer = setTimeout(done, Math.max(0, Math.min(timeoutMs, 120_000)));
			signal?.addEventListener("abort", done, { once: true });
		});
	}

	inputChecked(id: string, data: string): string | null {
		if (data.length > MAX_INPUT) return `输入过长（上限 ${MAX_INPUT} 字符）`;
		const entry = this.terms.get(id);
		if (!entry || entry.exited) return "终端不存在或进程已退出";
		entry.pty.write(data);
		return null;
	}

	key(id: string, key: string, modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}): string | null {
		const encoded = encodeTerminalKey(key, modifiers);
		if ("error" in encoded) return encoded.error;
		return this.inputChecked(id, encoded.data);
	}


	/** Emit a terminal failure (bad cwd, spawn error) and mark the terminal dead. */
	private fail(id: string, text: string): void {
		this.emit({ type: "notice", level: "error", text });
		this.emit({
			type: "terminal_output",
			terminalId: id,
			data: `\x1b[91m${text}\x1b[0m\r\n`,
		});
		this.emit({ type: "terminal_exit", terminalId: id, exitCode: null });
	}


	private exit(id: string, exitCode: number): void {
		const entry = this.terms.get(id);
		if (!entry || entry.exited) return;
		const banner = `\r\n\x1b[90m[进程已退出，退出码 ${exitCode}]\x1b[0m\r\n`;
		this.appendOutput(entry, banner);
		this.writeOut(id, banner);
		entry.exited = true;
		entry.exitCode = exitCode;
		this.terms.delete(id);
		while (this.history.size >= MAX_TERMINAL_HISTORY) {
			const oldest = this.history.keys().next().value;
			if (typeof oldest !== "string") break;
			this.history.delete(oldest);
		}
		this.history.set(id, entry);
		this.emit({ type: "terminal_exit", terminalId: id, exitCode });
		this.emitList();
	}

	input(id: string, data: string): void {
		void this.inputChecked(id, data);
	}

	resize(id: string, cols: number, rows: number): void {
		const entry = this.terms.get(id);
		if (!entry || entry.exited) return;
		try {
			entry.pty.resize(
				Math.max(2, Math.floor(cols) || 80),
				Math.max(2, Math.floor(rows) || 24),
			);
			// Remember the size so an in-place restart spawns at the same dims.
			entry.cols = Math.max(2, Math.floor(cols) || 80);
			entry.rows = Math.max(2, Math.floor(rows) || 24);
		} catch {
			// PTY already gone — nothing to do.
		}
	}

	/** Kill one terminal (tab closed), including an exited terminal's retained history. */
	kill(id: string): void {
		const entry = this.terms.get(id);
		if (entry) {
			entry.exited = true;
			try {
				entry.pty.kill();
			} catch {
				// already dead
			}
			this.terms.delete(id);
			this.emit({ type: "terminal_exit", terminalId: id, exitCode: null });
			this.emitList();
			return;
		}
		if (this.history.delete(id)) this.emitList();
	}

	/** Kill every terminal owned by this conversation. */
	killAll(): void {
		for (const entry of this.terms.values()) {
			if (entry.exited) continue;
			entry.exited = true;
			try {
				entry.pty.kill();
			} catch {
				// already dead
			}
		}
		for (const entry of this.terms.values()) {
			for (const wake of entry.waiters) wake();
			entry.waiters.clear();
		}
		this.terms.clear();
		this.history.clear();
		this.emitList();
	}
}

/** Build the agent-facing persistent terminal tools for one conversation. */
export function makePersistentTerminalTools(
	terminals: TerminalManager,
	cwd: string,
): ToolDefinition[] {
	const result = (text: string, details: unknown = {}): {
		content: { type: "text"; text: string }[];
		details: unknown;
	} => ({ content: [{ type: "text", text }], details });
	const failIf = (error: string | null): void => {
		if (error) throw new Error(error);
	};

	return [
		defineTool({
			name: "terminal_create",
			label: "Create terminal",
			description:
				"Create a named persistent interactive PTY in the current workspace. Use terminal_input or terminal_key to interact with it and terminal_read to inspect incremental output.",
			promptSnippet: "create persistent interactive PTY terminals",
			parameters: Type.Object({
				terminalId: Type.String({ description: "Stable terminal name" }),
				cwd: Type.Optional(Type.String({ description: "Workspace-relative directory" })),
				cols: Type.Optional(Type.Integer({ minimum: 2, maximum: 500 })),
				rows: Type.Optional(Type.Integer({ minimum: 2, maximum: 200 })),
			}),
			execute: async (_id, p) => {
				const info = terminals.create(
					p.terminalId,
					p.cwd ?? cwd,
					p.cols ?? 120,
					p.rows ?? 40,
					cwd,
					p.terminalId,
				);
				if (!info) throw new Error(`创建终端失败：${p.terminalId}`);
				return result(`终端已创建：${JSON.stringify(info)}`, info);
			},
		}),
		defineTool({
			name: "terminal_list",
			label: "List terminals",
			description: "List all persistent PTY terminals owned by this conversation.",
			promptSnippet: "list persistent terminals",
			parameters: Type.Object({}),
			execute: async () => result(JSON.stringify(terminals.list()), terminals.list()),
		}),
		defineTool({
			name: "terminal_close",
			label: "Close terminal",
			description: "Close a persistent PTY and terminate its process tree.",
			parameters: Type.Object({ terminalId: Type.String() }),
			execute: async (_id, p) => {
				if (!terminals.has(p.terminalId)) throw new Error(`终端不存在：${p.terminalId}`);
				terminals.kill(p.terminalId);
				return result(`终端已关闭：${p.terminalId}`);
			},
		}),
		defineTool({
			name: "terminal_input",
			label: "Send terminal input",
			description: "Send arbitrary text to a persistent PTY. Include newline when a command should be submitted.",
			parameters: Type.Object({ terminalId: Type.String(), data: Type.String() }),
			execute: async (_id, p) => {
				failIf(terminals.inputChecked(p.terminalId, p.data));
				return result(`已发送 ${p.data.length} 个字符到 ${p.terminalId}`);
			},
		}),
		defineTool({
			name: "terminal_key",
			label: "Send terminal key",
			description: "Send Enter, Tab, arrows, function keys, or Ctrl/Alt combinations to a persistent PTY.",
			parameters: Type.Object({
				terminalId: Type.String(),
				key: Type.String({ description: "Enter, Tab, ArrowUp, c, etc." }),
				modifiers: Type.Optional(Type.Object({
					ctrl: Type.Optional(Type.Boolean()),
					alt: Type.Optional(Type.Boolean()),
					shift: Type.Optional(Type.Boolean()),
				})),
			}),
			execute: async (_id, p) => {
				failIf(terminals.key(p.terminalId, p.key, p.modifiers));
				return result(`已发送按键 ${p.key} 到 ${p.terminalId}`);
			},
		}),
		defineTool({
			name: "terminal_read",
			label: "Read terminal output",
			description: "Read incremental output from a persistent PTY. Keep the returned cursor and pass it on the next read; optionally wait for new output or process exit.",
			parameters: Type.Object({
				terminalId: Type.String(),
				cursor: Type.Optional(Type.Integer({ minimum: 0 })),
				maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })),
				waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 120000 })),
			}),
			execute: async (_id, p, signal) => {
				const cursor = p.cursor ?? 0;
				if (p.waitMs) await terminals.waitForOutput(p.terminalId, cursor, p.waitMs, signal);
				const read = terminals.read(p.terminalId, cursor, p.maxBytes ?? 20000);
				if (!read) throw new Error(`终端不存在：${p.terminalId}`);
				return result(JSON.stringify(read), read);
			},
		}),
	];
}
