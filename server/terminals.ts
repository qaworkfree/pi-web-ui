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
	/** Coalesced outbound output (see OUTPUT_FLUSH_MS) not yet sent to the browser. */
	pendingOut: string;
	/** Timer for the coalescing window; null = nothing pending. */
	flushTimer: ReturnType<typeof setTimeout> | null;
	// ---- 终端活力检测（liveness watchdog，仅 agent 工具路径参与）----
	/** true = 该终端被 agent 的 terminal_create/input/key 触碰过（用户手开的
	 *  终端永远不参与静默提醒）。同时也是「当前纪元仍武装」的标志：看门狗
	 *  触发一次后清零，下次 agent 触碰重新开始计时。 */
	agentTouched: boolean;
	/** 最后一次 PTY 输出 / 输入写入的时刻——静默时长以它为基准。 */
	lastActivityAt: number;
	/** 静默看门狗 timer；null = 未武装。 */
	idleTimer: ReturnType<typeof setTimeout> | null;
	/** 输出观察器（终端接管 bash 的完成检测）：注册后在 appendOutput 里累积
	 *  新数据并匹配正则；命中或终端退出时回调一次即移除。buf 从注册时刻累积。 */
	watches: { re: RegExp; buf: string; cb: (m: RegExpMatchArray | null) => void }[];
	/** true = 终端接管 bash 刚发出一条带哨兵的命令且尚未结束（terminal_wait
	 *  用它区分「有命令在跑」和「shell 空闲在提示符」——后者等哨兵永远等不到）。 */
	sentinelPending?: boolean;
}

const isWindows = process.platform === "win32";
const MAX_TERMINALS = 16;
/** Coalescing window for terminal_output WS messages (one animation frame). */
const OUTPUT_FLUSH_MS = 16;
const MAX_TERMINAL_HISTORY = 32;
const MAX_OUTPUT = 200_000;
const MAX_INPUT = 64 * 1024;
const MAX_ID = 80;

/**
 * 终端活力检测阈值：agent 触碰过的终端连续静默这么久且该对话正在运行时，
 * 通过 onAgentIdle 回调通知宿主（宿主注入一条 steer 消息唤醒 AI 去检查）。
 * PI_WEB_TERMINAL_IDLE_MS 覆盖；0 = 关闭检测。每次调用时读取（测试可注入）。
 */
export function terminalIdleNotifyMs(): number {
	const raw = Number(process.env.PI_WEB_TERMINAL_IDLE_MS);
	return Number.isFinite(raw) && raw >= 0 ? raw : 15_000;
}

// ---------------------------------------------------------------------------
// 终端接管 bash（terminal-backed bash tool）
// ---------------------------------------------------------------------------

/** 哨兵行：命令执行完后由 shell 打印，携带真实退出码。正则只匹配数字，
 *  因此不会误匹配回显里的 printf 格式串 `[pi-exit:%s]`。 */
const BASH_SENTINEL_RE = /\[pi-exit:(\d+)\]/g;

/**
 * 把任意命令（含多行脚本）构造成「一行」交互 shell 命令：执行 + 捕获退出码。
 *
 * 单行很关键：整行先被 shell 完整解析再执行，命令中途读 stdin 也不会吃掉
 * 后续哨兵；也避开交互 shell 的 bracketed-paste 对多行输入的特殊处理。
 * 多行脚本用 `$'...'` ANSI-C 引号转义后交给 eval（bash/zsh/busybox ash 都支持）。
 */
export function buildTerminalBashLine(command: string): string {
	const trimmed = command.replace(/\s+$/, "");
	let body = trimmed;
	if (trimmed.includes("\n")) {
		body = `eval $'${trimmed
			.replace(/\\/g, "\\\\")
			.replace(/'/g, "\\'")
			.replace(/\r/g, "\\r")
			.replace(/\n/g, "\\n")
			.replace(/\t/g, "\\t")}'`;
	}
	return `${body}; __pi_rc=$?; printf '\\n[pi-exit:%s]\\n' "$__pi_rc"`;
}

