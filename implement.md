# pi-web-ui 底栏主机资源监控实施方案

## 0. 文档用途与执行边界

本文件指导实现者在 `pi-web-ui` 中完成“底栏右侧显示服务端主机处理器与内存使用率”功能。执行者应严格按步骤实施、测试并留下可复核证据；完成后停在本地工作区，由主验收 Agent 检查，不提交、不推送、不创建 Pull Request（拉取请求）或 Issue（议题）。

`implement.md` 是本地协作文件，不属于产品代码。它必须保持未跟踪或由 `.git/info/exclude` 本地排除，不能加入 Git 暂存区，不能上传到 GitHub。

执行范围仅包括本方案列出的主机指标采集、协议传输、前端状态、底栏显示、国际化和测试。保留工作区内所有无关改动，尤其不要处理现有的 `docs/research/` 未跟踪目录。

## 1. 目标结果

功能完成后，底栏形成稳定的左右语义分区：

- 左侧继续显示智能体相关信息：连接、引擎、上下文、成本、缓存、消息数、插件状态、工作状态与生成速率。
- 右侧显示服务端主机相关信息：处理器使用率、内存使用率、工作目录。
- 主机指标指运行 `pi-web-ui` 服务进程的机器，不指浏览器所在设备。远程访问时尤其要保持这个语义。
- 桌面端示例：`处理器 18% · 内存 42%`，其后是现有工作目录按钮。
- 指标约每 2 秒更新一次，即使智能体空闲也继续更新。
- 缺少指标时不显示空壳条目；新版前端连接旧版服务时底栏保持可用。
- 主机指标走轻量通道，不进入 `UiState`，不触发完整或增量会话快照，不增加大对话的序列化负担。
- 处理器使用率按整机总容量归一化到 `0–100%`，多核机器不能显示为数百个百分点。
- 内存使用率按 `(总内存 - 空闲内存) / 总内存` 计算并限制在 `0–100%`。
- Windows、Linux 与 macOS 都使用 Node.js 标准库采样，不启动外部命令，不要求新增系统权限或依赖。

## 2. 明确不做的内容

本次保持改动小而聚焦：

- 不增加历史曲线、弹窗、详情面板或设置开关。
- 不显示图形处理器、磁盘、网络或单进程资源。
- 不把指标持久化到客户端状态文件、会话文件或浏览器存储。
- 不把指标放进 `UiState`、`snapshot` 或 `snapshot_delta`。
- 不为这个向后兼容的可选字段提升 WebSocket 协议版本。
- 不新增第三方依赖。
- 不改变工作目录选择器行为。
- 不改变插件底栏条目的业务语义；插件条目仍归左侧信息组。
- 不提交、推送、创建分支、创建拉取请求或发布版本。

## 3. 架构决策

### 3.1 数据通道

扩展现有 `heartbeat` 服务端消息，使它可选携带 `hostMetrics`：

```ts
export interface UiHostMetrics {
	cpuPercent: number | null;
	memoryPercent: number;
}

// ServerMessage 中的分支
| { type: "heartbeat"; hostMetrics?: UiHostMetrics }
```

选择可选字段的原因：

- 旧前端收到多余字段会忽略，保持兼容。
- 新前端收到旧服务端没有字段的心跳时不更新指标并保持隐藏。
- 心跳本来就是全局、低成本、与会话无关的消息，符合主机指标语义。
- 指标不会污染会话快照，也不会增加快照修订号。

`PROTOCOL_VERSION` 保持当前值。只有实现过程中发现旧端会发生功能破坏，而不是单纯缺少新指标时，才暂停并向主验收 Agent 报告；不要自行提升版本。

### 3.2 采样周期

将现有心跳周期从 `10_000` 毫秒调整为命名常量 `2_000` 毫秒。每个周期只采样一次，然后复用同一条序列化消息发给所有已连接 WebSocket 客户端。

约束：

- 采样位置在 `server/index.ts` 的全局心跳计时器，不按客户端创建采样器。
- 多个浏览器标签页不能导致重复读取主机指标。
- 计时器继续在服务关闭时由 `shutdown()` 清理。
- 没有连接时仍可继续更新处理器基线；这避免新连接第一次看到从服务启动至今的长周期平均值。

### 3.3 处理器计算

Node.js `node:os` 的 `cpus()` 为每个逻辑核心返回累计时间。采样模块先把所有核心和所有时间类别求和：

```text
单核心总时间 = user + nice + sys + idle + irq
整机空闲时间 = 所有核心 idle 之和
整机总时间   = 所有核心总时间之和
```

