/* 终端接管 bash（terminal-backed bash tool）回归：直接实例化
 * TerminalManager + makeTerminalBashTool（真实 PTY，不起 server、零 token）：
 *   1. 纯函数：buildTerminalBashLine 单行/多行、stripAnsi、detectTrailingLimiter、
 *      queryTerminalOutput（head/tail/search+context）；
 *   2. 一次性（默认）：每个 bash 调用一个新鲜终端 id（首行返回 [终端: id]），命令跑完
 *      shell 退出→输出落 history（可事后按 id 查询），且不跨调用保留 shell 状态；
 *   3. 持久（persistent:true）：复用 ai-bash，保留 cd/pwd 状态；
 *   4. 静默解阻 + notifyBackgroundDone + terminal_wait（按返回的真实 terminalId）；
 *   5. 自动化解 | tail -N 管道（不吞报错、不挂死、部分输出）；
 *   6. terminal_read 快照查询（head/tail/search+context，含已退出终端的缓冲）；
 *   7. abort_bash：阻塞期间 abort → Ctrl+C 杀前台进程，持久终端保留。
 * Run:  npm run build:server && node tests/terminal-bash-test.mjs */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new globalThis.URL("../", import.meta.url));
// Windows 上动态 import() 要 file:// URL；POSIX 上 fileURLToPath + pathToFileURL 同样成立。
const { TerminalManager, makeTerminalBashTool, makePersistentTerminalTools, buildTerminalBashLine, stripAnsi, detectTrailingLimiter, detectStdoutRedirect, splitTopLevelPipes, queryTerminalOutput } =
	await import(pathToFileURL(join(REPO, "dist", "server", "terminals.js")).href);

