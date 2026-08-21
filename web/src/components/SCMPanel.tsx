import { useCallback, useEffect, useRef, useState } from "react";
import { randomUuid } from "../uuid";
import {
	FiArrowDown,
	FiArrowUp,
	FiCheck,
	FiGitBranch,
	FiRefreshCw,
	FiTerminal,
} from "react-icons/fi";
import type { ChatState, TerminalMeta } from "../use-chat";
import type { ClientMessage, CommandDef } from "../types";
import { useT } from "../i18n";

/* ------------------------------------------------------------------ */
/* 隐藏查询终端协议                                                      */
/*                                                                     */
/* 面板内的只读 git 查询（status / branch / diff）复用现有终端桥接执行：   */
/* 在一条隐藏 PTY 里跑交互式 bash，然后通过 terminal_input 发送查询行，   */
/* 用 terminal.register 捕获输出，按唯一标记（sentinel）切分解析。        */
/*                                                                     */
/* 关键点（Windows conpty 实测验证）：                                   */
/*  · 交互式 bash 会回显输入、打印多行彩色提示符 —— 先 exec 一个         */
/*    --norc 的新 bash，并把 PS1 导成固定标记 __PIWEB_PROMPT__，          */
/*    提示符行即可被精确过滤；                                           */
/*  · 输入回显与输出交错会污染线性解析 —— 暖机时执行 stty -echo 关掉回显； */
/*  · 标记本身用 shell 变量拼接生成（S=…; S=$S"…"），即使某条查询行被     */
/*    意外回显，回显文本里也不含完整标记，sentinel 计数不受干扰。         */
/* ------------------------------------------------------------------ */

/** Id of the hidden PTY that runs read-only git queries. */
const QUERY_TERM_ID = "scm-git-query";
/** Prompt marker exported as PS1 in the query shell — marker lines are filtered. */
const PROMPT_MARKER = "__PIWEB_PROMPT__";
/** Section separator echoed by the query shell (built from shell pieces). */
const SENTINEL = "__PIWEB_SCM_DONE_7F3A__";
/** Warm-up marker: printed by the non-interactive query shell once it is ready. */
const READY = "__PIWEB_READY_9C1B__";
const QUERY_TIMEOUT_MS = 15_000;
const MAX_BUF = 1_000_000;
/** Consecutive query failures before we stop auto-retrying (manual refresh resets). */
const MAX_FAILS = 3;

/* ------------------------------------------------------------------ */
/* data shapes                                                         */
/* ------------------------------------------------------------------ */

export interface ScmFile {
	/** Repo-relative path (unquoted). */
	path: string;
	/** porcelain index (staged) status letter. */
	x: string;
	/** porcelain worktree status letter. */
	y: string;
}

export interface ScmStatus {
	branch: string;
	detached: boolean;
	upstream: string | null;
	ahead: number;
	behind: number;
	upstreamGone: boolean;
	files: ScmFile[];
}

export interface ScmBranch {
	name: string;
	current: boolean;
}

interface ScmCommit {
	hash: string;
	shortHash: string;
	author: string;
	date: string;
	subject: string;
	decorations: string;
	/** The graph prefix emitted by `git log --graph` (for example `| * `). */
	graph: string;
}

interface StatInfo {
	add: number;
	del: number;
}

type FileKind = "staged" | "unstaged" | "untracked" | "both";

/* ------------------------------------------------------------------ */
/* output cleaning + git output parsing                                */
/* ------------------------------------------------------------------ */

/** Strip ANSI escapes, split on \n/\r (git sometimes rewrites lines with \r),
 *  drop prompt-marker lines / empty lines / bare prompts. */
