# 核心架构

> 改代码前必读。本文档覆盖快照驱动、协议单源、安全边界、主题切换、多对话并发等全局架构决策。

## 快照驱动

- **服务端是唯一事实源**：每次 SDK 事件后节流 60ms 推快照（`UiState`），浏览器只按快照渲染。重连只需重发 `get_state`。
- **增量快照（协议 v2）**：持久化消息内容不可变 + 对象引用稳定，`emitSnapshotNow` 用 O(n) 指针等同性遍历检测追加式增长——能追加则发 `snapshot_delta`（轻字段 + `appended` 尾部，baseRev 链），中途变更/截断/切会话/强制 resync 回落全量 `snapshot`。前端 reducer 按 rev 链合并，缺口触发防抖 `get_state`；背压下 delta 与 snapshot 同样可丢弃，丢包靠 rev 链断裂自愈。`get_state` 恒返全量。回归：`snapshot-delta-test`。**测试适配**：等「动作后快照」的测试必须同时接受 snapshot_delta（参照 conv-cwd/vision-bridge 的 rev 链合并写法）；连接后的首个快照恒为全量。
- **WS permessage-deflate**：WebSocketServer 开启压缩（threshold 16KB），大会话多 MB snapshot 线上传输降数倍；小消息（notice/心跳）不压省 CPU。
- **多标签页序列化共享**：emit 把同一消息对象发给客户端的所有 socket，index.ts 用 WeakMap 按对象身份缓存 stringify 结果——N 个标签页共享一次序列化，新 snapshot 即新对象自动失效。
- 序列化时**对象引用稳定**：`uiMessageCache` + 消息数组签名比对，消息没变就不重建数组，前端 `React.memo` 因此能跳过整条消息——**不要**破坏这个缓存（stable id、引用复用）。
- `UiState` 携带 `thinkingLevel`（当前生效）和 `availableThinkingLevels`（当前模型实际支持的级别，SDK 会把集合外的请求静默就近钳制——UI 只能启用这些，否则用户点"低/中"看起来"改不了"）。

### `message_delta` 实时增量通道

`message_update` 事件 → 只对**活动对话**推 `message_delta`（`conversationId` + 每对话单调 `seq` + `messageId = stream-<ts>`（与 `serializeStreamingMessage` 的稳定 id 一致）+ 实时 usage + 剥离 `partial` 后的 thinking/text delta）。它**不经 snapshot 通道**——`send()` 背压只丢 snapshot，增量永远可达，大会话不再因背压停更。前端 `applyMessageDelta`（`web/src/message-delta.ts` 纯函数、不可变——StrictMode 双调 reducer 会把原地 mutation 加倍）patch `streamingMessage` + `stats.tokens`；seq 缺口触发防抖 `get_state` 重同步；snapshot 权威收敛。

同时：delta 活跃期（1.5s 内有增量）snapshot 降为**事件驱动检查点**——agent_end / tool_execution_end 立即 flush，其余事件走 2s 兜底定时器（增量负责流畅度、快照只做边界校准）。单测：`tests/unit/message-delta.test.ts`。

### `tool_delta` 同协议

也带 `conversationId` + `seq`，与 message_delta 共享同一每对话单调序列（`conv.deltaSeq`）；前端按对话 Map 追踪 seq，仅活动对话缺口触发重同步（后台对话切回时 snapshot 收敛）。

### 协议版本协商

`hello` 可带 `protocolVersion`，`ready` 回带服务端版本；前端比对不一致时显示持久刷新横幅（应用原地更新后「界面新的/WS 旧的」混跑防护）。常量在 server/ 与 web/ 各一份 protocol-version.ts，`check:protocol` 校验两份一致——改协议时必须同步 bump。

## 协议单源（types.ts 是 re-export shim，不再手工同步）

`server/protocol.ts` 是唯一事实源；`web/src/types.ts` 用 `export type * from "../../server/protocol"` 全量再导出（纯类型，构建时擦除），前端本地类型（FileContent/FileListing/ToolStatus）附在 shim 下方。