/** 去掉 ANSI 转义序列（OSC/CSI/其余 ESC 序列）与孤立 CR（进度条重绘），
 *  让 PTY 回显变成 bash 工具风格的纯文本。 */
export function stripAnsi(s: string): string {
	return s
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC（标题/超链接等）
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI（颜色/光标/清屏等）
		.replace(/\x1b[@-_]/g, "") // 其余单字符 ESC 序列
		.replace(/\r(?!\n)/g, ""); // 孤立 CR（进度条原地重绘）
}

/** 截断过长的工具结果：保留头尾，中间省略。 */
function truncateMiddle(text: string, max = 30_000): string {
	if (text.length <= max) return text;
	const head = Math.floor(max * 0.3);
	const tail = max - head;
	return `${text.slice(0, head)}\n…（中间省略 ${text.length - max} 字符）…\n${text.slice(-tail)}`;
}

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
 * Shell for the terminal-backed bash tool ('ai-bash'): ALWAYS bash, never the
 * user's login shell (often zsh on macOS, whose `read -p` etc. diverge from
 * the bash semantics models write). Windows already prefers Git Bash/busybox
 * bash; on posix pick $SHELL when it is bash, else plain `bash`.
 */
function resolveBashShell(): { shell: string; args: string[] } {
	if (isWindows) {
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
	}
	const she = process.env.SHELL;
	if (she && she.endsWith("bash") && existsSync(she)) {
		return { shell: she, args: ["-i"] };
	}
	return { shell: "bash", args: ["-i"] };
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

	/** 宿主回调：AI 触碰过的终端静默 ≥ 阈值时触发（一次性/纪元语义见
	 *  noteAgentActivity）。宿主自行判断会话是否在运行并决定是否注入。 */
	onAgentIdle: ((terminalId: string, idleMs: number, title: string) => void) | null = null;

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
		opts?: { forceBash?: boolean },
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
		if (
			this.spawnShell(
				id,
				safeCwd,
				cols,
				rows,
				title || `终端 ${++this.seq}`,
				undefined,
				opts?.forceBash,
			)
		) {
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
				this.flushPending(existing);
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
		forceBash?: boolean,
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
			const { shell, args } = forceBash ? resolveBashShell() : resolveShell();
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
			pendingOut: "",
			flushTimer: null,
			agentTouched: false,
			lastActivityAt: Date.now(),
			idleTimer: null,
			watches: [],
		};
		this.terms.set(id, entry);
		// The closures capture `entry`: after a restart the map points at the
		// replacement, so a late event from the OLD pty must be ignored.
		pty.onData((data) => {
			if (this.terms.get(id) !== entry) return;
			this.appendOutput(entry, data);
			// Coalesce instead of emitting per chunk: node-pty onData fires per
			// ConPTY read buffer (dozens of bytes to a few KB each), so a build or
			// `cat` of a big file used to produce hundreds/thousands of WS frames
			// per second — each paying stringify + frame + parse + dispatch cost.
			// A one-frame micro-batch cuts the frame rate 10-50× at ≤16ms latency
			// (imperceptible; xterm writes batch data more efficiently anyway).
			this.queueOut(entry, data);
		});
		pty.onExit(({ exitCode }) => {
			if (this.terms.get(id) !== entry) return;
			this.exit(id, exitCode);
		});
		return true;
	}

	/**
	 * 记录一次 agent 工具触碰并启动一个新的静默纪元（terminal_create /
	 * terminal_input / terminal_key 的工具包装层调用——浏览器路径绝不调用，
	 * 用户自己开的终端永远不会收到静默提醒）。
	 *
	 * 纪元语义（防骚扰）：agentTouched 同时是「纪元武装」标志。看门狗触发
	 * 一次后即解除武装，之后无论静默多久都不再提醒，直到 agent 再次触碰
	 * （再发输入 = AI 又在等结果了）。纪元内的每一段输出都重置倒计时。
	 */
	noteAgentActivity(id: string): void {
		const entry = this.terms.get(id);
		if (!entry || entry.exited) return;
		entry.agentTouched = true;
		entry.lastActivityAt = Date.now();
		this.armIdleWatch(entry);
	}

	/** 武装（或按当前 lastActivityAt 重置）静默看门狗。 */
	private armIdleWatch(entry: TermEntry): void {
		if (entry.idleTimer) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = null;
		}
		const idleMs = terminalIdleNotifyMs();
		if (!entry.agentTouched || idleMs <= 0) return;
		const delay = Math.max(0, idleMs - (Date.now() - entry.lastActivityAt));
		entry.idleTimer = setTimeout(() => {
			entry.idleTimer = null;
			// 原地重启/退出后旧 entry 的事件必须忽略（与 onData/onExit 同款守卫）。
			if (this.terms.get(entry.id) !== entry || entry.exited) return;
			// 一次性：触发后解除武装，直到下次 agent 触碰。
			entry.agentTouched = false;
			this.onAgentIdle?.(entry.id, Date.now() - entry.lastActivityAt, entry.title);
		}, delay);
		entry.idleTimer.unref?.();
	}

	/** Emit output immediately, bypassing the coalescing window (rare paths:
	 *  one-shot hints/banners — not per-chunk data). */
	private writeOut(id: string, data: string): void {
		this.emit({ type: "terminal_output", terminalId: id, data });
	}

	/** Queue output for the coalescing window; flushes via flushPending. */
	private queueOut(entry: TermEntry, data: string): void {
		entry.pendingOut += data;
		if (entry.flushTimer) return;
		entry.flushTimer = setTimeout(() => {
			entry.flushTimer = null;
			this.flushPending(entry);
		}, OUTPUT_FLUSH_MS);
	}

	/** Emit everything queued for this terminal (no-op when nothing pending). */
	private flushPending(entry: TermEntry): void {
		if (entry.flushTimer) {
			clearTimeout(entry.flushTimer);
			entry.flushTimer = null;
		}
		if (!entry.pendingOut) return;
		const pending = entry.pendingOut;
		entry.pendingOut = "";
		this.emit({ type: "terminal_output", terminalId: entry.id, data: pending });
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
		// 纪元内的输出重置静默倒计时。
		entry.lastActivityAt = Date.now();
		if (entry.idleTimer) this.armIdleWatch(entry);
		// 输出观察器：累积匹配，命中一次即移除（终端接管 bash 的完成检测）。
		if (entry.watches.length > 0) {
			type Watch = (typeof entry.watches)[number];
			const remaining: Watch[] = [];
			const hits: { w: Watch; m: RegExpMatchArray }[] = [];
			for (const w of entry.watches) {
				w.buf += data;
				if (w.buf.length > 64_000) w.buf = w.buf.slice(-32_000);
				w.re.lastIndex = 0;
				const m = w.re.exec(w.buf);
				if (m) hits.push({ w, m }); // 命中 → 移出（cb 在下面统一触发）
				else remaining.push(w);
			}
			entry.watches = remaining;
			for (const { w, m } of hits) w.cb(m);
		}
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
		// 已武装的纪元里任何人（含用户手动敲键盘）写了输入都算新活动，重置倒计时。
		entry.lastActivityAt = Date.now();
		if (entry.idleTimer) this.armIdleWatch(entry);
		entry.pty.write(data);
		return null;
	}

	key(id: string, key: string, modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}): string | null {
		const encoded = encodeTerminalKey(key, modifiers);
		if ("error" in encoded) return encoded.error;
		return this.inputChecked(id, encoded.data);
	}


	/** 解除静默看门狗（退出/关闭/全部停止时）。 */
	private disarmIdleWatch(entry: TermEntry): void {
		if (entry.idleTimer) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = null;
		}
		entry.agentTouched = false;
	}

	/** 只拆钟不清标记（终端接管 bash 阻塞期间挂起活力提醒，避免双重通知）。 */
	suspendIdleWatch(id: string): void {
		const entry = this.terms.get(id);
		if (!entry || !entry.idleTimer) return;
		clearTimeout(entry.idleTimer);
		entry.idleTimer = null;
	}

	/** 输出末尾的绝对 cursor（terminal-backed bash 的读取起点）。 */
	endCursor(id: string): number | null {
		const entry = this.find(id);
		if (!entry) return null;
		return entry.outputOffset + entry.output.length;
	}

	/**
	 * 阻塞等待当前前台命令结束（哨兵行出现或终端退出）。terminal_wait 工具
	 * 用它在静默解阻后「重新加入等待」——AI 不必反复 terminal_read 轮询。
	 *
	 * @param afterCursor 只认该绝对偏移之后的哨兵（排除上一条命令残留的旧标记；
	 *                    调用方传 endCursor() 即表示「等我调用之后才出现的结束」）
	 * @returns finished=false 表示超时/中止（命令仍在跑），可再次调用继续等
	 */
	async waitForCompletion(
		id: string,
		timeoutMs: number,
		signal?: AbortSignal,
		afterCursor = 0,
	): Promise<{ finished: boolean; exitCode: number | null }> {
		const entry = this.find(id);
		if (!entry) return { finished: false, exitCode: null };
		return new Promise((resolve) => {
			// 命令可能在调用前就已结束：先扫 afterCursor 之后的存量缓冲。
			const relStart = Math.max(0, afterCursor - entry.outputOffset);
			const segment = entry.output.slice(relStart);
			const scan = new RegExp(BASH_SENTINEL_RE.source, BASH_SENTINEL_RE.flags);
			scan.lastIndex = 0;
			const existing = [...segment.matchAll(scan)].pop();
			if (existing) {
				resolve({ finished: true, exitCode: Number(existing[1]) });
				return;
			}
			if (entry.exited) {
				resolve({ finished: true, exitCode: entry.exitCode });
				return;
			}
			let timer: ReturnType<typeof setTimeout> | undefined;
			let settled = false;
			let unwatch: () => void = () => {};
			const onAbort = () => done({ finished: false, exitCode: null });
			const done = (r: { finished: boolean; exitCode: number | null }) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				unwatch();
				resolve(r);
			};
			unwatch = this.watchOutput(id, BASH_SENTINEL_RE, (m) => {
				// m=null = 终端被关闭/退出 → 命令肯定结束了（退出码未知）。
				done({ finished: true, exitCode: m ? Number(m[1]) : null });
			});
			timer = setTimeout(
				() => done({ finished: false, exitCode: null }),
				Math.max(1, Math.min(timeoutMs, 600_000)),
			);
			timer.unref?.();
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	/** 标记/清除「哨兵待决」状态（终端接管 bash 工具专用）。 */
	setSentinelPending(id: string, pending: boolean): void {
		const entry = this.find(id);
		if (entry) entry.sentinelPending = pending;
	}

	/** 是否有带哨兵的命令尚未结束（terminal_wait 的适用性判断）。 */
	isSentinelPending(id: string): boolean {
		return this.find(id)?.sentinelPending === true;
	}

	/** 注册一次性输出观察器：命中 re 或终端退出时回调一次。返回注销函数。 */
	watchOutput(
		id: string,
		re: RegExp,
		cb: (m: RegExpMatchArray | null) => void,
	): () => void {
		const entry = this.find(id);
		if (!entry) {
			cb(null);
			return () => {};
		}
		// 每个观察器独立 regex 实例（global 正则的 lastIndex 是共享可变状态）。
		const own = new RegExp(re.source, re.flags);
		const watch = { re: own, buf: "", cb };
		entry.watches.push(watch);
		return () => {
			const cur = this.find(id);
			if (!cur) return;
			cur.watches = cur.watches.filter((w) => w !== watch);
		};
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
		this.disarmIdleWatch(entry);
		// Flush queued output BEFORE the exit banner so ordering is preserved.
		this.flushPending(entry);
		const banner = `\r\n\x1b[90m[进程已退出，退出码 ${exitCode}]\x1b[0m\r\n`;
		this.appendOutput(entry, banner);
		this.emit({ type: "terminal_output", terminalId: id, data: banner });
		entry.exited = true;
		// 终端退出 → 未命中的输出观察器以 null 回调（宿主可据此通知「终端已关闭」）。
		const pendingWatches = entry.watches;
		entry.watches = [];
		for (const w of pendingWatches) w.cb(null);
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
			this.disarmIdleWatch(entry);
			const killedWatches = entry.watches;
			entry.watches = [];
			for (const w of killedWatches) w.cb(null);
			this.flushPending(entry);
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
			this.disarmIdleWatch(entry);
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
			for (const w of entry.watches) w.cb(null);
			entry.watches = [];
		}
		this.terms.clear();
		this.history.clear();
		this.emitList();
	}
}