const workdir = mkdtempSync(join(tmpdir(), "piweb-tbash-"));
mkdirSync(join(workdir, "subdir"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const check = (name, cond, extra = "") => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name} ${extra}`);
		process.exitCode = 1;
	}
};
/** 从 bash 结果首行取终端 id（[终端: bash-N]）。 */
const parseTermId = (text) => (String(text ?? "").match(/^\[终端: ([^\]]+)\]/) ?? [])[1];

// ---- 1. 纯函数 ----
{
	const line = buildTerminalBashLine("ls -la");
	check("单行命令追加哨兵序列", line.includes("ls -la") && line.includes("[pi-exit:%s]") && line.includes("__pi_rc=${PIPESTATUS:-$?}"));
	check("退出码取首命令（PIPESTATUS[0]，ash 退化 $?）", line.includes("${PIPESTATUS:-$?}"));
	check("SIGPIPE(141) 归 0 转换存在", line.includes("-eq 141"));
	const ml = buildTerminalBashLine("for i in 1 2\ndo\n echo $i\ndone");
	check("多行脚本包进 eval $'...'", ml.startsWith("eval $'") && ml.includes("\\n") && !ml.includes("\n"));
	check("多行脚本仍是一行物理输入", !ml.includes("\n"));
	const stripped = stripAnsi("\x1b[31m红\x1b[0m\x1b]0;title\x07文\r\nx\ry");
	check("stripAnsi 清理颜色/OSC/孤立CR", stripped === "红文\r\nxy");
}

// ---- 1b. 纯函数：detectTrailingLimiter（识别/化解模型爱写的 | tail 管道）----
{
	const d = detectTrailingLimiter("seq 1 30 | tail -5");
	check("识别 | tail -5", d?.kind === "tail" && d?.lines === 5 && d?.base === "seq 1 30");
	const n = detectTrailingLimiter("seq 1 30 | tail -n 8");
	check("识别 | tail -n 8", n?.lines === 8);
	const bare = detectTrailingLimiter("make | tail");
	check("裸 | tail 默认 10 行", bare?.lines === 10 && bare?.base === "make");
	const less = detectTrailingLimiter("git log | less");
	check("识别 | less", less?.kind === "less");
	const f = detectTrailingLimiter("tail -f log");
	check("首命令 tail -f 不拆", f === null);
	const grep = detectTrailingLimiter("make | grep Error");
	check("| grep 是过滤语义，不拆", grep === null);
	const head = detectTrailingLimiter("yes | head -5");
	check("| head（SIGPIPE 早停）不拆", head === null);
	const quote = detectTrailingLimiter('echo "a | b" | tail -2');
	check("引号内 | 不误拆、仍识别外层 tail", quote?.kind === "tail" && quote?.lines === 2 && quote?.base === 'echo "a | b"');
	const inner = splitTopLevelPipes("make | tail -5");
	check("splitTopLevelPipes 顶层拆分", inner.length === 2 && inner[1].trim() === "tail -5");
}

// ---- 1d. 纯函数：detectStdoutRedirect（重定向+tail 兼容）----
{
	check("识别 > file 重定向", detectStdoutRedirect("make > log 2>&1")?.file === "log");
	check("识别 >> file 追加重定向", detectStdoutRedirect("cmd >> app.log")?.file === "app.log");
	check("忽略 fd 重定向 2>&1", detectStdoutRedirect("cmd 2>&1") === null);
	check("忽略 /dev/null", detectStdoutRedirect("cmd > /dev/null") === null);
}

// ---- 1c. 纯函数：queryTerminalOutput（head/tail/search+context）----
{
	const h = queryTerminalOutput("1\n2\n3\n4\n5", { head: 2 });
	check("head:2 返回前 2 行带行号", h.text === "1: 1\n2: 2", JSON.stringify(h));
	const t = queryTerminalOutput("1\n2\n3\n4\n5", { tail: 2 });
	check("tail:2 返回后 2 行带行号", t.text === "4: 4\n5: 5", JSON.stringify(t));
	const s = queryTerminalOutput("a\nb\nerror here\nc\nd\n", { search: "error", context: 1 });
	check("search 命中并带上下文", s.text.includes("3: error here") && s.text.includes("2: b") && s.text.includes("4: c"), JSON.stringify(s.text));
	check("search matches 带 1-based 行号", s.matches?.[0]?.line === 3 && s.matches?.[0]?.text === "error here");
	const none = queryTerminalOutput("a\nb\n", { search: "zzz" });
	check("搜索无命中给（无匹配）", none.text.includes("无匹配") && none.matches === undefined);
}

const mgr = new TerminalManager(() => {}, workdir);
let bgDone = null;
let idleMsOverride = 0; // 默认永不静默解阻（纯阻塞模式），个别用例注入小阈值
const tool = makeTerminalBashTool(mgr, {
	cwd: workdir,
	idleMs: () => idleMsOverride,
	kills: new Set(),
	notifyBackgroundDone: (info) => {
		bgDone = info;
	},
});

// 从持久终端工具集中取 terminal_wait / terminal_read
const persistentTools = makePersistentTerminalTools(mgr, workdir);
const waitTool = persistentTools.find((t) => t.name === "terminal_wait");
const readTool = persistentTools.find((t) => t.name === "terminal_read");
check("terminal_wait 已注册", waitTool !== undefined);
check("terminal_read 已注册", readTool !== undefined);

async function run(commandOrParams, timeout) {
	const params =
		typeof commandOrParams === "string"
			? { command: commandOrParams }
			: { ...commandOrParams };
	if (timeout) params.timeout = timeout;
	let result, error;
	try {
		result = await tool.execute("t1", params, undefined);
	} catch (e) {
		error = e;
	}
	return { result, error };
}

function textOf(r) {
	return r?.result?.content?.[0]?.text ?? (r?.error ? `ERR:${r.error}` : "");
}

try {
	// ---- 2. 一次性（默认）：新鲜 id + 首行标识 + 真实退出码 ----
	{
		const t0 = Date.now();
		const { result, error } = await run("echo hello-tbash");
		check("echo 正常完成无错误", !error);
		const text = textOf({ result });
		check("首行返回终端 id", /^\[终端: bash-\d+\]/.test(text.trim()), JSON.stringify(text));
		check("输出包含命令结果", text.includes("hello-tbash"), JSON.stringify(text));
		check("退出码 0", /\[exit:0\]$/.test(text.trim()));
		check("不含哨兵原文与回显标记", !text.includes("__pi_rc") && !text.includes("pi-exit"));
		check("阻塞到命令真正结束", Date.now() - t0 >= 50);
		check("details 带 terminalId", typeof result?.details?.terminalId === "string");
	}
	{
		const { result } = await run("bash -c 'exit 3'");
		check("非零退出码透传", /\[exit:3\]/.test(textOf({ result })));
	}

	// ---- 2b. 一次性：不跨调用保留 shell 状态 ----
	{
		await run("cd subdir");
		const { result } = await run("pwd");
		const text = textOf({ result });
		check("一次性：cd 状态不保留（pwd 仍在 workdir）", !text.includes("subdir"), JSON.stringify(text));
	}

	// ---- 2c. 持久（persistent:true）：shell 状态跨调用保留 ----
	{
		await run({ command: "cd subdir", persistent: true });
		const { result } = await run({ command: "pwd", persistent: true });
		const text = textOf({ result });
		check("持久：cd 状态保留到下一次调用", text.includes("subdir"), JSON.stringify(text));
		check("持久终端 id 为 ai-bash", /^\[终端: ai-bash\]/.test(text.trim()), JSON.stringify(text));
		await run({ command: `cd "${workdir}"`, persistent: true });
	}

	// ---- 3. 多行脚本 ----
	{
		const script = "for i in a b c\ndo\n echo item=$i\ndone";
		const { result } = await run(script);
		const text = textOf({ result });
		check(
			"多行脚本执行并收集全部输出",
			text.includes("item=a") && text.includes("item=b") && text.includes("item=c"),
			JSON.stringify(text),
		);
	}

	// ---- 3b. tail 参数：只返回末尾 N 行（替代 | tail 管道）----
	{
		const { result } = await run({ command: "seq 1 30", tail: 5 });
		const text = textOf({ result });
		const numLines = text.split("\n").filter((l) => /^\d+$/.test(l.trim())).map((l) => l.trim()).join(",");
		check("tail:5 只保留末 5 行（26–30）", numLines === "26,27,28,29,30", JSON.stringify(text));
		const full = await run("seq 1 30");
		const fullLines = textOf(full).split("\n").filter((l) => /^\d+$/.test(l.trim())).length;
		check("不带 tail 时完整返回 30 行", fullLines === 30);
	}

	// ---- 3c. 自动化解模型写的 | tail 管道：不吞报错、不挂死、部分输出 ----
	{
		const t0 = Date.now();
		const { result } = await run("bash -c 'exit 3' | tail -5");
		const text = textOf({ result });
		check("| tail 也不吞真实退出码（应为 exit:3）", /\[exit:3\]$/.test(text.trim()), JSON.stringify(text));
		check("| tail 管道不挂死，快速返回", Date.now() - t0 < 3000);
		check("返回里带拆管道说明", text.includes("检测到你带了 tail -5") && text.includes("别再套管道"), JSON.stringify(text));
	}
	{
		const { result } = await run("seq 1 30 | tail -5");
		const text = textOf({ result });
		const numLines = text.split("\n").filter((l) => /^\d+$/.test(l.trim())).map((l) => l.trim()).join(",");
		check("| tail -5 拆掉后仍只给模型末 5 行（26–30）", numLines === "26,27,28,29,30", JSON.stringify(text));
	}
	{
		const { result } = await run("seq 1 5 | grep 3");
		check("| grep 不拆，保留过滤结果", textOf({ result }).split("\n").some((l) => l.trim() === "3"));
	}
	// ---- 3d. 语义保真：head 返回 head 的结果；grep 不吞首命令真实退出码 ----
	{
		const { result } = await run("seq 1 30 | head -5");
		const text = textOf({ result });
		const nums = text.split("\n").filter((l) => /^\d+$/.test(l.trim())).map((l) => l.trim()).join(",");
		check("| head -5 返回前 5 行（head 语义，非默认tail）", nums === "1,2,3,4,5", JSON.stringify(text));
		check("| head 退出码是首命令（seq）的", /\[exit:0\]$/.test(text.trim()));
	}
	{
		const { result } = await run("bash -c 'exit 7' | grep x");
		const text = textOf({ result });
		check("| grep 不吞首命令真实退出码（应为 exit:7）", /\[exit:7\]$/.test(text.trim()), JSON.stringify(text));
	}
	{
		const { result } = await run("seq 1 1000000 | head -5"); // head 截断 → 首命令 SIGPIPE 141
		const text = textOf({ result });
		const nums = text.split("\n").filter((l) => /^\d+$/.test(l.trim())).map((l) => l.trim()).join(",");
		check("| head 截断大批量：输出前 5 行且 SIGPIPE 归 0（非假失败）", nums === "1,2,3,4,5" && /\[exit:0\]$/.test(text.trim()), JSON.stringify(text));
	}
	{
		const { result } = await run("this_cmd_does_not_exist | head -5");
		check("真错误(127)不被 head/SIGPIPE 掩盖", /\[exit:127\]$/.test(textOf({ result })));
	}

	// ---- 3e. 重定向 + tail：输出进文件也要让模型看到日志尾部 + 真实退出码 ----
	{
		const { result } = await run("echo seen-me > out.log 2>&1 | tail -3");
		const text = textOf({ result });
		check("重定向+tail：模型看到日志内容", text.includes("seen-me"), JSON.stringify(text));
		check("重定向+tail：说明注明已改为 tail 文件", text.includes("改为 tail 该文件"), JSON.stringify(text));
	}
	{
		const { result } = await run("bash -c 'echo x > o.log 2>&1; exit 7' | tail -3");
		check("重定向+tail：退出码仍是底层命令（7）", /\[exit:7\]$/.test(textOf({ result })));
	}

	// ---- 3f. 分页器禁用：stdout 是 tty 时 git log 不应开 less 挂起 ----
	{
		let gitAvail = true;
		try {
			execFileSync("git", ["--version"], { stdio: "ignore" });
		} catch {
			gitAvail = false;
		}
		if (gitAvail) {
			const repoDir = join(workdir, "gitrepo");
			mkdirSync(repoDir);
			writeFileSync(join(repoDir, "x.txt"), "x");
			execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
			execFileSync("git", ["config", "user.email", "a@b.c"], { cwd: repoDir, stdio: "ignore" });
			execFileSync("git", ["config", "user.name", "a"], { cwd: repoDir, stdio: "ignore" });
			execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "ignore" });
			execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });
			const t0 = Date.now();
			const { result } = await run({ command: `git -C ${repoDir.replace(/\\/g, "/")} log --oneline`, timeout: 10 });
			const text = textOf({ result });
			check("git log（tty stdout）不因分页器挂起，秒回", Date.now() - t0 < 5000, `${Date.now() - t0}ms`);
			check("git log 返回提交信息", text.includes("init"), JSON.stringify(text));
		} else {
			check("git 未安装，跳过分页器测试", true);
		}
	}

	// ---- 4. 静默解阻 + 完成通知 + 事后按 id 查询缓冲区 ----
	{
		idleMsOverride = 500;
		bgDone = null;
		const t0 = Date.now();
		const { result } = await run("echo started-bg; sleep 1.5; echo finished-bg");
		const elapsed = Date.now() - t0;
		const text = textOf({ result });
		const id = parseTermId(text);
		check("静默解阻：提前返回不阻塞", elapsed < 1400, `${elapsed}ms`);
		check("返回「仍在运行」说明且带 id", text.includes("仍在终端") && !!id, JSON.stringify(text));
		check("返回已有部分输出", text.includes("started-bg"));
		check("details 标记 running + terminalId", result?.details?.running === true && result?.details?.terminalId === id);
		for (let i = 0; i < 60 && !bgDone; i++) await sleep(100);
		check("完成后主动回调通知", bgDone !== null);
		if (bgDone) {
			check("通知带正确 terminalId", bgDone.terminalId === id);
			check("通知带正确退出码", bgDone.exitCode === 0);
			check("通知带原命令", typeof bgDone.command === "string" && bgDone.command.includes("sleep"));
		}
		// 命令已结束（shell 也退出），缓冲仍在 history —— 由 id 事后查询
		const q = await readTool.execute("q", { terminalId: id, search: "finished-bg" });
		check("事后按 id 搜索已退出终端缓冲", JSON.parse(q?.content?.[0]?.text ?? "{}")?.matches?.[0]?.text?.includes("finished-bg"), JSON.stringify(q));
		idleMsOverride = 0;
		await sleep(300);
	}

	// ---- 4b. terminal_wait：解阻后重新阻塞等完成，无需轮询 ----
	{
		idleMsOverride = 500;
		const { result } = await run("echo w-start; sleep 2.5; echo w-end"); // 静默解阻返回
		const id = parseTermId(textOf({ result }));
		check("解阻返回有可用的 terminalId", !!id, JSON.stringify(textOf({ result })));
		const t0 = Date.now();
		let wr = null;
		try {
			wr = await waitTool.execute("tw", { terminalId: id, maxWaitMs: 8000 });
		} catch (e) {
			wr = { error: e };
		}
		const parsed = JSON.parse(wr?.content?.[0]?.text ?? "{}");
		check("terminal_wait 阻塞到命令真正结束", parsed.finished === true && Date.now() - t0 >= 1200);
		check("terminal_wait 拿到退出码 0", parsed.exitCode === 0);
		check("terminal_wait 附带等待期间的输出", (parsed.outputTail ?? "").includes("w-end"));
		idleMsOverride = 0;
		await sleep(5500); // 让 sleep 2.5 跑完，避免污染后续用例
	}

	// ---- 4c. 空闲终端调用 terminal_wait：立即返回说明，不挂起 ----
	{
		idleMsOverride = 0;
		const { result } = await run("echo idle-probe");
		const id = parseTermId(textOf({ result }));
		const t3 = Date.now();
		const wr4 = JSON.parse(
			(await waitTool.execute("tw", { terminalId: id, maxWaitMs: 60000 }))?.content?.[0]?.text ?? "{}",
		);
		check("空闲终端 terminal_wait 秒回 applicable:false", wr4.applicable === false && Date.now() - t3 < 1500, JSON.stringify(wr4));
	}

	// ---- 5. terminal_read 快照查询：head / tail / search+context ----
	{
		const { result } = await run("printf 'line1\\nline2\\nERROR boom\\nline4\\nline5\\n'");
		const id = parseTermId(textOf({ result }));
		const head = JSON.parse((await readTool.execute("h", { terminalId: id, head: 2 }))?.content?.[0]?.text ?? "{}");
		check("terminal_read head:2", head.text.includes("1: line1") && head.text.includes("2: line2"), JSON.stringify(head));
		const tail = JSON.parse((await readTool.execute("t", { terminalId: id, tail: 2 }))?.content?.[0]?.text ?? "{}");
		check("terminal_read tail:2", tail.text.includes("line5"), JSON.stringify(tail.text));
		const search = JSON.parse((await readTool.execute("s", { terminalId: id, search: "error", context: 1 }))?.content?.[0]?.text ?? "{}");
		check("terminal_read search 命中+上下文", search.matches?.[0]?.line === 3 && search.text.includes("2: line2"), JSON.stringify(search.text));
		const full = JSON.parse((await readTool.execute("f", { terminalId: id }))?.content?.[0]?.text ?? "{}");
		check("无查询参数走增量读（含全部行）", typeof full.data === "string" && full.data.includes("line1"));
	}

	// ---- 6. abort_bash（阻塞期间中止；持久终端保留）----
	{
		const kills = new Set();
		const abortTool = makeTerminalBashTool(mgr, {
			cwd: workdir,
			idleMs: () => 0, // 永不解阻 → 只能靠 abort
			kills,
			notifyBackgroundDone: () => {},
		});
		const execPromise = abortTool.execute("t2", { command: "sleep 30", persistent: true }, undefined);
		await sleep(700); // 让命令先跑起来
		for (const ac of [...kills]) ac.abort();
		const t0 = Date.now();
		let abortedErr = null;
		try {
			await execPromise;
		} catch (e) {
			abortedErr = e;
		}
		check("abort 后快速返回", abortedErr !== null && Date.now() - t0 < 2000);
		check("报 Command aborted", /aborted/i.test(abortedErr?.message ?? ""));
		check("持久终端本身未被杀（会话保留）", mgr.read("ai-bash", 0, 1)?.running !== false);
		mgr.kill("ai-bash"); // 关掉持久终端，避免清理时残留活 PTY
	}
} finally {
	// 显式清理：Windows 上 node-pty 的 ConPTY 子进程可能不被父进程自动回收，
	// 导致 rmSync / 进程退出挂起。这里先 killAll，再给予短暂时间，最后强制退出。
	try {
		mgr.killAll();
		await sleep(200);
	} catch {
		// best effort
	}
	try {
		rmSync(workdir, { recursive: true, force: true });
	} catch {
		// Windows 下若仍有子进程持有句柄，删除会抛错——忽略，避免挂起
	}
}

console.log(`\n${passed} checks passed${process.exitCode ? "（有失败）" : ""}`);
process.exit(process.exitCode || 0);
