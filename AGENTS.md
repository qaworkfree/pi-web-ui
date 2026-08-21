# AGENTS.md — pi-web-ui 项目指南

> 本文件是给 AI 编码助手（pi / Claude Code / Cursor 等）看的项目说明书：
> 结构、架构约定、开发流程、GitHub 上传与 npm 发布流程。
> 修改本文件后，在 pi 中运行 `/reload` 生效。

## 1. 项目是什么

pi-web-ui 是 pi 编码智能体（`@earendil-works/pi-coding-agent` SDK）的 Web 聊天界面：
浏览器里对话、查看文件树、附加文件、内置终端（xterm.js + node-pty）、模型管理、
声音提醒、中英文切换。一条命令可跑（`pi-web-ui`），可 Docker / systemd / launchd /
Windows 计划任务部署。

- 仓库（公开）：`git@github.com:xing-shuyin/pi-web-ui.git`
- npm 包：`pi-web-ui`（发布者 npm 账号 `xingshuyin`）
- Node 要求：**>= 22.19.0**（pi SDK 的 dist 使用了 `import … with { type: "json" }` 语法）
- 版本：`package.json` 与 `package-lock.json` 两处同步维护

## 2. 技术栈

| 层 | 技术 |
| --- | --- |
| 后端 | Node + Express（静态 + `/api/health`）+ `ws`（`/ws` WebSocket 协议） |
| 前端 | React 18 + Vite 6 + react-markdown + highlight.js + xterm.js |
| 智能体 | `@earendil-works/pi-coding-agent` SDK（进程内，读 `~/.pi/agent` 配置） |
| 终端 | node-pty（服务端 PTY）+ `@xterm/xterm`（浏览器渲染，经 terminal bridge 转发） |
| 样式 | 单文件 `web/src/styles.css`（CSS 变量主题，深色） |

## 3. 目录结构