新增/修改任何消息：只改 `protocol.ts`，然后在 `server/index.ts` 的 `dispatch` switch 和 `web/src/use-chat.ts` 的 `onmessage` switch 各加一个分支。注意 protocol.ts 必须保持**纯类型导出**（不能加 const/function 等运行时代码，否则破坏 type-only 前提）；`npm run check:protocol` 守护这两个不变量。

## 安全边界

- **默认只绑 loopback**（`PI_WEB_HOST`，默认 `127.0.0.1`）：本地个人工具不暴露到网络；局域网/容器需显式 `PI_WEB_HOST=0.0.0.0`（docker-compose.yml 已内置，Docker 端口映射才能工作）。
- **WS 升级做 Origin/Host 同权威校验**（`server/index.ts` 的 `originAllowed`，`WebSocketServer({ noServer: true })` + 手动 `handleUpgrade`）：Origin 存在时其 hostname+**有效端口**必须与请求 Host 一致（浏览器里 `example-host:8445` 与 `example-host:9443` 是不同源）；非浏览器客户端（无 Origin）放行；`PI_WEB_ALLOW_ORIGINS` 白名单绕过（dev:server 已内置 `http://localhost:5173,http://127.0.0.1:5173`，反代场景自配）；`PI_WEB_ALLOW_HOSTS` 可选严格 hostname 白名单。**不要**加回「本地任意端口放行」——那正是提案要修的洞。
- **quiesce 准入控制**（`AgentService.quiesce/unquiesce`）：进入排空后**拒绝一切新工作**——新 prompt（native slash 命令例外，纯配置无 token）、new_chat、edit_message fork、switch_session、goal wizard；存量运行继续跑完。已知 clientId 仍可 attach 看存量（发 notice 提示），**全新客户端 attach 抛 `QuiesceRejectedError` → index.ts 以 4403 关 WS**，浏览器重连循环在 unquiesce 后自动恢复。
- **控制 socket**（`server/control-socket.ts`）：CLI 的 `server status|quiesce|unquiesce` 经本地 mode-0600 unix socket / Windows 命名管道（`\\.\pipe\pi-web-ui-<port>`）与运行中进程通信，`status` 报告真实 socket 数（`noteSocketOpen/Close`，index.ts 维护）、active/pending 计数、quiesce 状态；无鉴权 HTTP 端点。
- **provider headers 不下发浏览器**（`models_config` 不再携带 `headers` 字段，可能含 Authorization/API key）：`saveModelConfig` 保存时若 config 无 headers 则保留旧值（`prevHeaders`）。`UiProviderConfig.headers` 已从 protocol.ts / types.ts 删除，前端没有任何地方编辑 headers（仅 apiKey 经独立消息 `set_provider_api_key` 走浏览器）。
- **dev 兼容**：vite :5173 代理 /ws 到 :8788 时 Origin(:5173) ≠ Host(:8788)，靠 `PI_WEB_ALLOW_ORIGINS`（dev:server 内置）放行，勿删。

## 主题切换