// ---------------------------------------------------------------------------
// 终端接管 bash：bash 风格工具跑在持久可见终端里
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 取 collected 尾部里最后一个哨兵匹配（哨兵只可能出现在新输出的尾部）。 */
function lastSentinel(collected: string): RegExpMatchArray | null {
	const tail = collected.length > 8000 ? collected.slice(-8000) : collected;
	BASH_SENTINEL_RE.lastIndex = 0;
	return [...tail.matchAll(BASH_SENTINEL_RE)].pop() ?? null;
}

/** 去掉输入回显、哨兵及其后的 shell 提示符垃圾与 ANSI 序列，还原 bash 风格纯文本。 */
function cleanBashOutput(raw: string): string {
	let text = stripAnsi(raw).replace(/\r\n/g, "\n");
	// 回显的命令行可能被 readline 折行拆成多行，按行剥不可靠——改为锚定
	// printf 格式串字面量 [pi-exit:%s]（真哨兵是数字版），连同其所在整行丢弃。
	// 注意：同一命令会被回显两次（PTY 输入回显 + readline 提示符回显），需循环。
	for (;;) {
		const fmtIdx = text.indexOf("[pi-exit:%s]");
		if (fmtIdx < 0) break;
		const nl = text.indexOf("\n", fmtIdx);
		text = nl >= 0 ? text.slice(nl + 1) : "";
	}
	// 最后一个哨兵之后的内容全是 shell 新提示符——整段截掉。
	BASH_SENTINEL_RE.lastIndex = 0;
	let last: RegExpExecArray | null = null;
	for (let m = BASH_SENTINEL_RE.exec(text); m; m = BASH_SENTINEL_RE.exec(text)) {
		last = m;
	}
	if (last) text = text.slice(0, last.index);
	const lines = text.split("\n");
	while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
	return truncateMiddle(lines.join("\n").trim());
}