```
pi-web-ui/
├── server/                     # 后端（Node ESM，编译到 dist/server/）
│   ├── index.ts                # 入口：express 静态 + /ws 端点、消息分发、心跳、优雅停机
│   │                           #   启动时 win32 把 ~/.pi-web/bin 前置到 PATH + 后台触发 ensureWindowsBash
│   ├── protocol.ts             # ★ 唯一事实源：wire 协议类型（client↔server 消息）
│   ├── agent-service.ts        # 核心：ClientSession（每客户端一个会话组，可并行多个对话）+ AgentService
│   │                           #   · 多对话并发：convs Map<convId, Conversation>，每个对话独立
│   │                           #     AgentSessionRuntime（new_chat 不再杀旧对话，switch_conversation
│   │                           #     只换 activeId；模型共享一个 ModelRuntime；消息序列化缓存按对话隔离；
│   │                           #     set_cwd 切到目标项目自己的对话，不重建；「运行的对话」列表按项目、
│   │                           #     运行中被挤到后台才入列，打开后不继续再切走才移出）
│   │                           #   · WebUIContext：把扩展的 widget/status/dialog 桥接到浏览器
│   │                           #   · 附件构建（inline/reference/lines 三种模式）
│   │                           #   · readFile 预览（512KB 上限、二进制检测、路径越界拦截）
│   │                           #   · 文件列表按平台拆分（readDirForUI）：win32 稳定+全量优先——ACL
│   │                           #     保护目录降级为空列表+警告（不炸面板）、目录符号链接/junction 跟随、
│   │                           #     上限 2000 并上报 truncated；posix（mac/linux）保持原逻辑（上限 500）。
│   │                           #     IGNORED_ENTRIES 也分平台：win 只藏 node_modules/.git/.pi-web/垃圾文件，
│   │                           #     dist/.next/venv 等全部可见
│   │                           #   · 模型管理 / auth.json / models.json / 会话列表 / cwd 切换
│   │                           #     （fetch_models：自定义服务商表单里「自动获取模型列表」按钮 → 服务端
│   │                           #     探测 baseUrl 的 OpenAI 兼容 /models 接口（服务端请求绕开 CORS；
│   │                           #     api 类型决定鉴权头：openai→Bearer、anthropic→x-api-key、google→
│   │                           #     x-goog-api-key；authHeader=false 不带任何头；裸 /models 404 时回退
│   │                           #     /v1/models；15s 超时；reqId 回显供并发匹配）。**尽力解析模型元数据**
│   │                           #     回填表单：context_window/context_length/max_model_len→上下文、
│   │                           #     modalities/input_modalities/supports_vision/vision→文本+图片、
│   │                           #     reasoning/supports_reasoning→推理、display_name→显示名、
│   │                           #     max_output_tokens 等→最大输出；Google 格式 {models:[…]}（name 去
│   │                           #     models/ 前缀 + inputTokenLimit/outputTokenLimit）也支持；已有 id 的
│   │                           #     行只补空字段、保留手填值）
│   │                           #   · 每客户端持久化 lastCwd + 最近项目（<dataDir>/client-state.json，
│   │                           #     重启后恢复上次工作目录；projects 消息推送最近项目列表）
│   │                           #   · 编辑重问（edit_message）：按消息 id 解析 entryId → runtime.fork
│   │                           #     新建分支会话（保留该问题之前的历史，原对话不动）→ 重新 prompt
│   │                           #   · 自更新（check_update/update_app）：读自身 package.json 版本，
│   │                           #     对比 npm registry，npm i -g 升级后自动重启（launchd KeepAlive /
│   │                           #     systemd Restart 退出即拉起；前台派生子进程等旧进程释放端口后接管；
│   │                           #     Docker 容器内提示外部重启）
│   │                           #   · 目标审查（goal）：输入框上方 GoalBar 设目标（文本 + 审查模型 +
│   │                           #     最大轮数 + 锁定开关）。目标绑定设置时的 conversationId；每个对话
│   │                           #     独立触发 runGoalReview，多个对话可并行审查，切换/新建对话不会误审查：
│   │                           #     用独立 ModelRuntime + createAgentSessionFromServices 建一个 in-memory
│   │                           #     审查会话（不污染主会话、可指定不同模型），喂「目标 + 最终文本 +
│   │                           #     git diff HEAD」→ 解析 {"verdict":"pass|fail","feedback"}；pass 清目标并
│   │                           #     插 ✅卡片；fail 且未到 maxRounds 则把意见作为 user 消息注入主会话重改，
│   │                           #     改完再审查。协议：set_goal / clear_goal / goal_status (GoalStatus)
│   │                           #   · 审查结果作为普通对话消息（**不再用独立的 goal-review 卡片**）：pass / fail
│   │                           #     都通过 mainSession.sendUserMessage 把「结论 + 目标 + 审查意见」作为一条
│   │                           #     普通 user 消息注入主会话（fail 且有剩余轮数时，该消息就是触发重改的 steer）。
│   │                           #     用 sendUserMessage 而不是 sendCustomMessage → 既是审查结果又带“已解除目标
│   │                           #     模式、响应新指令”的语义，主 agent 不会惯性停留旧目标、把后续新指令
│   │                           #     （如“发布”）当目标确认回显。
│   │                           #   · 目标调研向导（start_goal_wizard）：用户输入原始需求，后端起一个
│   │                           #     独立调研会话（独立 ModelRuntime + in-memory session + 自定义工具
│   │                           #     goal_ask，绑定 WebUIContext，复用 select/input 的 dialog 桥接逐条
│   │                           #     提问，单选/自由文本；收敛后按 GOAL: 标记解析出最终目标并设为 goal。
│   │                           #     GoalBar「AI 提炼」按钮触发；仅当前对话的调研与审查互斥（调研期间暂停
│   │                           #     该对话 agent_end 的审查触发）。调研进度卡经 sendCustomMessage
│   │                           #     (customType "goal-wizard") 落主会话。协议：start_goal_wizard
│   │                           #     + GoalStatus.wizard (WizardStatus)
│   │                           #   · 调研取消/超时：每道题的 goal_ask 里 ui.select/input 与一个
│   │                           #     AbortController（wizardAbort）信号做 Promise.race。点 ✗（clear_goal）
│   │                           #     或空闲超时（WIZARD_IDLE_TIMEOUT_MS=5 分钟）或总时长上限
│   │                           #     （WIZARD_MAX_TOTAL_MS=20 分钟）都会 ac.abort()：取消待答弹窗
│   │                           #     （WebUIContext.cancelPendingDialogs 发 dialog_closed）→
│   │                           #     wizard.abort() 终止 agent 运行 → 不再 setGoal（wizardCancelled
│   │                           #     标记，ac.signal.aborted 判断）。
│   │                           #   · 轮数与偏好记忆：审查轮数 maxRounds 0=不限（默认，持续重改到 pass），
│   │                           #     >0=有限（cap 到 50）；调研提问不设上限（自行收敛，靠时长/空闲超时兜底）。
│   │                           #     模型选择 + 轮数 + 锁定经 set_goal_prefs 持久化到 client-state.json
│   │                           #     （stateStore.goalPrefs，attachSink 重连时回推 goal_status，刷新即恢复）。
	│   │                           #   · 设置面板（settings_state / set_settings / save_preset / apply_preset /
	│   │                           #     delete_preset）：顶栏 ⚙ 打开。① 系统提示词：append（追加到默认提示词
	│   │                           #     末尾）或 replace（整体替换，项目上下文/技能段仍自动附加）——经
	│   │                           #     resourceLoaderOptions 的 systemPromptOverride + appendSystemPromptOverride
	│   │                           #     实现（官方钩子，每次 reload() 重放）；**replace 模式输入框预填默认提示词**
	│   │                           #     （settings_state.defaultSystemPrompt = system prompt 文件内容，无文件时回退当前
	│   │                           #     会话实际生效的完整 systemPrompt）；未修改默认文本直接失焦保存为空 → 服务端回退默认
	│   │                           #     （避免固化全文、切回 append 后重复追加）；② 技能/插件开关：skillsOverride /
	│   │                           #     extensionsOverride 按名/按源（npm spec 或路径）过滤，session.reload() 后
	│   │                           #     立即从系统提示词、/skill: 目录和扩展命令中消失；③ 目标审查：设置中可单独配置审查提示词与 review skill 开关，不污染主会话；④ 预设：把当前设置
	│   │                           #     （主提示词/开关 + 审查提示词/skill 开关）存成命名组合，一键 apply/delete。设置存 client-state.json
	│   │                           #     （stateStore.settings/presets，按客户端）；已知列表缓存（knownSkills /
	│   │                           #     knownExtensions）保证禁用后条目仍在面板里可重新启用；回复流式中改设置
	│   │                           #     不立即 reload（防拆毁运行中的 run）——pendingSettingsReload 在 agent_end 后
	│   │                           #     延迟应用。协议类型在 protocol.ts / types.ts 手工同步。
│   ├── serialize.ts            # SDK 消息 → UiMessage 序列化（截断、稳定 id、对象缓存）
 │   ├── themes.ts               # 主题管理：listThemes(builtinDir, userDir) 合并内置+用户主题、
 │   │                           #   resolveThemeFile 解析 id → 文件路径（用户目录优先）；
 │   │                           #   id 必须匹配 ID_RE（^[A-Za-z0-9_-]+$）防路径穿越
 │   ├── vision-bridge.ts        # 视觉桥：纯文本主模型无 vision 时，把图片交给已配置的视觉模型转写成文字证据
│   ├── ensure-bash.ts          # Windows 轻量 bash 兜底：无 Git Bash 时自动下载 busybox-w32
│   ├── control-socket.ts       # 本地控制 socket（status / quiesce / unquiesce）：POSIX mode-0600
│   │                           #   unix socket（<dataDir>/pi-web-ui.sock）/ Windows 命名管道
│   │                           #   （\\.\pipe\pi-web-ui-<port>）；JSON 行协议、5s 空闲超时；CLI 经它
│   │                           #   查实时状态和开关排空模式，不开网络端口、不暴露 HTTP 管理端点
│   │                           #   （单 exe ~660KB，含 bash/iconv/sh/timeout）到 ~/.pi-web/bin/bash.exe
│   │                           #   （busybox 按 argv[0] 派发 applet）；下载失败静默回退 cmd
│   └── terminals.ts            # TerminalManager（按 conversation 持久 PTY + 增量输出/按键工具）+ .pi/commands.json 读写
├── web/                        # 前端（React + Vite，编译到 web/dist/）
│   ├── vite.config.ts          # dev 端口 5173，/ws 代理到后端
│   ├── src/
│   │   ├── App.tsx             # 顶层布局：TopBar / LeftPanel / MessageList / ChatInput /
│   │   │                       #   RightPanel / FooterBar / Dialog / 各 Modal / FilePreview /
│   │   │                       #   视图切换 chat | terminal | git（源代码管理）
│   │   ├── use-chat.ts         # ★ useChat()：WebSocket 连接管理、reducer 状态机、
│   │   │                       #   终端输出 bridge（按 conversationId 隔离，未挂载终端的输出先缓冲）
│   │   ├── types.ts            # ★ wire 协议镜像（与 server/protocol.ts 手工同步，仅类型）
│   │   ├── i18n.tsx            # ★ 中英文案（zh 默认），新增 key 必须两处都加
│   │   ├── styles.css          # ★ 全部样式（按组件分区，带注释分隔线）；也是默认深色主题本体
│   │   ├── theme.ts            # 主题切换：/api/themes 列表 + localStorage 持久化 +
│   │   │                       #   applyTheme() 注入 <link id="theme-stylesheet"> 整文件替换
│   │   │                       #   （每主题 = styles.css 的完整独立副本，非变量覆盖；null=默认深色）
│   │   │                       #   buildTermTheme() 读 --term-* CSS 变量 → xterm 画布主题；
│   │   │                       #   切换后派发 pi-web-ui:theme-change 供 TermXterm 热更新画布
│   │   ├── sounds.ts           # WebAudio 提示音
│   │   ├── download.ts         # 下载：downloadFile（fetch→blob→objectURL，绕开 Chrome
│   │   │                       #   Safe Browsing 对 HTTP 下载的拦截，错误可读；Chromium 安全上下文
│   │   │                       #   下优先 showSaveFilePicker（Windows 下 blob 下载仍会被静默拦截时
│   │   │                       #   的解法），Windows 自动清洗非法保存名）
│   │   └── components/         # 见下
│   └── dist/                   # 构建产物（gitignore，但打进 npm 包）
├── bin/pi-web-ui.mjs           # CLI：前台启动（就绪后自动打开浏览器，--no-browser 关闭）/ --port --cwd --data-dir / server install|uninstall|start|stop|restart|status
│                               #   （macOS→launchd，Linux→systemd，Windows→schtasks 计划任务、隐藏窗口）
├── deploy/                     # 部署示例：launchd plist / systemd unit / Windows 任务 XML
├── themes/                     # 内置主题（完整独立 CSS 文件，随 npm 包分发；light.css 由 make-light-theme.mjs 生成）
├── make-light-theme.mjs        # 主题生成器：web/src/styles.css → themes/light.css（styles.css 改动后重跑）
├── Dockerfile / docker-compose.yml
├── freeze-test.mjs 等           # 仓库根的手写 Playwright E2E 脚本（chromium headless）
└── tsconfig.server.json / web/tsconfig.json
```

`web/src/components/` 速览：

