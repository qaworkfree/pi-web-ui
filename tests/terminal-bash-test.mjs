/* 终端接管 bash（terminal-backed bash tool）回归：直接实例化
 * TerminalManager + makeTerminalBashTool（真实 PTY，不起 server、零 token）：
 *   1. 纯函数：buildTerminalBashLine 单行/多行、stripAnsi；
 *   2. 阻塞语义：echo 快速命令等哨兵返回完整输出 + 真实退出码；
 *   3. 多行脚本（eval $'...' 转义路径）正常执行；
 *   4. 静默解阻：连续无输出达阈值立即返回 running:true，命令后台跑完由
 *      notifyBackgroundDone 回调通知退出码；
 *   5. shell 状态跨调用保留（cd 后 pwd 不变——原生 bash 做不到）；
 *   6. abort_bash：阻塞期间 abort → Ctrl+C 杀前台进程，快速返回。
 * Run:  npm run build:server && node tests/terminal-bash-test.mjs */
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new globalThis.URL("../", import.meta.url));
const { TerminalManager, makeTerminalBashTool, makePersistentTerminalTools, buildTerminalBashLine, stripAnsi } =
	await import(join(REPO, "dist", "server", "terminals.js"));

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

// ---- 1. 纯函数 ----
{
	const line = buildTerminalBashLine("ls -la");
	check("单行命令追加哨兵序列", line.includes("ls -la") && line.includes("[pi-exit:%s]") && line.includes("__pi_rc=$?"));
	const ml = buildTerminalBashLine("for i in 1 2\ndo\n echo $i\ndone");
	check("多行脚本包进 eval $'...'", ml.startsWith("eval $'") && ml.includes("\\n") && !ml.includes("\n"));
	check("多行脚本仍是一行物理输入", !ml.includes("\n"));
	const stripped = stripAnsi("\x1b[31m红\x1b[0m\x1b]0;title\x07文\r\nx\ry");
	check("stripAnsi 清理颜色/OSC/孤立CR", stripped === "红文\r\nxy");
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

// 从持久终端工具集中取 terminal_wait（解阻后重新阻塞等完成，无需轮询）
const persistentTools = makePersistentTerminalTools(mgr, workdir);
const waitTool = persistentTools.find((t) => t.name === "terminal_wait");
check("terminal_wait 已注册", waitTool !== undefined);

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

try {
	// ---- 2. 阻塞语义：快速命令返回输出+退出码 ----
	{
		const t0 = Date.now();
		const { result, error } = await run("echo hello-tbash");
		check("echo 正常完成无错误", !error);
		const text = result?.content?.[0]?.text ?? "";
		check("输出包含命令结果", text.includes("hello-tbash"), JSON.stringify(text));
		check("退出码 0", /\[exit:0\]$/.test(text.trim()));
		check("不含哨兵原文与回显标记", !text.includes("__pi_rc") && !text.includes("pi-exit"));
		check("阻塞到命令真正结束", Date.now() - t0 >= 50);
	}
	{
		const { result } = await run("sh -c 'exit 3'");
		check("非零退出码透传", /\[exit:3\]/.test(result?.content?.[0]?.text ?? ""));
	}

	// ---- 3. 多行脚本 ----
	{
		const script = "for i in a b c\ndo\n echo item=$i\ndone";
		const { result } = await run(script);
		const text = result?.content?.[0]?.text ?? "";
		check(
			"多行脚本执行并收集全部输出",
			text.includes("item=a") && text.includes("item=b") && text.includes("item=c"),
			JSON.stringify(text),
		);
	}

	// ---- 3b. tail 参数：只返回末尾 N 行（替代 | tail 管道）----
	{
		const { result } = await run({ command: "seq 1 30", tail: 5 });
		const text = result?.content?.[0]?.text ?? "";
		const numLines = text
			.split("\n")
			.filter((l) => /^\d+$/.test(l.trim()))
			.map((l) => l.trim())
			.join(",");
		check(
			"tail:5 只保留末 5 行（26–30）",
			numLines === "26,27,28,29,30",
			JSON.stringify(text),
		);
		const full = await run("seq 1 30");
		const fullLines = (full.result?.content?.[0]?.text ?? "")
			.split("\n")
			.filter((l) => /^\d+$/.test(l.trim())).length;
		check("不带 tail 时完整返回 30 行", fullLines === 30);
	}

	// ---- 4. 静默解阻 + 完成通知 ----
	{
		idleMsOverride = 500;
		bgDone = null;
		const t0 = Date.now();
		const { result } = await run("echo started-bg; sleep 1.5; echo finished-bg");
		const elapsed = Date.now() - t0;
		const text = result?.content?.[0]?.text ?? "";
		check("静默解阻：提前返回不阻塞", elapsed < 1400, `${elapsed}ms`);
		check("返回「仍在运行」说明", text.includes("仍在持久终端 ai-bash 中运行"));
		check("返回已有部分输出", text.includes("started-bg"));
		check("details 标记 running", result?.details?.running === true);
		// 等后台命令真正结束 → notifyBackgroundDone
		for (let i = 0; i < 60 && !bgDone; i++) await sleep(100);
		check("完成后主动回调通知", bgDone !== null);
		if (bgDone) {
			check("通知带正确退出码", bgDone.exitCode === 0);
			check("通知带原命令", typeof bgDone.command === "string" && bgDone.command.includes("sleep"));
		}
		idleMsOverride = 0;
		await sleep(300); // 等 shell 提示符稳定
	}

	// ---- 4b. terminal_wait：解阻后重新阻塞等完成，无需轮询 ----
	{
		idleMsOverride = 500;
		mgr.kill("ai-bash"); // 全新终端，排除上一用例残留
		await run("echo w-start; sleep 2.5; echo w-end"); // 静默解阻返回
		const t0 = Date.now();
		let wr = null;
		try {
			wr = await waitTool.execute("tw", { terminalId: "ai-bash", maxWaitMs: 8000 });
		} catch (e) {
			wr = { error: e };
		}
		const parsed = JSON.parse(wr?.content?.[0]?.text ?? "{}");
		check("terminal_wait 阻塞到命令真正结束", parsed.finished === true && Date.now() - t0 >= 1200);
		check("terminal_wait 拿到退出码 0", parsed.exitCode === 0);
		check("terminal_wait 附带等待期间的输出", (parsed.outputTail ?? "").includes("w-end"));
		// 显式 cursor=0：存量哨兵可命中（预扫描路径），应秒回不空等
		const t2 = Date.now();
		const wr2 = JSON.parse(
			(await waitTool.execute("tw2", { terminalId: "ai-bash", cursor: 0, maxWaitMs: 3000 }))?.content?.[0]?.text ?? "{}",
		);
		check("存量哨兵预扫描立即返回", wr2.finished === true && Date.now() - t2 < 1500);
		// 超时路径：等待一个不会结束的静默命令
		await run("sleep 5");
		const t1 = Date.now();
		const wr3 = JSON.parse(
			(await waitTool.execute("tw3", { terminalId: "ai-bash", maxWaitMs: 800 }))?.content?.[0]?.text ?? "{}",
		);
		check("超时返回 finished:false 且耗时≈阈值", wr3.finished === false && Date.now() - t1 >= 700 && Date.now() - t1 < 2500);
		idleMsOverride = 0;
		await sleep(5500); // 让 sleep 5 跑完，避免污染后续用例
	}

	// ---- 4c. 空闲终端调用 terminal_wait：立即返回说明，不挂起 ----
	{
		idleMsOverride = 0;
		mgr.kill("ai-bash");
		await run("echo idle-probe"); // 正常完成 → 哨兵已消费，无待决命令
		const t3 = Date.now();
		const wr4 = JSON.parse(
			(await waitTool.execute("tw4", { terminalId: "ai-bash", maxWaitMs: 60000 }))?.content?.[0]?.text ?? "{}",
		);
		check(
			"空闲终端 terminal_wait 秒回 applicable:false",
			wr4.applicable === false && Date.now() - t3 < 1500,
			JSON.stringify(wr4),
		);
	}

	// ---- 5. shell 状态跨调用保留 ----
	{
		await run("cd subdir");
		const { result } = await run("pwd");
		check("cd 状态保留到下一次调用", (result?.content?.[0]?.text ?? "").includes("subdir"));
		await run(`cd "${workdir}"`);
	}

	// ---- 6. abort_bash（阻塞期间中止）----
	{
		mgr.kill("ai-bash"); // 全新终端，确保没有残留前台进程
		const kills = new Set();
		const abortTool = makeTerminalBashTool(mgr, {
			cwd: workdir,
			idleMs: () => 0, // 永不解阻 → 只能靠 abort
			kills,
			notifyBackgroundDone: () => {},
		});
		const execPromise = abortTool.execute("t2", { command: "sleep 30" }, undefined);
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
		check("终端本身未被杀（会话保留）", mgr.read("ai-bash", 0, 1)?.running !== false);
	}
} finally {
	mgr.killAll();
	await sleep(200);
	rmSync(workdir, { recursive: true, force: true });
}

console.log(`\n${passed} checks passed${process.exitCode ? "（有失败）" : ""}`);
