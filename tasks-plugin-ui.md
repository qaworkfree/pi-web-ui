# tasks-plugin-ui.md — 插件 UI 扩展点框架（issue #146 完整版）交接单

> 给「新对话的 AI」看的续作说明。**动手前先读完整份 + `AGENTS.md`**。
> 注：仓库里的 `tasks.md` 是另一份任务书（issue #91 服务端多语言），本文件是**插件 UI 扩展点**的交接单，互不覆盖。
> 本轮的立场：宿主做成**通用扩展点框架**（新增挂载点 = 宿主加常量 + 一处渲染，插件侧契约不变），
> 而不是继续往 #146 里塞字段。

---

## 0. 一句话现状

**T1（右栏/会话右键的 slot 接入）、T2（`settings.pages` 进设置面板）、T3（多根工作区 + 会话 API）、
T4 的 1/2/3/4/5（单测、`PLUGIN_API_VERSION` 升 2、文档、CHANGELOG、i18n）都已落地并全绿。**

当前工作区状态（`main`，**大量未提交改动**）：

```
npm run typecheck  ✅（五套 tsc）
npm run format:check ✅
npm run lint       ✅ 基线 3 warnings（model-admin / mermaid / marker-service）
npx vitest run     ✅ 101 文件 1301 用例
npm run build      ✅
冒烟（run-smoke 子集）✅ workspace-roots-test / plugin-grants-test / settings-test /
                       plugin-test / plugin-jobs-test / plugin-settings-test / left-panel-delete-test
真 Chrome E2E       ✅ plugin-topbar-ui-test(10) / plugin-settings-page-test(12) /
                       context-menu-ui-test(44) / ui-layout-ui-test(43) / panel-layout-test
```

**发版前还剩的事**见 §4（版本号 / CHANGELOG 复核 / issue 回帖 / 重启服务），代码层面没有已知未完成项。

---

## 1. 已完成（别重做）

### 1.1 契约（`server/protocol.ts`）
- `UiSlotId`：**11 个挂载点** —— `topbar.primary` / `topbar.overflow` / `bottombar` /
  `composer.actions` / `message.actions` / `rightpanel.tabs` /
  `contextmenu.topbar|message|session|file` / `settings.pages`
- `UiContribution`（`kind`: view/action/badge/menu/page/organizer/divider；`children`（一层）/
  `when` / `badge` / `group` / `order` / `hidden` / `action` / `view`）
- `UiArrangeOp`（插件整理**任何**条目，含 `host:*` 内置）/ `UiPluginUi`（`{items, arrange}`）
- `UiLayoutPrefs`（用户偏好：`hidden` / `shown` / `order` / `groups` / `labels`）
- **`set_workspace_roots`（本轮落地）** + `UiState.workspaceRoots?`
- 授权：`plugin_path_request` / `plugin_path_response` / `plugin_path_revoke` / `plugin_grants`

### 1.2 服务端
- `server/plugins.ts`：manifest `"ui"` 解析（`parseUiItem`/`parseUiContributions`/`parseUiArrange`、
  `UI_SLOTS`、`UI_SLOT_ALIASES` 自然简写）、**权限门控**（严格模式 = 声明了 permissions **或** `apiVersion>=2`）、
  `host.ui.register/update/remove/arrange/list`、跨目录 `host.fs.requestAccess/authorizedDirs/listPath/
  readPath/readTextPath/writePath/removePath`、`host.project.create`、
  `notifyWorkspaceRoots()` / `isInsideWorkspace()`（额外工作区根也算「工作区内」）、
  **`PLUGIN_API_VERSION = 2`**、`onGrantsChanged` 钩子（授权落表即重推 `plugin_grants`）
- `server/client-state.ts`：`normalizeWorkspaceRoots` / `MAX_WORKSPACE_ROOTS = 8` /
  按项目（cwd）持久化 `workspaceRoots`（`getWorkspaceRoots` / `saveWorkspaceRoots`）