| 组件 | 职责 |
| --- | --- |
| `FilePreview.tsx` | 文件预览弹窗：行号、点选/拖拽/Shift 选区、添加到对话（lines 附件）；Markdown 默认渲染预览，可切换原文；文本文件可通过默认关闭的编辑开关修改并保存 |
| `LeftPanel.tsx` | 左栏：最近项目（点击切换 cwd）+ 运行的对话（≥1 个时显示，活跃高亮、流式绿点，按当前项目过滤；固定在历史列表上方独立滚动）+ 历史对话（标题不随列表滚动） |
| `RightPanel.tsx` | 文件树浏览（list_files，目录过大时显示截断提示），文件名点击→预览，📎/🔗/👁 附件按钮；服务端对**当前列出目录**做 fs.watch，改动推 `file_changed`（新协议消息）→ 立即静默重列，失败/不支持的文件系统回落 10s 轮询 |
| `ChatInput.tsx` | 输入框 + 附件 chips（inline/reference/lines 三色）；回复中显示「补充」按钮（**followUp 排队** —— 等整个 run 生成完全结束才发送、不打断不跳工具；区别于直接回车/发送按钮的 steer：当前回合工具结算后立即注入、跳过剩余工具、agent 马上响应，即 pi CLI Enter 打断语义；前端经 `prompt.queue=true` 区分）+「停止」；**斜杠命令**：输入 `/` 弹出命令选择器（内置/扩展/模板/技能四类标签，↑↓ + Enter/Tab 补全，Esc 关闭），`/help` 打开命令清单弹窗、`/copy` 复制上一条助手回复（纯客户端）；内置命令（/new /model /compact /cwd /thinking /resume）由服务端 `AgentService.prompt()` 拦截执行，扩展/技能/模板命令透传给 SDK prompt（SDK 原生展开），未知 `/xxx` 作为普通文本发送 |
| `Message.tsx` / `MessageList.tsx` | 消息渲染：附件卡片（`stripFileWrapper` 剥 `<file>` 包装）、流式光标、tool 结果关联；`/skill:name` 展开的 `<skill>` 块渲染为可折叠技能卡片（`web/src/skill-block.ts` 的 `parseSkillBlock` 镜像 SDK 正则，折叠显示 `[技能] name`，展开显示完整 SKILL.md；用户自己的 args 单独渲染，编辑重问时重建 `/skill:name args`，问题导航用 args 而非技能内容）；超过 30 条后旧消息折叠为摘要行（`CollapsedMessage`，惰性渲染，点击展开，常量 `KEEP_RECENT`/`COLLAPSE_MIN` 在 MessageList 顶部）；**问题导航双通道**：右侧浮动 `.qn-rail`（hover 浮出问题文本 chip，问题多时 `.many` 变体换成可滚动 `.qn-list` 面板，移出立即隐藏无延迟）+ 每个问题消息头部右端的常驻 `.qn-tag`（横条+序号，点击跳转，当前屏幕问题高亮） |
| `ToolCallBlock.tsx` / `ThinkingBlock.tsx` / `BashBlock` | 工具调用卡片、思考块、bash 输出 |
| `TerminalPanel.tsx` / `TermXterm.tsx` | 终端视图 + xterm 实例桥接 |
| `SCMPanel.tsx` | **源代码管理（Git）视图**：对当前 cwd 展示 status/branch/diff；提交/切换分支/推送/拉取按钮复用终端桥接把命令发到可见终端执行（自动切到终端视图）；只读查询在**隐藏查询终端**里跑（terminal_create + terminal_input + terminal.register 捕获输出，shell 变量拼接的 sentinel 切分多段输出，stty -echo 关回显、PS1 标记过滤提示符）|
| `TopBar.tsx` / `FooterBar.tsx` | 顶栏（模型/思考强度/后台任务/声音/新对话/视图切换）、底栏（上下文/成本/工作目录） |
| `Dialog.tsx` | 扩展 `ui.select/confirm/input` → 浏览器弹窗 |
| `ModelConfigModal.tsx` / `PiSetupModal.tsx` | models.json 管理 / 首次配置引导 |
| `SettingsModal.tsx` | 设置面板：系统提示词（append/replace 模式 + 文本，失焦自动应用）、技能/插件开关（即时生效）、预设（保存/应用/删除当前组合） |
| `Markdown.tsx` / `Dropdown.tsx` / `copy-button.tsx` / `SoundSettings.tsx` | 通用件 |

## 4. 核心架构（改代码前必读）

### 快照驱动

- **服务端是唯一事实源**：每次 SDK 事件后节流 60ms 推全量 `snapshot`（`UiState`），
  浏览器只按快照渲染。重连只需重发 `get_state`。
- 序列化时**对象引用稳定**：`uiMessageCache` + 消息数组签名比对，消息没变就不重建数组，
  前端 `React.memo` 因此能跳过整条消息——**不要**破坏这个缓存（stable id、引用复用）。
- `UiState` 携带 `thinkingLevel`（当前生效）和 `availableThinkingLevels`（当前模型实际支持的级别，
  SDK 会把集合外的请求静默就近钳制——UI 只能启用这些，否则用户点“低/中”看起来“改不了”）。

### 协议双端手工同步

`server/protocol.ts`（事实源）和 `web/src/types.ts`（镜像）**没有共享代码，必须手工同步**。
新增/修改任何消息：先改 `protocol.ts`，再把同样的类型镜像到 `types.ts`，最后在
`server/index.ts` 的 `dispatch` switch 和 `web/src/use-chat.ts` 的 `onmessage` switch
各加一个分支。

### 附件三种模式（`ClientMessage.prompt.attachments[].mode`）

### 安全边界（loopback / Origin 校验 / quiesce / 凭据隔离）

- **默认只绑 loopback**（`PI_WEB_HOST`，默认 `127.0.0.1`）：本地个人工具不暴露到网络；局域网/容器需显式 `PI_WEB_HOST=0.0.0.0`（docker-compose.yml 已内置，Docker 端口映射才能工作）。
- **WS 升级做 Origin/Host 同权威校验**（`server/index.ts` 的 `originAllowed`，`WebSocketServer({ noServer: true })` + 手动 `handleUpgrade`）：Origin 存在时其 hostname+**有效端口**必须与请求 Host 一致（浏览器里 `example-host:8445` 与 `example-host:9443` 是不同源）；非浏览器客户端（无 Origin）放行；`PI_WEB_ALLOW_ORIGINS` 白名单绕过（dev:server 已内置 `http://localhost:5173,http://127.0.0.1:5173`，反代场景自配）；`PI_WEB_ALLOW_HOSTS` 可选严格 hostname 白名单。**不要**加回「本地任意端口放行」——那正是提案要修的洞。
- **quiesce 准入控制**（`AgentService.quiesce/unquiesce`）：进入排空后**拒绝一切新工作**——新 prompt（native slash 命令例外，纯配置无 token）、new_chat、edit_message fork、switch_session、goal wizard；存量运行继续跑完。已知 clientId 仍可 attach 看存量（发 notice 提示），**全新客户端 attach 抛 `QuiesceRejectedError` → index.ts 以 4403 关 WS**，浏览器重连循环在 unquiesce 后自动恢复。
- **控制 socket**（`server/control-socket.ts`）：CLI 的 `server status|quiesce|unquiesce` 经本地 mode-0600 unix socket / Windows 命名管道（`\\.\pipe\pi-web-ui-<port>`）与运行中进程通信，`status` 报告真实 socket 数（`noteSocketOpen/Close`，index.ts 维护）、active/pending 计数、quiesce 状态；无鉴权 HTTP 端点。
- **provider headers 不下发浏览器**（`models_config` 不再携带 `headers` 字段，可能含 Authorization/API key）：`saveModelConfig` 保存时若 config 无 headers 则保留旧值（`prevHeaders`）。`UiProviderConfig.headers` 已从 protocol.ts / types.ts 删除，前端没有任何地方编辑 headers（仅 apiKey 经独立消息 `set_provider_api_key` 走浏览器）。
- **dev 兼容**：vite :5173 代理 /ws 到 :8788 时 Origin(:5173) ≠ Host(:8788)，靠 `PI_WEB_ALLOW_ORIGINS`（dev:server 内置）放行，勿删。

### 主题切换（整文件样式替换，不做变量抽取）

- **机制**：每主题 = `web/src/styles.css` 的**完整独立副本**（不同配色），非 CSS 变量覆盖。
  默认深色主题仍由打包的 `styles.css` 提供；选其他主题时前端注入
  `<link id="theme-stylesheet" href="/themes/<id>.css">` 整文件覆盖，选回默认则移除该 link
  （`web/src/theme.ts` 的 `applyTheme`，localStorage 键 `pi-web-ui:theme`，`main.tsx` 首帧前应用防闪烁）。
- **服务端**：`GET /api/themes` 列主题（`server/themes.ts` 的 `listThemes`），
  `GET /themes/:id.css` 发文件（`resolveThemeFile`，用户目录优先）。id 必须匹配 `ID_RE`
  （`^[A-Za-z0-9_-]+$`）防路径穿越。两个路由在 `server/index.ts` 注册于 SPA catch-all 之前
  （否则被吞返回 index.html）。dev 模式 Vite 需在 `web/vite.config.ts` 代理 `/themes`（已加）。
- **主题来源**：内置 `<pkgRoot>/themes/*.css`（随 npm 包分发，`package.json` files 白名单含
  `themes/`）；用户自定义直接往 `<dataDir>/themes/` 丢 CSS 文件即可（id 冲突时用户覆盖内置）。
  `pkgRoot` 经 `resolvePkgRoot()` 向上找含 package.json 的祖先解析，dev(server/) 与 prod(dist/server/) 均正确。