/**
 * 终端接管的 bash 工具：模型看到的参数与 SDK bash 完全一致（command + 可选
 * timeout 秒），但执行体是往持久终端写命令并等哨兵行拿到真实退出码。
 *
 * 行为语义：
 * - 默认阻塞：等到命令结束才返回完整输出（ANSI 已清理）+ 真实退出码；
 * - 静默解阻：连续 idleMs 毫秒无新输出且未结束 → 立即返回「仍在运行」+ 已有
 *   输出，命令留在终端里继续跑，并注册完成观察器——结束后由宿主
 *   notifyBackgroundDone 主动通知 AI（流式中 steer / 空闲时 nextTurn）；
 * - abort_bash 支持：AbortController 注册进 kills 集合，abort 时向 PTY 发
 *   Ctrl+C 杀前台进程，对话继续（与 makeKillableBashTool 同一套集合）；
 * - shell 状态跨调用保留（cd / venv activate / ssh 会话）——这是原生 bash
 *   工具做不到的。
 */
export function makeTerminalBashTool(
	terminals: TerminalManager,
	opts: {
		cwd: string;
		/** 静默解阻阈值毫秒；每次调用时读取（设置即时生效）；0 = 不解阻。 */
		idleMs: () => number;
		/** abort_bash 的控制器集合。 */
		kills: Set<AbortController>;
		/** 后台命令最终结束时的宿主通知（exitCode null = 终端被关闭）。 */
		notifyBackgroundDone: (info: {
			terminalId: string;
			command: string;
			exitCode: number | null;
		}) => void;
	},
): ToolDefinition {
	const TERM_ID = "ai-bash";

	return defineTool({
		name: "bash",
		label: "Run bash command",
		description:
			"Run a shell command and return its full output plus exit code. Commands execute in a PERSISTENT visible terminal ('ai-bash'): shell state such as cd, venv activation or ssh sessions is retained across calls. Run the bare command — do NOT pipe through tail/head/more/less (output is returned complete anyway, and pipes hide live progress in the visible terminal). If a command stays silent for a while it keeps running in the background and you get an automatic notice when it finishes; use terminal_wait to re-block until it finishes, or terminal_read / terminal_input / terminal_key on 'ai-bash' to observe or interact anytime.",
		promptSnippet: "run commands in the persistent visible terminal (state retained across calls)",
		parameters: Type.Object({
			command: Type.String({ description: "The shell command to run" }),
			timeout: Type.Optional(
				Type.Number({ description: "Optional timeout in seconds" }),
			),
			tail: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 5000,
					description:
						"Only return the LAST N lines of output (like `| tail -N`). Use this for verbose commands instead of piping through tail — the command keeps streaming live to the visible terminal while you only get the tail back.",
				}),
			),
		}),
		execute: async (_id, p, signal) => {
			// create() 对已存活的同名终端原样返回、对已退出的原地重启。
			// forceBash：该终端永远跑 bash（而非用户登录 shell），模型写的
			// bash 语法（数组/read -p/process substitution…）不会踩 zsh 差异。
			if (
				terminals.create(TERM_ID, opts.cwd, 120, 40, opts.cwd, "AI bash", {
					forceBash: true,
				}) === null
			) {
				throw new Error(`无法打开 AI bash 终端（${TERM_ID}）`);
			}
			// 阻塞等待期间挂起活力提醒（我们自己在检测静默，避免双重通知）。
			terminals.suspendIdleWatch(TERM_ID);
			const start = terminals.endCursor(TERM_ID)!;
			const ac = new AbortController();
			opts.kills.add(ac);
			const idleMs = Math.max(0, opts.idleMs());
			const deadline =
				p.timeout && p.timeout > 0 ? Date.now() + p.timeout * 1000 : null;
			// tail 参数：只返回末尾 N 行（替代 `| tail -N` 管道——管道会缓冲输出、
			// 让可见终端全程哑火，还容易白白触发静默解阻）。
			const applyTail = (t: string): string => {
				if (!p.tail || p.tail <= 0) return t;
				const lines = t.split("\n");
				return lines.length > p.tail
					? `…（前 ${lines.length - p.tail} 行已省略）\n${lines.slice(-p.tail).join("\n")}`
					: t;
			};
			try {
				let collected = "";
				let cursor = start;
				let lastDataAt = Date.now();
				// 标记「有哨兵命令在跑」：terminal_wait 据此区分等待与空闲。
				terminals.setSentinelPending(TERM_ID, true);
				const inputErr = terminals.inputChecked(TERM_ID, buildTerminalBashLine(p.command) + "\r");
				if (inputErr) throw new Error(inputErr);
				for (;;) {
					if (ac.signal.aborted || signal?.aborted) {
						// Ctrl+C 杀前台进程；终端本身保留（会话状态还在）。
						terminals.setSentinelPending(TERM_ID, false);
						terminals.inputChecked(TERM_ID, "\x03");
						throw new Error("Command aborted");
					}
					await sleep(60);
					const read = terminals.read(TERM_ID, cursor);
					if (read?.data) {
						collected += read.data;
						cursor = read.cursor;
						lastDataAt = Date.now();
					}
					const m = lastSentinel(collected);
					if (m) {
						terminals.setSentinelPending(TERM_ID, false);
						const text = applyTail(cleanBashOutput(collected));
						return {
							content: [
								{
									type: "text",
									text: `${text}${text ? "\n" : ""}[exit:${m[1]}]`,
								},
							],
							details: { exitCode: Number(m[1]), output: text },
						};
					}
					if (deadline !== null && Date.now() > deadline) {
						terminals.setSentinelPending(TERM_ID, false);
						terminals.inputChecked(TERM_ID, "\x03");
						throw new Error(
							`Command timed out after ${p.timeout}s（已发 Ctrl+C；已有输出：${truncateMiddle(stripAnsi(collected), 4000)}）`,
						);
					}
					// 静默解阻：转后台 + 注册完成观察器，立即把控制权还给模型。
					if (idleMs > 0 && Date.now() - lastDataAt >= idleMs) {
						return backgroundResult(
							terminals,
							opts,
							p.command,
							applyTail(cleanBashOutput(collected)),
							Math.round((Date.now() - lastDataAt) / 1000),
						);
					}
				}
			} finally {
				opts.kills.delete(ac);
			}
		},
	});
}

