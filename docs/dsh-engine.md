# pi-web-ui × DeepSeek Harness（dsh）双引擎改造 —— 工作交接文档

> 本文档是**跨对话交接**用：记录已定决策、已完成工作、进行中/受阻状态、剩余计划与所有环境事实。
> 新对话开始时：**先读本文件**，再读 `E:/pi-web-ui/server/dsh/` 下的代码与注释，按"下一步做什么"继续。
> 当前时间：2026-09-01 凌晨（对话推进到 dsh 引擎核心对话全链路验证通过）。

---

## 0. 目标（用户拍板的三项决策）

1. **引擎可切换**：`PI_WEB_ENGINE=pi|dsh` 环境变量启动时切换（默认 pi），重启生效；前端显示引擎徽标；`/api/health` 返回 `engine` 字段。
2. **界面功能完全一样**：dsh 引擎要按现行 pi-web-ui wire 协议（protocol.ts）全量对齐 —— 目标/审查、SCM、后台任务、设置面板、模型配置、插件、终端、消息增量（message_delta/快照/snapshot_delta/tool_status）全都工作。
3. **架构 = 服务端引擎分发**：保留现有 pi 路径零改动；新增 `server/dsh/`（从 ds-web-ui 移植适配 + 升级到现行协议）；`server/index.ts` 按引擎选择实现类。同一 wire 协议，前端改动极小。

---

## 1. 环境事实（实测，勿重查）

| 项 | 值 |
|---|---|
| 工作区 | `E:/pi-web-ui`（pi-web-ui 仓库，当前项目） |
| 参考实现 | `E:/ds-web-ui`（xing-shuyin 的 DSH 版 pi-web-ui 移植，**仅参考**，用的是旧版分散包 `0.1.0-rc.6`） |
| Node | v24.20.0（fnm 管理） |
| DeepSeek key | `~/.pi/agent/auth.json` 的 `deepseek.key`（**2026-09-01 用户重新提供 sk-f0e6…d99，len 35**），**dsh 运行时能复用**（ds-web-ui 就这么干）。⚠️ clear-provider-key-test 会清掉它 —— 跑前备份，跑后恢复（dsh 已尊重 PI_CODING_AGENT_DIR，正常测试不会再碰真实 auth.json） |
| 全局 dsh 运行时 | `npm i -g @deepseek-ai/dsh@0.1.1-rc.2` **已装**。物理位置：`C:\Users\c\AppData\Roaming\fnm\node-versions\v24.20.0\installation\node_modules\@deepseek-ai\dsh`，其**嵌套树** `dsh/node_modules/@deepseek-ai/`（196 个包）即完整运行时树（dsh-base/dsh-app-boot/全部工具/loader peers 都在）。⚠️ **dsh-base 不在顶层 `npm root -g/@deepseek-ai/`（只有 dsh 一个包），运行时树解析必须查嵌套位置**（runtime-root.mjs 已处理） |
| pi-web-ui 本地 dsh 依赖 | 用户已执行 `npm i … @deepseek-ai/dsh-sdk-jsonrpc-server@0.1.1-rc.2 @deepseek-ai/dsh-sdk-protocol@0.1.1-rc.2`，`E:/pi-web-ui/node_modules/@deepseek-ai/` 现有 **26 个包**（jsonrpc-server + protocol + 全部 peer：dsh-agent/dsh-llm/dsh-llm-deepseek/dsh-scope/dsh-session/dsh-subagent/dsh-invariants/dsh-timeout/dsh-tools/dsh-atomic-write/cordis/cosmokit/schemastery 等） |
| **版本族** | 与 dsh 对齐的最新同族：`dsh@0.1.1-rc.2`、`dsh-sdk-jsonrpc-server@0.1.1-rc.2`、`dsh-sdk-protocol@0.1.1-rc.2`（注册表 dist-tag 是旧版，npm view 时别信 tag，按版本号） |

---

## 2. DSH 研究结论（关键，决定实现策略）

### 2.1 JSON-RPC 协议面（官方最新 0.1.1-rc.2，仍是精简面）
- **RPC 方法仅 3 个**：`initialize`（cwd/provider/model/maxTokens）、`session/prompt`（sessionId + contentBlocks → 返回 `{messageId}`，**按需隐式建会话**）、`shutdown`。
- **通知**：`session.event`（sessionId + event，全量持久事件）、`session.status`（running/idle）、`subagent.started` / `subagent.finished`。
- **官方明确限制**：无 per-session close、无 prompt 取消、无 per-prompt 结果 → **中止 = 强杀运行时进程**，**换模型 = 重启运行时**，**会话管理/列表/回放 = 直读 JSONL**。
- 每进程一个 provider/model；`initialize` 无 provider adapter 时自动挂 dsh-llm-deepseek fallback。

### 2.2 运行时组合（已实证可 boot）
- 用 `@deepseek-ai/dsh-app-boot` 的 `boot(binName, configPath, patches, prepare, bareModuleBaseUrl)`：config = 空 `[]`，patches = [dsh-base bundle patch, override patch]。
- **dsh-base bundle** = 官方所有 profile 的共享底座（78 行：llm/session/agent/agent-loop/settings-file/credentials-local/jsonl 持久化/全部工具/goal/plan-mode/skill/subagent/workflow/search/审批）。
- **bareModuleBaseUrl**（裸包名解析的唯一 base）→ 运行时树；**混树挂项目依赖的 jsonrpc 插件必须走绝对路径**。
- patch 语法铁律：**重复 base 的 id 用 `- id: … name: … config: …` 定向替换（last-write-wins）；新行用 `- insert: [...]`**。
- ⚠️ **patch 列表必须是扁平结构**：boot 的 patches 参数是"patch entry 列表"（`[{insert:...}, {id:...,...}]`），传嵌套数组会被 applyEntryPatches 当无 id 的 entry 静默跳过（本次踩过的坑，见 §6.10）。
- ⚠️ **loader 只对 entry 的 config 做 !!js 插值，name 字段不支持 !!js**（disabled 支持）→ jsonrpc 插件绝对路径由 launcher 用 JS 写回 patch entry 的 name（§6.9）。
- ⚠️ **permission-presets 整行 config 全量替换**：approval=never + workspace-write 组合必须显式补一个 preset（workspace-write-never）并设 defaultPreset，否则报 "composed sandbox and approval defaults match no preset"。
- 无头运行注意：base 的 approval 策略 `ask` 会卡死工具调用 → override 改 `policy: 'never'`（web UI 的 Stop 按钮是用户控制手段）。
- `installFailLoud(BIN_NAME, process, release)` 第二个参数是 process 对象不是 pid。
- loader 的 AggregateError 明细在 `err.aggregateErrors ?? err.errors`（逐层 cause 递归打印才看得到）。