- **示例 light 主题**：`themes/light.css` 由根目录脚本 `make-light-theme.mjs` 从 `styles.css` 生成
  （`:root` 浅色系 + 硬编码暗色映射 + `.hljs` 语法高亮浅色覆盖 + `--term-*` 终端亮色变量）。
  **终端跟随主题**：xterm 画布经 `web/src/theme.ts` 的 `buildTermTheme()` 读 `--term-*` 变量，
  主题切换时 `TermXterm.tsx` 监听 `pi-web-ui:theme-change` 事件用 `term.options.theme` 热更新画布；
  CSS 容器 `.term-main` / `.term-xterm .xterm-viewport` 用 `var(--term-bg)`，与画布自动融合
  （历史底部黑条问题的根因就是容器背景与画布不一致）。styles.css 改动后重跑
  `node make-light-theme.mjs` 重新生成。
- **回归**：`theme-test.mjs`（端口 8937，隔离 data-dir）：列表/内置/用户主题、注入 link、
  浅色生效、刷新持久、用户主题可应用、回默认移除 link。

| mode | 含义 | 服务端处理 |
| --- | --- | --- |
| `inline` | 内联全文 | ≤ `PI_WEB_INLINE_FILE_MAX`（默认 12KB）内联，超出自动降级为 reference |
| `reference` | 仅路径 | 发 `<file path="..." size="..."/>`，模型按需用 read 工具读 |
| `lines` | 选中行 | 发 `<file path="..." lines="2-3">```选中行```</file>`，只读该范围（读取上限 2MB，超限降级 reference） |

**图片问答（无工作区路径）**：粘贴（Ctrl+V）/ 拖入输入框 / 🖼 上传的图片带
`attachments[].imageData`（base64）+ `mimeType` + `name` 发送——服务端直接作为 image content
附加，不走文件路径（`path` 忽略）。浏览器端（`web/src/image-paste.ts`）先把图片等比缩到
≤1568px、按需转 PNG/JPEG，保证 payload 在服务端 2MB 上限内（`MAX_PASTED_IMAGE_BYTES`）。
当前模型不支持识图（`model.vision`）时前端提示警告。

**视觉桥（纯文本模型看图，参照 modlens 思路）**：当**当前对话模型不支持识图**（DeepSeek/GLM
等 `input` 只有 `text`）时，`buildAttachmentMessages` 不再把图片直接作为 image content 发送
（会被忽略），而是交给一个**已配置的视觉模型**转写成文字证据再喂给主模型（`server/vision-bridge.ts`）：
- **零配置自动发现**：`findVisionModels` 扫描 `ModelRuntime` 所有 **`hasConfiguredAuth`** 的
  provider，找出 `input` 含 `"image"` 的模型（qwen-vl、GLM-4V、Gemini…）——复用 models.json/auth.json
  里已有的凭据，不新增任何配置。⚠️ 必须过滤未配置的 SDK 内置 provider（如 amazon-bedrock 自带
  Nova 视觉模型但无 auth，不滤会调用失败）。
- **转写**：`transcribeImages` 用 `runtime.completeSimple` 把整批图（多图合并一次调用）发给视觉
  模型，提示词要求证据优先——逐字 OCR、版面布局、图表坐标/图例、实体，读不清明说「读不清」不编造
  （沿用 modlens 的 evidence-not-imagination 契约）。默认 90s 超时（`PI_WEB_VISION_TIMEOUT_MS`），
  maxTokens 4000 防爆上下文。
- **结果形态**：附件卡片 content 变为 `[text(<vision-bridge>包装), image(缩略图)]`，`details.mode`
  = `"bridged"`（前端 AttachmentCard 显示「👁 已转写」标签 + 展开看缩略图与转写文字；`stripFileWrapper`
  同时剥 `<vision-bridge>` 包装）。notice 提示转写开始/完成/失败（失败回退原样发送）。
- **文件列表引用图片同样触发**：`buildAttachmentMessages` 预处理阶段除 `imageData` 外，还把
  **路径指向图片的附件**（扩展名 ∈ IMAGE_EXT 且非 SVG，`sniffImageMime` 魔数嗅探确认，≤5MB
  `MAX_PATH_IMAGE_BYTES`）读成 base64——纯文本模型走视觉桥（bridged 卡片带 `path`），视觉模型
  直接作为 image content 发送（不再让模型用 read 工具读二进制乱码）；SVG 保持普通文件（模型读源码）。
- **缓存**：`visionBridgeCache` 按批次 hash（name + base64 前 48 字符）缓存转写文本——编辑重问重发
  相同图片不再重复耗视觉 token。
- **无视觉模型时**：warning notice 提示「未找到可用的视觉模型」+ 图片原样发送（现状）。
- **设置面板可指定模型/开关/提示词**（`SettingsModal` 视觉桥区块，走 `set_settings` + `UiSettingsState`，
  存 client-state.json 按客户端持久化）：①开关 `visionBridgeEnabled`（默认开；关掉后图片原样发送
  + warning notice「视觉桥已在设置中关闭」）；②转写模型 `visionBridgeModel`（"provider/id"，默认
  null=自动选第一个；服务端 `buildAttachmentMessages` 里 `resolveReviewModel` 解析并校验
  `getModel().input` 含 image，无效则回退自动发现）；③转写提示词 `visionBridgePromptMode`
  （"append"/"replace"，语义同 promptMode）+ `visionBridgePrompt`（自定义文本，空 = 内置默认）——
  经 `buildVisionBridgePrompt`（vision-bridge.ts 导出）组装后传给 `transcribeImages` 的
  `systemPrompt`；append 在默认提示词后追加，replace 整体替换（空文本仍回退默认）；**提示词
  纳入批次缓存键**——改提示词后同图重发不再命中旧转写缓存。`settings_state` 带 `visionModels`（
  `collectVisionModels()` = `findVisionModels` 结果）供下拉选择；预设（preset）**不包含**视觉桥
  偏好（`SettingsPreset extends Omit<ClientSettings, "visionBridge…">`，apply 时保留当前值）；
  `setSettings` 里视觉桥字段变更**不触发** `applyRuntimeSettings()`（无需 reload，下次 prompt 即生效）。
  **两个 replace 输入框都会预填"原本的提示词"**（settings_state 带 `defaultSystemPrompt` +
  `visionBridgeDefaultPrompt`）：切换替换模式时空输入框自动填入内置默认文本供直接修改，
  内容与默认一致时保存为空（= 使用默认），切回 append 不会出现重复追加。

**文件对话（无工作区路径）**：拖入输入框 / 📎 上传的任意文件带 `attachments[].fileData`
（base64）发送——服务端写入全局目录 `~/.pi-web/uploads/<clientId>/`（**不放项目内**，
`MAX_UPLOAD_BYTES` 20MB 上限），小文本（≤ `PI_WEB_INLINE_FILE_MAX` 且嗅探为文本）直接内联，
其余以**绝对路径** reference 附加（read 工具支持绝对路径）。前端分流（`isRasterImage`）：
**只有栅格图片**（png/jpeg/gif/webp/bmp/avif…）走 imageData 管线；**SVG 等矢量格式排除**——
createImageBitmap 解码 SVG 会失败，SVG 作为普通文件附加让模型读源码更有用，其余文件走 fileData。

附件作为独立 custom message（`sendCustomMessage` + `deliverAs: "nextTurn"` asides）发送，
渲染成可折叠卡片。客户端 `stripFileWrapper` 的正则要兼容 `lines="..."` 属性。
**消息序列化缓存按 `role:timestamp` 为 key——同一 prompt 的多个 aside 同毫秒创建会碰撞，
必须靠内容指纹（`contentFingerprint`）区分，否则只有第一个渲染（已修，勿回退）。**

### 文件预览协议

- 客户端发 `{ type: "read_file", path }` → 服务端回 `{ type: "file_content", path, name, text, truncated, binary, lines, size }`。
- 只读文件前 **512KB**（`MAX_PREVIEW_BYTES`）；**内容嗅探决定文本还是二进制**：
  无 NUL、控制字符占比 < 2% 即按文本预览（`looksLikeText`）——未知/无扩展名文件
  （jsonl、.log.1 等）也能打开；**文本解码带 GBK 回退**（`decodeText`：严格 UTF-8
  失败 → GBK → latin1，预览/内联附件/行附件都用它），Windows 老中文文件不再乱码；二进制返回 `binary: true`，`text` 为前 4KB 的
  **十六进制视图**（`hexDump`，前端 `.fp-hex` 渲染，可下载完整文件）。
  路径经 `resolve + relative` 校验，`..` 越界直接拒。
