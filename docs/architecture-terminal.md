# 终端架构

> 覆盖 PTY 管理、按键编码、输出合并、SCM git 查询、活力检测、终端接管 bash 等。

## 终端管理

- 每个 `Conversation` 一个 `TerminalManager`；agent 可调用 `terminal_create`、`terminal_list`、`terminal_close`、`terminal_input`、`terminal_key`、`terminal_read`、`terminal_wait`，支持命名多终端、增量 cursor、Enter/Tab/方向键及 Ctrl/Alt 组合。PTY 工作目录限制在该对话工作区，最多 16 个终端，输入/读取有大小与等待上限。
- **`terminal_read` 双模式**：①**增量读**（默认）——传上一次返回的 `cursor` 取新输出，`waitMs` 等新输出或进程退出；②**快照查询**——给出 `head=N`（前 N 行）/`tail=N`（后 N 行）/`search=关键词` + `context=N`（每个匹配行及其前后 N 行，默认 3），按 1-based 行号返回。快照查询作用于**保留缓冲**（含已退出的 history 终端），因此可事后按 id 查看/搜索任一次性 bash 终端的输出；`queryTerminalOutput()` 是纯函数（单测覆盖）。
- **所有 spawn 路径统一准入**：`terminal_create`（浏览器/agent）与 `run_command`（命令列表）共用 `validateId`（字母/数字/.-_:/≤80 字符）+ `ensureSpawnAllowed`（新 live PTY 需低于 `MAX_TERMINALS`；已在运行的同名终端原地重启不占新名额；**history 里的已退出终端不保留名额**——满员时重跑已退出终端同样拒绝，堵住"唯一 ID 无限生成 PTY"的洞）；失败统一走 `fail()`（notice + 终端内红色报错 + terminal_exit）。

## terminal_key 按键编码

`encodeTerminalKey(key, modifiers)` 是纯函数（导出，字节级断言在 terminal-smoke-test.mjs）：命名键按名称路由，Ctrl/Alt 组合绝不回退成"Ctrl+首字母"——Ctrl+ArrowUp=`ESC[1;5A`（非 Ctrl+A）、Ctrl+Enter=`ESC[13;5u`（非 Ctrl+E）；方向键/F1–F4/Home/End 带修饰符时用 xterm 修饰序列 `ESC[1;<m>X`，其余命名键用 CSI-u `ESC[<code>;<m>u`，普通字符 Ctrl 映射 A–Z→0x01–0x1A、Shift 大写、Alt 前缀 ESC。

## 输出合并

输出经带 `conversationId` 的 `terminal_output` 推给浏览器；未挂载终端保留 200KB 输出窗口，切回对话时回放。socket 断开不杀 PTY；切换/重连保留状态，对话被释放或服务关闭时才杀掉全部 PTY。

**终端输出微批合并**（`terminals.ts` 的 `queueOut`/`flushPending`，窗口 `OUTPUT_FLUSH_MS=16ms`）：`pty.onData` 每 chunk 先入 `pendingOut` 缓冲再统一 flush 一条 `terminal_output`——构建等场景每秒数百上千个小 chunk 的 WS 帧风暴降 10~50 倍；exit/kill/原地重启先 flush 再发退出事件保证顺序。

## node-pty × Node `--watch` 兼容自愈

`server/patch-node-pty.ts`（必须排在 node-pty 之前 import）：dev 脚本用 `node --watch`，watch 模式会向 node-pty 的 ConPTY worker / console-list agent 的 IPC 通道推 `watch:require`/`watch:import` 消息——node-pty 1.1.0 不识别，导致①每条都 `console.warn('Unexpected ConoutWorkerMessage')` 刷屏；②kill 路径把 watch 消息当 agent 回复，`message.consoleProcessList` 为 undefined 直接 `.forEach` 崩溃。补丁模块在启动时幂等地改写安装副本（仿 spawn-helper chmod 先例）；`terminals.ts` 里另有一层 console.warn 过滤兜底。生产（无 `--watch`）不受影响。

## SCM 源代码管理

`SCMPanel`（视图 `git`）的只读 git 查询走服务端 `server/scm.ts`，用 `execFile("git", …)` 直跑（不经过 shell——无提示符/回显/ANSI/zsh 差异），解析成结构化 JSON。

### 协议

客户端发 `scm_status`（status+branches(含远程,for-each-ref)+numstat）/ `scm_history`（提交图，懒加载——切到「提交树」tab 才查）/ `scm_filediff`（单文件 staged+worktree diff）/ `scm_commit`（hash 白名单校验后 git show），服务端必回一条 `scm_data`（echo reqId + kind，ok/error/notRepo），前端按 reqId 匹配 pending 槽位——每个请求必有且仅有一个响应，UI 不可能卡 loading；sendScm 在 socket 断开时不占槽位不置 busy（防转圈卡死）。路径校验：filediff 的 path 必须 resolve 后仍在工作区内；非 git 仓库返回 ok:true + notRepo:true（面板显示提示而非报错）。15s 超时/maxBuffer 16MB。