### 2.3 事件面 ground truth（实测 dump，序列化依据）
`session.event` 通知 params = `{ sessionId, event: { type, seq, time, data } }`：
- **user/message** data: `{ content[], source: {kind}, role, id }`。⚠️ 系统注入消息的 source.kind = `agent-instructions` / `plugin`（workspace 指令/运行时上下文快照）——必须过滤，否则 UI 显示垃圾气泡。
- **assistant/message** data: `{ turn, step, message: { role, content[], id, time } }`（完整消息；content 里 reasoning/text/tool-call 块）。
- **tool/result** data: `{ turn, step, message: { role:"user", content:[{type:"tool-result", toolCallId, content[], isError}] } }`。
- **assistant/chunk** data.chunk: `block-start {index, blockType: reasoning|text|tool-call}`、`reasoning-delta {index, text}`、`text-delta {index, text}`、`tool-call-delta {index, id, name, argumentsDelta}`、`block-end {index, block}`、`usage {usage:{inputTokens,outputTokens,cacheReadTokens}}`、`finish {reason}`。
- **turn/end** data.reason：`{kind: "completed"|"max-tokens"|"error", error?: {message, code}}`。⚠️ 恢复会话时 kind="error" + message 含 "id collision"（见 §2.4）。
- **session/title** data: `{title}`。
- **agent/inbox/spliced** data: `{target, start, inserted: [messages], removedCount}`（prompt 注入；可据此清理 followUp 队列）。

### 2.4 ⚠️ 关键限制：DSH 无法恢复已持久化会话（id collision）
- **同进程内多轮对话**：正常（live session 复用，turn completed）。
- **跨进程恢复**（磁盘 JSONL 存在但 live 无该 session）：prompt 返回 messageId，但 turn/end 报 `kind:"error"` + `"session X already has a persisted log on disk that does not match this live session (id collision)"`，模型不产出任何内容（空 turn）。
- **对策（已实现）**：switch_session 只读回放（fromDisk 标记）；prompt 到 fromDisk 会话自动 fork 新会话（历史作为上下文注入）；**turn/end 检测 id collision 自动 forkAndReprompt**（覆盖 abort 重启运行时后原会话不可续聊的场景）。abort = kill 运行时 → 重启 → 原会话全变"磁盘有日志无 live" → 下次 prompt 走 fork。
- ds-web-ui 同样撞上此限制（"Resuming a persisted session is not supported... disk log → id collision"），其对策也是新建会话继续。

### 2.5 扩展性结论（答复用户"还有 npx dsh web 的扩展性吗"）
- **agent 侧扩展性全保留**：运行时就是同一棵官方 Cordis 插件树（MCP client、subagent、goal、plan、skill、workflow、搜索全在）。
- **dsh web 的 UI 生态** 与 pi-web-ui 前端是两套界面，不互斥。
- **用户插件扩展缝（已实现，见 §4.2）**：launcher 加载 `<dataDir>/dsh-patches/*.yml` 用户 patch 层。
- pi-web-ui 自己的"插件 AI 工具"（registerAgentTool）无注入点，v1 声明不支持，二期做"工具桥" Cordis 插件。

### 2.6 ⭐ DSH 原生 goal 机制（用户拍板：goal 直接适配 DSH，不自造审查会话）
运行时树自带完整 goal 栈（base bundle 默认启用）：`dsh-goal`（状态域）+ `dsh-goal-round-driver`（轮次驱动）+ `dsh-tool-goal`（模型工具）+ `dsh-command-goal`（/goal 命令）。
- **状态域 dsh-goal**：事件源化 same-session 目标状态，`ctx.goals` 服务动词 get/create/edit/pause/resume/complete/block/clear；每次 mutation 追加 durable `goal/change` 事件（全量快照）。生命周期：active → complete | blocked | paused；激活（armed）**不持久化**，进程重启/会话 resume/fork 后 disarm，需 resume 重 arm。
- **轮次驱动 dsh-goal-round-driver**：agent idle + active armed goal + 剩余轮次 → 自动排队一条 `<goal_round>` user 消息（source.kind=goal，带 round 号）→ 模型继续干活 → 直到模型调 update_goal complete/blocked 或轮次用尽。**不需要我们驱动**。
- **模型工具 dsh-tool-goal**：get_goal/create_goal/update_goal（edit/pause/resume/complete/blocked）；goal policy 要求证据充分才 complete；blocked 需同一条件连续 3 轮（blockedAfterConsecutiveRounds: 3）。
- **⚠️ 无独立审查者（官方明确）**："evaluator-backed certification is deferred"——完成/受阻由模型自判定，不是独立审查会话。与 pi 引擎审查哲学不同，这是 DSH 的设计意图（goal 轮次 = 自动迭代，非审查-修改循环）。
- **触发方式（关键）**：JSON-RPC 面只有 initialize/session/prompt/shutdown，`/goal` 命令走 ctx.commands（prompt 直进 inbox 拦截不到）；唯一可靠触发 = **自写 wrapper 插件给 jsonrpc 加 goal RPC**（见下）。
- **goal/change 事件**：经官方 jsonrpc 的 `ctx.on("session/event")` 全量转发自然到达（含 operation/goal{phase,roundsStarted,maxGoalRounds,blockedReason}/roundsStarted）。
- **轮次消息过滤**：`<goal_round>` 是 source.kind=goal 的 user/message，必须过滤不进 UI（同时用它更新轮数显示，round 在 source.round）。
- **view 是扁平结构**：`{id,revision,objective,phase,maxGoalRounds,roundsStarted,blockedReason?,activation}`，无 goal 嵌套字段；无目标时 get 返回 undefined。
- **wrapper 插件实现**（server/dsh/runtime/goal-rpc.mjs）：import 官方 `HarnessSdkJsonRpcServer`（官方包 export 它）子类化 + handleRequest 加 goal/set|get|clear|resume|edit 分支，inject 加 "goals"，shutdown/transport 语义照抄官方 apply。launcher patch 的 sdk-jsonrpc name 指向 wrapper（官方入口经 env PI_WEB_DSH_JSONRPC_ENTRY 传进去）。
- **UI 映射**：phase active→reviewing=true/"目标进行中（第 N 轮）…"；complete→verdict=pass/"✅ 目标已达成"；blocked→verdict=fail+feedback=blockedReason；clear→清空。goal 状态 per-conversation（DshConversation.goal + dsGoal），随会话切换推 goal_status。