- **媒体预览走 HTTP**：image/video 经 `/api/file?clientId=…&path=…` 流式返回（`sendFile` 支持 Range），
  路径按**该客户端的会话 cwd**（打开的项目）解析，而非服务启动目录——两者可能不一致；
  `clientId` 缺失或会话不存在时回退到服务启动 `CWD`。路径校验统一走 `workspacePath()`（agent-service 导出）。
- 行号语义：**尾随换行不产生空行**（`countLines` 已修正），前后端 split 逻辑必须一致。
- **下载按钮**（`web/src/download.ts`）：不用 `<a download href>`（Chrome Safe Browsing
  会拦截非 HTTPS 源的无信誉文件类型如 .zip/.exe，报「无法下载/联系你的组织」），而是
  fetch → blob 保存；>200MB 回退原生导航流式下载；失败 toast 显示服务端
  错误正文（`downloadFailed` i18n key）。**Windows 特例**：blob 锚点下载在 Windows 上仍可能被
  Safe Browsing 静默拦截（无 JS 错误，表现为「点了没反应」）——Chromium 安全上下文
  （localhost/HTTPS）下优先用 `showSaveFilePicker` 直接写入用户选中的文件（绕过下载管线）；
  Windows 上保存名经 `sanitizeFileName` 清洗（`<>:"\|?*`、尾随点/空格、CON/COM1 等保留
  设备名）；取消保存对话框不算错误（`cancelled`，不弹 toast）。`download-test.mjs` 覆盖回归
  （已禁用 picker 以测 blob 路径）。

### 终端

- 每个 `Conversation` 一个 `TerminalManager`；agent 可调用 `terminal_create`、`terminal_list`、
  `terminal_close`、`terminal_input`、`terminal_key`、`terminal_read`，支持命名多终端、增量 cursor、
  Enter/Tab/方向键及 Ctrl/Alt 组合。PTY 工作目录限制在该对话工作区，最多 16 个终端，输入/读取有大小与等待上限。
- **所有 spawn 路径统一准入**：`terminal_create`（浏览器/agent）与 `run_command`（命令列表）共用
  `validateId`（字母/数字/.-_:/≤80 字符）+ `ensureSpawnAllowed`（新 live PTY 需低于 `MAX_TERMINALS`；
  已在运行的同名终端原地重启不占新名额；**history 里的已退出终端不保留名额**——满员时重跑已退出
  终端同样拒绝，堵住“唯一 ID 无限生成 PTY”的洞）；失败统一走 `fail()`（notice + 终端内红色报错 + terminal_exit）。
- **terminal_key 按键编码是纯函数** `encodeTerminalKey(key, modifiers)`（导出，字节级断言在
  terminal-smoke-test.mjs）：命名键按名称路由，Ctrl/Alt 组合绝不回退成“Ctrl+首字母”——
  Ctrl+ArrowUp=`ESC[1;5A`（非 Ctrl+A）、Ctrl+Enter=`ESC[13;5u`（非 Ctrl+E）；方向键/F1–F4/Home/End
  带修饰符时用 xterm 修饰序列 `ESC[1;<m>X`，其余命名键用 CSI-u `ESC[<code>;<m>u`，普通字符
  Ctrl 映射 A–Z→0x01–0x1A、Shift 大写、Alt 前缀 ESC。
- 输出经带 `conversationId` 的 `terminal_output` 推给浏览器；未挂载终端保留 200KB 输出窗口，切回对话时回放。
  socket 断开不杀 PTY；切换/重连保留状态，对话被释放或服务关闭时才杀掉全部 PTY。
- **node-pty × Node `--watch` 兼容自愈**（`server/patch-node-pty.ts`，必须排在 node-pty 之前 import）：
  dev 脚本用 `node --watch`，watch 模式会向 node-pty 的 ConPTY worker / console-list agent 的
  IPC 通道推 `watch:require`/`watch:import` 消息——node-pty 1.1.0 不识别，导致①每条都
  `console.warn('Unexpected ConoutWorkerMessage')` 刷屏；②kill 路径把 watch 消息当 agent 回复，
  `message.consoleProcessList` 为 undefined 直接 `.forEach` 崩溃。补丁模块在启动时幂等地改写
  安装副本（仿 spawn-helper chmod 先例）；`terminals.ts` 里另有一层 console.warn 过滤兜底。
  生产（无 `--watch`）不受影响。
- **源代码管理（`SCMPanel`，视图 `git`）的隐藏查询终端**：不新增后端 git 集成，纯前端复用
  终端协议跑只读查询——固定 terminalId `scm-git-query` 的隐藏 PTY（`terminal_create` +
  `terminal_input`，输出经 `terminal.register` 捕获）。两段握手暖机：① `export PS1=<标记>;`
  `exec bash --norc -si` 等标记提示符出现（必须加 `-i` 使 shell 交互式才会打印 PS1 提示符；PS1 用 `__PIWEB_PROMPT_""__` 拼接，回显行不含连续标记；
  必须分两段等握手——ConPTY 下 exec 完成前送入的输入会被丢弃）；② `stty -echo` + READY 标记
  （关回显消除输入回显与输出交错，消费到 READY 顺带丢弃启动提示符/.bashrc 噪音）。查询行用
  shell 变量拼接 sentinel（`S=__PIWEB_SCM_; S=$S"DONE_7F3A__"`，回显不含连续 sentinel），
  一次查询多段输出按 sentinel 切分解析（status/branch/diff --stat…）。**cleanSection 剥行首
  PS1 标记而非整行丢弃**——zsh/交互 shell 的提示符无尾换行，会把 git 输出第一行（如 `## main`）
  粘在提示符后（`__PIWEB_PROMPT___## main...`），整行丢弃会静默吃掉状态头；`-si` 而非 `-s`
  （无 `-i` 的 bash 非交互、不打印 PS1）。15s 超时自动 kill+重建。
  **该终端不出现在终端 tab 列表**（TerminalPanel 用 `SCM_QUERY_TERM_ID` 过滤），否则其 xterm writer 会
  覆盖 SCMPanel 注册的输出解析器（bridge 的 writers 是 Set 多订阅广播，但 UI 仍不该渲染这个私有 PTY）。
  写操作（提交/切换分支/推送/拉取）复用可见终端 tab（TerminalPanel 同款 tab 复用逻辑）并切到终端视图。
- macOS 下若服务由 launchd 拉起（`process.ppid === 1`，LaunchAgent/孤儿进程），TCC 会把
  相机/麦克风权限归因到 node 本身（无 App Bundle、无 Info.plist）而静默拒绝——ffmpeg 取流会
  卡死在取帧。`terminals.ts` 检测该场景，在客户端首次创建终端时输出提示（改 url/文件源，
  或在自己已授权的终端里前台运行）。

### 其他桥接

- **工具结束实时状态（`tool_status`）**：服务端 `onEvent` 监听 `tool_execution_start/end`（AI 调工具路径，
  注意区别于 `bash_execution_update`——那是 `!cmd`/终端直接执行路径专属）。`tool_execution_end` 触发时
  立即推 `tool_status`（toolCallId/toolName/isError/exitCode/durationMs），**先于** toolResult 快照落盘——
  浏览器 tool 卡片随即从「执行中」切到「已结束 · 等模型 · 耗时」，一眼区分「命令还在跑」vs「命令完了在等模型响应」。
  bash 工具的 details 不带 exitCode（成功时返回 truncation 信息，失败时错误文本含 `Command exited with code N`），
  服务端从错误文本正则提取；`tool_execution_start` 时刻记在 `conv.toolStartTimes`（按对话隔离）算真实执行耗时。
  前端 `toolStatuses` Map 在 toolResult 落盘（snapshot prune）后清除，回落到权威的 toolResult 状态。
### 多对话并发（每项目「运行的对话」）