- **机制**：每主题 = `web/src/styles.css` 的**完整独立副本**（不同配色），非 CSS 变量覆盖。默认深色主题仍由打包的 `styles.css` 提供；选其他主题时前端注入 `<link id="theme-stylesheet" href="/themes/<id>.css">` 整文件覆盖，选回默认则移除该 link（`web/src/theme.ts` 的 `applyTheme`，localStorage 键 `pi-web-ui:theme`，`main.tsx` 首帧前应用防闪烁）。
- **服务端**：`GET /api/themes` 列主题（`server/themes.ts` 的 `listThemes`），`GET /themes/:id.css` 发文件（`resolveThemeFile`，用户目录优先）。id 必须匹配 `ID_RE`（`^[A-Za-z0-9_-]+$`）防路径穿越。两个路由在 `server/index.ts` 注册于 SPA catch-all 之前（否则被吞返回 index.html）。dev 模式 Vite 需在 `web/vite.config.ts` 代理 `/themes`（已加）。
- **主题来源**：内置 `<pkgRoot>/themes/*.css`（随 npm 包分发，`package.json` files 白名单含 `themes/`）；用户自定义直接往 `<dataDir>/themes/` 丢 CSS 文件即可（id 冲突时用户覆盖内置）。`pkgRoot` 经 `resolvePkgRoot()` 向上找含 package.json 的祖先解析，dev(server/) 与 prod(dist/server/) 均正确。
- **浅色主题**：`themes/light.css`（柔和紫）与 `themes/white.css`（显示名「白色」：纯白底 + GitHub 蓝强调）均由根目录脚本 `make-light-theme.mjs` 从 `styles.css` 生成（`:root` 浅色系 + 硬编码暗色映射 + `.hljs` 语法高亮浅色覆盖 + `--term-*` 终端亮色变量；white 主题额外把紫色系链接映射为蓝色）。**暗色紫晕**：`themes/md-preview.css`（显示名「紫晕」）= 原始暗色直通 + body 加 `.fp-markdown` 同款紫色径向渐变，并把 `.topbar/.panel/.statusbar` 背景**全透明**。styles.css 改动后重跑 `node make-light-theme.mjs`。
- **主题显示名**：css 首行 `/* theme-name: 中文名 */` 即为下拉里的显示名（`listThemes` 读文件头 300 字节解析），缺省回退文件 id——文件名必须是 ASCII（id 校验 `ID_RE`），中文靠这个标记。
- **终端跟随主题**：xterm 画布经 `web/src/theme.ts` 的 `buildTermTheme()` 读 `--term-*` 变量，主题切换时 `TermXterm.tsx` 监听 `pi-web-ui:theme-change` 事件用 `term.options.theme` 热更新画布；CSS 容器 `.term-main` / `.term-xterm .xterm-viewport` 用 `var(--term-bg)`，与画布自动融合。styles.css 改动后重跑 `node make-light-theme.mjs` 重新生成。
- **回归**：`theme-test.mjs`（端口 8937，隔离 data-dir）：列表/内置/用户主题、注入 link、浅色生效、刷新持久、用户主题可应用、回默认移除 link。

## 多对话并发

- 每客户端 `convs: Map<convId, Conversation>`，**每个对话一个独立 `AgentSessionRuntime`**：`new_chat` 新建 runtime + 新 session 文件（旧对话继续在后台跑，不中断）；`switch_conversation` 只换 `activeId`（不碰其他 runtime）；`runtime`/`session` 访问器指向当前活动对话。**对话按项目归属**：`conv.cwd` 即所属项目，每个项目各自的活动对话互不干扰。
- **`set_cwd` 不再重建当前对话**——改为切到目标项目自己的对话（该项目最近活动的那个；没有则新建一个并恢复该项目最近的持久会话）。
- **「运行的对话」列表生命周期**（每个对话 `listed` / `promptedSinceActive` / `lastActiveAt` 三字段）：
  - 入列：活动对话**正在流式输出时**被挤到后台（new_chat / switch_conversation / set_cwd）→ `listed=true`；
  - 留在列表：后台跑完不移出（用户可能还没看结果）；
  - 移出：打开它（切为活动）→ 没有继续对话（期间没发过 prompt）→ 切走时 `displaceActive()` 返回它，`removeConversation` 释放 runtime（会话已持久化，历史列表仍可恢复）。
- 上限 `MAX_OPEN_CONVERSATIONS = 8` **按项目计**，超出时 new_chat 发 warning notice。
- 所有对话共享**一个 ModelRuntime**（首个对话创建时播种，`makeRuntimeFactory` 传入复用）——顶栏换模型对全部对话生效。**消息序列化缓存（msgIds/uiMessageCache/签名）按对话隔离**：两个对话可能产生相同的 (role, timestamp) 键，共享会串号。
- `snapshot` 带 `conversationId`；`conversations`（ServerMessage）只推**当前项目已入列**的对话 + `activeId`（activeId 可能未入列，如刚 new_chat 还没跑过）；`switch_conversation`（ClientMessage）只在同项目内切换。
- `switch_session`（恢复持久会话）会为目标会话创建独立 runtime，再按上述生命周期把当前对话移到后台；若目标会话已在运行列表中则直接复用其 conversation，绝不因打开历史记录中断当前生成。回归测试：`tests/switch-session-background-test.mjs`。`edit_message` 在**当前**对话内 fork；`dispose` 遍历销毁全部对话；attachSink 重连时补推 conversations。
- 前端：左栏「运行的对话」区（≥1 个时显示，活跃高亮、流式绿点），MessageList 以 conversationId 为 key 强制切换重挂载。