### 2.7 ⭐ 二期：视觉桥 + 用户提问桥 + 交互式调研向导（均实证通过）
**视觉桥**（真图片，替代 v1 文本占位）：
- DSH 附件机制：`dsh-attachment`（ctx.attachments 服务，base 已挂 attachment-local 存储后端）+ `ImageAttachmentRef`（durable，含 sha256 哈希）+ `EncodedImageAttachment`（base64 wire 格式）。image 块 = `{type:'image', attachment: ref}`。
- **仅 `deepseek-v4-flash-vision-exp` 模型支持图片**（adapter 默认目录 inputModalities: [text,image]）；flash/pro 是 text-only 路由 → 图片被省略（模型会说"只接受文本"）。DSH_MODELS 现在带 per-model vision 标记，前端据此启用/禁用图片粘贴。
- RPC：`attachment/save`（base64 → ref，调 ctx.attachments.saveImage，字节/媒体类型校验）+ `attachment/read`（ref → base64，回放补图）。模型请求侧由 dsh-llm-deepseek adapter 自动把 ref 转 file-id/inline parts。
- 接入：buildContentBlocks 的 imageData/工作区图片文件 → save → image 块；乐观消息带 dataUrl 图块；user/message 事件回放时 hydrateImageBlocks 异步读回补 dataUrl。
- 实测：vision-exp 模型准确描述项目截图（"pi-web-ui 设置面板"+ 读出 UI 文字）。

**用户提问桥**（= pi 引擎 WebUIContext 等价物）：
- DSH 机制：`dsh-user-questions`（ctx.userQuestions.ask() 阻塞等答案，registerProvider 注册 UI 侧）+ `dsh-tool-ask-user`（ask_user_question 工具，**base bundle 未挂，需 override.patch.yml 手动 insert**）。
- 桥实现（goal-rpc.mjs）：apply 里 `ctx.userQuestions.registerProvider({ ask })` → 发 `question.pending` 通知 → 等 `question/answer` RPC（带 answers/cancelled）→ 恢复工具结果。单客户端隔离（每客户端一 runtime）。取消 → reject → 工具报错 → 模型继续。
- 协议：客户端 `question_answer`；服务端 `question_pending`（questions 含 options{label,description}/multiSelect）。
- 前端：DshQuestionDialog.tsx（每题单选/多选 + 自由文本补充 + 提交/取消，复用 .dialog-inline 样式）。
- 实测：模型 ask_user_question → 浏览器收到"喜欢什么颜色 红/蓝/绿" → 答"蓝+偏深蓝" → 模型回应"你选择的是蓝（偏深蓝）"。

**交互式调研向导**（startGoalWizard 重写，替代一键设置）：
- 主会话 prompt 向导指令（wizardPrompt：用 ask_user_question 逐题提问收敛，最后只输出 GOAL: 行，禁止直接 create_goal）；conv.turnWaiter 等本轮 turn/end（提问-回答-收敛在同一轮）；解析 GOAL: 行 → setGoal。clearGoal 中断在跑的向导。
- 实测：模型连问 4 轮（交付形式/存储/功能范围/技术约束，带选项）→ 收敛 "GOAL: 在 pi-web-ui 项目新增独立待办网页应用（React+Vite，中文，localStorage 持久化）…" → 自动设目标 → round-driver 自动进第 1 轮。

---

## 3. 已完成的工作

### 3.1 server/dsh/ 交付物（全部文件）
```
E:/pi-web-ui/server/dsh/
├── runtime/
│   ├── launcher.mjs          # DSH 运行时子进程 launcher（boot 组合 + 事件管道 + 用户 patch 层）
│   ├── goal-rpc.mjs          # ⭐ jsonrpc wrapper 插件：goal/* + attachment/* + question/* RPC（直连 ctx.goals/attachments/userQuestions）
│   ├── runtime-root.mjs      # 运行时树解析共享模块（flat + dsh 嵌套布局）
│   ├── cordis.yml            # 空根 []（两层 patch 全在 boot patches 参数里）
│   └── override.patch.yml    # 会话根/默认模型/人设/沙箱/approval=never/permission preset/jsonrpc
├── dsh-client.ts             # DshRuntime（TS）：spawn launcher + JSON-RPC + goal RPC + kill/restart
├── dsh-serialize.ts          # 事件 → UiMessage + DshStreamAccumulator（chunk 增量）
├── dsh-sessions.ts           # JSONL 只读（zstdDecompressAll/readSessionLog/projectKey/回放）
├── dsh-agent-service.ts      # DshClientSession（协议对齐，goal=DSH 原生事件驱动）+ DshAgentService
├── probe-mixed.mjs           # 端到端 probe（已验证通过）
├── probe-patch-seam.mjs      # 用户 patch 层 probe（已通过：会话根被 patch 重定向）
└── probe-native-goal.mjs     # DSH 原生 goal probe（已通过：goal/set→round-driver→complete→clear）
```
- **launcher 运行时树解析**：`$PI_WEB_DSH_RUNTIME` → 本包 node_modules → execPath 邻近 node_modules → `npm root -g`（win32 shell:true）。**支持 dsh 嵌套树**（`<root>/@deepseek-ai/dsh/node_modules`）。
- **jsonrpc 插件入口**：`createRequire(import.meta.url).resolve("@deepseek-ai/dsh-sdk-jsonrpc-server")`（主入口即可；⚠️ 包 exports 只暴露 "." 和 "./invariant"，**resolve 子路径 lib/index.js 会报 "not defined by exports"**）。
- **launcher 修复 jsonrpc 绝对路径**：loader 的 name 字段不支持 !!js → launcher 用 JS 把 env/项目解析写回 patch entry。
- **构建**：`npm run build:dsh-runtime`（scripts/copy-dsh-runtime.mjs）把 runtime 的 .mjs/.yml 拷贝到 dist/server/dsh/runtime/（tsc 只编译 .ts）；build 链已接上。