连续两次快照的差值用于计算：

```text
总时间差 = 当前总时间 - 上次总时间
空闲差   = 当前空闲时间 - 上次空闲时间
处理器使用率 = (1 - 空闲差 / 总时间差) × 100
```

边界规则：

- `总时间差 <= 0` 时返回 `cpuPercent: null`，不能返回 `NaN` 或无穷值。
- 最终结果限制在 `0–100`。
- 采样器创建时立即读取一次基线；第一次心跳再读取当前值，因此正常情况下第一条指标消息已有有效处理器百分比。
- 每次采样完成后把“当前快照”保存为下一次的“上次快照”。
- 计算保留浮点数，前端负责四舍五入显示整数。

### 3.4 内存计算

每次采样同时读取 `totalmem()` 与 `freemem()`：

```text
已用内存 = max(0, 总内存 - 空闲内存)
内存使用率 = 已用内存 / 总内存 × 100
```

边界规则：

- 总内存不是正数时返回 `0`。
- 结果限制在 `0–100`。
- 本次界面只显示百分比，不增加字节换算函数，避免无必要的协议字段与格式化逻辑。

### 3.5 底栏分组

不要仅依赖某个条目的 `margin-left: auto`。`FooterBar` 应显式渲染两个容器：

```text
footer.statusbar
├── .statusbar-left   智能体与插件条目
└── .statusbar-right  主机资源与工作目录
```

分组规则是单一事实源：

- `host:host-metrics` 与 `host:cwd` 放入右侧。
- 其他宿主条目与插件条目放入左侧。
- 每个组内部独立插入 `·` 分隔符，两个组之间不绘制分隔符。
- 条件渲染结果为 `null` 的条目不留下孤立分隔符。
- 底栏布局设置仍能隐藏或调整条目在所属组内的相对顺序。
- 工作目录编辑态的遮罩和选择器仍由 `host:cwd` 节点渲染，不能因分组重构失效。

## 4. 预计改动文件

实施前用 `rg` 确认当前位置，行号可能随远端更新变化，不以本表行号为依据。

| 文件 | 预期改动 |
| --- | --- |
| `server/host-metrics.ts` | 新增主机资源纯计算与可注入采样器 |
| `server/protocol.ts` | 新增 `UiHostMetrics`，扩展 `heartbeat` 可选字段 |
| `server/index.ts` | 创建全局采样器，将指标附加到两秒心跳 |
| `web/src/use-chat.ts` | 保存最新主机指标，断线时清空，处理带指标的心跳 |
| `web/src/ui-slots.ts` | 登记 `host:host-metrics` 底栏宿主条目 |
| `web/src/components/FooterBar.tsx` | 渲染指标并拆分左右容器 |
| `web/src/styles.css` | 左右布局、数字样式与窄屏规则 |
| `web/src/i18n.tsx` | 增加中文与英文文案 |
| `locales/*.json` | 为 8 个外部语言包增加同序键 |
| `tests/unit/host-metrics.test.ts` | 采样计算与基线推进单元测试 |
| `tests/unit/ui-slots.test.ts` | 宿主底栏登记测试 |
| `tests/host-metrics-test.mjs` | 真实服务 WebSocket 指标冒烟测试 |
| `tests/run-smoke.mjs` | 将零令牌指标冒烟测试加入聚合列表 |
| `tests/host-metrics-ui-test.mjs` | 真浏览器底栏位置和窄屏行为回归测试 |

如果实现者发现无需修改其中某个文件，应在交付报告中逐项解释。新增其他产品文件前先说明其不可替代的职责，避免扩散。

## 5. 执行顺序与完成标准

### 步骤 1：同步并确认工作区边界

执行：

```powershell
git status --short --branch
git pull --ff-only
git status --short
```

要求：

- 使用 UTF-8 读取中文文件。
- 记录开始前已有的修改与未跟踪文件。
- 保留 `docs/research/`。
- 确认 `implement.md` 没有被 Git 跟踪或暂存。
- 思考“是否必须写代码”：本功能需要服务端真实主机数据，浏览器无法可靠读取远程服务主机资源，因此必须增加服务端采样和协议传输。

完成标准：远端已同步，原有改动清单已记录，实施范围没有覆盖用户文件。

### 步骤 2：红灯一——定义采样行为

