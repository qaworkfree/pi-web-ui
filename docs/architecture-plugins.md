# 插件系统

> 可选界面组件，存放在 `<dataDir>/plugins/`。不装即不存在，attach 时热重扫。

## 形态

一个插件 = `<dataDir>/plugins/<id>/` 目录：

- `manifest.json`（name/version/description）
- `index.mjs` 服务端入口（可选，`export default { activate(host) → deactivate? }`）
- `client/entry.mjs` 视图入口（可选，`export default { mount(el, ctx) → cleanup? }`）

**不装即不存在**——目录不在就没有任何协议/UI 痕迹；attach 时重扫目录，新丢进来的插件无需重启服务即出现在顶栏视图 tab（import 每进程一次并缓存；删除目录 → 下次 attach 反激活）。

## 协议

| 方向 | 消息 | 作用 |
| --- | --- | --- |
| 上行 | `plugin_message` | 路由到该插件的 onMessage 处理器，回调第二参为 clientId；未知/非法 id 静默丢弃 |
| 上行 | `plugins_reload` | 服务端热重载：反激活全部→重扫激活→epoch+1→重推清单 |
| 下行 | `plugins` | attach 时推清单（plugins, epoch），epoch 用作前端 import 缓存击穿参数 `?e=` |
| 下行 | `plugin_data` | 默认广播给所有 socket，前端按 pluginId 扇出给已加载视图 |

## 宿主扩展点

| 方法 | 作用 |
| --- | --- |
| `host.notify(level, text)` | 发系统通知条（notice，前端 toast） |
| `host.sendTo(clientId, payload)` | 定向发给单个 socket |
| `host.onToolEvent(h)` | 订阅 SDK 工具执行事件（phase:start\|end, toolName, conversationId?, durationMs?, isError?） |
| `host.registerAgentTool(tool)` | 注册供 AI 调用的工具，返回注销函数 |
| `host.onAttach(h)` | 注册「新客户端接入」钩子（每次浏览器 attach，含 plugins_reload 后的重接入） |
| `host.registerCommand(cmd)` | 注册斜杠命令（SlashCommandInfo source=plugin → 选择器 + prompt 拦截执行） |
| `host.route(method, path, handler)` | 挂载 HTTP 路由（`/plugins-api/:id/*`） |
| `host.fs` | 受限工作区文件访问（WorkspaceFS，路径锚定活 cwd 根，越界拒绝） |
| `host.getSettings()` | 读取声明式设置（manifest.settings schema） |
| `host.onSettingsChanged(h)` | 订阅设置变更 |
| `host.registerBackgroundTask(task)` | 注册插件常驻任务，并入顶栏「后台任务」面板 |
| `host.notifyCwd(cwd)` | 当主应用 set_cwd 成功后通知插件（幂等去重，异常隔离） |

### 宿主设施（plugin-facilities.ts）

| 设施 | 说明 |
| --- | --- |
| `storage` | `<pluginDir>/storage.json` 原子 KV |
| `secrets` | AES-256-GCM 加密机密，密钥 `<dataDir>/secrets.key`，拷机 fail closed |
| `ensureDeps` | npm 自动补装单飞 |

### 能力声明与强制（manifest.permissions）

写了=严格模式，宿主自控 API（registerAgentTool→tools / route→http / host.fs→fs）按声明族强制拦截，未声明的族拒绝并报「缺哪族」；未写且 apiVersion<2=旧全权（放行但每激活期警告一次，v2 起默认拒绝已预埋）。

## manifest 可选字段

- `icon`（emoji/单字符，顶栏 tab 替代通用拼图图标）
- `description`（tab 悬浮提示）
- `version`
- `apiVersion`（与 `PLUGIN_API_VERSION` 比较，> 则拒绝激活并提示升级）
- `permissions`（能力声明数组）
- `settings`（声明式设置 schema → ⚙ 面板自动渲染表单）

## 前端集成