### 3.2 引擎分发 + 前端徽标
- `server/index.ts`：`ENGINE = PI_WEB_ENGINE === "dsh" ? "dsh" : "pi"`；`new DshAgentService(CWD, stateFile, DATA_DIR, getAgentDir())` vs `new AgentService(...)`；定义 `DispatchSession`（dispatch 表契约）与 `EngineService` 接口，pi/dsh 两引擎结构兼容。**agentDir 贯通**：auth.json 读写与 DshRuntime 的 key 读取都尊重 PI_CODING_AGENT_DIR（smoke 测试的临时 agent 目录才能隔离）。
- `/api/health` 返回 `engine` 字段；`ready` 消息带 `engine`。
- `server/control-socket.ts`：startControlServer 的 service 类型放宽为 `ControlService`（Pick serviceStatus/quiesce/unquiesce）。
- `server/protocol.ts`：ready 加 `engine?: string`；`dsh_patches_list`/`dsh_patches_rescan`（客户端）+ `dsh_patches`（服务端）协议消息；types.ts shim 自动同步（check:protocol ✓）。
- 前端：`web/src/use-chat.ts` state 加 `engine` + `dshPatches`；`FooterBar.tsx` 显示 DSH 徽标；`SettingsModal.tsx` 插件页签下加"DSH 用户补丁"区块（列表 + 重扫，仅 dsh 引擎显示）；i18n 加对应 key（zh/en）。

### 3.3 已验证（empirical）
- ✅ **probe-mixed.mjs 全链路**：initialize → prompt → 事件流（kinds 全）→ text-delta 拼接 "mixed tree works" → shutdown。
- ✅ **probe-patch-seam.mjs**：用户 patch 层生效（patch 把会话持久化根重定向到 marker 目录，prompt 后 JSONL 落在 marker 下）。
- ✅ **probe-native-goal.mjs**：goal/set → create+arm → **round-driver 自动续轮**（<goal_round> round=1）→ 模型 update_goal complete → goal/change 事件 → goal/clear 墓碑。DSH 原生 goal 全链路。
- ✅ **目标（DSH 原生，经 DshClientSession）**：setGoal → goal_status 流转（等待生成→进行中（第 1 轮）→✅ 已达成 verdict=pass）→ clearGoal 清空；<goal_round> 消息不泄漏进 UI。
- ✅ **launcher 单测**（dist 编译产物）boot 成功、initialize 响应。
- ✅ **DshRuntime 独立测试**：start 856ms、prompt 7ms、事件流完整；同进程多轮 turn completed。
- ✅ **真 key E2E（WS 全链路，新 key）**：ready(engine=dsh) → 真模型回复（"4；2+2 按算术规则等于 4。"）→ 原生 goal 循环 pass（"✅ 目标已达成"）→ dsh_patches 列表消息 → 会话 JSONL 持久化。全部通过。
- ✅ **系统消息过滤 + 重复去重**：user/message 只保留真正用户消息（agent-instructions/plugin/goal 过滤；重复文本去重）。
- ✅ **会话列表/切换**：list_sessions（JSONL 扫描）→ switch_session（回放 4+ 消息）。
- ✅ **历史会话续聊**：prompt 到 fromDisk 会话自动 fork + 上下文注入，模型正常回复。
- ✅ **abort**：kill 运行时 + 自动重启 + turn/end id collision 自动 fork 重发，模型恢复回复。
- ✅ **终端**：terminal_create/list/input/output（bash echo TERM_OK 回显）。
- ✅ **quiesce**：attach 拒绝抛 QuiesceRejectedError（index.ts 转 4403 close）+ prompt/newChat/setGoal 拒绝发错误 notice（含 quiesce）。
- ✅ **SCM**：scmQuery 走 FilesService（git-dir watcher → 外部提交推 scm_changed，scm-features-test 9/9）。
- ✅ **API key 管理**：set/clearProviderApiKey 对齐 pi 形状（{provider:{type,key}}）+ PI_CODING_AGENT_DIR 隔离（clear-provider-key-test 4/4）。
- ✅ **质量门**：`npm run typecheck`（server+web+tests）0 错；`npm run build` OK；`npm run test` 246 通过。
- ✅ **pi 引擎回归**：默认 PI_WEB_ENGINE=pi 未改行为（typecheck/build/单测/smoke 抽样全绿）。

### 3.5 dsh 引擎冒烟评估（PI_WEB_ENGINE=dsh，17/32 通过 + 2 环境跳过）
可复用（✓）：global-search / goal-prefs / goal-test / plugin-cwd / plugin-http / mcp-bridge / plugin-settings / plugin-update / preview / quiesce / recursive-watch / scm-features / snapshot-delta / ssh-plugin / steer-queue-smoke / clear-provider-key（对齐后 4/4）。
不可复用（引擎差异，v1 预期失败）：conv-cross-project / conv-cwd（set_cwd 生命周期差异：per-project 对话回收、notice 文案、文件树刷新时机）；settings / slash-commands（dsh 返回空技能/扩展/命令列表）；fetch-models / refresh-models / vision-bridge（自定义 provider/视觉桥 v1 不支持）；plugin-test / plugin-bgtask / plugin-command（registerAgentTool/命令注入无点）；left-panel-delete（pi 会话目录结构假设）；switch-session-background（依赖 mock provider "main/switch-session-mock"）。环境问题：db-client / vscode-editor（dev/plugins/ 缺失，pi 下同样失败）。

### 3.4 过程性踩坑（见 §6）

---

## 4. 下一步做什么（按序）