先新增 `tests/unit/host-metrics.test.ts`，生产模块此时尚不存在。为避免“模块找不到”成为测试基础设施错误，初始测试使用变量路径动态导入并捕获导入失败，然后让行为断言得到 `undefined` 而失败。生产模块出现后，在重构阶段改成静态导入。

至少覆盖以下用例：

1. `previous={idle:100,total:400}`、`current={idle:140,total:500}`，总内存 `1000`、空闲内存 `250`，结果必须为处理器 `60`、内存 `75`。
2. 总时间差为 `0` 时处理器结果为 `null`。
3. 异常输入不会越界：空闲差小于 `0` 时结果不得超过 `100`；空闲差大于总差时结果不得小于 `0`。
4. 总内存为 `0` 时内存结果为 `0`。
5. 可注入采样器连续读取三个快照，第一次调用使用第 1、2 个快照，第二次调用使用第 2、3 个快照，证明基线每次推进。

运行：

```powershell
npx vitest run tests/unit/host-metrics.test.ts
```

红灯标准：测试以断言失败结束，原因是目标行为尚不存在；不能是语法错误、路径拼写错误或测试框架错误。保存失败摘要用于最终报告。

### 步骤 3：绿灯一——实现纯采样模块

新增 `server/host-metrics.ts`。建议公开以下最小接口，命名可以等价调整，但职责不能混合：

```ts
import type { UiHostMetrics } from "./protocol.js";

export interface HostResourceSnapshot {
	cpuIdle: number;
	cpuTotal: number;
	memoryFree: number;
	memoryTotal: number;
}

export function calculateHostMetrics(
	previous: HostResourceSnapshot,
	current: HostResourceSnapshot,
): UiHostMetrics;

export function createHostMetricsSampler(
	readSnapshot?: () => HostResourceSnapshot,
): () => UiHostMetrics;
```

实现要点：

- 默认读取器使用 `cpus()`、`freemem()`、`totalmem()`。
- 累计每个核心的 `user`、`nice`、`sys`、`idle`、`irq`。
- 纯计算函数不读取系统，不依赖时间，不修改入参。
- 采样器只持有一个“上次快照”。
- 不使用 `process.cpuUsage()`；该接口只表示当前 Node.js 进程，不符合整机需求。
- 不使用性能计数器命令、PowerShell、`top`、`wmic`、`ps` 或第三方包。

完成实现后，将测试改为静态导入真实导出，再运行：

```powershell
npx vitest run tests/unit/host-metrics.test.ts
```

绿灯标准：所有采样用例通过，无警告、无非有限数字。检查每个新公开函数至少被一个真实行为测试覆盖。

### 步骤 4：红灯二——定义 WebSocket 传输契约

新增 `tests/host-metrics-test.mjs`，沿用现有自启动服务测试风格：

- 使用 `30000–39999` 的随机本地端口，避免与固定端口测试冲突。
- 使用临时 `PI_WEB_DATA_DIR`，工作目录指向仓库根。
- 启动 `node dist/server/index.js`。
- 等待端口可用后连接 `/ws` 并发送合法 `hello`。
- 等待一条 `heartbeat`，要求存在 `hostMetrics`。
- 断言 `cpuPercent` 是 `null` 或 `0–100` 的有限数。
- 断言 `memoryPercent` 是 `0–100` 的有限数。
- 设置明确超时，失败时输出最后收到的消息类型。
- `finally` 中关闭 WebSocket、终止服务并删除临时目录。
- 不发送 prompt，不调用模型，不消耗令牌。

在协议和服务端接线之前先构建并执行：

```powershell
npm run build:server
node tests/host-metrics-test.mjs
```

红灯标准：服务可以启动，但测试因心跳没有 `hostMetrics` 而失败；不能因端口、路径或清理错误失败。

### 步骤 5：绿灯二——接通协议与全局心跳

修改 `server/protocol.ts`：

- 在服务端到客户端类型区域增加纯类型 `UiHostMetrics`。
- 将 `heartbeat` 分支改为带可选 `hostMetrics`。
- 保持文件只有类型导出。
- 不修改 `web/src/types.ts`；它已经通过 `export type *` 复用唯一事实源。
- 不修改两份 `PROTOCOL_VERSION`。

修改 `server/index.ts`：

- 导入 `createHostMetricsSampler`。
- 在 WebSocket 服务器全局范围创建一个采样闭包。
- 用命名常量表达 `2_000` 毫秒心跳周期。
- 每个周期先调用一次采样器，再构造一条满足 `ServerMessage` 的消息。
- 在循环外只执行一次 `JSON.stringify`，在循环内复用字符串发送给所有打开连接。
- 维持现有关闭清理。
- 单个采样异常不能击穿计时器或服务进程：捕获异常时退化为不带指标的普通心跳，并让下一轮继续采样。