- `server/agent-service.ts`：`ClientSession.setWorkspaceRoots()` + `workspaceRoots` getter、
  快照 `workspaceRoots`、`onCwdChanged(abs, roots)` 钩子带上根；
  `server/dsh/dsh-agent-service.ts` 同样实现（DSH 无插件宿主，多根只让文件树受益）
- `server/index.ts`：分发 `set_workspace_roots`；`onClientCwdChanged` → `notifyCwd` + `notifyWorkspaceRoots`；
  `plugin_path_request` 广播与答复、attach 推 `plugin_grants`、`plugin_job*` / `plugin_catalog_sync` /
  `set_settings.uiLayout`
- `server/plugin-grants.ts`（授权表）、`plugin-project.ts`（项目组装）、`plugin-installer.ts`（#152）、
  `plugin-catalog-sync.ts`（#148）

### 1.3 前端
- `web/src/ui-slots.ts`：`BUILTIN_UI_ITEMS`（**32** 条，含 `host:file-add-root`）+ `buildUiSlots`
  （**四级优先级：宿主默认 → 插件贡献 → 插件 arrange → 用户偏好（最高）**）+ `splitOverflow` /
  `restoreUiItem` / `restoreAllUi`；条目带 `arrangedBy` / `userOverrides` / `movedFrom`
- `web/src/context-menu-state.ts` + `components/ContextMenu.tsx`（App 里唯一的全局右键菜单）
- `components/PluginPage.tsx`（`settings.pages` 宿主容器）+ `components/SlotTabs.tsx`（slot tab 容器）
- **已接入的挂载点**：`topbar.primary` / `topbar.overflow`（含**隐藏的内置入口在「⋯」里真的可点**，
  见 §2.6）/ `bottombar` / `composer.actions` / `message.actions` / `contextmenu.message` /
  `contextmenu.topbar` / `rightpanel.tabs`（含根选择器）/ `contextmenu.file` / `contextmenu.session` /
  `settings.pages`
- 设置面板：**「界面布局」页**（按 slot 列条目、来源、隐藏/显示、↑↓、单条恢复、全部恢复）+ **「已授权目录」段**
  + **插件自定义页**（侧边栏一项一页，`PluginPage` 渲染）
- `web/src/app-globals.ts`：`workspaceRoots`（与 `cwd` 同源，快照镜像；`sameArray` 比较防白重渲染）
- `web/src/plugin-host.ts`：宿主 API 版本 **6**（新增 `sessions.list/open`、`openSession` 多根）
- 样式：`styles.css` 的 `.ctx-menu*` / `.slot-tabs*` / `.plugin-page*` / `.root-picker*` /
  `.status-action` / `.composer-plugin-action` / `.set-ui-slot*` / `.set-plugin-page`

### 1.4 测试
- 单测：`ui-slots`(33) / `context-menu`(33) / `plugin-grants`(25) / `plugin-project`(21) /
  `plugin-installer`(10) / `plugin-catalog-sync`(9) / **`plugin-ui-manifest`(39，本轮新增)** /
  **`workspace-roots`(13，本轮新增)** / `plugin-host`（本轮补了多根 + 会话 API 用例）
- 协议：**`tests/workspace-roots-test.mjs`**（多根落快照 / 归一化 / 按项目持久化 / 插件免授权读根）、
  **`tests/plugin-grants-test.mjs`**（授权接线：request → 浏览器确认 → 落表 → 插件读得到 → 撤销 → 再问一遍）、
  `tests/plugin-jobs-test.mjs`
- 浏览器（真 Chrome，**不入 run-smoke**）：`plugin-topbar-ui-test.mjs`(10)、
  **`plugin-settings-page-test.mjs`(12)**、**`context-menu-ui-test.mjs`(44)**、
  **`ui-layout-ui-test.mjs`(43：布局页 ↔ 界面一致性)**

---

## 2. 本轮的关键决策（以后别推翻，除非有更好理由）