### 4.1 引擎主体收尾（已基本完成；goal 已改为 DSH 原生，见 §2.6）
- **目标（goal）**：✅ 完成 —— DSH 原生 goal 域（goal-rpc wrapper RPC + goal/change 事件翻译 + round-driver 自动轮次 + 模型自判定 complete/blocked）。与 pi 引擎差异（设计意图）：无独立审查会话；完成由模型自判定；locked 开关透传不映射行为（DSH 目标持续到 complete/blocked/轮尽）；reviewModel 忽略（无独立审查者）。
- **设置面板**：当前最小（promptMode/customSystemPrompt/terminalToolsEnabled → DSH_PERSONA env + 重启运行时；reviewPrompt 已存但 DSH 原生 goal 不使用）。技能/扩展列表返回空、visionModels 空。**可接受 v1，但设置 UI 显示空技能/扩展列表体验一般**。
- **视觉桥**：✅ 完成（§2.7）—— 真 image block（attachment/save + read RPC + vision-exp 模型 + 回放补图）。图片附件/工作区图片文件都走附件存储。注意：仅 deepseek-v4-flash-vision-exp 模型看图。
- **模型配置表单（models.json）**：DSH 引擎返回空 providers 列表 + 保存报"不支持"。**v1 可接受**（DSH 只有内置 deepseek 模型）。
- **对话框（dialog_response）/ 扩展 UI 桥**：DSH 侧已有提问桥（question_pending/question_answer，§2.7）；pi 扩展 dialog（dialog_response）v1 仍忽略。
- **目标调研向导（startGoalWizard）**：✅ 完成（§2.7）—— 交互式（模型 ask_user_question 逐题提问 + 前端对话框 + GOAL: 收敛 + 自动设目标）。

### 4.2 用户 patch 扩展缝 ✅ 已实现
- launcher 读 `PI_WEB_DSH_DATA_DIR`（dsh-client 注入）→ `<dataDir>/dsh-patches/*.yml`（按文件名序，在 override 之后）append 进 boot patches；失败文件跳过 + stderr 日志。jsonrpc 路径写回对用户 patch 同样生效。
- 引擎方法：`listDshPatches()`（扫描 + dsh_patches 消息）/ `rescanDshPatches()`（重启运行时使新 patch 生效）。协议：`dsh_patches_list` / `dsh_patches_rescan`。
- 前端：设置面板「界面插件」页签下的「DSH 用户补丁」区块（文件列表 + 重扫按钮 + 目录提示）。

### 4.3 dsh 引擎冒烟 ✅ 已评估（见 §3.5）
- `PI_WEB_ENGINE=dsh node tests/run-smoke.mjs` 全量跑过：17/32 + 2 环境跳过；其余失败全部归因为 pi 专属/设计差异（见 §3.5 清单）。
- 真 key 手动全流程（对话/工具/会话持久化/换模型/中止）此前已验证；goal 原生循环已用真 key probe 验证。

### 4.4 已知 v1 简化项（与 pi 引擎的差异，前端可感知）
- **无逐字流式**：本机快速完成时 60ms 快照捕捉不到 streaming，但 message_delta 通道已实现（thinking/text 逐 token 走 message_delta，前端 patch streamingMessage），长响应可见流式。
- **queue 语义**：DSH 无 mid-run steering —— isStreaming 时 prompt 全部走 followUp（运行时 inbox 排队，run 结束后消费）；前端 queue 显示为"发送即清"（乐观消息 + agent/inbox/spliced 清理）。
- **工具执行状态**：tool/call（开始）+ tool/result（结束）→ tool_status 已发；无 tool_delta（DSH 不流式工具输出）。
- **后台任务**：tool/call bash → bg.snapshotBefore；tool/result bash → bg.trackAfterBash（端口 diff）已接。
- **goal 审查语义**（见 §2.6）：DSH 无独立审查者——"目标进行中（第 N 轮）…"由 round-driver 自动续轮驱动，完成/受阻由模型自判定；blocked 需连续 3 轮同条件。

---

## 5. 任务清单状态

| # | 任务 | 状态 |
|---|---|---|
| 1 | 研究 DSH JSON-RPC 协议面 | ✅ 完成（§2.1/§2.3 事件 ground truth） |
| 2 | 通读 pi-web-ui agent-service.ts | ✅ 核心读完（快照/事件/会话/模型方法，作对齐参照） |
| 3 | 通读 ds-web-ui 移植素材 | ✅ 核心读完（dsh-client/serialize/agent-service JSONL 部分） |
| 4 | 设计 server/dsh/ + 引擎分发 + 徽标 | ✅ 完成（DispatchSession/EngineService 接口 + ENGINE 分发 + health/ready engine + 前端徽标） |
| 5 | dsh 核心对话引擎 | ✅ 完成（prompt/事件折叠/快照/snapshot_delta/message_delta/tool_status/消息过滤去重） |
| 6 | dsh 会话管理 | ✅ 完成（JSONL 列表/回放/切换/删除 + fork 续聊 + id collision 自动 fork） |
| 7 | 终端/SCM/后台任务/文件服务接入 | ✅ 完成（TerminalManager/scm.ts/FilesService/BgServerTracker 复用 + WS 验证） |
| 8 | 设置/模型配置/目标/视觉桥/插件对齐 + 用户 patch 缝 | 🔶 部分（设置最小、模型配置 v1 不支持；**目标=DSH 原生 ✅、视觉桥 ✅、提问桥+交互式向导 ✅、用户 patch 缝 ✅**） |
| 9 | 前端徽标 + 引擎状态 | ✅ 完成 |
| 10 | typecheck/build/冒烟（双引擎） | ✅ typecheck/build/vitest 全绿；pi smoke 抽样回归绿；**dsh smoke 已评估（§3.5，18/32 + 2 环境跳过，失败全归因）** |
| 11 | 二期：视觉桥（真 image block + vision-exp 模型 + 回放补图） | ✅ 完成（§2.7，probe-vision.mjs 实证） |
| 12 | 二期：用户提问桥（question_pending/question_answer + DshQuestionDialog） | ✅ 完成（§2.7，WS 实证：提问→回答→模型回应） |
| 13 | 二期：交互式调研向导（startGoalWizard 重写） | ✅ 完成（§2.7，4 轮提问→GOAL 收敛→自动设目标实证） |