/** 静默解阻路径：注册完成观察器后立即返回「仍在后台运行」。 */
function backgroundResult(
	terminals: TerminalManager,
	opts: Parameters<typeof makeTerminalBashTool>[1],
	command: string,
	partialText: string,
	silentSeconds: number,
): { content: { type: "text"; text: string }[]; details: unknown } {
	terminals.watchOutput("ai-bash", BASH_SENTINEL_RE, (m) => {
		// 后台命令最终结束（或终端被关）→ 清除待决标记，terminal_wait 不再适用。
		terminals.setSentinelPending("ai-bash", false);
		opts.notifyBackgroundDone({
			terminalId: "ai-bash",
			command,
			exitCode: m ? Number(m[1]) : null,
		});
	});
	// partialText 已在调用方做过 cleanBashOutput + applyTail。
	const partial = truncateMiddle(partialText, 6000);
	return {
		content: [
			{
				type: "text",
				text:
					`命令仍在持久终端 ai-bash 中运行（已连续 ${silentSeconds} 秒无输出，未结束）。` +
					`本次调用不阻塞——命令继续在后台执行，结束时你会收到自动通知。\n` +
					`已有输出：\n${partial || "（暂无输出）"}\n` +
					`要重新阻塞等它结束就用 terminal_wait(terminalId="ai-bash")（无需反复轮询）；需要交互用 terminal_input / terminal_key（Ctrl+C 可终止）。`,
			},
		],
		details: { running: true, terminalId: "ai-bash", silentSeconds },
	};
}