### 2.1 多根工作区存**服务端**（不是 localStorage）
按项目（cwd）存在 `client-state.json`，经快照 `workspaceRoots` 下发。理由：插件宿主也要知道
（`isInsideWorkspace` 据此豁免授权），多标签页/多设备一致，重启不丢。**AI 仍只在主 cwd 里干活**
（pi SDK 单 cwd 模型）；多根只影响「哪些路径算工作区内」+ 右栏文件树的根。
前端表现 = 右栏 crumbs 里的根选择器（`.root-picker`）+ 两个加根入口（文件树右键「添加为工作区根」、底栏 cwd 选择器头部「＋ 添加为工作区根」）。

### 2.2 文件树只**切换根**，不做合并视图
一个根一个根地浏览（`list_files` 本来就吃任意绝对路径）。合并多根树 = 多份并发列表 + 虚拟层级，
收益不明、复杂度高，明确不做。

### 2.3 内置「文件」tab 也**可以**被隐藏
`RightPanel` 尊重 `host:right-files` 的 `hidden`（用户偏好 / 插件 arrange）。否则布局页那个勾选框
就是摆设，「设置里看到的 == 界面上看到的」这条 #146 核心不变量当场破产。全藏光时右栏为空 —— 那是
用户/插件的明确意愿，布局页「恢复」一键可退。

### 2.4 `host.ui.register` 与 manifest **同一套解析**
运行时注册也走 `UI_SLOT_ALIASES` + `UI_SLOTS` 校验（以前不映射别名、不校枚举 → 插件写
`slot: "topbar"` 会得到一个前端不认识的 slot，表现成「注册了但界面上没有」，最难排）。
`parseUiArrange` 的 `slot` 仍只收完整枚举名（既有契约，别顺手改）。

### 2.5 `PLUGIN_API_VERSION` 1 → 2 的含义
新能力（`ui` 族、跨目录 fs、`project`、多根）算 v2 契约。升到 2 后：`apiVersion: 2` 的插件**必须**
声明 `permissions`（否则默认拒绝 + `console.error`），manifest 侧的 `ui` 门控也与 `can()` 同口径了
（`scan()` 里原来只看 permissions，不看 apiVersion —— 已修）。仓库里的官方插件都没写 `apiVersion`，
不受影响（仍是旧全权模式：放行 + 每次激活警告一次）。

### 2.6 隐藏的内置顶栏入口在「⋯」溢出菜单里**必须真的可点**
`App` 的 `onUiAction` 只分发**插件**动作；`host:*` 的实现留在拥有它的组件里（T1 的教训）。
所以 `TopBar` 自己有一份 `dispatchHostOverflow`（history / files / new-chat / search / tasks / settings →
本地处理器），溢出菜单先问它、再回落 `onUiAction`。**新增可隐藏的宿主入口时记得在这里补一条**，
否则用户会得到一个点了没反应的按钮。顺带修掉了溢出菜单把宿主图标词表名（`folder`）当文字显示的问题。

### 2.7 授权落表即重推
`host.fs.requestAccess` 成功后经 `PluginManager.onGrantsChanged` → `index.ts` 的 `pushPluginGrants()`，
设置面板「已授权目录」即时可见（以前只在 attach / 撤销时推，「点了允许但列表里没出现」）。

---

## 3. 内置条目现在**真的**听布局页（本轮补齐，别退回）

初版只有部分渲染层消费 slot（其它写死在组件 JSX 里 → 布局页的勾选框是摆设，见 git 历史里的
`ui-slots.ts` 注释「位置登记，由渲染层决定画不画」）。**本轮把宿主内置条目也接进了 slot 渲染**：

| 位置 | 渲染层 | 隐藏 | ↑↓ 调序 |
|---|---|---|---|
| 顶栏视图三连 / 右上固定开关（历史·文件·新对话） | `hostOn()` 门禁 | ✅（隐藏的从「⋯」菜单点回来） | 结构固定 |
| 顶栏「桌面工具组」（搜索/浏览器/任务/设置/声音/语言/主题/版本/GitHub） | `TopBar.tsx` 的 `hostNodes` 节点工厂，按 `uiPrimary` 顺序画 | ✅ 进「⋯」菜单（**菜单型整块组件搬过去**：`OVERFLOW_AS_NODE_IDS`） | ✅ 真的换位置 |
| 底栏 | `FooterBar.tsx` 的 `hostNodes` + `bottombarItems` 顺序 | ✅ | ✅ 真的换位置 |
| 消息 hover 工具条 | `Message.tsx` 跳 `hidden` | ✅（全隐藏 ⇒ 整条容器不画） | ✅（按数组顺序拼） |
| 右栏 tab | `RightPanel.tsx` 按 `uiRightPanelTabs` 顺序 | ✅（含内置「文件」tab） | ✅ |
| 四处 `contextmenu.*` | `LeftPanel` / `RightPanel` 跳 `hidden` | ✅（一条不剩就不弹空菜单） | ✅（数组顺序即菜单顺序） |