### git 目录 watcher

首次 scm_status 时 `git rev-parse --absolute-git-dir` 定位 .git 并 fs.watch（非递归——HEAD/index/packed-refs 都在顶层，覆盖 commit/stage/checkout），事件去抖 600ms 推 `scm_changed` → 前端静默 refresh（外部 CLI/IDE 改仓库实时反映）；setCwd/dispose/notRepo 时 unwatch；watch 失败静默降级为 30s 可见轮询兜底。

### 自动刷新触发器

全部走 silent refresh 不闪 spinner：scm_changed / 终端 tab 里 SCM 生成的 git 写命令 running→exit（标题 `/^git /`）/ 视图激活 / cwd 切换 / 30s 轮询。

### 写操作

仍走可见终端 tab（TerminalPanel 同款 tab 复用逻辑）并切到终端视图：提交/推送/拉取/切换分支（远程分支 `origin/x` → `git checkout -b x origin/x || git checkout x`）/ 单文件暂存（`git add -- <path>`，行 hover 显示 + 按钮）/ 取消暂存（`git reset HEAD -- <path>`，− 按钮），路径经单引号转义。分支下拉本地/远程分组（optgroup，i18n scmRemoteBranches）。

### 历史教训（已废弃的旧实现）

曾用隐藏 PTY + shell 变量拼接 sentinel 切分文本，踩过 xterm writer 覆盖解析器、zsh 提示符无尾换行粘行吞掉 `## main` 状态头、全局队列被流式期间的慢查询阻塞等三个坑。

## 终端活力检测（liveness watchdog）

`terminals.ts` 的 `noteAgentActivity` / `armIdleWatch` + agent-service 的 `notifyTerminalIdle`：agent 工具路径的 terminal_create/input/key 会启动一个「静默纪元」——该终端连续 `PI_WEB_TERMINAL_IDLE_MS`（默认 15s）无输出且**该对话正在流式运行**时，经 onAgentIdle 回调由宿主 `sendUserMessage` 注入一条 steer 提醒唤醒 AI 去检查（等输入/已挂起）。提醒**附带该终端最近 `PI_WEB_TERMINAL_IDLE_LINES`（默认 10）行输出**（经 `queryTerminalOutput({tail})`，含 1-based 行号），让 AI 一眼看到终端当前状态。

防骚扰设计：①用户手开的终端永不参与（只有工具包装层调 noteAgentActivity，浏览器路径不调）；②一次性——触发后解除武装，agent 再次触碰才重新计时；③纪元内任何输出/输入都重置倒计时；④退出/关闭即拆钟。系统提示词引导 TERMINAL_TOOLS_GUIDANCE 已告知模型该机制。回归：`tests/terminal-idle-test.mjs`（直接实例化 TerminalManager + 小阈值，零 token 不起 server；win32 未验证）。

## 终端接管 bash（terminal-backed bash）

设置面板开关 `terminalBash`（默认关）。`terminals.ts` 的 `makeTerminalBashTool` + agent-service 的 `makeAdaptiveBashTool` 动态分流：开启后 bash 工具的执行体改为往持久可见终端 `ai-bash` 写命令（单行哨兵技术：`{cmd}; __pi_rc=$?; printf '\\n[pi-exit:%s]\\n' "$__pi_rc"`，多行脚本经 `$'...'` 转义 eval，避免被交互 shell 的 stdin/bracketed-paste 吃掉），等哨兵行拿到**真实退出码**后返回完整输出（`stripAnsi` 清理 ANSI/OSC/孤立 CR、截掉回显与新提示符）。

**一次性/持久双模式**：bash 新参数 `persistent`（默认关闭）。
- **一次性（默认）**：每次调用分配一个新鲜终端 id（`bash-N`），以 `bash -c <line>` **非交互**启动（无命令回显、无提示符，缓冲即干净输出），命令跑完自动退出 → 输出落到 `history`（保留缓冲，可事后按 id 查询/搜索）。shell 状态**不**跨调用保留。
- **持久（persistent:true）**：复用固定 `ai-bash`（交互 shell，命令经 stdin 写入），保留 cd/venv/ssh 状态；abort/交互语义同旧持久实现。
- 返回结果的**首行**是 `[终端: <id>]`，便于 AI 用 `terminal_read(terminalId=...)` 事后查看/搜索该终端（含已退出的一次性终端的缓冲）。