function cleanSection(raw: string): string {
	const text = raw
		.replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "") // OSC title
		.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "") // CSI
		.replace(/\x1b[()][A-Za-z0-9]/g, "") // charset select
		.replace(/\x1b[=>]/g, ""); // mode set/reset
	return text
		.split(/\r?\n|\r/)
		.map((l) => l.replace(/\s+$/, ""))
		.filter((l) => {
			if (!l) return false;
			if (l.startsWith(PROMPT_MARKER)) return false;
			if (l.includes("S=$S")) return false; // echoed command line (paranoia)
			if (/^\s*[$#>%]\s*$/.test(l)) return false;
			return true;
		})
		.join("\n");
}

/** Undo git's C-style quoting for unusual file names ("a\tb" → a<TAB>b). */
function unquotePath(s: string): string {
	if (!s.startsWith('"')) return s;
	const inner = s.endsWith('"') ? s.slice(1, -1) : s.slice(1);
	return inner.replace(/\\(.)/g, (_m, c: string) => {
		switch (c) {
			case "n":
				return "\n";
			case "t":
				return "\t";
			case "r":
				return "\r";
			case "b":
				return "\b";
			case "a":
				return "\a";
			case "f":
				return "\f";
			case "v":
				return "\v";
			case "\\":
				return "\\";
			case '"':
				return '"';
			default:
				return c;
		}
	});
}

function parseStatus(text: string): ScmStatus {
	const out: ScmStatus = {
		branch: "HEAD",
		detached: false,
		upstream: null,
		ahead: 0,
		behind: 0,
		upstreamGone: false,
		files: [],
	};
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trimEnd();
		if (!line) continue;
		if (line.startsWith("## ")) {
			parseStatusHeader(line.slice(3), out);
			continue;
		}
		if (line.length >= 3) {
			let path = line.slice(3);
			const arrow = path.indexOf(" -> "); // rename: "R  old -> new"
			if (arrow >= 0) path = path.slice(arrow + 4);
			out.files.push({ path: unquotePath(path), x: line[0], y: line[1] });
		}
	}
	return out;
}

function parseStatusHeader(rest: string, out: ScmStatus) {
	let branchPart = rest;
	let flags = "";
	const bi = rest.indexOf(" [");
	if (bi >= 0) {
		branchPart = rest.slice(0, bi);
		flags = rest.slice(bi + 2);
		if (flags.endsWith("]")) flags = flags.slice(0, -1);
	}
	if (branchPart === "HEAD (no branch)" || branchPart === "HEAD") {
		out.detached = true;
		out.branch = "HEAD";
	} else {
		if (branchPart.startsWith("No commits yet on "))
			branchPart = branchPart.slice("No commits yet on ".length);
		const up = branchPart.indexOf("...");
		if (up >= 0) {
			out.branch = branchPart.slice(0, up);
			out.upstream = branchPart.slice(up + 3);
		} else {
			out.branch = branchPart;
		}
	}
	if (flags) {
		for (const part of flags.split(",")) {
			const p = part.trim();
			const m = p.match(/^(ahead|behind) (\d+)$/);
			if (m) {
				if (m[1] === "ahead") out.ahead = Number(m[2]);
				else out.behind = Number(m[2]);
			} else if (p === "gone") {
				out.upstreamGone = true;
			}
		}
	}
}

function parseBranches(text: string): ScmBranch[] {
	const out: ScmBranch[] = [];
	for (const line of text.split("\n")) {
		const m = line.match(/^([*+ ]) (.+)$/);
		if (!m) continue;
		const name = m[2].trim();
		if (!name || name.startsWith("(")) continue; // skip "(HEAD detached at ...)"
		out.push({ name, current: m[1] === "*" });
	}
	return out;
}

/** Parse one commit per line from `git log --graph` while preserving its graph prefix. */
function parseCommitHistory(text: string): ScmCommit[] {
	const out: ScmCommit[] = [];
	for (const line of text.split("\n")) {
		const tab = line.indexOf("\t");
		if (tab < 0) continue; // connector-only graph line
		const prefixAndHash = line.slice(0, tab);
		const match = prefixAndHash.match(/([0-9a-f]{7,40})$/i);
		if (!match || match.index === undefined) continue;
		const fields = line.slice(tab + 1).split("\t");
		// cleanSection trims trailing whitespace, so an empty decoration field
		// removes the final tab. Four fields is therefore a valid undecorated commit.
		if (fields.length < 4) continue;
		out.push({
			hash: match[1],
			shortHash: fields[0],
			author: fields[1],
			date: fields[2],
			subject: fields[3],
			decorations: fields[4] ?? "",
			graph: prefixAndHash.slice(0, match.index),
		});
	}
	return out;
}

/** Parse `git diff --stat` output: "path | 3 ++-" → {add, del} per path. */
function mergeStats(sections: string[]): Map<string, StatInfo> {
	const map = new Map<string, StatInfo>();
	for (const section of sections) {
		for (const line of section.split("\n")) {
			if (!line) continue;
			const m = line.match(/^\s*(\S.*?)\s+\|\s+(\d+)\s+([+\-\s]+)\s*$/);
			if (!m) continue;
			let add = 0;
			let del = 0;
			for (const c of m[3]) {
				if (c === "+") add++;
				else if (c === "-") del++;
			}
			const path = unquotePath(m[1].trim());
			const prev = map.get(path);
			map.set(path, { add: (prev?.add ?? 0) + add, del: (prev?.del ?? 0) + del });
		}
	}
	return map;
}