**新增/改渲染层时必须在渲染组件里接上**（§2.6 那条纪律的另一半）：

1. 新增一个可隐藏/可排序的宿主入口 → 在拥有它的组件里加一份 **id → 节点/处理器** 映射
   （`hostNodes` 或 `dispatchHostOverflow` 那种），并确保 `uiPrimary`/`bottombarItems` **没传**时
   回退成「按内置默认顺序全画」（拿不到 slot 数据就把整条顶栏/底栏清空是最糟的降级）。
2. 顶栏的**容器划分**（品牌区 / 视图条 / 桌面组 / 右上固定开关）是结构性的：↑↓ 只在桌面组与底栏
   真的换位置，跨容器调序不可表达；窄屏 `.topbar-more` 折叠面板完全不参与 slot（它不是同一批入口）。
3. 右栏插件 tab / 插件页会随选中项卸载（`SlotTabs` 的取舍：让插件 cleanup 生效，代价是 tab 内部
   状态不保）。要保状态就把状态提到上层组件 —— 别改成 `display:none` 全留。

回归网：`tests/ui-layout-ui-test.mjs`（真 Chrome，43 checks：插件 arrange 藏宿主条目 / 插件条目与宿主同排 /
右栏 tab 顺序 / 勾掉与 ↑↓ 真的生效 / 隐藏的菜单型条目在溢出菜单里还能用 / 消息工具条整条不画）。

## 4. 还剩什么（发版收口）

1. **版本号 + CHANGELOG 复核**：`package.json` / `package-lock.json` 同步升版本；确认
   `CHANGELOG.md` 的 Unreleased 段落把本轮写全（已由上一轮改动写了 `### Added` 与 `### i18n`，
   复核一遍即可）；`npm run changelog:i18n` 在有文案增减时必跑。
2. **#146 issue 回帖**（可选）：写清「裁剪版 → 完整版」的落地结果（11 个挂载点、四级优先级、
   目录授权、项目组装、多根、会话 API、后台作业、市场同步）。
3. **发布**：`git push` → 打 tag → Action 建 Release + 出桌面包 → `npm publish`；升级后
   `pi-web-ui server restart`（服务端改了插件宿主与快照，不重启不生效）。
4. **可选增强**（都不是必须）：
   - 右栏多根的合并视图（现在只支持切换根）；
   - 设置面板里直接管理「额外工作区根」（现在只能从文件树右键加减）；
   - `kind="organizer"` 目前只在协议词表与 `UI_KINDS` 里存在，各渲染层无专门处理；
   - 顶栏跨容器调序（要把品牌区/视图条/桌面组/固定开关合成一条 slot 序列，改动面大）。

---

## 5. 硬约束与坑（必读）

### 5.1 工具坑
- **不要用 `edit_soft`**：它对多行块（尤其含 `}` 结尾）会匹配错位，实测弄坏过 `protocol.ts`、
  `use-chat.ts`、`ChatInput.tsx`。用**精确 `edit`** 或（更稳）**写临时 node/python 脚本做字符串/行级替换**。
- 写临时脚本时：**每次替换后就 `writeFileSync`**（或最后统一写但先确认无中途抛错），失败路径也要清干净
  （临时脚本命名 `.pi-tmp-*` / 放 `tests/scratch/`，用完立刻 `rm`，`git status` 里别留 `??`）。