- 每客户端 `convs: Map<convId, Conversation>`，**每个对话一个独立 `AgentSessionRuntime`**：
  `new_chat` 新建 runtime + 新 session 文件（旧对话继续在后台跑，不中断）；
  `switch_conversation` 只换 `activeId`（不碰其他 runtime）；`runtime`/`session` 访问器指向当前活动对话。
  **对话按项目归属**：`conv.cwd` 即所属项目，每个项目各自的活动对话互不干扰。
- **`set_cwd` 不再重建当前对话**——改为切到目标项目自己的对话（该项目最近活动的那个；
  没有则新建一个并恢复该项目最近的持久会话）。离开项目的对话原地保留、后台继续跑，
  标题/cwd 永远不会串项目（旧版「切项目后高亮对话名字还是上个项目」的根因就是重建）。
- **「运行的对话」列表生命周期**（每个对话 `listed` / `promptedSinceActive` / `lastActiveAt` 三字段）：
  - 入列：活动对话**正在流式输出时**被挤到后台（new_chat / switch_conversation / set_cwd）→ `listed=true`；
  - 留在列表：后台跑完不移出（用户可能还没看结果）；
  - 移出：打开它（切为活动）→ 没有继续对话（期间没发过 prompt）→ 切走时 `displaceActive()` 返回它，
    `removeConversation` 释放 runtime（会话已持久化，历史列表仍可恢复）。从未入列的空对话在切走时同样释放。
- 上限 `MAX_OPEN_CONVERSATIONS = 8` **按项目计**，超出时 new_chat 发 warning notice。
- 所有对话共享**一个 ModelRuntime**（首个对话创建时播种，`makeRuntimeFactory` 传入复用）——
  顶栏换模型对全部对话生效。**消息序列化缓存（msgIds/uiMessageCache/签名）按对话隔离**：
  两个对话可能产生相同的 (role, timestamp) 键，共享会串号。
- `snapshot` 带 `conversationId`；`conversations`（ServerMessage）只推**当前项目已入列**的对话 + `activeId`
  （activeId 可能未入列，如刚 new_chat 还没跑过）；`switch_conversation`（ClientMessage）只在同项目内切换。
- 行为不变的部分：`switch_session`（恢复持久会话）替换**当前**对话的 runtime（成功后视作已继续）；
  `edit_message` 在**当前**对话内 fork；`dispose` 遍历销毁全部对话；attachSink 重连时补推 conversations。
- 前端：左栏「运行的对话」区（≥1 个时显示，活跃高亮、流式绿点），MessageList 以 conversationId 为 key 强制切换重挂载。

- 扩展的 `setWidget/setStatus/notify/select/confirm/input` → `widgets/statuses/notice/dialog` 消息；
  对话框经 `dialog_response` 回传，Esc 视为取消。
- `snapshot` 里 `streamingMessage` 是进行中的消息（60ms 粒度流式），`messages` 是已落盘的。

## 5. 开发工作流

```bash
npm run dev          # 并行：node --watch --import tsx 后端(:8788，dev:server 脚本，cross-env 固定 PORT=8788，
#                     避开全局 pi-web-ui 的默认 :8787) + vite 前端(:5173，代理 /ws 到 :8788)。
#                     注意：不要用 `tsx watch` 起后端——它在 Windows 下、stdio 为管道（concurrently 的 spawn 方式）时会静默挂死（tsx 上游 bug），改用 Node 原生 --watch。
npm run typecheck    # 双端 tsc --noEmit（提交前必跑）
npm run build        # build:web (vite) + build:server (tsc)
npm start            # 跑编译产物 dist/server/index.js（生产）
npm run test:freeze  # 冻结/重连回归测试（Playwright，需要 chromium headless）
```

### 编码约定

- **缩进用 Tab**；前端组件小写文件名（`copy-button.tsx` 例外）；代码注释中英混写，UI 文案默认中文。
- **i18n**：所有用户可见字符串走 `useT()`；改 `i18n.tsx` 必须同时加 `zh` 和 `en` 两个 key
  （`en` 的类型是 `Record<keyof typeof zh, string>`，漏一个会编译报错，这是特性不是 bug）。
- **通知文案**：服务端 notice 直接写中文，不需要 i18n。
- **样式**：全部在 `styles.css`，按 `/* ---- 组件名 ---- */` 分区；颜色用 CSS 变量
  （`--bg-elev*`、`--border*`、`--text*`、`--accent*`、`--amber`、`--green`、`--red`）。
- 文件列表 `IGNORED_ENTRIES`（node_modules/.git/dist 等）在 `agent-service.ts` 顶部维护。
- 新增协议消息 → 见第 4 节「协议双端手工同步」。
- **斜杠命令目录**：服务端 `pushSlashCommands()` 收集当前活动会话的扩展命令
  （`session.extensionRunner.getRegisteredCommands()`）+ 模板（`promptTemplates`）+
  技能（`resourceLoader.getSkills()` → `skill:<name>`）加上 9 个内置命令，经
  `slash_commands` 消息推送（attach / set_cwd / new_chat / switch_conversation /
  switch_session / get_commands 时刷新）；内置命令在 `prompt()` 里拦截
  （`execNativeCommand`，含 /model 模糊匹配、/thinking 中英别名、`/reload` 调
  `session.reload()` 重新发现扩展/技能/模板后重推目录），其余透传 SDK（SDK 会
  展开扩展/技能/模板命令）。注意 SDK 的 `getSkills()` 返回的是会话创建时的内存
  快照——删除/新增 skill 文件后必须 `/reload`（或 /new / 切项目重建 runtime）才
  生效。改动时保持 `NATIVE_COMMANDS` 与 `execNativeCommand()` 同步。回归：
  `slash-commands-test.mjs`。

### 验证清单（改完自检）

1. `npm run typecheck` 零错误
2. 涉及 UI → `npm run dev` 手动过一遍交互
3. 涉及 ws 协议 → 仓库根有现成 Playwright 脚本可参照（`*-test.mjs`）：
   `terminal-smoke-test.mjs` / `freeze-test.mjs` 等，改 PORT 后用
   `node xxx-test.mjs` 跑（需要 `/Users/c/Library/Caches/ms-playwright/.../chrome-headless-shell`）

### 测试规范（写测试/测代码前先读）

- **全局 vs 本地**：用户日常可能正用**全局安装**的 `pi-web-ui`（`~/.local/share/fnm/node-versions/…/lib/node_modules/pi-web-ui`，默认端口 `8787`）跑着对话/工作。开发改造对象永远是**本地仓库** `/Volumes/P/project/pi-web-ui`。用户会在自己测试时手动关闭全局 dev、切到本地。
- **绝对不要杀全局进程/占 8787**：禁止 `pkill -f "dist/server/index.js"`——它会命中全局 server（端口 8787），把用户正在用的会话打断。清理只针对**自己启动的测试 server**。
- **隔离端口**：每个 `*-test.mjs` 用独立端口（≥8900，避开 8787/5173/3300），并在启动 server 前先 `lsof -ti :PORT -sTCP:LISTEN` 确认空闲；若被占，改端口而非硬杀。
- **精确清理自己起的进程**：spawn 后记录 `server.pid`，测试收尾（含异常 catch 路径）用 `process.kill(pid, 'SIGTERM')` 只杀自己启动的。多开几个 server 时用各自 PID 逐个杀，别用宽泛模式匹配。
- **data-dir 隔离**：测试 server 设 `PI_WEB_DATA_DIR` 为 `mkdtempSync(tmpdir…)`，`PI_WEB_CWD` 指本地仓库——避免污染真实 user data / client-state / session。
- **需要真模型/走审查调研的**（goal-*, wizard）会真实调用 LLM、耗 token 且依赖本机模型（opencode-go 可能慢/卡）——写测试时区分「协议冒烟（无 token，如 goal-test/goal-prefs 的 set/clear 轮序）」和「live（真调用）」两类，避免误以为功能坏。
- **验证项**：每改完一版，跑本地 server（隔离端口+独立 data-dir）→ 对应 `*-test.mjs` → `npm run typecheck` → 涉及 UI 再用 `playwright` 浏览器测试（chromium 路径见各测试文件 HEADLESS 常量）。
- **goal 家族测试**（仓库根 `goal-*.mjs`）：`goal-test`=协议冒烟（set/clear/locked/review-model/rounds 轮序，无 token）；`goal-prefs-test`=偏好持久化跨 reload；`goal-pill-test`=GoalBar UI（胶囊、向上下拉）；`goal-rounds-test`=最大轮数**直接输入**控件（可输任意值/0=不限）；`goal-autostart-test`=直接 set_goal（不带向导）也**自动触发生成**；`goal-abort-test`=**手动 Stop 即清除 goal、停止审查循环**（agent_end 里助手消息 stopReason==="aborted" 判中断）；`goal-wizard-test`=问卷收敛 auto-set + **auto-generate 自动触发生成**；`goal-wizard-cancel-test`=调研取消/超时；`goal-review-loop-test`=锁定+无限轮数的真实审查循环（需要真模型，本机 deepseek 可能卡，fail 属环境非概率即可）。
- **settings 家族测试**（`settings-test.mjs`，端口 8931）：设置面板协议冒烟——settings_state 推送 / get_settings / set_settings（提示词 append+replace、技能与插件开关） / save_preset / apply_preset / delete_preset / 重连后持久化；假 agent 目录（隔离）只测协议，指向真实 agent 目录可覆盖开关往返。
- **scm-test.mjs**：源代码管理面板 E2E（独立端口 + 临时 git 仓库 cwd + 临时 data-dir，真实 Chrome headless）：status 列表 / 分支 chip / 单文件 diff / 未跟踪提示 / 提交端到端（终端 tab + 磁盘验证 + 自动刷新回干净） / 分支切换（select + 终端执行 checkout）。注意本机 `process.execPath` 是 fnm multishell 临时 shim，spawn server 前先 `realpathSync(process.execPath)` 取真实 node。