App 按 chat.plugins 动态 import 各插件的 client bundle（`/* @vite-ignore */`），TopBar 为每个插件加一个 🧩 tab（激活失败的置灰）；插件不共享 React 实例，与主应用只有 ctx.send/onData 两条窄通道。

`syncPluginViews(plugins, epoch)` 统一同步注册表：清单消失/被禁用即卸载视图（调 cleanup）、epoch 变化清 failed 重拉 bundle。

设置面板 ⚙ 有「界面插件」开关区（`set_settings.disabledPlugins`，持久化 client-state、纯 UI 隐藏不触发 runtime reload）+ **每行「更新/卸载」按钮**（更新需 CLI install 记录的来源 `.pi-source.json` → `UiPluginInfo.source`；两个操作都走可见终端 tab，退出后 App 观察器发 `plugins_reload` 热重载）。

## 静态服务

`GET /plugins/:id/client/*` 映射到插件目录的 client/ 子树（**只暴露这个子树**——manifest 与服务端 index.mjs 可能含凭据，绝不下载；id 校验 + resolve 前缀防穿越）。dev 模式 vite 已代理 /plugins。

## MCP 工具桥（server/mcp-bridge.ts）

读取 `<dataDir>/mcp.json` 启动外部 MCP 服务器（stdio、换行分隔 JSON-RPC，零三方依赖；`{servers:{名:{command,args,cwd,env}}}`），握手 initialize→initialized→tools/list→tools/call 后把每个远端工具适配成 PluginAgentTool（名字归一化 sanitizeToolName），并入 plugin.d.ts 的 pluginToolsProvider（与插件工具同一 customTools 管线）。单服务器失败隔离（rejectAll + 日志，不炸进程）；dispose 时 kill 子进程；请求按 id 匹配 + 超时看门狗。

## 真实插件

| 插件 | 目录 | 说明 |
| --- | --- | --- |
| demo-mailbox | `dev/plugins/demo-mailbox/` | 内存邮箱 demo，plugin-test 夹具 |
| webmail | `dev/plugins/webmail/` | 📬 网页邮箱，IMAP/SMTP 邮件管理 |
| vscode-editor | `dev/plugins/vscode-editor/` | 📝 编辑器 + SSH（原独立插件合并） |
| db-client | `dev/plugins/db-client/` | 🗄️ 数据库连接管理（mysql2/pg/mssql/sqlite/mongodb/redis） |

## 回归测试

| 测试文件 | 端口 | 说明 |
| --- | --- | --- |
| `plugin-test.mjs` | 8978 | 清单推送 / message 回环 / 静默丢弃 / 静态服务 / 路径穿越拒绝 |
| `plugin-command-test.mjs` | 8979 | 插件命令全链路 |
| `plugin-http-test.mjs` | 8981 | host.route 全链路（GET/POST/404/500） |
| `plugin-bgtask-test.mjs` | 8982 | registerBackgroundTask 全链路 |
| `plugin-settings-test.mjs` | 8983 | 声明式设置 schema 校验/持久化/回显 |
| `plugin-cwd-test.mjs` | 8989 | set_cwd→notifyCwd→广播全链路 |
| `mcp-bridge-test.mjs` | 8990 | MCP 服务器握手/工具调用/失败隔离 |
| `plugin-update-test.mjs` | — | install/check-updates/rollback 全链路 |
| `ssh-plugin-test.mjs` | 8964 | SSH 远程文件/终端全链路（mock SSH 服务端） |
| `db-client-test.mjs` | 8968 | SQLite 全链路协议冒烟 |
| 单测 `plugin-facilities.test.ts` | — | storage/secrets/deps/apiVersion 门控 |
| 单测 `plugin-settings.test.ts` | — | schema 解析/校验/持久化 |
| 单测 `mcp-bridge.test.ts` | — | 握手/工具列表/调用/超时 |
| 单测 `plugin-updater.test.ts` | — | 备份/回滚/prune/资源解析 |