### 5.2 工作区
- 工作区有**大量未提交改动**（含别人的 #145/#147 修复）。**不要 `git checkout --` 整目录**，
  也不要 `git stash`；需回滚单个文件时先 `git diff <file>` 确认那文件里没有别人的改动。
- 服务端改动后要 **`pi-web-ui server restart`**（或重启 dev server）才生效；前端要 `npm run build`。

### 5.3 接入新挂载点时的纪律
1. **内置条目的实现留在组件内**，`host:*` 由该组件按 id 显式分派（App 只分发插件动作）
2. `hidden === true` 的条目：有"溢出"概念的地方（顶栏）**移到溢出菜单**（且必须真的可点），
   没有的地方（底栏/右键）**直接跳过** —— 用户永远能在设置面板「界面布局」里改回来
3. 条目顺序**严格按传入数组**（宿主已排好序，组件不要再排一次）
4. 无条目时**不要渲染空容器**
5. 组件里不要 import `styles.css`；新类名把 CSS 片段加进 `styles.css` 的「插件 UI 扩展点」分区

### 5.4 测试规范
- 单测：`tests/unit/*.test.ts`（vitest）；E2E：`tests/*-test.mjs`（自起 server，端口 ≥8900，
  临时 data-dir，结束精确清理自己进程，**禁用 `pkill -f`**）
- 需要 Chrome 的浏览器 E2E 放在 `tests/`，**不入 `run-smoke.mjs`**（CI 不一定有 Chrome），
  文件头写清「缺 Chrome 自动 SKIP」
- 加了新的零 token 协议脚本 → 记得加进 `tests/run-smoke.mjs` 的 `ALL` 列表
- **浏览器 E2E 的两个实测坑**（写新脚本时直接抄现有脚本的 `tap` / `settle` 助手）：
  1. `locator.click()` 在顶栏上偶发不达（悬停时子节点位移，事件没冒泡到按钮）→ 用
     「按坐标派发真实鼠标事件」（`tap()`）；右键菜单要用 `page.mouse.click(x, y, {button:"right"})`
  2. 服务端刚 `build` 过时页面会**自愈重载一次**（PR #144），会把刚打开的弹窗清掉 →
     操作前先 `settle()`（连续 2.5s 没有导航）或对「打开弹窗」这类动作带重试
  3. 别用 `title*="文件"` 找右栏开关 —— 全局搜索的提示文案里也有「文件」，会点开搜索弹窗
     盖住整页（要精确匹配 `title="文件列表"`）

### 5.5 i18n
- 前端 key：`web/src/i18n.tsx` 的 `zh` + `en`，**同时**补 `locales/*.json` 的 8 个语言包
  （顺序与 zh 一致、值先用英文），否则 `tests/unit/locales.test.ts` 红
- 服务端文案：`pick(lang, zh, en, "key", vars)` / `getServerBlock`；`bilingual()` 用于 tool 定义

---

## 6. 验证命令（每次收口都跑）

```bash
npm run typecheck        # 五套 tsc（server/web/tests/desktop/extension）
npm run format && npm run format:check
npm run lint             # 基线 = 3 warnings（model-admin / mermaid / marker-service）
npx vitest run           # 期望 101 文件 / 1301 用例全绿
npm run build
# 真 Chrome（本地跑；CI 里自动 SKIP）
node tests/plugin-topbar-ui-test.mjs
node tests/plugin-settings-page-test.mjs
node tests/context-menu-ui-test.mjs
node tests/ui-layout-ui-test.mjs
node tests/panel-layout-test.mjs
# 零 token 协议冒烟（本地 / CI 同款）
node tests/run-smoke.mjs workspace-roots-test plugin-grants-test settings-test \
  plugin-test plugin-jobs-test plugin-settings-test left-panel-delete-test
```

---

## 7. 关键文件地图