---

## 6. 坑与备忘（避免重复踩）

1. **npm 在 bash 工具环境里会假死** —— 让用户在自己的终端跑；不要在工具里后台装大包。
2. **fnm multishell**：`npm root -g` 从 bash/node spawn 取空桶很正常；launcher 已把 execPath 邻近 node_modules 放前面。**每个 bash 命令是独立 multishell（execPath 不同），junction 路径只在当前 shell 存活**。
3. **cordis patch 语法**：id 定向替换 vs insert，错了报 duplicate loader entry id。
4. **JSON-RPC stdout 纯净**：runtime 的 stdout 只能有协议帧；任何日志都要 stderr（调试信息用 PI_WEB_DSH_DEBUG 门控打到 stderr）。
5. **中止=杀进程**：win32 用 `taskkill /pid X /T /F`；会话 JSONL 在磁盘，进程重建不丢。**abort 后原会话不可续聊（id collision）→ 必须 fork**。
6. **`.jsonl.zstd` 多帧解压**：zstdDecompressSync 只解首帧，要各帧分别解（dsh-sessions.ts 的 zstdDecompressAll）。
7. **会话目录名**：projectKey 风格（`--<cwd>--`，分隔符转 `-`，非法字符 `~XXXX`）。
8. **协议版本**：protocol.ts 加字段后跑 `npm run check:protocol`（types.ts shim 单源）。
9. **loader 的 name 字段不支持 !!js**（只插值 config）→ jsonrpc 插件绝对路径由 launcher JS 写回（launcher.mjs 的 jsonrpcEntry 解析段）。
10. **boot 的 patches 必须扁平**：`[...baseList, ...overrideList]`；嵌套数组被 applyEntryPatches 静默跳过（表现为"插件没挂上"）。
11. **permission-presets 整行全量替换**：approval=never 组合需显式 preset + defaultPreset（override.patch.yml 的 workspace-write-never）。
12. **运行时树在嵌套位置**：全局 `npm root -g/@deepseek-ai/` 只有 dsh 包；dsh-base/dsh-app-boot 在 `@deepseek-ai/dsh/node_modules/@deepseek-ai/`（runtime-root.mjs 的 runtimeBaseFor 检查两种布局）。
13. **require.resolve 子路径限制**：dsh-sdk-jsonrpc-server 的 exports 只暴露 "." 和 "./invariant"，resolve 必须用主入口。
14. **快照增量陷阱**：`emittedMessages = cur` 若保存数组引用，appendMessage push 同一数组会让 prev/cur 恒等 → slice(prev.length) 恒空 → 消息永不到前端。必须拷贝（`[...conv.messages]`）。
15. **流式时序**：本机快速完成时 60ms 延迟快照总被 assistant/message 抢跑（streaming 从未被捕捉）→ 必须走 message_delta 独立通道（text_delta/thinking_delta，与 pi SDK 的事件类型一致）。
16. **DSH 重复用户消息**：同文本 user/message 会重放 → 按文本去重；agent-instructions/plugin 过滤；**goal source 的 <goal_round> 轮次消息也要过滤**（不渲染，但用它更新轮数显示，round 在 source.round）。
17. **Windows 测试进程管理**：`pkill -f` 在 Git Bash 匹配不到 node 进程（pid 残留 + EADDRINUSE），用 `taskkill //PID <pid> //T //F`。
18. **服务器启动竞态**：DshRuntime.start() 并发调用必须共享同一 startPromise（否则重复 spawn launcher，prompt 写错 stdin）。
19. **Windows ESM 动态 import 绝对路径**：`import("E:\\...")` 报 ERR_UNSUPPORTED_ESM_URL_SCHEME —— 必须 `import(pathToFileURL(p).href)`（goal-rpc.mjs 踩过）。
20. **dsh-goal view 是扁平结构**：`{id,revision,objective,phase,maxGoalRounds,roundsStarted,activation}`，无 goal 嵌套字段；无目标时 get() 返回 undefined（不是 {goal:null}）。
21. **goal/change 事件只在 mutation 时发**（create/edit/resume/complete/block/clear），轮次承认不发 —— 轮数显示靠 <goal_round> user/message 的 source.round 更新。
22. **auth.json 形状与路径**：pi 引擎形状 `{<provider>:{type:"api_key",key}}`，dsh 必须同形状（clear-provider-key-test 断言）；路径尊重 PI_CODING_AGENT_DIR（getAgentDir()），硬编码 ~/.pi/agent 会让测试/部署的临时 agent 目录隔离失效。⚠️ **clear-provider-key-test 会破坏真实 ~/.pi/agent/auth.json 的 deepseek key**（pi/dsh 都一样）——跑之前备份，跑完恢复。
23. **sdk-jsonrpc 插件可扩展**：官方包 export HarnessSdkJsonRpcServer/apply/Config/inject/name，可 import 子类化加 RPC 方法（goal-rpc.mjs 的模式）；inject 要加新服务依赖（"goals"）；loader 对插件文件的裸 import 走 node ESM 解析（混树安全，官方插件同理）。
24. **JSON-RPC 面无法触发 /goal 命令**：prompt 直进 inbox，命令运行时（ctx.commands）拦截不到；唯一可靠触发 = 扩展 RPC 方法直调 ctx.goals 服务动词。
25. **图片只对 vision 模型可用**：dsh-llm-deepseek adapter 默认目录仅 `deepseek-v4-flash-vision-exp` 有 inputModalities:[text,image]；flash/pro text-only → 图片被省略（模型会说"只接受文本"）。视觉标记必须 per-model。
26. **dsh-tool-ask-user 不在 base bundle**：base 只挂 user-questions 服务；ask_user_question 工具要 override.patch.yml 手动 insert（否则模型说"没有该工具"）。
27. **提问桥单 pending**：ctx.userQuestions 一个 context 只一个 provider；ask() 阻塞期间新提问报"已有提问等待回答"。前端 question_pending 只显示一个；提交前每题需 selected 或 custom 非空。
28. **附件字节校验**：attachment/save 用 saveImage（内部校验媒体类型/字节/像素上限），非 png/jpeg/webp/gif 或超限报错 → 调用方回退文本占位。
29. **Event loop 阻塞注意**：提问桥的 ask() await 挂起 agent 循环直到 answer/cancel/超时（10 分钟）——前端不回答会卡住该会话，超时后工具报错模型继续。