## 其他桥接

### 工具结束实时状态（`tool_status`）

服务端 `onEvent` 监听 `tool_execution_start/end`（AI 调工具路径，注意区别于 `bash_execution_update`——那是 `!cmd`/终端直接执行路径专属）。`tool_execution_end` 触发时立即推 `tool_status`（toolCallId/toolName/isError/exitCode/durationMs），**先于** toolResult 快照落盘——浏览器 tool 卡片随即从「执行中」切到「已结束 · 等模型 · 耗时」，一眼区分「命令还在跑」vs「命令完了在等模型响应」。bash 工具的 details 不带 exitCode（成功时返回 truncation 信息，失败时错误文本含 `Command exited with code N`），服务端从错误文本正则提取；`tool_execution_start` 时刻记在 `conv.toolStartTimes`（按对话隔离）算真实执行耗时。前端 `toolStatuses` Map 在 toolResult 落盘（snapshot prune）后清除，回落到权威的 toolResult 状态。

### 工具挂死看门狗

每个 `tool_execution_start` 都会为 toolCallId arm 一个 `TOOL_WATCHDOG_TIMEOUT_MS`（默认 20 分钟，环境变量 `PI_WEB_TOOL_TIMEOUT_MS`（毫秒）覆盖）的 timer——超时仍在跑就 `session.abort()`（杀进程树）+ warning notice，`tool_execution_end` / `removeConversation` / `dispose` 都会清掉对应 timer。恢复重建 + 重绑会话（同一 conv 记录，UI 不掉线）；看门狗超时也走同一 `interruptRun`。**只停止运行，不碰后台服务**——那些由「后台任务」面板单独管理。

### 后台任务列表

bash 工具执行前后各拍一次监听快照（`snapshotListeningPorts`，Windows netstat / POSIX lsof），diff 出的新增 LISTENING 进程记入 `bgServers`（端口→pid→since→name，name 经 `lookupProcessName` tasklist/ps 尽力获取），启动后 notice 提示「可在顶栏「后台任务」里单独停止或全部关闭」；**列表按客户端持久**（ClientSession 字段，非对话级）——对话结束/切换/断线重连都不消失（attachSink 重推 `bg_servers`），只有任务被停或进程自行退出才移除（30s 定时器 `refreshBgServers` 重新对端口快照，port+pid 都匹配才算还活着，静默剔除死项）。

协议：`bg_servers`（ServerMessage，推送全量列表）/ `kill_background_server`（按端口停单个）/ `kill_background_servers`（全部关闭，`killAllBackgroundServers` 对每个 pid `killPidTree`，Windows `taskkill /F /T`）/ `list_bg_servers`（面板打开时请求刷新）；前端 `BgTasksModal`（每个任务行「停止」+ 底部「全部关闭」「刷新」，空列表有占位文案）。

### 只停止 bash 命令（对话继续）

bash 工具卡片运行中显示「停止」→ 发 `{ type: "abort_bash" }` → `ClientSession.abortBash()`。服务端用 **killable bash 工具**（`makeKillableBashTool`，经 `customTools` 按 name 覆盖 SDK 内置 bash）：执行时把自己的 AbortController 注册进客户端级 `bashKills` 集合，abort 只杀这些 controller → bash 子进程进程树被杀（工具抛 "Command aborted"，被 agent-loop 捕获成工具错误结果）→ **agent run 与对话继续**；与 SDK `session.abortBash()`（只对扩展 `executeBash` 路径有效，agent 工具路径无效）不同，这里对对话中的 bash 工具调用真实生效。

命令被中止时 SDK 会把**终止前已输出的内容拼接进工具错误结果**（AI 能看到输出 + "Command aborted"）；随后 `abortBash()` 再 `sendUserMessage` 注入「用户手动停止」提示，让 AI 明确知道是用户手动而非失败。

### 扩展 UI 桥

扩展的 `setWidget/setStatus/notify/select/confirm/input` → `widgets/statuses/notice/dialog` 消息；对话框经 `dialog_response` 回传，Esc 视为取消。

`snapshot` 里 `streamingMessage` 是进行中的消息（60ms 粒度流式），`messages` 是已落盘的。