| 层 | 文件 | 作用 |
|---|---|---|
| 契约 | `server/protocol.ts` | `UiSlotId` / `UiContribution` / `UiArrangeOp` / `UiPluginUi` / `UiLayoutPrefs` / `workspaceRoots` / 授权消息 |
| 服务端 | `server/plugins.ts` | manifest `ui` 解析 + 权限门控 + `host.ui.*` / `host.fs.*`（含跨目录）/ `host.project` + `notifyWorkspaceRoots` |
| 服务端 | `server/plugin-grants.ts` | 目录授权表 |
| 服务端 | `server/plugin-project.ts` | 项目组装（clone/写文件，越界拒绝） |
| 服务端 | `server/plugin-installer.ts` | 插件后台作业（#152） |
| 服务端 | `server/client-state.ts` | `normalizeWorkspaceRoots` + 按项目存根 |
| 服务端 | `server/agent-service.ts` | `ClientSession.setWorkspaceRoots` / 快照 / `onCwdChanged(abs, roots)` |
| 服务端 | `server/index.ts` | 分发：`plugin_job*` / `plugin_path_*` / `set_settings.uiLayout` / `set_workspace_roots` / attach 推 `plugin_grants` |
| 前端 | `web/src/ui-slots.ts` | 内置条目 + 四级优先级合并（**排序/可见性的唯一事实源**） |
| 前端 | `web/src/context-menu-state.ts` + `components/ContextMenu.tsx` | 通用右键菜单 |
| 前端 | `web/src/components/PluginPage.tsx` + `SlotTabs.tsx` | 插件页宿主 / slot tab 容器 |
| 前端 | `web/src/plugin-host.ts` | `window.__piWebUiHost`（API 版本 **6**） |
| 接入点 | `TopBar.tsx`（含 `dispatchHostOverflow`）/ `FooterBar.tsx` / `ChatInput.tsx` / `Message.tsx` / `MessageList.tsx` / `RightPanel.tsx`（含根选择器）/ `LeftPanel.tsx` / `App.tsx` | 已接入的挂载点与 props 传递 |
| 面板 | `web/src/components/SettingsModal.tsx` | 「界面布局」页 + 「已授权目录」段 + 插件自定义页 |

---

## 8. 契约速查

### 8.1 插件怎么声明（manifest.json）
```jsonc
{
  "permissions": ["ui", "fs"],   // apiVersion: 2 时**必须**声明（严格模式按族门控）
  "ui": {
    "topbar": [{ "id": "inbox", "label": "收件箱", "labelEn": "Inbox", "icon": "📬",
                 "kind": "action", "action": "webmail:open-inbox", "group": "mail", "order": 10 }],
    "composer": [{ "id": "pick", "label": "拾取元素", "kind": "action", "action": "webmail:pick" }],
    "rightpanel": [{ "id": "mail", "label": "邮件", "kind": "view" }],
    "settings": [{ "id": "conf", "label": "邮箱设置", "kind": "page" }],
    "contextmenu.file": [{ "id": "mail", "label": "发送到邮箱", "kind": "action", "action": "webmail:send" }],
    "arrange": [{ "id": "host:tasks", "hide": true }, { "id": "host:ctx", "order": 5 }]
  }
}
```
（`topbar` / `topbar.more` / `composer` / `message` / `rightpanel` / `settings` 是别名，全名也可用。）

### 8.2 插件怎么接管动作（client bundle）
```js
window.__piWebUiHost?.onUiAction?.("webmail:open-inbox", (itemId) => { /* ... */ });
window.__piWebUiHost?.onTopbarAction?.("webmail:open-inbox", fn);   // 旧名，等价
```

### 8.3 合并优先级
```
宿主默认(BUILTIN_UI_ITEMS) → 插件 items → 插件 arrange(按插件顺序, 只改已存在条目) → 用户偏好(最高)
用户偏好：hidden / shown(覆盖插件 hide 与默认 hidden) / order / groups / labels
```

### 8.4 会话 / 多根 API（宿主桥 v6）
```js
await __piWebUiHost.openSession({ cwd, folders: [extra1, extra2], prompt, newChat });  // 多根 = cwd + 额外根
__piWebUiHost.sessions.list();          // 运行中的对话 + 当前项目历史会话
await __piWebUiHost.sessions.open(id);  // 跨项目会先切 cwd（走目录授权）
```
