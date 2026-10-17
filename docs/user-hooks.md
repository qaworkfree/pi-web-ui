# 用户钩子（User Hooks）

对标 Claude Code 的 hooks：在代理生命周期的固定事件点运行**用户配置的 shell 命令**。
配置存 `<dataDir>/user-hooks.json`（全局共享，live 生效无需 reload），设置页「Hooks」区编辑；
经 `settings_state.userHooks` 下发、`save_user_hooks` 整表保存（服务端归一化后回显）。
**对 AI 不可见**：模型既看不到钩子列表也不能改它（没有任何工具暴露这份配置）。

## 事件与语义

| 事件            | 触发点                     | blocking 语义                                                                 |
| --------------- | -------------------------- | ----------------------------------------------------------------------------- |
| `pre-tool`      | 工具执行前（按工具名过滤） | 退出码 2 = 拒绝本次调用（stderr/stdout 首行作为给模型的理由，isError 结果）    |
| `post-tool`     | 工具执行后（被拒的不算）   | 恒为观察：并行发射不等待；负载带 `resultPreview`（≤2KB）与 `isError`           |
| `prompt-submit` | 用户消息发出前             | 退出码 2 = 拦下这条消息（warning notice 通知用户，消息不进模型）               |
| `turn-end`      | 一轮生成结束（含中止）     | 恒为观察；负载带 `aborted`                                                     |

通用口径：**fail-open** —— 其他非零退出码 / 超时 / 起不来 = 发一条 warning notice 后放行，
坏钩子不能瘫痪代理。非 blocking 钩子一律并行观察。超时 1s–120s（默认 10s），到点杀进程。
列表上限 50 条；`tools` 空或含 `*` = 全部工具，大小写不敏感。

## 运行方式

命令经 `spawn(command, { shell: true, cwd })` 执行（工具事件 cwd = 会话工作区，prompt/turn 事件
cwd = 对话 cwd）。JSON 事件负载从 **stdin** 传入（`{event, tool?, params?, prompt?, conversationId,
cwd, ...}`），环境变量注入 `PI_HOOK_EVENT` / `PI_HOOK_ID`。stdout/stderr 各截 64KB。
离线模式下继承服务进程的黑洞代理环境（`applyOfflineChildEnv` 改的是 `process.env`，子进程自然继承）。

**安全口径**：钩子以服务进程身份运行、不经过文件系统策略 —— 这是用户自己写的自动化，
与在终端面板里敲命令同责（设置页有明示）。

## 接线（单源 = `server/user-hooks.ts`）

- 归一化/匹配/运行/存储：`normalizeUserHooks` / `matchUserHooks` / `runUserHook` / `UserHooksStore`。
- 工具面闸门 `withUserHookGate`（agent-service）：形状与 `withPlanModeGate` 同构，包在**最最外层**
  （用户自动化先于目标审查/审查者/计划闸门），覆盖两处 —— customTools 整列的创建时 `.map`，
  以及 `toolOverrideSpecs` 的 `hookGate`（planGate 外层 + read 两条目）。与计划闸门同口径的空白：
  `syncPluginTools` 后续动态补入的插件工具不在覆盖面。
- `prompt-submit` 闸门在 `prompt()` 入口（嵌入模型检查之后、`promptAc` 之前）；`turn-end` 在
  agent_end 的两条路径（正常/中止）`notifyTurnEnd` 旁发射。
- DSH 引擎无 pi 工具注册面：设置页隐藏「Hooks」分区，`userHooks` 恒为 `[]`，`save_user_hooks` 静默忽略。

回归：`tests/unit/user-hooks.test.ts`（归一化/匹配/运行/存储）+ `tests/hooks-test.mjs`
（零 token 端到端：保存回显 / pre-tool 拒 / post-tool+turn-end 落盘探针 / prompt 拦截 / 停用恢复，
已入 run-smoke ALL）。