---

## 7. 相关文件清单（新对话必读）

| 文件 | 用途 |
|---|---|
| `E:/pi-web-ui/server/dsh/dsh-agent-service.ts` | 引擎主体（DshClientSession 协议对齐 + goal=DSH 原生事件驱动 + DshAgentService） |
| `E:/pi-web-ui/server/dsh/dsh-client.ts` | DshRuntime（launcher spawn + JSON-RPC + goal RPC + kill/restart） |
| `E:/pi-web-ui/server/dsh/dsh-serialize.ts` | 事件 → UiMessage + DshStreamAccumulator |
| `E:/pi-web-ui/server/dsh/dsh-sessions.ts` | JSONL 只读（列表/回放/fork 素材） |
| `E:/pi-web-ui/server/dsh/runtime/launcher.mjs` | 运行时 launcher（boot 组合；jsonrpc wrapper 指向；用户 patch 层） |
| `E:/pi-web-ui/server/dsh/runtime/goal-rpc.mjs` | ⭐ jsonrpc wrapper 插件：goal/set|get|clear|resume|edit + attachment/save|read + question/answer + 提问 provider 桥 |
| `E:/pi-web-ui/server/dsh/runtime/runtime-root.mjs` | 运行时树解析（flat + 嵌套布局） |
| `E:/pi-web-ui/server/dsh/runtime/override.patch.yml` | 组合覆盖层（permission preset 等） |
| `E:/pi-web-ui/server/dsh/probe-native-goal.mjs` | DSH 原生 goal probe（goal/set→round-driver→complete→clear） |
| `E:/pi-web-ui/server/dsh/probe-vision.mjs` | 视觉桥 probe（attachment/save+read+vision 模型看图） |
| `E:/pi-web-ui/web/src/components/DshQuestionDialog.tsx` | 模型提问对话框（单选/多选/自定义文本） |
| `E:/pi-web-ui/server/dsh/probe-patch-seam.mjs` | 用户 patch 层 probe（会话根重定向验证） |
| `E:/pi-web-ui/server/index.ts` | 引擎分发（ENGINE/EngineService/DispatchSession）+ dispatch 表 + dsh_patches 分支 |
| `E:/pi-web-ui/server/protocol.ts` | wire 协议唯一事实源（ready.engine + dsh_patches 消息） |
| `E:/pi-web-ui/scripts/copy-dsh-runtime.mjs` | build:dsh-runtime（拷贝 .mjs/.yml 到 dist） |
| `E:/pi-web-ui/server/agent-service.ts` | pi 引擎（协议对齐参照；QuiesceRejectedError 定义处） |
| `E:/pi-web-ui/server/files-service.ts` | 文件/SCM 服务（scmQuery 带 git-dir watcher，dsh 复用） |
| `E:/ds-web-ui/server/dsh-client.js` / `agent-service.js` | 移植源（JSONL 解码/事件适配参考） |

---

## 8. 后续优化路线图（用户待办，按优先级）

> 状态截止 2026-09-01：v1 功能齐备（对话/会话/终端/SCM/后台任务/goal 原生/视觉桥/提问桥/向导/patch 缝），
> 冒烟 18/32 + 2 环境跳过。以下为已识别但未做的优化点，按「影响 × 成本」排序。

### 8.1 P0 — 稳定性 / 健壮性

| # | 项 | 现状 | 方案 |
|---|---|---|---|
| 1 | **runtime 崩溃自动重启 watchdog** | `DshRuntime.onExit` 只打日志；运行时意外退出后所有会话卡死（会话还在，但 prompt 全部失败） | onExit 里做自动重启（限频：如 60s 内最多 2 次，超限升级为 notice 报错）；重启后原会话变"磁盘有日志无 live" → 依赖已有 id-collision fork 路径恢复；同时发 notice 告知用户 |
| 2 | **setModel / abort 与进行中 run 的竞态** | `setModel` → `runtime.restart` 直接 kill 运行时，进行中的 prompt/工具执行被中断且无提示；用户可能不知道"换模型 = 当前所有对话的运行中止" | restart 前检测活跃 run：有则发确认 notice（"换模型将中止当前运行，继续？"）或先 abort 再换；abort 的 notice 文案已说明但 setModel 没说 |
| 3 | **长期运行内存：convs 不回收** | `newChat` 不主动移除旧 conv（listed 生命周期简化）；长会话+多对话内存/事件累积 | 按 idle 时间回收非活跃且非 streaming 的 conv（JSONL 在磁盘，回放即可恢复）；限制每项目 conv 上限已存在（8）但只挡新建不回收 |
| 4 | **PI_WEB_DSH_DEBUG 门控未实现** | 文档 §6.4 提到调试日志门控，实际代码没有；排障只能看 stderrTail | dsh-client/launcher 加 `PI_WEB_DSH_DEBUG=1` 门控：把 session.event 关键分支、RPC 帧计数、restart 原因打到 stderr（诊断时开，默认关） |
| 5 | **DshRuntime.start 失败重试** | `start()` 失败只 catch + 发 notice；瞬时失败（端口/网络）需手动重连 | 指数退避重试（如 3 次，1s/3s/9s），最终失败才 notice |
| 6 | **提问桥超时可配置 + 前端倒计时** | ask() 10 分钟硬超时，前端无感知 | 环境变量配置超时；question_pending 带超时时间戳，前端显示倒计时并允许"取消提问" |

### 8.2 P1 — 体验对齐（前端可感知）