重新构建并运行：

```powershell
npm run build:server
node tests/host-metrics-test.mjs
node scripts/check-protocol-sync.mjs
```

绿灯标准：真实服务在超时内发送合法范围的指标，协议同步检查通过，服务退出后没有残留进程。

### 步骤 6：红灯三——登记底栏宿主入口

先修改 `tests/unit/ui-slots.test.ts`：

- 现有“覆盖宿主既有入口”断言加入 `host:host-metrics`。
- 默认底栏顺序断言应明确该项位于 `host:working` 之后、`host:cwd` 之前；不要只用过宽的 `arrayContaining` 掩盖顺序错误。
- 既有 `labelKey` 完整性断言会自动要求新增中文文案存在。

运行：

```powershell
npx vitest run tests/unit/ui-slots.test.ts
```

红灯标准：断言因缺少 `host:host-metrics` 失败。

### 步骤 7：绿灯三——登记入口与国际化文案

修改 `web/src/ui-slots.ts`：

- 新增 `host:host-metrics`。
- `slot: "bottombar"`。
- `kind: "badge"`。
- `order` 放在 `host:working` 与 `host:cwd` 之间，例如 `19`。
- `group` 使用清晰的主机语义，例如 `"host"`。
- `labelKey` 使用 `hostResources`。

修改 `web/src/i18n.tsx` 的中文与英文表，新增且只新增以下语义键：

- `hostResources`：中文“主机资源”，英文“Host resources”。
- `hostProcessor`：中文“处理器”，英文“CPU”。英文悬浮提示需通过 `hostResourcesTip` 展开为 Central processing unit (CPU)。
- `hostMemory`：中文“内存”，英文“Memory”。
- `hostResourcesTip`：中文“运行 pi-web-ui 服务的主机 · 中央处理器（CPU）和内存使用率”，英文“Host running pi-web-ui · Central processing unit (CPU) and memory usage”。

将相同键按与中文表完全一致的顺序加入以下 8 个语言包：

- `locales/de.json`
- `locales/es.json`
- `locales/fr.json`
- `locales/it.json`
- `locales/ja.json`
- `locales/ko.json`
- `locales/pt.json`
- `locales/ru.json`

翻译应简洁自然；`CPU` 首次出现的提示文案需要在相应语言中展开或明确指向中央处理器。不要改语言包 `version`，除非仓库现有规则明确要求。

运行：

```powershell
npx vitest run tests/unit/ui-slots.test.ts tests/unit/locales.test.ts
npm run i18n:diff
```

绿灯标准：宿主登记与全部语言包键序一致，国际化差异脚本没有缺失键。

### 步骤 8：红灯四——定义前端可观察行为

新增 `tests/host-metrics-ui-test.mjs`，采用现有 Playwright 浏览器回归脚本结构：

- 随机本地端口和临时数据目录。
- 检测不到 Chrome 时打印明确的 `SKIP` 并以 `0` 退出；该脚本不加入默认 `run-smoke` 清单。
- 启动构建后的服务并打开页面。
- 等待 `.status-host-metrics` 出现。
- 文本同时包含处理器标签、`0–100%` 数值、内存标签、`0–100%` 数值。
- 元素 `title` 包含“运行 pi-web-ui 服务的主机”语义。
- `.statusbar-left` 和 `.statusbar-right` 都存在。
- 指标与工作目录都在 `.statusbar-right` 内。
- 指标的水平位置在工作目录左边。
- 视口宽度设为 `520` 像素时指标隐藏，工作目录仍可见。
- 恢复桌面宽度后指标重新出现。
- 截图只在失败时写入 `tests/scratch/`，不要加入版本控制。
- 清理浏览器、服务与临时目录。

先构建当前前端并执行：

```powershell
npm run build
node tests/host-metrics-ui-test.mjs
```

红灯标准：有 Chrome 时测试因目标元素不存在而失败。若环境没有 Chrome，记录跳过原因，继续实施，最终由主验收 Agent 在可用环境补验。

### 步骤 9：绿灯四——前端状态与底栏渲染

修改 `web/src/use-chat.ts`：