- **quiesce-test.mjs**（端口 8911）：安全加固冒烟——控制 socket status/quiesce/unquiesce（Windows 命名管道 / POSIX unix socket 自动适配）、Origin/Host 同权威校验（跨源拒绝、同源通过、**同主机跨端口拒绝**）、models_config 不再含 headers、quiesce 后存量客户端可 attach 但 prompt 被拒、全新客户端 attach 以 4403 关闭、unquiesce 恢复。改动安全边界后必跑（`npm run build:server` 后 `node quiesce-test.mjs`）。
- **fetch-models-test.mjs**（端口 8955）：自定义服务商模型列表自动获取的协议测试（mock /models 端点，零 token）——happy path（去重排序 + **元数据解析**：context_window/max_model_len→contextWindow、modalities/supports_vision→input、reasoning、display_name/max_output_tokens）、reqId 回显、authHeader=true 带 Bearer / false 不带、裸 /models 404 时 /v1 回退、**Google 格式 {models:[…]} 解析**（models/ 前缀剥离 + inputTokenLimit）、空 baseUrl/非法 URL/非 http(s)/空列表/非 JSON/404 各错误路径、并发请求 reqId 不错配。
- **model-config-ui-test.mjs**（真 Chrome headless）：模型管理弹窗「自动获取模型列表」按钮 E2E——新增服务商表单填 baseUrl/apiKey → 点击后模型行自动填满（3 行 mock-a/b/c）+ 成功提示「已获取 3 个模型」+ **元数据回填断言**（contextWindow 数字框、文本+图片 select、推理勾选；无元数据的行保持默认）；非法 baseUrl 显示行内错误。改动模型配置 UI 后跑。
- **vision-bridge-test.mjs**（端口 8945）：视觉桥端到端协议测试，**本地 mock OpenAI 兼容 API 同时充当主模型与视觉模型**（真实调用零 token）：text-only 主模型 + image-capable 视觉模型（临时 agent 目录）→ 发带 imageData 的 prompt 断言「正在用视觉桥」/「转写完成」notice、mock 收到含图的视觉请求、附件卡片 mode=bridged 且含 `<vision-bridge>` 转写文本、缩略图保留、**相同图片复用缓存不发第二次视觉请求**、settings_state 带视觉桥字段与模型列表、**指定转写模型生效**（设 visionBridgeModel 后 mock 收到指定 model）、**关闭视觉桥后警告且不转写**。改动视觉桥后必跑。
- **vision-bridge-ui-test.mjs**：视觉桥设置面板 UI 测试（系统 Chrome headless）：⚙ 打开设置 → 视觉桥区块渲染、开关默认开、下拉列出自动+全部视觉模型、选中指定模型后服务器回显保持、关闭后下拉隐藏且显示关闭提示。

## 6. 发布流程（GitHub + npm）

> npm 发布者账号是 `xingshuyin`（`npm whoami` 验证）。`dist/`、`web/dist/` 被
> gitignore 不进 git，但 `package.json` 的 `files` 白名单会把它们打进 npm 包；
> `prepublishOnly` 会在发布前自动 `npm run build`。

### 步骤

```bash
# 1) 升版本（patch/minor 视改动；npm 上已存在该版本会 404 拒绝）
#    两处都要改，保持一致：
#      package.json 的 "version" 和 package-lock.json 的 "version"（第 3 行 + packages[""]）

# 2) 自检 + 构建
npm run typecheck
npm run build

# 3) 提交（Conventional Commits：feat/fix/perf/chore(scope): 描述，说明 why）
git add -A
git commit -m "feat(files): <一句话描述>"

# 4) 推送 GitHub（仓库公开：xing-shuyin/pi-web-ui，分支 main）
git push origin main

# 5) 发布 npm（会自动跑 prepublishOnly 构建）
npm publish

# 6) 验证
npm view pi-web-ui version        # 应显示新版本（registry 有缓存延迟属正常）
curl -s https://registry.npmjs.org/pi-web-ui/latest | jq .version
```

### 注意事项

- 版本号**必须**高于 npm registry 上已有的（当前 `0.2.x`）。
- 提交信息不要带 `Co-authored-by`（P1 规则，仓库 hook 会拦）。
- `.pi/commands.json` 是**每个项目各自**的个人命令（当前 cwd 的 `.pi/ 下），已被 gitignore，永远不会进公开仓库；
  切换 cwd 时命令列表自动刷新为该项目的命令。
- 大改动发布前先问用户是否要 `npm publish`（会真实消耗账号权限、触发构建）。
- **升级后自动重启**：`npm i -g` 只更新磁盘文件，已运行进程内存里还是旧代码——前端是每次
  请求实时读盘的（会先变新），但 WS 消息处理是进程内旧逻辑，新旧混跑会表现为「界面是新的、
  某功能一直加载中」。因此界面内「立即更新」成功后会自动重启（launchd KeepAlive / systemd
  Restart 退出即拉起，前台派生子进程接管；Docker 容器内需 `docker compose restart`），
  无需手动操作。
- **发布前检查示例文件不泄密**：`deploy/`、`README` 等随 npm 包（`files` 白名单含 `deploy/`）和 GitHub 分发的文件**绝不放真实 IP / 域名 / 密钥**——用占位符（如 `<LAN_IP>`、`<PUBLIC_IP>:<PUBLIC_PORT>`、`your-host`）。真实环境配置只在本地改，不进仓库。
- **历史已泄露 IP 的清理方法**（2026-08 实操过，`deploy/nginx-subpath.conf` 曾含 `192.168.1.101` / `39.99.235.208:60018`，波及 53/128 个 commit）：
  1. 先改工作区文件为占位符；
  2. `git filter-branch --force --index-filter 'if git cat-file -e :<file> 2>/dev/null; then BLOB=$(git cat-file blob :<file> | sed -e "s/<旧IP>/<占位符>/g" ... | git hash-object -w --stdin); git update-index --cacheinfo "100644,$BLOB,<file>"; fi' -- --all`（**不要用 xargs 传 cacheinfo**，Git for Windows 下参数会碎导致 `option 'cacheinfo' expects <mode>,<sha1>,<path>`）；
  3. 重写后**手动把 tag 移到重写版**（`git tag -f vX.Y.Z $(git log main --format='%h %s' | grep -F '<tag的message>' | head -1 | cut -d' ' -f1)`，filter-branch 不会自动跟）；
  4. 删备份分支 + `rm -rf .git/refs/original` + `git reflog expire --expire=now --all` + `git gc --prune=now --aggressive`；
  5. 验证 `git rev-list --all | while read c; do git grep -l '<IP>' $c -- . 2>/dev/null; done` 为空后 `git push --force` main + tag。
  **残留提醒**：已发布 npm 包的 tarball 无法追回（只能靠新版本替换）；GitHub 上被 force push 覆盖的旧对象对访问者不可见但服务器会留存（需联系 GitHub 支持彻底删）。

## 7. 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `PORT` | `8787` | HTTP 端口 |
| `PI_WEB_CWD` | `process.cwd()` | 智能体工作区（读/写/终端都以此为根） |
| `PI_WEB_DATA_DIR` | `~/.pi-web` | 每客户端持久化 UI 状态（client-state.json，最近项目/工作目录）；对话会话放 SDK 默认目录 `<agentDir>/sessions/--<cwd>--/`（与 pi CLI/TUI 共享同一对话列表） |
| `PI_WEB_INLINE_FILE_MAX` | `12288` (12KB) | inline 附件的内联阈值，超过自动降级为路径引用 |
| `PI_WEB_TOOL_TIMEOUT_MS` | `1200000` (20 分钟) | 单个工具调用最长执行时长，超时看门狗自动 abort 会话（防挂死） |
| `PI_WEB_VISION_TIMEOUT_MS` | `90000` | 视觉桥单次转写（整批图片）超时，防止慢视觉模型拖住 prompt |
| `PI_WEB_SHELL` | 自动探测 | Windows 终端面板（node-pty）的 shell：默认优先 Git Bash（与 SDK bash 工具一致），可用此变量显式指定（如 `powershell.exe` / `cmd.exe`） |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | pi 配置目录（auth.json / models.json / skills） |
| `PI_WEB_HOST` | `127.0.0.1` | 监听地址。**默认只绑 loopback**（本地个人工具，不暴露到网络）；局域网/容器访问需显式 `0.0.0.0`（docker-compose 已内置） |
| `PI_WEB_ALLOW_ORIGINS` | 空 | 逗号分隔的额外 Origin 白名单（如 `http://localhost:5173` dev 代理、反代场景），用于绕过 WS 的 Origin/Host 同权威校验 |
| `PI_WEB_ALLOW_HOSTS` | 空 | 可选严格模式：设置了才启用，请求 Host 的 hostname 必须在此白名单（逗号分隔） |