| # | 项 | 现状 | 方案 |
|---|---|---|---|
| 7 | **图片粘贴不校验模型 vision 能力** | 前端完全没读 `model.vision`（已 grep 确认）：flash/pro（text-only）下也能粘图，图被 DSH 侧省略、用户以为发了 | ChatInput 在 `model.vision === false` 时禁用图片粘贴按钮或粘贴时提示"当前模型不支持图片（换 DeepSeek V4 Flash Vision (exp)）"；`ModelInfo.vision` 已下发，只是前端没用 |
| 8 | **设置面板空列表（技能/扩展/vision 模型）** | DSH 下 skills/extensions/visionModels 全空，UI 显示空列表体验一般 | 方案 A：从运行时暴露真实清单（dsh-skill 系统 + cordis 插件树 → RPC 查询，改 patch 配置启停）；方案 B（低配）：DSH 引擎隐藏这些区块 + 显示"DSH 引擎使用运行时内置技能/插件"说明 |
| 9 | **reviewPrompt / visionBridge 设置在 DSH 下无用** | 设置面板照常显示，改动只存不生效（无独立审查者 / 无 vision bridge 概念） | DSH 引擎隐藏或改语义：reviewPrompt → "目标轮次附加指令"（经 DSH_PERSONA 注入 system prompt，让模型在 goal-round 里遵守）；visionBridge 区块隐藏 |
| 10 | **GoalBar 轮次用尽检测** | roundsStarted >= maxGoalRounds 且 phase 仍 active 时 UI 一直显示"目标进行中"，无提示 | goal/change + user/message(source.goal) 到达时若 round 已达 maxGoalRounds → status "已达轮数上限，目标未完成"（verdict=fail 或提示续轮方式：edit maxGoalRounds / resume） |
| 11 | **locked / reviewModel 控件的 DSH 语义** | 两个控件显示但无行为映射（DSH 目标持续到 complete/blocked/轮尽；无独立审查模型） | 方案：locked=false → setGoal 时 maxGoalRounds 强设为 1（单轮语义近似）；reviewModel 下拉在 DSH 下隐藏或改为"轮次上限"快捷选择 |
| 12 | **conv-cwd / conv-cross-project 冒烟对齐** | 2 个 smoke 失败：set_cwd 生命周期差异（per-project 对话回收、文件树刷新时机、notice 文案） | 对齐 pi 行为：set_cwd 后旧项目 conv 标记回收（不在运行列表）、文件树立即刷新、notice 文案一致 → 测试可复用 |
| 13 | **会话 JSONL 保留期清理** | dsh-sessions/ 无限增长（pi 有 uploads 保留期，会话文件无） | 配置保留期（如 90 天）后台清理非活跃会话；删除会话时顺带清理其附件（attachment store 有 GC 缺口，官方已注明 deferred） |
| 14 | **session 搜索增强** | searchSessions 只搜 user/assistant 文本 | 可选：把 tool-result 文本/附件名纳入索引；结果锚点已支持 |

### 8.3 P2 — 新能力

| # | 项 | 现状 | 方案 |
|---|---|---|---|
| 15 | **工具桥（插件注入点）** | pi-web-ui 插件 `registerAgentTool` 无 DSH 注入点；v1 声明不支持 | 写 Cordis 工具桥插件：服务器侧收集插件工具定义 → RPC 注册进运行时（模型可用插件工具）；工具执行回调回服务端跑插件实现 |
| 16 | **MCP 桥** | pi 引擎有 mcp.json 桥；DSH 运行时树自带 MCP client | 研究把 `mcp.json` 的服务器定义桥到 DSH 运行时（或把 DSH 的 MCP 会话暴露给前端） |
| 17 | **模型目录动态化** | DSH_MODELS 硬编码 3 个模型 | 用 `ctx.llm.listModels('deepseek-official')`（adapter 目录可扩展）经 RPC 查询，动态生成模型列表（含 vision 标记）；定价/上下文窗口保持本地表 |
| 18 | **技能启停 UI** | 设置面板技能列表空 | 基于运行时 dsh-skill 插件清单（patch 层 disabled 配置）+ RPC 查询 → 设置面板真实开关（同 #8 方案 A） |
| 19 | **fork 会话的目标迁移提示** | abort/续聊 fork 后原会话 goal 丢失（DSH same-session 语义），无提示 | fork 时若原 conv 有 active goal → notice 提示"原目标已随会话存档，如需继续请重新设置或使用原会话 resume" |
| 20 | **提问桥并发排队** | 重叠的两次独立 ask() 直接 reject（"已有提问等待回答"） | 排队（队列深度 3）+ 前端一次只显示一个 |
| 21 | **流式 UI 增强** | 长思考文本（thinking_delta）全量展开 | 前端思考块折叠/截断（pi 引擎有类似折叠），节省版面 |

### 8.4 测试与交付

| # | 项 | 现状 | 方案 |
|---|---|---|---|
| 22 | **dsh 专属冒烟套件** | 现有 smoke 是 pi 用例；dsh 的 goal/提问桥/视觉桥/patch 缝只有 probe | 把 probe（native-goal / vision / patch-seam / 提问桥 WS）转成 `tests/*-dsh-test.mjs` 正式用例（零 key 部分 + 真 key 门控），跑 `PI_WEB_ENGINE=dsh` |
| 23 | **浏览器 E2E（playwright）** | 只有 WS 层验证 | 浏览器走一遍：DSH 徽标/流式渲染/图片粘贴（vision-exp）/提问对话框/目标条/设置补丁区块 |
| 24 | **部署文档** | docs/deployment.md 无 dsh 提及 | 补：`PI_WEB_ENGINE`、`PI_WEB_DSH_RUNTIME`、`PI_WEB_DSH_DATA_DIR`、`PI_WEB_DSH_PATCH_DIR` 环境变量；Docker 镜像带 dsh 运行时树（或运行时树解析失败时的安装指引）；systemd/launchd 的 env 示例 |

### 8.5 已知取舍（不打算改，除非用户要求）
- **无逐字流式**：message_delta 通道已实现，60ms 快照节流是设计使然（pi 同款）。
- **queue = 发送即清**：DSH 无 mid-run steering，isStreaming 时 prompt 走 followUp，前端乐观消息即时入流。
- **无独立审查者**：goal 完成/受阻由模型自判定（DSH 官方设计）；blocked 需连续 3 轮同条件。
- **abort = 重启运行时**：所有会话的运行一起停（DSH 协议面无 per-session close）。
- **模型配置表单 / 自定义 provider**：DSH 引擎只有内置 deepseek 模型，v1 明确不支持。