/** Names of the agent-facing persistent-terminal tools（设置开关门控用）。 */
export const TERMINAL_TOOL_NAMES = [
	"terminal_create",
	"terminal_list",
	"terminal_close",
	"terminal_input",
	"terminal_key",
	"terminal_read",
	"terminal_wait",
] as const;

/** System-prompt guidance teaching the model WHEN to prefer the terminal tools
 *  over one-shot bash. Without it models almost never pick them — bash returns
 *  complete output in a single call, so it always wins on convenience. */
export const TERMINAL_TOOLS_GUIDANCE = `Persistent interactive terminal tools are available (terminal_create / terminal_list / terminal_close / terminal_input / terminal_key / terminal_read / terminal_wait). The one-shot bash tool stays the DEFAULT for ordinary commands - it runs once and returns the full output. Switch to the terminal tools only when:
- The program is interactive or TUI-based (REPLs like python/node, vim/htop, installers asking y/n, anything waiting on stdin).
- You start a long-running server or watcher and want to keep watching its output (terminal_read with waitMs), send keys to it later (e.g. interrupt via terminal_key with Ctrl+c), or block until a backgrounded command finishes without polling (terminal_wait).
- The user explicitly asks you to work in the visible terminal panel.
Liveness watchdog: terminals you touched (create/input/key) are monitored - if one goes silent with no new output while you are working (default 15s), an automatic system reminder is injected into the conversation. Treat it as a prompt to check that terminal (terminal_read), respond to an input prompt (terminal_input / terminal_key), or close it (terminal_close) if it is no longer needed.
Do NOT use them for simple one-shot commands; bash remains cheaper and simpler there.`;

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
				"Create a named persistent interactive PTY in the current workspace. Use terminal_input or terminal_key to interact with it and terminal_read to inspect incremental output. Prefer this over bash when the program is interactive/TUI-based (REPLs, vim/htop, y/n prompts), when starting a long-running server you want to keep observing or interrupt, or when the user asks to work in the visible terminal. For simple one-shot commands use bash instead.",
			promptSnippet:
				"run interactive programs or long-running servers in a persistent visible PTY (multi-step: create → input/key → read)",
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
				// AI 创建 → 启动活力检测纪元（静默提醒只针对 agent 触碰过的终端）。
				terminals.noteAgentActivity(p.terminalId);
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
				// AI 发了输入 = 在等结果，重开一个静默纪元。
				terminals.noteAgentActivity(p.terminalId);
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
				// 同 terminal_input：AI 主动交互后重新计时。
				terminals.noteAgentActivity(p.terminalId);
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
		defineTool({
			name: "terminal_wait",
			label: "Wait for terminal command",
			description:
				"Block until a command started THROUGH THE BASH TOOL finishes (its exit marker appears) or the timeout expires — no polling needed. Only applies to terminals with a pending bash-tool command; terminals driven manually via terminal_input (e.g. interactive programs) have no completion marker — use terminal_read(waitMs=…) to observe those instead. Returns {finished, exitCode} plus the output produced while waiting; finished=false means it is STILL running (call again to keep waiting).",
			promptSnippet: "block until a terminal's current command finishes (no polling)",
			parameters: Type.Object({
				terminalId: Type.String(),
				cursor: Type.Optional(
					Type.Integer({ minimum: 0, description: "Ignore exit markers before this absolute offset (default: now)" }),
				),
				maxWaitMs: Type.Optional(
					Type.Integer({ minimum: 100, maximum: 600000, description: "Max wait in ms (default 300000)" }),
				),
			}),
			execute: async (_id, p, signal) => {
				if (!terminals.has(p.terminalId)) {
					throw new Error(`终端不存在：${p.terminalId}（可能已被关闭或会话重置，请先 terminal_create）`);
				}
				// 没有带哨兵的待决命令：shell 空闲在提示符，或该终端的命令是经
				// terminal_input 手动发的（无完成标记）——等哨兵永远等不到，直接
				// 说明并引导改用 terminal_read，避免 AI 无限重试。（显式传 cursor
				// 的调用是有目的的追溯查询，不拦。）
				if (p.cursor === undefined && !terminals.isSentinelPending(p.terminalId)) {
					const why = `终端 ${p.terminalId} 当前没有正在等待完成的 bash 工具命令（shell 空闲，或该命令是通过 terminal_input 发出的、没有完成标记）。terminal_wait 不适用；要观察输出请用 terminal_read(terminalId="${p.terminalId}", waitMs=…)。`;
					return result(
						JSON.stringify({ applicable: false, reason: why }),
						{ applicable: false },
					);
				}
				const cursor = p.cursor ?? terminals.endCursor(p.terminalId) ?? 0;
				const wait = await terminals.waitForCompletion(
					p.terminalId,
					p.maxWaitMs ?? 300_000,
					signal,
					cursor,
				);
				const read = terminals.read(p.terminalId, cursor, 20_000);
				const outputTail = read?.data ? stripAnsi(read.data).slice(-4000) : "";
				return result(JSON.stringify({ ...wait, outputTail }), {
					...wait,
					outputTail,
				});
			},
		}),
	];
}