## 8. 部署（速查）

```bash
pi-web-ui --port 9000 --cwd /path          # 前台
pi-web-ui server install [--port --cwd --data-dir --name]   # 开机自启：
                                           #   macOS→launchd（无需 sudo）
                                           #   Linux→systemd（自动 sudo）
                                           #   Windows→计划任务（登录自启，隐藏窗口无黑窗）
pi-web-ui server shortcut [--port --cwd --data-dir --name]  # 桌面「一键启动」图标（启动服务并打开浏览器）：
                                           #   Windows→桌面 .lnk（WScript.Shell COM，OneDrive 安全；服务未运行则在本
                                           #     隐藏窗口前台启动并记录 PID，server stop/uninstall 可止停）
                                           #   macOS→桌面 .command 双击启动器（已装 launchd 则 kickstart，否则终端前台）
                                           #   Linux→桌面 .desktop 图标 + ~/.local/share/pi-web-ui 启动脚本（systemctl 优先）
pi-web-ui server status|restart|stop|uninstall
# Docker：docker-compose.yml（端口映射 + 挂载数据目录）
```
> uninstall 会自动移除桌面图标；未装服务时桌面快捷方式启动的实例在 status/stop 中单独报告（PS1 前台+记录 PID）。

## 9. 常见坑

- **改了 `protocol.ts` / `types.ts` 后两端不同步** → 前端收到未知消息类型被 switch 静默丢弃，表现为"没反应"。先跑 `npm run typecheck`。
- **快照 60ms 节流**：调试时 `get_state` 可立即推一次（`cs.flushSnapshot()`）。
- **`hello` 前/会话未就绪时的命令**：`server/index.ts` 的 `pending` 队列会缓存并在 attach 后重放。
- **socket 半开**：服务端 10s 心跳，客户端 30s 无消息主动断开重连（指数退避 1s→10s）。
- **预览与附件行号**：`countLines` 不算尾随换行；前端 `split("\n")` 后也要 pop 掉末尾空串。
- **终端 shell（Windows）**：`terminals.ts` 的 `resolveShell()` 每次创建终端时解析，优先 bash——
  `PI_WEB_SHELL` 显式 → `$SHELL` → Git Bash（ProgramFiles）→ busybox 兜底
  （`~/.pi-web/bin/bash.exe`，`ensure-bash.ts` 无 Git Bash 时自动下载 busybox-w32）→ `$COMSPEC` → powershell。
  与 SDK bash 工具（Git Bash / PATH 上的 bash）保持一致，避免 PowerShell/bash 混用挂死。
- **Windows 老中文文件乱码**：预览/内联附件/行附件统一走 `decodeText`（严格 UTF-8 失败 → GBK → latin1）；
  win32 下 `makeRuntimeFactory` 经 `resourceLoaderOptions.systemPromptOverride` 注入 `WINDOWS_PERSONA`，约束模型：
  bash 工具必须带 timeout（SDK 无默认超时）、禁 heredoc/交互/前台长驻命令（防整夜挂死）；GBK 文件用终端按正确编码读
  （iconv / chcp / Get-Content -Encoding Default），绝不把乱码贴进推理/回答。
- **工具挂死看门狗**：每个 `tool_execution_start` 都会为 toolCallId arm 一个 `TOOL_WATCHDOG_TIMEOUT_MS`（默认 20 分钟，
  环境变量 `PI_WEB_TOOL_TIMEOUT_MS`（毫秒）覆盖）的 timer——超时仍在跑就 `session.abort()`（杀进程树）+ warning notice，
  `tool_execution_end` / `removeConversation` / `dispose` 都会清掉对应 timer。
	恢复重建 + 重绑会话（同一 conv 记录，UI 不掉线）；看门狗超时也走同一 `interruptRun`。
	**只停止运行，不碰后台服务**：abort 不再连带杀 AI 启动的服务——那些由「后台任务」面板单独管理。
- **后台任务列表（顶栏「后台任务」按钮，替代原「中断」按钮）**：bash 工具执行前后各拍一次监听快照
  （`snapshotListeningPorts`，Windows netstat / POSIX lsof），diff 出的新增 LISTENING 进程记入 `bgServers`
  （端口→pid→since→name，name 经 `lookupProcessName` tasklist/ps 尽力获取），启动后 notice 提示
  「可在顶栏「后台任务」里单独停止或全部关闭」；**列表按客户端持久**（ClientSession 字段，非对话级）——
  对话结束/切换/断线重连都不消失（attachSink 重推 `bg_servers`），只有任务被停或进程自行退出才移除
  （30s 定时器 `refreshBgServers` 重新对端口快照，port+pid 都匹配才算还活着，静默剔除死项）。
  协议：`bg_servers`（ServerMessage，推送全量列表）/ `kill_background_server`（按端口停单个）/
  `kill_background_servers`（全部关闭，`killAllBackgroundServers` 对每个 pid `killPidTree`，Windows
  `taskkill /F /T`）/ `list_bg_servers`（面板打开时请求刷新）；前端 `BgTasksModal`（每个任务行
  「停止」+ 底部「全部关闭」「刷新」，空列表有占位文案）。
- **只停止 bash 命令（对话继续）**：bash 工具卡片运行中显示「停止」→ 发 `{ type: "abort_bash" }` →
  `ClientSession.abortBash()`。服务端用 **killable bash 工具**（`makeKillableBashTool`，经 `customTools` 按 name 覆盖
  SDK 内置 bash）：执行时把自己的 AbortController 注册进客户端级 `bashKills` 集合，abort 只杀这些 controller
  → bash 子进程进程树被杀（工具抛 "Command aborted"，被 agent-loop 捕获成工具错误结果）→ **agent run 与对话继续**；
  与 SDK `session.abortBash()`（只对扩展 `executeBash` 路径有效，agent 工具路径无效）不同，这里对对话中的
  bash 工具调用真实生效（已用 SDK 直连验证：sleep 30 在 1.5s 内被杀、registry 清理）。
  命令被中止时 SDK 会把**终止前已输出的内容拼接进工具错误结果**（AI 能看到输出 + "Command aborted"）；
  随后 `abortBash()` 再 `sendUserMessage` 注入「用户手动停止」提示，让 AI 明确知道是用户手动而非失败。
- **Playwright 脚本**：headless shell 路径写死在本机，CI/换机需要改 `HEADLESS` 常量。

---
*结构/流程变更时同步更新本文件（含新增组件、协议消息、发布步骤）。*