- `ChatState` 增加 `hostMetrics: UiHostMetrics | null`。
- 初始值为 `null`。
- `Action` 增加窄动作，例如 `{ type: "host_metrics"; metrics: UiHostMetrics }`。
- reducer 收到动作时只替换 `hostMetrics`，保持其他引用不变。
- 连接状态变为 `closed` 时清空 `hostMetrics`，避免断线后继续展示过时数字。
- WebSocket `heartbeat` 分支只在 `msg.hostMetrics` 存在时分发；没有字段时直接忽略，保证旧服务兼容。
- 不把高频指标写入 `app-globals.ts`；`FooterBar` 已经接收整个 `ChatState`，无需增加全局订阅。

修改 `web/src/components/FooterBar.tsx`：

- `FALLBACK_BOTTOMBAR` 在 `host:working` 后、`host:cwd` 前加入 `host:host-metrics`。
- `hostNodes` 增加指标节点；`chat.hostMetrics === null` 时返回 `null`。
- 显示整数百分比，使用 `Math.round`，文本为：

```text
处理器 {cpu}% · 内存 {memory}%
```

- `cpuPercent === null` 时仅处理器值显示 `—`，内存仍显示。
- 外层类名包含 `status-item status-host-metrics`。
- `title` 由 `hostResourcesTip`、处理器与内存当前值组成，不写死中文。
- 数值节点可增加 `aria-label`，让读屏能获得完整含义。
- 把已生成的 `items` 按第 3.5 节规则分成 `leftItems`、`rightItems`。
- 抽取局部渲染逻辑时保持分隔符行为一致；如果新增独立函数，应先增加对应纯函数测试。
- 使用 `<div>` 作为左右容器，因为工作目录编辑节点包含块级遮罩与面板，不能包在 `<span>` 内。

修改 `web/src/styles.css`：

```css
.statusbar-left,
.statusbar-right {
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 0;
}

.statusbar-left {
	flex: 1 1 auto;
	overflow: hidden;
}

.statusbar-right {
	flex: 0 0 auto;
	margin-left: auto;
}

.status-host-metrics {
	flex-shrink: 0;
	font-variant-numeric: tabular-nums;
}
```

同时完成：

- 从 `.status-cwd` 移除 `margin-left: auto`，右对齐职责交给 `.statusbar-right`。
- 在现有 `@media (max-width: 768px)` 底栏规则中确保指标不会被通用选择器误隐藏。
- 增加 `@media (max-width: 560px)`，隐藏 `.status-host-metrics`，保留工作目录与现有手机信息。
- 保持底栏单行、工作目录省略号和选择器定位行为。
- 不增加动画或颜色告警阈值；本次只解决稳定监控与信息分区。

构建并运行浏览器测试：

```powershell
npm run build
node tests/host-metrics-ui-test.mjs
```

绿灯标准：有 Chrome 时所有位置、文本与窄屏断言通过；没有 Chrome 时构建必须通过，并把跳过记录交给主验收 Agent。

### 步骤 10：把协议冒烟纳入持续集成

在 `tests/run-smoke.mjs` 的 `ALL` 中加入 `host-metrics-test`。位置放在其他轻量协议测试附近，并用一行注释说明它验证“全局主机采样经心跳推送，不调用模型”。

单独运行聚合目标：

```powershell
node tests/run-smoke.mjs host-metrics-test
```

完成标准：聚合器识别新名称并报告 `1/1 通过`，没有孤儿服务进程。

### 步骤 11：完整验证

按顺序运行，任何失败都先定位本次改动是否引入，修复后从对应命令重新执行：

```powershell
node scripts/check-protocol-sync.mjs
npm run typecheck
npx vitest run tests/unit/host-metrics.test.ts tests/unit/ui-slots.test.ts tests/unit/locales.test.ts
node tests/run-smoke.mjs host-metrics-test
npm run build
npm run lint
npm run format:check
git diff --check
```

如果时间和环境允许，再运行：

```powershell
npm test
npm run test:smoke
node tests/host-metrics-ui-test.mjs
```

验证时必须阅读完整退出码和失败计数，不能以部分输出推断成功。格式化检查失败时，只格式化本次修改文件，避免重写无关文件。

完成标准：必跑命令全部退出 `0`；可选全量命令的结果逐项记录；任何环境型跳过都有明确原因。

### 步骤 12：自审与交付

执行：

```powershell
git status --short
git diff --stat
git diff -- server/host-metrics.ts server/protocol.ts server/index.ts web/src/use-chat.ts web/src/ui-slots.ts web/src/components/FooterBar.tsx web/src/styles.css web/src/i18n.tsx locales tests
```

逐项确认：