function fileKind(f: ScmFile): FileKind {
	if (f.x === "?" && f.y === "?") return "untracked";
	const staged = f.x !== " " && f.x !== "?";
	const unstaged = f.y !== " " && f.y !== "?";
	if (staged && unstaged) return "both";
	if (staged) return "staged";
	return "unstaged";
}

/* ------------------------------------------------------------------ */
/* pending query plumbing                                              */
/* ------------------------------------------------------------------ */

interface Pending {
	resolve: (sections: string[]) => void;
	reject: (err: Error) => void;
	startIdx: number;
	sections: number;
	sentinel: string;
	timer: ReturnType<typeof setTimeout>;
}

interface ScmTerminalBridge {
	create: (meta: TerminalMeta) => void;
	close: (id: string) => void;
	register: (
		conversationId: string,
		id: string,
		writer: { write(data: string): void; dispose(): void },
	) => () => void;
	restart: (id: string) => void;
}

export interface ScmPanelProps {
	chat: ChatState;
	send: (msg: ClientMessage) => boolean;
	terminal: ScmTerminalBridge;
	/** True when this view is currently visible (drives auto-refresh). */
	active: boolean;
	/** Switch the top-level view to the terminal (write ops run there). */
	onSwitchToTerminal: () => void;
}

export function ScmPanel({
	chat,
	send,
	terminal,
	active,
	onSwitchToTerminal,
}: ScmPanelProps) {
	const t = useT();
	const [status, setStatus] = useState<ScmStatus | null>(null);
	const [branches, setBranches] = useState<ScmBranch[]>([]);
	const [branchSel, setBranchSel] = useState("");
	const [statMap, setStatMap] = useState<Map<string, StatInfo>>(new Map());
	const [viewMode, setViewMode] = useState<"changes" | "history">("changes");
	const [history, setHistory] = useState<ScmCommit[]>([]);
	const [selectedCommit, setSelectedCommit] = useState<ScmCommit | null>(null);
	const [commitDetail, setCommitDetail] = useState("");
	const [commitLoading, setCommitLoading] = useState(false);
	const [selected, setSelected] = useState<ScmFile | null>(null);
	const [fileDiff, setFileDiff] = useState<{
		file: ScmFile;
		staged: string;
		worktree: string;
		untracked: boolean;
	} | null>(null);
	const [diffLoading, setDiffLoading] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notRepo, setNotRepo] = useState(false);
	const [commitMsg, setCommitMsg] = useState("");

	const bufRef = useRef("");
	const pendingRef = useRef<Pending | null>(null);
	const queueRef = useRef<Promise<unknown>>(Promise.resolve());
	const termReadyRef = useRef(false);
	const failCountRef = useRef(0);
	const lastCwdRef = useRef<string | null>(null);

	/** Reject the in-flight query (used on cwd change / disconnect). */
	const rejectPending = useCallback((err: Error) => {
		const p = pendingRef.current;
		if (p) {
			pendingRef.current = null;
			clearTimeout(p.timer);
			p.reject(err);
		}
	}, []);

	/** Kill + respawn the hidden query terminal (timeout recovery). */
	const recreateTerminal = useCallback(() => {
		send({ type: "terminal_kill", terminalId: QUERY_TERM_ID });
		send({
			type: "terminal_create",
			terminalId: QUERY_TERM_ID,
			cwd: lastCwdRef.current ?? "",
			cols: 240,
			rows: 50,
		});
		bufRef.current = "";
		termReadyRef.current = false;
	}, [send]);

	/** Bridge writer: accumulate output, resolve the pending query when the
	 *  expected number of sentinels arrived after its window start. */
	const onOutput = useCallback((data: string) => {
		bufRef.current += data;
		if (bufRef.current.length > MAX_BUF) {
			const trim = bufRef.current.length - MAX_BUF;
			bufRef.current = bufRef.current.slice(trim);
			const p = pendingRef.current;
			if (p) p.startIdx = Math.max(0, p.startIdx - trim);
		}
		const p = pendingRef.current;
		if (!p) return;
		const found: number[] = [];
		let from = p.startIdx;
		for (;;) {
			const idx = bufRef.current.indexOf(p.sentinel, from);
			if (idx < 0) break;
			found.push(idx);
			from = idx + p.sentinel.length;
			if (found.length >= p.sections) break;
		}
		if (found.length >= p.sections) {
			const sections: string[] = [];
			let cur = p.startIdx;
			for (const to of found) {
				sections.push(cleanSection(bufRef.current.slice(cur, to)));
				cur = to + p.sentinel.length;
			}
			bufRef.current = bufRef.current.slice(
				found[p.sections - 1] + p.sentinel.length,
			);
			pendingRef.current = null;
			clearTimeout(p.timer);
			p.resolve(sections);
		}
	}, []);

	/** Arm a pending that resolves when `sections` sentinels appear after now. */
	const waitForSentinel = useCallback(
		(sentinel: string, sections: number): Promise<string[]> =>
			new Promise<string[]>((resolve, reject) => {
				const pending: Pending = {
					resolve,
					reject,
					startIdx: bufRef.current.length,
					sections,
					sentinel,
					timer: setTimeout(() => {
						if (pendingRef.current !== pending) return;
						pendingRef.current = null;
						termReadyRef.current = false;
						failCountRef.current += 1;
						recreateTerminal();
						reject(new Error("timeout"));
					}, QUERY_TIMEOUT_MS),
				};
				pendingRef.current = pending;
			}),
		[recreateTerminal],
	);

	/** Bring the hidden terminal to a known state in two handshakes:
	 *  1. `export PS1=<marker>; exec bash --norc -s || exec bash -s` — wait until
	 *     the marker prompt appears (the exec'd shell is alive and reading input).
	 *     The PS1 value is built from shell pieces so the *echoed* command line
	 *     doesn't contain the contiguous marker.
	 *  2. `stty -echo; …; echo READY` — turn echo off (kills the input-echo
	 *     interleaving that pollutes linear parsing), then print the READY
	 *     marker; consuming up to READY also discards the startup prompt and any
	 *     .bashrc noise.
	 * Two stages (not one fire-and-forget line) because on Windows ConPTY,
	 * input typed before the exec'd shell is ready is dropped. */
	const ensureWarmed = useCallback((): Promise<void> => {
		if (termReadyRef.current) return Promise.resolve();
		termReadyRef.current = true; // queue is serial — no concurrent warm-ups
		const stage1 = waitForSentinel(PROMPT_MARKER, 1).then(() => undefined);
		stage1.catch(() => undefined);
		send({
			type: "terminal_input",
			terminalId: QUERY_TERM_ID,
			data: `export PS1=__PIWEB_PROMPT_""__; exec bash --norc -s || exec bash -s\r`,
		});
		return stage1
			.then(() => {
				const stage2 = waitForSentinel(READY, 1).then(() => undefined);
				stage2.catch(() => undefined);
				send({
					type: "terminal_input",
					terminalId: QUERY_TERM_ID,
					data: `stty -echo 2>/dev/null; R=__PIWEB_READY_; R=$R"9C1B__"; echo "$R"\r`,
				});
				return stage2;
			})
			.catch((err: unknown) => {
				termReadyRef.current = false;
				throw err;
			});
	}, [send, waitForSentinel]);

	/** Run a multi-section git query through the hidden terminal, serialized. */
	const sendQuery = useCallback(
		(parts: string[], sections: number): Promise<string[]> => {
			const cmdLine =
				`S=__PIWEB_SCM_; S=$S"DONE_7F3A__"; ` +
				parts.join(`; echo "$S"; `) +
				`; echo "$S"`;
			const task = () => {
				if (failCountRef.current >= MAX_FAILS) {
					return Promise.reject(new Error("too many failures"));
				}
				return ensureWarmed().then(() => {
					const p = waitForSentinel(SENTINEL, sections);
					send({
						type: "terminal_input",
						terminalId: QUERY_TERM_ID,
						data: cmdLine + "\r",
					});
					return p;
				});
			};
			const run = queueRef.current.then(task, task);
			queueRef.current = run.then(
				() => undefined,
				() => undefined,
			);
			return run;
		},
		[ensureWarmed, send, waitForSentinel],
	);

	/* ------------------------------------------------------------------ */
	/* status refresh + per-file diff                                      */
	/* ------------------------------------------------------------------ */

	const applyStatus = useCallback(
		(
			statusText: string,
			branchText: string,
			statText: string,
			cachedStatText: string,
		) => {
			const notRepo = /not a git repository/i.test(statusText);
			setNotRepo(notRepo);
			if (notRepo) {
				setStatus(null);
				setBranches([]);
				setStatMap(new Map());
				setHistory([]);
				setSelectedCommit(null);
				setCommitDetail("");
				setFileDiff(null);
				return;
			}
			const st = parseStatus(statusText);
			const branches = parseBranches(branchText);
			const stats = mergeStats([statText, cachedStatText]);
			setStatus(st);
			setBranches(branches);
			setStatMap(stats);
			setBranchSel((prev) => {
				if (st.detached) return prev || "";
				const cur = st.branch;
				if (cur && branches.some((b) => b.name === cur)) return cur;
				if (prev && branches.some((b) => b.name === prev)) return prev;
				return branches[0]?.name ?? "";
			});
			setFileDiff((prev) =>
				prev && !st.files.some((f) => f.path === prev.file.path)
					? null
					: prev,
			);
		},
		[],
	);

	const refresh = useCallback(
		(manual = false) => {
			if (!chat.ready || chat.status !== "open") return;
			const cwd = chat.state?.cwd;
			if (!cwd) return;
			// Make sure the query PTY exists (no-op when it is already running).
			send({
				type: "terminal_create",
				terminalId: QUERY_TERM_ID,
				cwd,
				cols: 240,
				rows: 50,
			});
			// 自动刷新（切回本视图 / 重连 / 换目录）在连续失败后停手，等用户手动重试；
			// 手动点击刷新总是重置失败计数并重新尝试。
			if (!manual && failCountRef.current >= MAX_FAILS) {
				setError(t("scmTooManyFailures"));
				return;
			}
			if (manual) failCountRef.current = 0;
			setBusy(true);
			setError(null);
			sendQuery(
			[
				`git -c color.ui=false --no-pager status --porcelain=v1 -b`,
				`git -c color.ui=false --no-pager branch --list`,
				`git -c color.ui=false --no-pager diff --stat`,
				`git -c color.ui=false --no-pager diff --cached --stat`,
				`git -c color.ui=false --no-pager log --all --graph --decorate=short --date=short --pretty=format:%H%x09%h%x09%an%x09%ad%x09%s%x09%D -n 120`,
			],
			5,
		)
			.then(([statusText, branchText, statText, cachedStatText, historyText]) => {
				applyStatus(statusText, branchText, statText, cachedStatText);
				setHistory(parseCommitHistory(historyText));
			})
			.catch((err: unknown) => {
				setError(
					t("scmQueryFailed", {
						error: err instanceof Error ? err.message : String(err),
					}),
				);
			})
			.finally(() => setBusy(false));
	}, [applyStatus, chat.ready, chat.state?.cwd, chat.status, send, sendQuery, t]);

	const showFileDiff = useCallback(
		(f: ScmFile) => {
			setSelected(f);
			setSelectedCommit(null);
			if (f.x === "?" && f.y === "?") {
				setFileDiff({ file: f, staged: "", worktree: "", untracked: true });
				return;
			}
			const esc = f.path.replace(/'/g, `'\\''`);
			setDiffLoading(true);
			setError(null);
			sendQuery(
				[
					`git -c color.ui=false --no-pager diff --cached -- '${esc}'`,
					`git -c color.ui=false --no-pager diff -- '${esc}'`,
				],
				2,
			)
				.then(([staged, worktree]) =>
					setFileDiff({ file: f, staged, worktree, untracked: false }),
				)
				.catch((err: unknown) =>
					setError(
						t("scmQueryFailed", {
							error: err instanceof Error ? err.message : String(err),
						}),
					),
				)
				.finally(() => setDiffLoading(false));
		},
		[sendQuery, t],
	);

	const showCommitDetail = useCallback(
		(commit: ScmCommit) => {
			setSelectedCommit(commit);
			setSelected(null);
			setFileDiff(null);
			setCommitDetail("");
			setCommitLoading(true);
			setError(null);
			const esc = commit.hash.replace(/'/g, `'\\''`);
			sendQuery(
				[`git -c color.ui=false --no-pager show --no-ext-diff --find-renames --format=fuller --stat --patch '${esc}'`],
				1,
			)
				.then(([detail]) => setCommitDetail(detail))
				.catch((err: unknown) =>
					setError(
						t("scmQueryFailed", {
							error: err instanceof Error ? err.message : String(err),
						}),
					),
				)
				.finally(() => setCommitLoading(false));
		},
		[sendQuery, t],
	);

	/* ------------------------------------------------------------------ */
	/* write operations → visible terminal tab                             */
	/* ------------------------------------------------------------------ */

	const runGitCommand = useCallback(
		(title: string, command: string) => {
			if (!chat.ready) return;
			const def: CommandDef = { name: title, command, cwd: "${pwd}" };
			const existing = chat.terminals.find((tm) => tm.title === title);
			if (existing) {
				terminal.restart(existing.id);
				send({
					type: "run_command",
					terminalId: existing.id,
					conversationId: existing.conversationId,
					command: def,
					cols: 80,
					rows: 24,
				});
			} else {
				const id = randomUuid();
				terminal.create({
					id,
					conversationId: chat.activeConversationId || chat.state?.conversationId || "",
					title,
					cwd: chat.state?.cwd ?? "",
					cols: 80,
					rows: 24,
					running: true,
					exitCode: null,
					command: def,
				});
			}
			onSwitchToTerminal();
		},
		[chat.ready, chat.state?.cwd, chat.terminals, onSwitchToTerminal, send, terminal],
	);

	const handleCommit = useCallback(() => {
		const msg = commitMsg.trim();
		if (!msg || notRepo) return;
		const escaped = msg
			.replace(/\\/g, "\\\\")
			.replace(/"/g, '\\"')
			.replace(/`/g, "\\`")
			.replace(/\$/g, "\\$");
		runGitCommand("git commit", `git add -A && git commit -m "${escaped}"`);
		setCommitMsg("");
	}, [commitMsg, notRepo, runGitCommand]);

	const handleSwitch = useCallback(() => {
		if (!branchSel || notRepo) return;
		runGitCommand("git checkout", `git checkout ${branchSel}`);
	}, [branchSel, notRepo, runGitCommand]);

	const handlePush = useCallback(() => runGitCommand("git push", "git push"), [runGitCommand]);
	const handlePull = useCallback(() => runGitCommand("git pull", "git pull"), [runGitCommand]);

	/* ------------------------------------------------------------------ */
	/* lifecycle                                                          */
	/* ------------------------------------------------------------------ */

	// (Re)register the output capture + reset query state on (re)connect and
	// on cwd change (the bridge writer is dropped when the socket closes).
	useEffect(() => {
		if (!chat.ready || chat.status !== "open") return;
		const unregister = terminal.register(chat.activeConversationId || chat.state?.conversationId || "", QUERY_TERM_ID, {
			write: onOutput,
			dispose: () => undefined,
		});
		const cwd = chat.state?.cwd;
		if (lastCwdRef.current !== null && lastCwdRef.current !== cwd) {
			send({ type: "terminal_kill", terminalId: QUERY_TERM_ID });
		}
		lastCwdRef.current = cwd ?? "";
		termReadyRef.current = false;
		bufRef.current = "";
		failCountRef.current = 0;
		rejectPending(new Error("会话已重置"));
		return unregister;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [chat.ready, chat.status, chat.state?.cwd, terminal.register, onOutput, send]);

	// Socket dropped → reject any in-flight query instead of waiting it out.
	useEffect(() => {
		if (chat.status === "closed") {
			rejectPending(new Error("连接已断开"));
			termReadyRef.current = false;
		}
	}, [chat.status, rejectPending]);

	// Auto-refresh when the panel becomes visible (also covers cwd/connect
	// changes while visible, since refresh reads the latest cwd).
	useEffect(() => {
		if (active) refresh();
	}, [active, refresh]);

	// Unmount: kill the hidden query PTY.
	useEffect(() => {
		return () => {
			send({ type: "terminal_kill", terminalId: QUERY_TERM_ID });
		};
	}, [send]);

	/* ------------------------------------------------------------------ */
	/* render                                                             */
	/* ------------------------------------------------------------------ */

	const kindLabels: Record<FileKind, string> = {
		staged: t("scmStaged"),
		unstaged: t("scmUnstaged"),
		untracked: t("scmUntracked"),
		both: t("scmStagedUnstaged"),
	};

	const renderDiff = (text: string) => {
		const lines = text.split("\n");
		return (
			<pre className="scm-diff-pre">
				{lines.map((ln, i) => {
					let cls = "";
					if (
						ln.startsWith("diff --git") ||
						ln.startsWith("index ") ||
						ln.startsWith("new file") ||
						ln.startsWith("deleted file") ||
						ln.startsWith("old mode") ||
						ln.startsWith("new mode") ||
						ln.startsWith("similarity index") ||
						ln.startsWith("rename ") ||
						ln.startsWith("copy ") ||
						ln.startsWith("Binary files") ||
						ln.startsWith("---") ||
						ln.startsWith("+++")
					) {
						cls = "hdr";
					} else if (ln.startsWith("@@")) {
						cls = "hunk";
					} else if (ln.startsWith("+")) {
						cls = "add";
					} else if (ln.startsWith("-")) {
						cls = "del";
					}
					return (
						<div key={i} className={`scm-diff-line ${cls}`}>
							{ln || " "}
						</div>
					);
				})}
			</pre>
		);
	};

	return (
		<div className="scm-view">
			<div className="scm-header">
				<div className="scm-title-row">
					<span className="scm-title">
						<FiGitBranch />
						{t("scmTitle")}
					</span>
					<div className="scm-view-tabs" role="tablist">
						<button
							type="button"
							role="tab"
							aria-selected={viewMode === "changes"}
							className={viewMode === "changes" ? "active" : ""}
							onClick={() => {
								setViewMode("changes");
								setError(null);
							}}
						>
							{t("scmChanges")}
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={viewMode === "history"}
							className={viewMode === "history" ? "active" : ""}
							onClick={() => {
								setViewMode("history");
								setError(null);
							}}
						>
							{t("scmHistory")}
						</button>
					</div>
						<button
							type="button"
							className="panel-refresh"
							title={t("scmRefreshTip")}
							disabled={busy}
							onClick={() => refresh(true)}
						>
							<FiRefreshCw className={busy ? "scm-spin" : ""} />
						</button>
				</div>

				{/* branch + push/pull */}
				<div className="scm-row">
					<span className="scm-branch-current" title={t("scmCurrentBranch")}>
						<FiGitBranch />
						{status ? (status.detached ? t("scmDetached") : status.branch) : "…"}
						{status?.upstream && (
							<span className="scm-upstream">
								{status.upstreamGone
									? t("scmUpstreamGone")
									: status.ahead > 0 || status.behind > 0
										? t("scmAheadBehind", {
												ahead: status.ahead,
												behind: status.behind,
											})
										: status.upstream}
							</span>
						)}
					</span>
					<select
						className="scm-select"
						value={branchSel}
						disabled={notRepo || branches.length === 0}
						title={t("scmSwitchBranch")}
						onChange={(e) => setBranchSel(e.target.value)}
					>
						<option value="" disabled>
							{t("scmSelectBranch")}
						</option>
						{branches.map((b) => (
							<option key={b.name} value={b.name}>
								{b.current ? `* ${b.name}` : b.name}
							</option>
						))}
					</select>
					<button
						type="button"
						className="btn"
						disabled={!branchSel || branchSel === status?.branch || notRepo}
						title={t("scmSwitchBranchTip", { branch: branchSel })}
						onClick={handleSwitch}
					>
						<FiGitBranch />
						{t("scmSwitch")}
					</button>
					<button
						type="button"
						className="btn"
						disabled={!status || status.detached || notRepo}
						title={t("scmPushTip")}
						onClick={handlePush}
					>
						<FiArrowUp />
						{t("scmPush")}
					</button>
					<button
						type="button"
						className="btn"
						disabled={!status || status.detached || notRepo}
						title={t("scmPullTip")}
						onClick={handlePull}
					>
						<FiArrowDown />
						{t("scmPull")}
					</button>
					<input
						className="scm-commit-input"
						value={commitMsg}
						placeholder={t("scmCommitPlaceholder")}
						disabled={notRepo}
						onChange={(e) => setCommitMsg(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.nativeEvent.isComposing) {
								handleCommit();
							}
						}}
					/>
					<button
						type="button"
						className="btn primary"
						disabled={!commitMsg.trim() || notRepo}
						title={t("scmCommitTip")}
						onClick={handleCommit}
					>
						<FiCheck />
						{t("scmCommit")}
					</button>
				</div>
			</div>

			{/* body: files + diff */}
			<div className="scm-body">
				{viewMode === "history" ? (
					<div className="scm-history">
						<div className="scm-files-header">
							<span>{t("scmHistory")}</span>
							{history.length > 0 && (
								<span className="scm-files-count">{history.length}</span>
							)}
						</div>
						<div className="scm-history-list">
							{notRepo ? (
								<div className="scm-empty">{t("scmNotGitRepo")}</div>
							) : !status ? (
								<div className="scm-empty">
									{chat.status === "open" ? t("scmLoading") : t("scmConnecting")}
								</div>
							) : history.length === 0 ? (
								<div className="scm-empty">{t("scmNoHistory")}</div>
							) : (
								history.map((commit) => (
									<button
										key={commit.hash}
										type="button"
										className={`scm-commit ${selectedCommit?.hash === commit.hash ? "active" : ""}`}
										onClick={() => showCommitDetail(commit)}
										title={commit.hash}
									>
										<span className="scm-commit-graph" aria-hidden="true">
											{commit.graph || "* "}
										</span>
										<span className="scm-commit-info">
											<span className="scm-commit-subject">{commit.subject}</span>
											<span className="scm-commit-meta">
												{commit.shortHash} · {commit.author} · {commit.date}
											</span>
											{commit.decorations && (
												<span className="scm-commit-refs">{commit.decorations}</span>
											)}
										</span>
									</button>
								))
							)}
						</div>
					</div>
				) : (
				<div className="scm-files">
					<div className="scm-files-header">
						<span>{t("scmChanges")}</span>
						{status && status.files.length > 0 && (
							<span className="scm-files-count">{status.files.length}</span>
						)}
					</div>
					<div className="scm-files-list">
						{notRepo ? (
							<div className="scm-empty">{t("scmNotGitRepo")}</div>
						) : !status ? (
							<div className="scm-empty">
								{chat.status === "open" ? t("scmLoading") : t("scmConnecting")}
							</div>
						) : status.files.length === 0 ? (
							<div className="scm-empty">{t("scmNoChanges")}</div>
						) : (
							status.files.map((f) => {
								const kind = fileKind(f);
								const st = statMap.get(f.path);
								return (
									<div
										key={f.path}
										className={`scm-file ${selected?.path === f.path ? "active" : ""}`}
										title={kindLabels[kind]}
										onClick={() => showFileDiff(f)}
									>
										<span
											className={`scm-file-xy ${kind === "untracked" ? "q" : "x"}`}
										>
											{f.x !== " " ? f.x : "\u00a0"}
										</span>
										<span
											className={`scm-file-xy ${kind === "untracked" ? "q" : "y"}`}
										>
											{f.y !== " " ? f.y : "\u00a0"}
										</span>
										<span className="scm-file-path">{f.path}</span>
										{st && (st.add > 0 || st.del > 0) && (
											<span className="scm-file-stat">
												{st.add > 0 && <span className="add">+{st.add}</span>}
												{st.del > 0 && <span className="del">-{st.del}</span>}
											</span>
										)}
									</div>
								);
							})
						)}
					</div>
				</div>
				)}

				<div className="scm-diff">
					<div className="scm-diff-header">
						<span>
							{viewMode === "history"
								? selectedCommit
									? `${selectedCommit.shortHash} ${selectedCommit.subject}`
									: t("scmCommitDetail")
								: selected
									? selected.path
									: t("scmDiff")}
						</span>
						{(viewMode === "history" ? commitLoading : diffLoading) && (
							<span className="scm-diff-loading">{t("scmLoading")}</span>
						)}
					</div>
					<div className="scm-diff-body">
						{viewMode === "history" ? (
							<>
								{error && <div className="scm-error">{error}</div>}
								{!selectedCommit && !error && (
									<div className="scm-empty">{t("scmSelectCommitHint")}</div>
								)}
								{selectedCommit && commitLoading && !error && (
									<div className="scm-empty">{t("scmLoading")}</div>
								)}
								{selectedCommit && !commitLoading && !error && commitDetail
									? renderDiff(commitDetail)
									: null}
							</>
						) : (
							<>
								{error && <div className="scm-error">{error}</div>}
								{!selected && !error && (
									<div className="scm-empty">{t("scmSelectFileHint")}</div>
								)}
								{selected && !fileDiff && !error && (
									<div className="scm-empty">{t("scmLoading")}</div>
								)}
								{selected && fileDiff && fileDiff.untracked && (
									<div className="scm-empty">{t("scmUntrackedNote")}</div>
								)}
								{selected && fileDiff && !fileDiff.untracked && (
									<>
										{fileDiff.staged && (
											<>
												<div className="scm-diff-section">{t("scmStaged")}</div>
												{renderDiff(fileDiff.staged)}
											</>
										)}
										{fileDiff.worktree && (
											<>
												<div className="scm-diff-section">{t("scmUnstaged")}</div>
												{renderDiff(fileDiff.worktree)}
											</>
										)}
										{!fileDiff.staged && !fileDiff.worktree && (
											<div className="scm-empty">{t("scmNoDiff")}</div>
										)}
									</>
								)}
							</>
						)}
					</div>
				</div>
			</div>

			<div className="scm-hint">
				<FiTerminal />
				<span>{t("scmRunsInTerminal")}</span>
				<button type="button" className="scm-goto-term" onClick={onSwitchToTerminal}>
					{t("scmViewTerminal")}
				</button>
			</div>
		</div>
	);
}