**自动化解模型常写的 `| tail` / `| head` 输出限制管道（语义保真）**：默认 bash 工具（`createBashTool` 直跑原命令）的顽疾是模型习惯在命令后套 `| tail -N`、`| head -N`、`| less`、`| more`、`| cat` 来限制返回量——这类管道在持久终端里 ①缓冲输出（可见终端全程哑火、无法感知实时进度）②吞掉真实退出码（退出码取管道**最后一个**命令，tail/head 恒 0）③需 stdin 的管道出错后可能挂到超时。

处理原则是「**拆了但结果跟拆之前一致**」：
- **拆掉并重现在返回输出里**（`detectTrailingLimiter()`，引号/反引号感知的顶层 `|` 拆分，**只拆末尾单个**）：`| tail -N` → 底层命令直跑、返回**末 N 行**；`| less` / `| more` / `| cat` → 直跑、返回全部。这些内容与管道原结果一致，且实时可见 + 真实退出码，避免交互分页器/缓冲挂起。
- **不拆、让它自然跑**：`| head`（`yes | head -5` 靠 SIGPIPE 早停，直跑 `yes` 会无限挂起；head 本身流式、返回前 N 行就是它的结果）、`| grep`/`| awk`/`| sed`（真过滤/变换）、`| sort`/`| uniq`/`| tr`/`| wc`、`| tee`（写文件副作用）。这些**内容就是原管道结果**，语义保真。
- **退出码取首命令 + SIGPIPE 归 0**：哨兵用 `${PIPESTATUS:-$?}`（bash 取 **PIPESTATUS[0]**=管道第一个命令、即真正干活那个；busybox ash/dash 无 PIPESTATUS 时退化为 `$?`，不崩溃），再 `[ "$__pi_rc" -eq 141 ] && __pi_rc=0`——因此 `cmd | grep` 无匹配时不再误报成 grep 的 1、`cmd | head` 截断产生的 SIGPIPE(141) 视为 0（“按设计截断=成功”，避免假失败），而真失败（127/1/2…）照报；`cmd | grep | tail -5` 也能报出 cmd 的真实退出码。
- 返回头部附一行「改用 bash(command, tail=N) 参数」的说明。提示词 `PIPELESS_BASH_GUIDANCE` 亦引导模型不用这些管道。

行为语义：
- ①默认阻塞到命令结束
- ②连续 `terminalBashIdleMs`（默认 15s，0=一直等）无输出 → **静默解阻**：立即返回「仍在后台运行」+ 已有输出，同时注册 `watchOutput` 完成观察器，命令真正结束后由宿主 `notifyTerminalBashDone` 通知 AI（流式中 sendUserMessage steer / 空闲时 sendCustomMessage nextTurn 排队不唤醒）
- ③shell 状态跨调用保留（cd/venv/ssh）
- ④abort_bash 复用同一 kills 集合，abort 时向 PTY 发 Ctrl+C 杀前台进程、终端保留
- ⑤自动拆末尾输出限制管道 `| tail -N` / `| less` / `| more` / `| cat`（见上文），保证实时可见 + 真实退出码 + 部分输出
- ⑥**重定向+tail 兼容**：`cmd > log 2>&1 | tail -N` 拆掉 tail 后 stdout 进文件、终端为空——`detectStdoutRedirect()` 识别重定向目标，改为在哨兵前补 `tail -N log`（退出码仍取底层命令），让模型看到日志尾部 + 真实退出码。
- ⑦**分页器禁用**：`shellEnv()` 设 `GIT_PAGER=cat`/`PAGER=cat`——stdout 是 tty 时 `git log`/`git diff`/`man` 等会开 `less` 并挂住等按键，强制 `cat` 透传防挂死（agent 需要完整输出而非分页）。

开关经 makeAdaptiveBashTool 在每次调用时读取设置 → 即时生效（customTools 固定于 runtime 创建，不能创建时二选一）；阈值随预设存取。回归：`tests/terminal-bash-test.mjs`（直接实例化 + 小阈值注入，零 token 不起 server；win32 未验证）。

## macOS launchd / TCC 问题

macOS 下若服务由 launchd 拉起（`process.ppid === 1`，LaunchAgent/孤儿进程），TCC 会把相机/麦克风权限归因到 node 本身（无 App Bundle、无 Info.plist）而静默拒绝——ffmpeg 取流会卡死在取帧。`terminals.ts` 检测该场景，在客户端首次创建终端时输出提示（改 url/文件源，或在自己已授权的终端里前台运行）。

## Windows shell 解析

`terminals.ts` 的 `resolveShell()` 每次创建终端时解析，优先 bash——`PI_WEB_SHELL` 显式 → `$SHELL` → Git Bash（ProgramFiles）→ busybox 兜底（`~/.pi-web/bin/bash.exe`，`ensure-bash.ts` 无 Git Bash 时自动下载 busybox-w32）→ `$COMSPEC` → powershell。与 SDK bash 工具（Git Bash / PATH 上的 bash）保持一致，避免 PowerShell/bash 混用挂死。