- `implement.md` 未出现在已跟踪或暂存变更中。
- `docs/research/` 未被改动、删除或加入暂存区。
- 没有改动 `package.json` 或锁文件，因为没有新增依赖。
- 没有提升协议版本。
- 指标没有进入 `UiState` 或快照。
- 一次心跳只采样、序列化一次，连接数量不改变采样次数。
- 断线会清空旧指标。
- 旧服务缺少可选字段时前端不报错。
- 主机指标和工作目录位于右侧容器。
- 小于等于 `560` 像素时指标隐藏。
- 所有新增用户文案都有中文、英文及 8 个语言包键。
- 测试确实覆盖错误分支与真实 WebSocket 接线，不只检查源码文本。
- 没有暂存、提交、推送或外部操作。

交付报告必须包含：

1. 完成的行为摘要。
2. 实际修改文件列表。
3. 每个红灯测试的预期失败原因摘要。
4. 每个验证命令、退出码与通过数量。
5. 浏览器测试是否运行；若跳过，写明缺失条件。
6. 未解决风险或“无”。
7. `git status --short` 的最终输出。
8. 一段符合项目规范的中文 Conventional Commits 提交说明，但不要执行提交。

完成标准：报告证据足够让主验收 Agent 不依赖口头结论即可复核实现。

## 6. 实现细节参考

### 6.1 主机指标类型位置

`UiHostMetrics` 放在 `server/protocol.ts` 靠近 `UiServiceInfo` 或其他服务级状态类型的位置。它不是会话统计，不应嵌入 `UiState.stats`。

### 6.2 前端百分比显示

服务端已经保证范围，前端仍应以防御式方式显示：

```ts
const cpu = metrics.cpuPercent === null ? "—" : `${Math.round(metrics.cpuPercent)}%`;
const memory = `${Math.round(metrics.memoryPercent)}%`;
```

如果收到非有限数，显示 `—`，避免 `NaN%` 出现在界面。不要为此引入复杂格式化库。

### 6.3 心跳错误退化

默认采样器读取标准库通常不会抛错，但计时器边界应保护服务进程：

```ts
let message: ServerMessage = { type: "heartbeat" };
try {
	message = { type: "heartbeat", hostMetrics: sampleHostMetrics() };
} catch {
	// 继续发送普通心跳，下一轮重试采样。
}
```

注释只说明“为什么仍发送普通心跳”，不要记录设计讨论或历史版本。

### 6.4 插件与用户布局兼容

`BUILTIN_UI_ITEMS` 是设置面板“界面布局”的登记册。新增指标必须登记，使用户能隐藏它。`FooterBar` 的实际渲染继续以 `bottombarItems` 为准；仅在未接线或单测没有提供时使用 `FALLBACK_BOTTOMBAR`。

右侧分组是宿主语义，不由插件 `group` 字段决定。插件可改变条目顺序与可见性，但不能把普通插件按钮隐式变成主机指标。若插件把 `host:host-metrics` 调整到别的 slot，`FooterBar` 自然收不到它，不需要额外补偿。

### 6.5 容器环境说明

Node.js 标准库返回服务进程当前运行环境可见的资源。容器部署中，这可能受容器运行时与平台资源限制影响。本次不增加“物理宿主”和“容器配额”切换，也不在界面中作无法保证的物理主机声明；统一表述为“运行 pi-web-ui 服务的主机/环境”。

## 7. 主验收 Agent 检查表

主验收 Agent 在实现者交付后独立执行，不接受实现者的“已通过”作为证据：

1. 读取 `git status --short` 与完整差异，确认范围、无关文件和本地计划文件状态。
2. 检查 `UiHostMetrics` 是服务级类型且字段为可选心跳扩展。
3. 检查采样器按所有核心累计时间差计算，而不是 Node.js 进程使用率或单次累计比例。
4. 检查多客户端只共享一次采样和一次序列化。
5. 检查前端断线清空、旧心跳兼容和非有限值降级。
6. 检查底栏真实 DOM 左右分组，工作目录编辑态仍可用。
7. 检查 8 个语言包键序、占位符和文案。
8. 重新运行步骤 11 的必跑命令，不复用实现者旧输出。
9. 有 Chrome 时重新运行 UI 回归，并人工查看桌面宽度与 `520` 像素宽度。
10. 如发现问题，只给出具体文件、行为、复现命令和期望结果；修复后重新走对应红绿验证。

验收通过的充分条件：目标结果全部满足，必跑验证有当前工作区的新鲜成功输出，无未解释的失败或跳过，无外部提交行为。
