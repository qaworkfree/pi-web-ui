/**
 * pi-web-ui 插件管理器 —— 可选界面组件的加载与桥接。
 *
 * 一个插件 = <dataDir>/plugins/<id>/ 目录：
 *   manifest.json   元数据 { id?, name, version?, description? }（id 缺省取目录名）
 *   index.mjs       服务端入口（可选）：export default { activate(host) → deactivate? }
 *   client/         前端资源（可选），经 /plugins/<id>/client/* 以静态文件暴露；
 *     entry.mjs      视图入口：export default { mount(el, ctx) → cleanup? }
 *
 * 设计要点：
 * - 不装即不存在：目录不在就没有任何协议/UI 痕迹；每次客户端 attach 时重扫目录，
 *   新丢进来的插件无需重启服务即可出现在顶栏（import 只做一次并缓存）。
 * - id 必须匹配 ID_RE，防路径穿越；client 静态服务同样逐段校验。
 * - host 窄接口：broadcast(pluginId, payload) 广播 plugin_data、onMessage 注册
 *   客户端上行处理、dataDir/cwd/log 环境。发送通道由 index.ts 注入（每个 socket
 *   的 send 函数），插件本身不接触 ws。
 * - activate 抛错只标记 error 字段并记日志，绝不影响主进程。
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	ServerMessage,
	UiMessage,
	UiPluginInfo,
	UiContribution,
	UiArrangeOp,
	UiPluginUi,
	BgServer,
	UiPluginSettingField,
	UiPluginCatalogEntry,
} from "./protocol.js";
import { pick, type ServerLang } from "./i18n.js";
import { PluginStorage, PluginSecrets, ensurePluginDeps, WorkspaceFS } from "./plugin-facilities.js";
import { readCatalog, addCustomEntry, removeCustomEntry, type CatalogAddInput } from "./plugin-catalog.js";
import { PluginGrantsStore, normalizeGrantPath } from "./plugin-grants.js";
// 工作区根的归一化与 client-state 共用一份（同一份语义：只收绝对路径 / 去重 / 上限）。
import { normalizeWorkspaceRoots } from "./client-state.js";
import { createProject, type ProjectCreateSpec, type ProjectCreateResult } from "./plugin-project.js";
import type { Request, Response } from "express";
import { createHash } from "node:crypto";

/** 合法插件 id：字母/数字/下划线/连字符，防路径穿越（同 themes.ts 的做法）。 */
const ID_RE = /^[A-Za-z0-9_-]+$/;

/** 插件收到的工具执行事件（agent-service 的 SDK tool_execution_start/end 转发）。 */
export interface PluginToolEvent {
	phase: "start" | "end";
	toolName: string;
	/** 事件所属对话（会话未就绪时可能为空）。 */
	conversationId?: string;
	/** SDK 工具调用 id（start/end 成对关联；旧插件忽略即可）。 */
	toolCallId?: string;
	/** end 独有：真实执行耗时毫秒 / 是否报错。 */
	durationMs?: number;
	isError?: boolean;
}

/**
 * 当前打开对话的快照（host.getActiveConversation 返回，轨迹类插件用）。
 * messages/streamingMessage 是服务端只读缓存对象的引用——插件只读、不得修改，
 * 要广播/持久化必须先抽成摘要（截断封顶），禁止原样下发（单条可达 200K）。
 */
export interface PluginConversationSnapshot {
	conversationId: string;
	title: string;
	/** 该对话最近活跃毫秒时间戳（多客户端时取最新者为“当前打开”）。 */
	at: number;
	isStreaming: boolean;
	messages: UiMessage[];
	streamingMessage: UiMessage | null;
	stats: {
		totalMessages: number;
		tokens: { input: number; output: number; total: number };
		cost: number;
	};
}

/**
 * 插件收到的智能体运行轨迹事件（agent-service 的 SDK 事件流转发，
 * host.onRunEvent 订阅）。一次用户任务对应一组事件：
 * run_start → (turn_start/message/tool_start/tool_end…交错) → run_end。
 *
 * 轨迹视图插件（如 run-trace）靠它把「收到任务 → 思考 → 工具调用 →
 * 文件改动 → 产出结果」聚成时间线；payload 全部截断封顶，可直接存/广播。
 */
export interface PluginRunEvent {
	type: "run_start" | "run_end" | "turn_start" | "turn_end" | "message" | "tool_start" | "tool_end";
	/** 事件所属对话。 */
	conversationId?: string;
	/** 事件毫秒时间戳（服务端时钟）。 */
	at: number;
	/** run_start：触发本轮的用户任务文本（截断 500 字；steer 等内部续跑为空）。 */
	task?: string;
	/** message：已定稿的一条消息（serialize.ts 同形，文本/参数已截断）。 */
	message?: UiMessage;
	/** tool_start/tool_end：SDK 工具调用 id（成对关联）。 */
	toolCallId?: string;
	/** tool_start/tool_end：工具名。 */
	toolName?: string;
	/** tool_start：调用参数 JSON（截断 4k）。 */
	argsText?: string;
	/** tool_end：结果文本预览（截断 4k）。 */
	resultText?: string;
	/** tool_end：真实执行耗时毫秒 / 是否报错。 */
	durationMs?: number;
	isError?: boolean;
	/** run_end：末条 assistant 的 stopReason（"aborted" 等，无则省略）。 */
	stopReason?: string;
}

/** 插件发起的无头 agent 调用请求（微信通道等外部消息驱动 agent 用）。
 *  fire-and-forget：prompt 投递即返回，运行结果经 onRunEvent(run_end)
 *  按 conversationId 关联（插件侧收尾回包）。 */
export interface PluginChatRequest {
	/** 送给 agent 的任务文本（插件应已拼好发送者前缀、裁剪封顶）。 */
	text: string;
	/** 通道内的账号标识（多账号隔离：每个 accountId 独立伪客户端/会话）。 */
	accountId?: string;
}

/** host.chat 的投递回执（运行中，结论经 run_end 事件）。 */
export interface PluginChatResult {
	conversationId: string;
	clientId: string;
}

/**
 * 插件注册的 AI 工具（结构化定义，与 SDK ToolDefinition 解耦——由
 * agent-service 负责转换）。execute 返回 { content, details? }（content 为
 * [{type:"text",text}] 或图片块），或直接返回字符串/对象（自动包成文本）。
 */
export interface PluginAgentTool {
	/** 工具名（建议 <插件名>_<动作> 前缀，如 mail_list；全局唯一，重复注册后者被拒）。 */
	name: string;
	/** UI 显示标签。 */
	label?: string;
	/** 给 LLM 的工具描述。 */
	description: string;
	/** 可选：出现在系统提示词 Available tools 区的一行摘要。 */
	promptSnippet?: string;
	/** 可选：追加到系统提示词 Guidelines 的要点。 */
	promptGuidelines?: string[];
	/** 参数 JSON Schema（TypeBox/JSON Schema 兼容）。缺省为空对象。 */
	parameters?: Record<string, unknown>;
	/** 执行体；onUpdate 可流式上报部分结果（同形结构）。 */
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: (partial: unknown) => void,
	): Promise<unknown>;
}

/** 插件服务端入口拿到的宿主接口。 */
export interface PluginHost {
	/** 向所有已连接的浏览器广播一条本插件的消息（plugin_data）。 */
	broadcast(payload: unknown): void;
	/** 发一条系统通知条（notice）给所有已连接的浏览器。 */
	notify(level: "info" | "warning" | "error", text: string, textEn?: string): void;
	/** 注册客户端上行消息（plugin_message）处理器；回调第二参为发送方 clientId
	 *  （可用于 sendTo 定向回复）。返回注销函数。 */
	onMessage(handler: (payload: unknown, from?: string) => void): () => void;
	/** 给指定客户端定向发一条本插件消息（不广播）；clientId 来自 onMessage。 */
	sendTo(clientId: string, payload: unknown): void;
	/** 注册「新客户端接入」钩子：每次浏览器 attach（含插件刚激活时已在场的连接、
	 *  以及 plugins_reload 后的重新接入）都会以 clientId 回调。插件应借此主动
	 *  推送自身完整状态（kind:"state" 等）——服务端是唯一事实源，不要依赖客户端
	 *  挂载后自己来拉（裸 ctx.send({action:"state"}) 无 reqId，响应会被客户端的
	 *  pending 匹配静默丢弃，这是已踩过两次的坑）。返回注销函数。 */
	onAttach(handler: (clientId: string) => void): () => void;
	/** 订阅智能体的工具执行事件（bash/读写文件等，start+end 成对）；返回注销函数。 */
	onToolEvent(handler: (ev: PluginToolEvent) => void): () => void;
	/** 订阅智能体的运行轨迹事件（run_start/message/tool_start/tool_end/run_end…
	 *  —— 轨迹/时间线类插件用它聚合「任务 → 思考 → 工具 → 文件改动 → 结果」。
	 *  返回注销函数）。 */
	onRunEvent(handler: (ev: PluginRunEvent) => void): () => void;
	/** 读取当前打开对话的快照（标题/消息/流式消息/统计——轨迹视图直接显示
	 *  打开对话的时间线，不只收录插件安装后的运行）。返回 null = 暂无对话。 */
	getActiveConversation(): PluginConversationSnapshot | null;
	/** 无头调用：把外部通道文本投给 agent（微信等，无浏览器也能跑）。
	 *  fire-and-forget，运行结果经 onRunEvent(run_end) 按 conversationId 关联。
	 *  需要能力 "chat"（manifest.permissions）。宿主未接 chatProvider 时拒绝。 */
	chat(req: PluginChatRequest): Promise<PluginChatResult>;
	/** 订阅「当前打开对话变了」（切历史会话 / 切 running 对话 / 新对话——
	 *  轨迹类插件靠它重拉时间线，否则切会话后视图一直是旧的）。返回注销函数。 */
	onConversationChanged(handler: () => void): () => void;
	/** 注册一个供 AI 调用的工具（新对话创建时带上，已有会话动态注入）；
	 *  返回注销函数——插件可按自己的配置开关随时注册/注销（如邮箱插件的
	 *  「让 AI 管理邮件」开关）。 */
	registerAgentTool(tool: PluginAgentTool): () => void;
	/** 插件自己的持久化目录（<dataDir>/plugins/<id>）——凭据等放这里。 */
	dir: string;
	/** 全局数据目录（~/.pi-web）。 */
	dataDir: string;
	/** 当前智能体工作区——**活的**：跟随任意客户端 set_cwd 成功后的新根，
	 *  插件可随时读；想主动感知变化用 onCwdChange。 */
	get cwd(): string;
	/** 注册工作区切换回调（主应用 set_cwd 成功后以新绝对路径触发）。
	 *  返回注销函数。旧版宿主无此方法（可选链兼容）。 */
	onCwdChange(handler: (cwd: string) => void): () => void;
	/** 注册一个斜杠命令（/name），出现在输入框命令选择器里，服务端拦截执行。
	 *  返回注销函数；重名拒绝（内置命令优先，先注册的插件优先）。 */
	registerCommand(cmd: PluginCommandDef): () => void;
	/**
	 * 宿主 UI 贡献（slot 框架，issue #146 完整版）。需要能力 "ui"。
	 *
	 * 声明式基线写在 manifest 的 "ui" 字段（推荐，随插件开关一起可见）；这里的运行时
	 * API 给"按用户配置动态增删"的场景（例如插件设置里勾选"在顶栏显示收件箱"）。
	 * 两边合并规则：同 id 运行时覆盖 manifest，remove 掉的即使是 manifest 声明的也不出现。
	 *
	 * 宿主负责渲染 / 排序 / 溢出 / 可访问性 / 用户偏好 / 审计（谁改了什么）；
	 * 插件只声明条目 + 提供动作回调（浏览器侧 host.onUiAction），**不碰 DOM**。
	 */
	ui: {
		/** 注册/覆盖条目（同 id 覆盖；最多 32 条）。返回注销函数（移除本次注册的 id）。 */
		register(items: unknown[] | unknown): () => void;
		/** 部分更新一个已存在条目（典型用途：刷新 badge 状态文案）。 */
		update(id: string, patch: Record<string, unknown>): void;
		/** 移除一个条目（manifest 里声明的也能移除，直到 reload 重新解析）。 */
		remove(id: string): void;
		/** 追加整理意图：对宿主内置条目（`host:<name>`）或其它插件条目生效。 */
		arrange(ops: unknown[] | unknown): void;
		/** 当前生效的贡献快照（调试 / 自查用）。 */
		list(): UiPluginUi;
	};
	/** 插件私有 KV 存储（<pluginDir>/storage.json，原子写、卸载即删除）。 */
	storage: {
		get<T>(key: string, fallback?: T): T | undefined;
		set(key: string, value: unknown): void;
		delete(key: string): void;
		all(): Record<string, unknown>;
	};
	/** 加密机密存储（AES-256-GCM；存密码/API key/token 等）。
	 *  明文绝不落盘；拷到别的机器因无宿主密钥解不开。 */
	secrets: {
		set(name: string, value: string): void;
		get(name: string): string | undefined;
		has(name: string): boolean;
		delete(name: string): void;
		list(): string[];
	};
	/** 确保依赖就绪：缺了自动 npm install 到插件目录（单飞合并）。
	 *  resolve 后的 import 才能成功——插件动态加载重型依赖前应 await 它。 */
	ensureDeps(specs: string[], opts?: { onProgress?: (msg: string) => void }): Promise<boolean>;
	/** 挂载 HTTP 路由：实际暴露为 /plugins-api/<id><path>（GET/POST/PUT/DELETE）。
	 *  主站的 PI_WEB_TOKEN 鉴权自动覆盖这些路由；body 已过 express.json 解析。
	 *  handler 抛错由宿主转成 500，不炸进程。返回注销函数。需要能力 "http"。 */
	route(
		method: "GET" | "POST" | "PUT" | "DELETE",
		path: string,
		handler: (req: Request, res: Response) => void,
	): () => void;
	/** 受限工作区文件访问（读/写/列/删）：路径永远锚定「当前工作区根」
	 *  （活值，跟随 set_cwd），越界拒绝——与插件自己 import node:fs 不同，
	 *  这一层是宿主强制执行的。需要能力 "fs"。 */
	fs: {
		list(relDir?: string): Promise<{ name: string; type: "file" | "dir" }[]>;
		read(relPath: string): Promise<Buffer>;
		readText(relPath: string, maxBytes?: number): Promise<string>;
		write(relPath: string, data: string | Uint8Array): Promise<void>;
		remove(relPath: string): Promise<void>;
		/** 请求访问**工作区之外**的目录（issue #146）：宿主在浏览器里弹确认，用户同意后
		 *  记进全局授权表（<dataDir>/plugin-grants.json），之后 requestAccess 直接通过。
		 *  父目录已授权时子目录也算已授权（授权 = 这棵子树交给你了）。 */
		requestAccess(dir: string, reason?: string): Promise<boolean>;
		/** 本插件当前已授权的目录（设置面板里可撤销）。 */
		authorizedDirs(): string[];
		/** 跨目录读写：路径必须已授权（否则抛错，错误信息告诉你先 requestAccess）。 */
		listPath(absDir: string): Promise<{ name: string; type: "file" | "dir" }[]>;
		readPath(absPath: string): Promise<Buffer>;
		readTextPath(absPath: string, maxBytes?: number): Promise<string>;
		writePath(absPath: string, data: string | Uint8Array): Promise<void>;
		removePath(absPath: string): Promise<void>;
	};
	/** 项目组装（issue #146）：在**已授权**的目录里建目录、clone 仓库、写文件。
	 *  典型用法：拿几个仓库拼出一个工作区，再 host.openSession({cwd, roots}) 打开它。
	 *  进度经 notify 广播；失败返回 {ok:false,error}（已完成的步骤在 log 里，不留半成品）。 */
	project: {
		create(spec: ProjectCreateSpec): Promise<ProjectCreateResult>;
	};
	/** 注册一个常驻后台任务（轮询器/连接池/后台 worker…）：出现在顶栏「后台任务」
	 *  面板，用户可一键停止。返回 { update, unregister }。id 在插件内唯一。 */
	registerBackgroundTask(task: {
		id: string;
		/** 面板显示名（如「📬 邮件轮询」）。 */
		label: string;
		/** 停止回调（面板「停止」按钮触发；用户也可能直接 kill 进程树）。 */
		stop?: () => void;
		/** 可选初始状态文案，之后可经 update() 刷新。 */
		status?: string;
	}): {
		update(next: Partial<{ label: string; status: string; stop: () => void }>): void;
		unregister(): void;
	};
	/** 读取宿主管理的设置值（manifest "settings" 声明的字段，storage.json
	 *  存值 + 默认值合并）。插件应以此为准做运行时行为。 */
	getSettings(): Record<string, unknown>;
	/** 订阅「用户在 ⚙ 面板改了这个插件的声明式设置」事件（保存后触发，
	 *  参数为新值对象）；返回注销函数。改完应自行重读 getSettings()。 */
	onSettingsChanged(handler: (values: Record<string, unknown>) => void): () => void;
	/** 带前缀的日志。 */
	log(...args: unknown[]): void;
}

/** 插件运行时 UI 注册（host.ui.*）——与 manifest 基线合并后随 plugins 清单下发。 */
interface UiRuntimeUi {
	/** 运行时注册/覆盖的条目（id → 条目）。 */
	items: Map<string, UiContribution>;
	/** 运行时移除的条目 id（连 manifest 声明的也压住，直到 reload 重解析）。 */
	removed: Set<string>;
	/** 追加的整理意图（与 manifest 的 arrange 顺序拼接）。 */
	arrange: UiArrangeOp[];
}

interface LoadedPlugin {
	info: UiPluginInfo;
	/** deactivate() if the entry provided one. */
	deactivate?: () => void;
	toolHandlers: Set<(ev: PluginToolEvent) => void>;
	/** 运行轨迹事件订阅（host.onRunEvent）。 */
	runHandlers: Set<(ev: PluginRunEvent) => void>;
	/** 对话切换订阅（host.onConversationChanged）。 */
	convChangeHandlers: Set<() => void>;
	/** onAttach 钩子（新客户端接入时逐个回调）。 */
	attachHandlers: Set<(clientId: string) => void>;
	/** onCwdChange 钩子（工作区切换时逐个回调）。 */
	cwdHandlers: Set<(cwd: string) => void>;
	/** 该插件注册的全部 AI 工具注销函数（反激活时逐个调用）。 */
	agentToolUnsubscribers?: Array<() => void>;
	/** 该插件注册的全部斜杠命令注销函数。 */
	commandUnsubscribers?: Array<() => void>;
	/** 该插件挂载的 HTTP 路由表："METHOD /path" → handler。 */
	httpRoutes: Map<string, (req: Request, res: Response) => void>;
	/** manifest.permissions 原始声明（空/缺省 = 未声明，旧全权模式）。错误路径占位可缺省。 */
	permsDeclared?: string[];
	/** 声明中的能力族（去冒号前缀）：fs/net/tools/http/terminal… */
	permFamilies?: Set<string>;
	/** 旧格式全权模式的「未声明」警告是否已发过（每次激活一次）。 */
	legacyWarned?: boolean;
	/** onSettingsChanged 钩子（⚙ 面板保存声明式设置后触发）。 */
	settingsHandlers: Set<(values: Record<string, unknown>) => void>;
}

/** 宿主提供的插件设施版本——manifest 声明的 apiVersion 高于此值则拒绝激活，
 *  插件能拿到明确的「请升级 pi-web-ui」而不是在新接口上莫名 undefined。
 *  1 = 初始：storage/secrets/命令/HTTP 路由/工具注册/受限 fs/后台任务。
 *  2 = issue #146：UI 扩展点（manifest "ui" + host.ui.*）、跨目录 fs（requestAccess /
 *      *Path 族）、项目组装（host.project.create）、多根工作区（set_workspace_roots）。
 *      同时把「未声明 permissions」从旧全权模式改为**默认拒绝**（versionGuard 前移）。 */
export const PLUGIN_API_VERSION = 2;

/** 插件通过 host.registerCommand 注册的斜杠命令。run 的返回值若为非空字符串，
 *  会作为系统通知条回显给发起人；需要富展示的视图插件应改用 broadcast/sendTo。
 *  命令是纯配置动作（不消耗 token），与内置命令同级拦截执行。 */
export interface PluginCommandDef {
	name: string;
	description?: string;
	descriptionEn?: string;
	argumentHint?: string;
	argumentHintEn?: string;
	run(args: string, ctx: { clientId?: string }): unknown | Promise<unknown>;
}

/** 每个插件的 AI 工具注册表（name → 定义）。 */
type AgentToolTable = Map<string, PluginAgentTool>;

/** 插件注册的常驻后台任务（经 host.registerBackgroundTask）。 */
export interface PluginBgTask {
	id: string;
	label: string;
	stop?: () => void;
	status?: string;
	since: number;
}

/** 消息处理器超时：仅作为不再等待的日志阈值（响应由 handler 自己发出）。 */
const MESSAGE_TIMEOUT_MS = 30_000;

/** host.fs 被能力门控拒绝时的共享 rejected promise（类型对齐用）。 */
const NO_FS_PROMISE = Promise.reject(new Error('插件未声明能力 "fs"（manifest.permissions）——请求被拒'));
NO_FS_PROMISE.catch(() => {}); // 避免未处理 rejection 噪音；调用方 await 时拿到错误

/** 每个 WS 连接注册一个 sender；cid() 返回该 socket 的 clientId（attach 前 null）。 */
interface Sender {
	cid: () => string | null;
	send: (msg: ServerMessage) => void;
}

// ---------------------------------------------------------------------------
// 声明式设置 schema（manifest "settings"）
// ---------------------------------------------------------------------------

const SETTING_TYPES = new Set(["text", "password", "number", "boolean", "select"]);

/**
 * 解析 manifest "ui" 的某个 slot 数组 → 规范化条目（issue #146 完整版）。
 *
 * 宽容但不放任：坏字段跳过、id 非法或重复跳过、children 只收一层、文本截断；
 * 不认识的 slot / kind / when 直接丢弃（旧宿主读到新字段也不会崩，新宿主读到旧字段同理）。
 * 归属由宿主决定：全局 id = `<pluginId>:<itemId>`。
 */
const UI_SLOTS: ReadonlySet<string> = new Set([
	"topbar.primary",
	"topbar.overflow",
	"bottombar",
	"composer.actions",
	"message.actions",
	"rightpanel.tabs",
	"contextmenu.topbar",
	"contextmenu.message",
	"contextmenu.session",
	"contextmenu.file",
	"settings.pages",
]);

/** manifest 里可以写更自然的简写（作者少踩坑）：解析时映射到完整 slot 名。 */
const UI_SLOT_ALIASES: Readonly<Record<string, string>> = {
	topbar: "topbar.primary",
	"topbar.more": "topbar.overflow",
	composer: "composer.actions",
	message: "message.actions",
	rightpanel: "rightpanel.tabs",
	settings: "settings.pages",
};

/** 合法的条目种类（缺省 action；settings.pages 缺省 page）。 */
const UI_KINDS: ReadonlySet<string> = new Set(["view", "action", "badge", "menu", "page", "organizer", "divider"]);

function trimStr(v: unknown, max = 60): string | undefined {
	return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
}

/** 规范化一个条目；非法返回 null（slot 由调用方给）。 */
export function parseUiItem(raw: unknown, slot: string): UiContribution | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const id = trimStr(o.id, 64);
	// id 必须匹配插件 id 字符集（它与 pluginId 拼成全局 key，直接进 DOM 的 data 属性）
	if (!id || !ID_RE.test(id)) return null;
	const label = trimStr(o.label, 60);
	if (!label) return null;
	const kindRaw = trimStr(o.kind, 16);
	let kind: UiContribution["kind"] = kindRaw && UI_KINDS.has(kindRaw) ? (kindRaw as UiContribution["kind"]) : undefined;
	if (!kind) kind = slot === "settings.pages" ? "page" : "action";
	const children: UiContribution[] = [];
	if (Array.isArray(o.children)) {
		for (const c of o.children.slice(0, 16)) {
			const child = parseUiItem(c, slot);
			// 子项不再递归（一层够用）：清掉它自己的 children 防嵌套刷栈
			if (child) children.push({ ...child, children: undefined });
		}
	}
	const when = Array.isArray(o.when)
		? o.when.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, 8)
		: undefined;
	const num = Number(o.order);
	return {
		id,
		slot: slot as UiContribution["slot"],
		label,
		...(trimStr(o.labelEn, 60) ? { labelEn: trimStr(o.labelEn, 60) } : {}),
		...(trimStr(o.icon, 16) ? { icon: trimStr(o.icon, 16) } : {}),
		...(trimStr(o.hint, 200) ? { hint: trimStr(o.hint, 200) } : {}),
		...(trimStr(o.hintEn, 200) ? { hintEn: trimStr(o.hintEn, 200) } : {}),
		kind,
		...(children.length ? { children } : {}),
		...(Number.isFinite(num) ? { order: num } : {}),
		...(trimStr(o.group, 40) ? { group: trimStr(o.group, 40) } : {}),
		...(o.hidden === true ? { hidden: true } : {}),
		...(trimStr(o.action, 64) ? { action: trimStr(o.action, 64) } : {}),
		...(trimStr(o.view, 64) ? { view: trimStr(o.view, 64) } : {}),
		...(when?.length ? { when } : {}),
		...(trimStr(o.badge, 24) ? { badge: trimStr(o.badge, 24) } : {}),
	};
}

/**
 * 解析 manifest "ui" → 规范化贡献。
 *
 * 形状两种都收（都是为了少让插件作者踩坑）：
 *   "ui": { "topbar": [...] }                       // 按 slot 分组（推荐）
 *   "ui": { "items": [{ slot, ... }, ...] }         // 平铺（运行时注册同形，便于两边复用）
 * 单条目上限 32、arrange 上限 64 —— 防一份 manifest 把前端顶爆。
 */
export function parseUiContributions(raw: unknown): UiPluginUi | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const o = raw as Record<string, unknown>;
	const items: UiContribution[] = [];
	const push = (it: UiContribution | null) => {
		if (it && items.length < 32) items.push(it);
	};
	if (Array.isArray(o.items)) {
		for (const it of o.items.slice(0, 32)) {
			const raw = trimStr((it as Record<string, unknown>)?.slot, 32);
			const slot = raw ? (UI_SLOT_ALIASES[raw] ?? raw) : "";
			if (!slot || !UI_SLOTS.has(slot)) continue;
			push(parseUiItem(it, slot));
		}
	}
	for (const [rawKey, val] of Object.entries(o)) {
		if (rawKey === "items" || rawKey === "arrange") continue;
		const key = UI_SLOT_ALIASES[rawKey] ?? rawKey;
		if (!UI_SLOTS.has(key) || !Array.isArray(val)) continue;
		for (const it of val.slice(0, 32)) push(parseUiItem(it, key));
	}
	const arrange = parseUiArrange(o.arrange);
	if (!items.length && !arrange.length) return undefined;
	return { items, arrange };
}

/** 规范化整理意图（对内置/其它插件的条目）。非法/越界形状丢弃。 */
export function parseUiArrange(raw: unknown): UiArrangeOp[] {
	if (!Array.isArray(raw)) return [];
	const out: UiArrangeOp[] = [];
	for (const it of raw.slice(0, 64)) {
		if (!it || typeof it !== "object") continue;
		const o = it as Record<string, unknown>;
		// 目标 id：`host:<name>` 或 `<pluginId>:<itemId>`
		const id = trimStr(o.id, 96);
		if (!id || !/^[A-Za-z0-9_-]+:[A-Za-z0-9_.:-]+$/.test(id)) continue;
		const slotRaw = trimStr(o.slot, 32);
		const num = Number(o.order);
		out.push({
			id,
			...(slotRaw && UI_SLOTS.has(slotRaw) ? { slot: slotRaw as UiArrangeOp["slot"] } : {}),
			...(o.hide === true ? { hide: true } : {}),
			...(o.hide === false ? { hide: false } : {}),
			...(trimStr(o.group, 40) ? { group: trimStr(o.group, 40) } : {}),
			...(Number.isFinite(num) ? { order: num } : {}),
			...(trimStr(o.label, 60) ? { label: trimStr(o.label, 60) } : {}),
			...(trimStr(o.hint, 200) ? { hint: trimStr(o.hint, 200) } : {}),
			...(trimStr(o.icon, 16) ? { icon: trimStr(o.icon, 16) } : {}),
		});
	}
	return out;
}

/** 合并 manifest 基线与运行时注册：运行时同 id 覆盖，removed 里的删除；arrange 追加。 */
function mergeUiPluginUi(base: UiPluginUi | undefined, rt: UiRuntimeUi | undefined): UiPluginUi | undefined {
	const items = new Map<string, UiContribution>();
	for (const it of base?.items ?? []) items.set(it.id, it);
	for (const it of rt?.items.values() ?? []) items.set(it.id, it);
	for (const id of rt?.removed ?? []) items.delete(id);
	const arrange = [...(base?.arrange ?? []), ...(rt?.arrange ?? [])];
	if (!items.size && !arrange.length) return undefined;
	return { items: [...items.values()], arrange };
}

/** 解析 manifest.settings → 合法 schema（坏字段跳过，最多 32 个）。 */
function parseSettingsSchema(raw: unknown): UiPluginSettingField[] {
	if (!Array.isArray(raw)) return [];
	const out: UiPluginSettingField[] = [];
	for (const f of raw) {
		if (!f || typeof f !== "object") continue;
		const o = f as Record<string, unknown>;
		const key = typeof o.key === "string" ? o.key.trim() : "";
		const type = typeof o.type === "string" ? o.type : "";
		if (!key || !SETTING_TYPES.has(type) || out.some((x) => x.key === key)) continue;
		const field: UiPluginSettingField = {
			key,
			type: type as UiPluginSettingField["type"],
			label: typeof o.label === "string" && o.label ? o.label : key,
			...(o.default !== undefined ? { default: o.default as string | number | boolean } : {}),
			...(typeof o.min === "number" ? { min: o.min } : {}),
			...(typeof o.max === "number" ? { max: o.max } : {}),
			...(Array.isArray(o.options) ? { options: o.options.filter((x): x is string => typeof x === "string") } : {}),
			...(typeof o.hint === "string" ? { hint: o.hint } : {}),
		};
		out.push(field);
		if (out.length >= 32) break;
	}
	return out;
}

/** 从 <pluginDir>/storage.json 读 settings 存值，按 schema 并默认值。 */
function storedSettingsValues(dir: string, schema: UiPluginSettingField[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	let stored: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(readFileSync(join(dir, "storage.json"), "utf8")) as Record<string, unknown>;
		if (parsed && typeof parsed === "object" && parsed.settings && typeof parsed.settings === "object") {
			stored = parsed.settings as Record<string, unknown>;
		}
	} catch {
		/* 无存储文件 = 全默认 */
	}
	for (const f of schema) out[f.key] = stored[f.key] ?? f.default;
	return out;
}

/** 校验并写回 settings（storage.json 的 settings 键，原子写）；返回错误信息或 null。 */
function saveSettingsValues(
	dir: string,
	schema: UiPluginSettingField[],
	values: Record<string, unknown> | undefined,
	/** 错误文案语言（默认英文）；调用方可传 () => getLang() 实现跟随。 */
	lang?: () => ServerLang,
): { error?: string; clean: Record<string, unknown> } {
	const l = lang?.() ?? "en";
	const clean: Record<string, unknown> = {};
	for (const f of schema) {
		const v = values?.[f.key];
		if (f.type === "number") {
			const n = v === undefined ? Number(f.default ?? 0) : Number(v);
			if (!Number.isFinite(n) || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
				return {
					error: pick(l, `${f.label} 超出范围`, `${f.label} out of range`, "plugins.settings.out.of.range", {
						"f.label": f.label,
					}),
					clean,
				};
			}
			clean[f.key] = n;
		} else if (f.type === "boolean") {
			clean[f.key] = v === undefined ? Boolean(f.default) : Boolean(v);
		} else if (f.type === "select") {
			if (v !== undefined && !f.options?.includes(String(v)))
				return {
					error: pick(l, `${f.label} 值非法`, `Invalid value for ${f.label}`, "plugins.settings.invalid.value", {
						"f.label": f.label,
					}),
					clean,
				};
			clean[f.key] = v === undefined ? f.default : String(v);
		} else {
			clean[f.key] = v === undefined ? (f.default ?? "") : String(v);
		}
	}
	try {
		// 保留 storage.json 里其它键（插件自己的数据），只动 settings。
		const file = join(dir, "storage.json");
		let existing: Record<string, unknown> = {};
		try {
			existing = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		} catch {
			/* 首次 */
		}
		const tmp = `${file}.tmp-${process.pid}`;
		writeFileSync(tmp, JSON.stringify({ ...existing, settings: clean }));
		renameSync(tmp, file);
	} catch (err) {
		console.error(`[plugins] settings persist failed (${dir}):`, err);
	}
	return { clean };
}

export class PluginManager {
	private loaded = new Map<string, LoadedPlugin>();
	/** 已 import 过但无入口/失败的目录——避免重复 import 与重复报错。 */
	private attempted = new Set<string>();
	private senders = new Set<Sender>();
	private messageHandlers = new Map<string, Set<(payload: unknown, from?: string) => void>>();
	/** 插件注册的 AI 工具：pluginId → (name → 定义)。宿主经 agentTools() 读取。 */
	private agentTools = new Map<string, AgentToolTable>();
	/** AI 工具集合变化回调（index.ts 接到 AgentService，把新工具推入活跃会话）。 */
	onAgentToolsChanged: (() => void) | undefined = undefined;
	/** 插件斜杠命令注册表：pluginId → (name → 定义)。宿主经 listCommands() 读取。 */
	private pluginCommands = new Map<string, Map<string, PluginCommandDef>>();
	/** 命令集合变化回调（index.ts 接到 AgentService，刷新各客户端命令目录）。 */
	onCommandsChanged: (() => void) | undefined = undefined;
	/** 插件常驻任务：pluginId → Map<taskId, PluginBgTask>。宿主经 bgTasks() 读取。 */
	private pluginBgTasks = new Map<string, Map<string, PluginBgTask>>();
	/** 任务集合变化回调（index.ts 接到 AgentService，重推 bg_servers）。 */
	onBgTasksChanged: (() => void) | undefined = undefined;
	/** 服务端重载纪元：每次 reload() +1，前端用作 import 缓存击穿参数。 */
	private epochCounter = 0;
	/** 插件市场列表纪元：每次 add/remove +1，前端据此重渲。 */
	private catalogEpoch = 0;
	/** 当前全局工作区（host.cwd 的背后存储）——随 notifyCwd 更新。 */
	private cwdValue: string;
	/** 当前项目的**额外工作区根**（宿主侧多根，见 protocol 的 set_workspace_roots）——
	 *  由 index.ts 在 set_cwd / set_workspace_roots 后调 notifyWorkspaceRoots 同步。
	 *  它们只影响「哪些路径算工作区内」（免授权的受支持路径），不改变 cwd 本身。 */
	private workspaceRoots: string[] = [];
	/** 插件目录授权表（<dataDir>/plugin-grants.json，issue #146）。 */
	readonly grants: PluginGrantsStore;
	/** 由 index.ts 注入：向浏览器请求「插件要访问这个目录」的用户确认。 */
	pathAccessRequester: ((pluginId: string, dir: string, reason?: string) => Promise<boolean>) | undefined = undefined;
	/** 由 index.ts 注入：授权表**变了**（新授权落表）时触发 —— 设置面板的「已授权目录」
	 *  靠它即时刷新（以前只在 attach / 撤销时推，「点了允许但列表里还没出现」很难不被当成 bug）。 */
	onGrantsChanged: (() => void) | undefined = undefined;
	/** 插件运行时注册的 UI 贡献（host.ui.register/arrange），随 plugins 清单推送。 */
	private uiRuntime = new Map<string, UiRuntimeUi>();
	/** manifest "ui" 基线（每次 scan 刷新；host.ui.list 与合并都读它）。 */
	private uiBase = new Map<string, UiPluginUi>();

	constructor(
		private readonly dataDir: string,
		cwd: string,
		/** 随包发布的默认插件列表（<pkgRoot>/plugins/catalog.json）。缺省 = 无内置列表。 */
		private readonly builtinCatalogPath?: string,
	) {
		this.cwdValue = resolve(cwd);
		this.grants = new PluginGrantsStore(dataDir);
	}

	/** index.ts 在客户端 set_cwd 成功后调用：更新全局工作区并扇出给
	 *  所有已激活插件的 onCwdChange 钩子（异常隔离，不炸主进程）。 */
	notifyCwd(next: string): void {
		const abs = resolve(next);
		if (abs === this.cwdValue) return; // 幂等：重复通知/同路径 no-op
		this.cwdValue = abs;
		for (const [id, p] of this.loaded) {
			for (const h of p.cwdHandlers) {
				try {
					h(abs);
				} catch (err) {
					console.error(`[plugin:${id}] cwd-change handler failed:`, err);
				}
			}
		}
	}

	/** index.ts 在客户端改动「额外工作区根」后调用（新增/移除/切项目都算）：归一化后存下，
	 *  同一份就是 no-op。刻意**不发** onCwdChange 钩子：工作区根变化不动 cwd，那个钩子的
	 *  语义就是「当前目录变了」（插件该切根的时机）。 */
	notifyWorkspaceRoots(roots: string[] | undefined): void {
		const next = normalizeWorkspaceRoots(roots ?? []);
		if (next.length === this.workspaceRoots.length && next.every((p, i) => p === this.workspaceRoots[i])) return;
		this.workspaceRoots = next;
	}

	get pluginsDir(): string {
		return join(this.dataDir, "plugins");
	}

	/** 全部插件注册的斜杠命令（按插件 id 稳定排序）。 */
	listCommands(): PluginCommandDef[] {
		const out: PluginCommandDef[] = [];
		for (const id of [...this.pluginCommands.keys()].sort()) {
			out.push(...this.pluginCommands.get(id)!.values());
		}
		return out;
	}

	/** 按名查找命令（供 prompt() 拦截执行；找不到返回 null）。 */
	findCommand(name: string): { def: PluginCommandDef; pluginId: string } | null {
		for (const [pluginId, table] of this.pluginCommands) {
			if (table.has(name)) return { def: table.get(name)!, pluginId };
		}
		return null;
	}

	/** 全部插件注册的常驻后台任务（扁平化为 BgServer 形状）。 */
	bgTasks(): BgServer[] {
		const out: BgServer[] = [];
		for (const [pluginId, table] of this.pluginBgTasks) {
			for (const t of table.values()) {
				out.push({
					taskId: t.id,
					plugin: pluginId,
					since: t.since,
					name: t.label,
					...(t.status ? { status: t.status } : {}),
				});
			}
		}
		return out;
	}

	/** 停止一个插件任务（kill_background_server with taskId）；返回是否命中。 */
	stopPluginBgTask(taskId: string): boolean {
		for (const [pluginId, table] of this.pluginBgTasks) {
			const t = table.get(taskId);
			if (!t) continue;
			try {
				t.stop?.();
			} catch (err) {
				console.error(`[plugin:${pluginId}] background task ${taskId} stop failed:`, err);
			}
			table.delete(taskId);
			if (table.size === 0) this.pluginBgTasks.delete(pluginId);
			try {
				this.onBgTasksChanged?.();
			} catch {}
			return true;
		}
		return false;
	}

	/** 保存某插件的声明式设置（⚙ 面板 → plugin_settings 消息）：按 schema 校验、
	 *  原子写 storage.json 的 settings 键、通知插件 onSettingsChanged、重推清单
	 *  让前端回显。返回错误信息或 null（成功）。 */
	savePluginSettings(
		pluginId: string,
		values: Record<string, unknown>,
		/** 错误文案语言（默认英文）；调用方可传 () => getLang() 实现跟随。 */
		lang?: () => ServerLang,
	): { error?: string } {
		const l = lang?.() ?? "en";
		if (!ID_RE.test(pluginId)) return { error: pick(l, "非法的插件 id", "Invalid plugin id", "plugins.id.invalid") };
		const dir = join(this.pluginsDir, pluginId);
		const info = this.loaded.get(pluginId)?.info;
		const schema = info?.settingsSchema ?? [];
		if (!schema.length)
			return {
				error: pick(
					l,
					"该插件没有声明式设置（manifest 未声明 settings）",
					"This plugin has no declarative settings (manifest declares no settings)",
					"plugins.settings.no.declarative",
				),
			};
		const { error, clean } = saveSettingsValues(dir, schema, values, lang);
		if (error) return { error };
		// 通知插件（异常隔离）
		for (const h of this.loaded.get(pluginId)?.settingsHandlers ?? []) {
			try {
				h(clean);
			} catch (err) {
				console.error(`[plugin:${pluginId}] onSettingsChanged handler failed:`, err);
			}
		}
		// 重推 plugins 清单（含新 settingsValues），前端回显。
		void this.pushToAll().catch(() => {});
		return {};
	}

	/** 当前重载纪元（随 plugins 消息下发）。 */
	get epoch(): number {
		return this.epochCounter;
	}

	/** 用户自定义插件列表文件（<dataDir>/plugin-catalog.json）。 */
	get customCatalogPath(): string {
		return join(this.dataDir, "plugin-catalog.json");
	}

	/** 合并后的插件市场列表（builtin + 用户自定义，同 id 用户覆盖）。 */
	catalog(): UiPluginCatalogEntry[] {
		return this.builtinCatalogPath ? readCatalog(this.builtinCatalogPath, this.customCatalogPath) : [];
	}

	/** 插件市场列表纪元（随 plugin_catalog 消息下发）。 */
	get catalogEpochValue(): number {
		return this.catalogEpoch;
	}

	/** 把插件市场列表推给所有 socket。 */
	async pushCatalog(): Promise<void> {
		this.deliverAll({ type: "plugin_catalog", entries: this.catalog(), epoch: this.catalogEpoch });
	}

	/** 往用户自定义列表加一条（同 id 覆盖）；返回错误信息或 null（成功）。
	 *  成功后 epoch+1 并重推列表。 */
	addCatalogEntry(input: CatalogAddInput, lang?: () => ServerLang): { error?: string } {
		try {
			addCustomEntry(this.customCatalogPath, input, lang);
			this.catalogEpoch += 1;
			void this.pushCatalog();
			return {};
		} catch (err) {
			return { error: (err as Error).message };
		}
	}

	/** 移除一条用户自定义条目（builtin 不可经此删除）；返回错误信息或 null。 */
	removeCatalogEntry(id: string, lang?: () => ServerLang): { error?: string } {
		const l = lang?.() ?? "en";
		try {
			const ok = removeCustomEntry(this.customCatalogPath, id);
			if (!ok)
				return {
					error: pick(
						l,
						"未找到该条目，或它是内置条目（不可移除）",
						"Entry not found, or it is a built-in entry (cannot be removed)",
						"plugins.catalog.entry.cannot.remove",
					),
				};
			this.catalogEpoch += 1;
			void this.pushCatalog();
			return {};
		} catch (err) {
			return { error: (err as Error).message };
		}
	}

	addSender(send: (msg: ServerMessage) => void, cid: () => string | null): () => void {
		const s: Sender = { cid, send };
		this.senders.add(s);
		return () => this.senders.delete(s);
	}

	/** 客户端上行：路由给对应插件的处理器；未知/未激活的插件静默丢弃。
	 *  插件代码不可信——同步抛错与返回的 Promise rejection 都必须隔离在
	 *  这里，绝不能炸主进程。 */
	handleMessage(pluginId: string, payload: unknown, from?: string): void {
		if (!ID_RE.test(pluginId)) return;
		const handlers = this.messageHandlers.get(pluginId);
		if (!handlers) return;
		for (const h of handlers) {
			try {
				const ret = h(payload, from) as unknown;
				if (ret instanceof Promise) {
					ret.catch((err) => {
						console.error(`[plugin:${pluginId}] async message handler failed:`, err);
					});
					// 超时护栏：响应由 handler 自己 sendTo/broadcast 发出，超时只是记
					// 日志不再等待——绝不能让单条消息把客户端 pending 管线无限拖死。
					const timer = setTimeout(() => {
						console.error(`[plugin:${pluginId}] message handler 超时（>${MESSAGE_TIMEOUT_MS}ms），已不再等待`);
					}, MESSAGE_TIMEOUT_MS);
					void ret.finally(() => clearTimeout(timer));
				}
			} catch (err) {
				console.error(`[plugin:${pluginId}] message handler failed:`, err);
			}
		}
	}

	/** 首次安装/能力变更时提醒在线用户（marker 文件记录上次激活时的声明）。 */
	private async maybeConsentNotice(info: UiPluginInfo, dir: string, perms: string[]): Promise<void> {
		try {
			const markerFile = join(dir, ".pi-approved");
			const key = createHash("sha256").update(JSON.stringify(perms)).digest("hex").slice(0, 32);
			let prev = "";
			try {
				prev = JSON.parse(readFileSync(markerFile, "utf8"))?.key ?? "";
			} catch {
				/* 无 marker = 首次安装 */
			}
			if (prev === key) return; // 同版本能力清单，不再打扰
			const list = perms.length ? perms.join(", ") : "无";
			this.notifyAll(
				perms.length ? "warning" : "info",
				`插件「${info.name}」已激活（${prev ? "能力清单变更" : "首次安装"}；声明能力：${list}）——请确认来源可信`,
				`Plugin "${info.name}" activated (${prev ? "capability list changed" : "first install"}; declared: ${list}) — verify the source is trusted`,
			);
			writeFileSync(markerFile, JSON.stringify({ v: 1, key, perms }), "utf8");
		} catch (err) {
			console.error(`[plugin:${info.id}] consent notice failed:`, err);
		}
	}

	/** index.ts 的 /plugins-api/:id/* 挂载点转发到这里：找到对应插件的已注册
	 *  路由并执行；未知插件/路径 → 404，handler 抛错 → 500（不炸进程）。 */
	handleHttp(pluginId: string, method: string, pathIn: string, req: Request, res: Response): void {
		if (!ID_RE.test(pluginId)) {
			res.status(404).end("plugin not found");
			return;
		}
		const table = this.loaded.get(pluginId)?.httpRoutes;
		const path = "/" + pathIn.replace(/^\/+/, "");
		const handler = table?.get(`${method.toUpperCase()} ${path}`);
		if (!handler) {
			res.status(404).end("not found");
			return;
		}
		try {
			// 异步 handler（`async (req, res) => …`）的 rejection 不会被这里的 try 接住，
			// 会变成 unhandledRejection 直接杀掉整个服务（插件读文件失败、host.fs 越界
			// 拒绝、上游超时…都会走到这条路上）——用 Promise.resolve().catch 兜住，
			// 与同步抛错同样转 500。
			void Promise.resolve(handler(req, res)).catch((err: unknown) => {
				console.error(`[plugin:${pluginId}] http ${method} ${path} failed:`, err);
				if (!res.headersSent) res.status(500).end("internal error");
				else res.end();
			});
		} catch (err) {
			console.error(`[plugin:${pluginId}] http ${method} ${path} failed:`, err);
			if (!res.headersSent) res.status(500).end("internal error");
			else res.end();
		}
	}

	broadcast(pluginId: string, payload: unknown): void {
		this.deliverAll({ type: "plugin_data", pluginId, payload });
	}

	/** 系统通知：发给所有 socket（复用 notice 消息，前端 toast 展示）。 */
	notifyAll(level: "info" | "warning" | "error", text: string, textEn?: string): void {
		this.deliverAll({ type: "notice", level, text, textEn });
	}

	/** 给指定客户端定向发一条插件消息；找不到该 socket 时静默忽略。 */
	sendTo(clientId: string, pluginId: string, payload: unknown): void {
		for (const s of this.senders) {
			if (s.cid() !== clientId) continue;
			try {
				s.send({ type: "plugin_data", pluginId, payload });
			} catch {
				/* dead socket */
			}
		}
	}

	/** 目录清单 + 当前 epoch 推给所有 socket。 */
	async pushToAll(): Promise<void> {
		const list = await this.scan();
		this.deliverAll({ type: "plugins", plugins: list, epoch: this.epochCounter });
	}

	/** 服务端热重载：反激活全部 → 清缓存 → 重扫重激活 → epoch+1。
	 *  返回新目录清单（含激活结果）。重激活后的插件实例是新模块，
	 *  内存状态为初始值——逐个客户端触发 onAttach 让它们重推自身状态。 */
	async reload(lang?: () => ServerLang): Promise<UiPluginInfo[]> {
		this.dispose();
		this.attempted.clear();
		this.epochCounter += 1;
		const list = await this.ensureLoaded(lang);
		for (const s of this.senders) {
			const cid = s.cid();
			if (cid) this.notifyAttach(cid);
		}
		return list;
	}

	/** 每个客户端 attach 后调用：让各插件向该客户端推送自身完整状态。
	 *  异常隔离——单个插件钩子报错不影响其他插件与其他钩子。 */
	notifyAttach(clientId: string): void {
		for (const [id, p] of this.loaded) {
			for (const h of p.attachHandlers) {
				try {
					h(clientId);
				} catch (err) {
					console.error(`[plugin:${id}] onAttach handler failed:`, err);
				}
			}
		}
	}

	/** agent-service 调：把 SDK 工具执行事件扇出给所有插件（异常隔离）。 */
	emitToolEvent(ev: PluginToolEvent): void {
		for (const p of this.loaded.values()) {
			for (const h of p.toolHandlers) {
				try {
					h(ev);
				} catch (err) {
					console.error(`[plugin:${p.info.id}] tool-event handler failed:`, err);
				}
			}
		}
	}

	/** index.ts 注入：读取当前打开对话的快照（轨迹类插件经 host.getActiveConversation 调用）。 */
	conversationProvider: (() => PluginConversationSnapshot | null) | undefined = undefined;
	/** index.ts 注入：插件无头调用 agent（微信通道等经 host.chat 调用）。 */
	chatProvider: ((pluginId: string, req: PluginChatRequest) => Promise<PluginChatResult>) | undefined = undefined;

	/** 当前打开对话的快照（无提供者/暂无对话时返回 null）。 */
	getActiveConversation(): PluginConversationSnapshot | null {
		try {
			return this.conversationProvider?.() ?? null;
		} catch (err) {
			console.error("[plugins] conversationProvider failed:", err);
			return null;
		}
	}

	/** agent-service 调：当前打开对话变了（切历史会话/切 running 对话/新对话）——
	 *  轨迹类插件靠它重拉时间线（异常隔离）。 */
	emitConversationChanged(): void {
		for (const p of this.loaded.values()) {
			if (p.convChangeHandlers.size === 0) continue;
			for (const h of p.convChangeHandlers) {
				try {
					h();
				} catch (err) {
					console.error(`[plugin:${p.info.id}] conversation-changed handler failed:`, err);
				}
			}
		}
	}

	/** agent-service 调：把运行轨迹事件扇出给所有插件（异常隔离，
	 *  与 emitToolEvent 同级；订阅者崩了只记日志，不影响主流程）。 */
	emitRunEvent(ev: PluginRunEvent): void {
		for (const p of this.loaded.values()) {
			if (p.runHandlers.size === 0) continue;
			for (const h of p.runHandlers) {
				try {
					h(ev);
				} catch (err) {
					console.error(`[plugin:${p.info.id}] run-event handler failed:`, err);
				}
			}
		}
	}

	/** 当前全部插件注册的 AI 工具（扁平化，按插件 id 稳定排序）。 */
	getAgentTools(): PluginAgentTool[] {
		const out: PluginAgentTool[] = [];
		for (const table of [...this.agentTools.values()].sort()) out.push(...table.values());
		return out;
	}
	/** 注册一个供 AI 调用的工具；重名拒绝并返回空操作注销函数。 */
	private registerAgentTool(pluginId: string, tool: PluginAgentTool): () => void {
		if (!tool || typeof tool.execute !== "function" || !tool.name || !tool.description) {
			console.error(`[plugin:${pluginId}] registerAgentTool: 缺少 name/description/execute，忽略`);
			return () => {};
		}
		let table = this.agentTools.get(pluginId);
		if (!table) this.agentTools.set(pluginId, (table = new Map()));
		if (table.has(tool.name)) {
			console.error(`[plugin:${pluginId}] AI 工具 "${tool.name}" 重复注册，忽略`);
			return () => {};
		}
		table.set(tool.name, tool);
		console.log(`[plugin:${pluginId}] registered AI tool: ${tool.name}`);
		try {
			this.onAgentToolsChanged?.();
		} catch (err) {
			console.error("[plugins] onAgentToolsChanged failed:", err);
		}
		return () => {
			if (table.delete(tool.name)) {
				if (table.size === 0) this.agentTools.delete(pluginId);
				try {
					this.onAgentToolsChanged?.();
				} catch {
					/* shutting down */
				}
			}
		};
	}

	/** 注册斜杠命令：跨插件重名拒绝（先注册者胜出），onCommandsChanged 通知目录刷新。 */
	private registerCommand(pluginId: string, cmd: PluginCommandDef): () => void {
		const name = String(cmd?.name ?? "").replace(/^\/+/, ""); // 容忍误带的前导 /
		if (!/^[a-zA-Z][a-zA-Z0-9:_-]*$/.test(name)) {
			console.error(
				`[plugin:${pluginId}] registerCommand: 非法名称「${cmd?.name}」（需字母开头，允许字母数字:_-），忽略`,
			);
			return () => {};
		}
		if (typeof cmd?.run !== "function") {
			console.error(`[plugin:${pluginId}] registerCommand: ${name} 缺少 run，忽略`);
			return () => {};
		}
		for (const [pid, table] of this.pluginCommands) {
			if (table.has(name) && pid !== pluginId) {
				console.error(`[plugin:${pluginId}] 命令 /${name} 已被插件 ${pid} 注册，忽略重复`);
				return () => {};
			}
		}
		let table = this.pluginCommands.get(pluginId);
		if (!table) this.pluginCommands.set(pluginId, (table = new Map()));
		if (table.has(name)) {
			console.error(`[plugin:${pluginId}] 命令 /${name} 重复注册，忽略`);
			return () => {};
		}
		const def: PluginCommandDef = { ...cmd, name };
		table.set(name, def);
		console.log(`[plugin:${pluginId}] registered command: /${name}`);
		try {
			this.onCommandsChanged?.();
		} catch (err) {
			console.error("[plugins] onCommandsChanged failed:", err);
		}
		return () => {
			if (table!.delete(name)) {
				if (table!.size === 0) this.pluginCommands.delete(pluginId);
				try {
					this.onCommandsChanged?.();
				} catch {
					/* shutting down */
				}
			}
		};
	}

	/** 取（或建）某插件的运行时 UI 状态。 */
	private uiRuntimeFor(pluginId: string): UiRuntimeUi {
		let rt = this.uiRuntime.get(pluginId);
		if (!rt) this.uiRuntime.set(pluginId, (rt = { items: new Map(), removed: new Set(), arrange: [] }));
		return rt;
	}

	/** 移除一个条目（运行时注册的或 manifest 声明的都记进 removed，保证合并时不复活）。 */
	private removeUiItem(pluginId: string, itemId: string): void {
		const rt = this.uiRuntimeFor(pluginId);
		rt.items.delete(itemId);
		rt.removed.add(itemId);
	}

	/** 该绝对路径是否落在当前工作区（或其额外根）内：工作区内的路径本来就能访问，
	 *  不必走授权。多根语义见 protocol 的 set_workspace_roots —— 用户把一个目录加成
	 *  工作区根，就是「我认它是我工作区的一部分」，插件读它无需再问。 */
	isInsideWorkspace(abs: string): boolean {
		for (const root of [this.cwdValue, ...this.workspaceRoots]) {
			const rel = relative(root, abs);
			if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return true;
		}
		return false;
	}

	/** 某插件当前生效的 UI 贡献 = manifest 基线 + 运行时注册（同 id 覆盖、removed 删除）。 */
	uiOf(pluginId: string): UiPluginUi | undefined {
		return mergeUiPluginUi(this.uiBase.get(pluginId), this.uiRuntime.get(pluginId));
	}

	private deliverAll(msg: ServerMessage): void {
		for (const s of this.senders) {
			try {
				s.send(msg);
			} catch {
				/* dead socket — index.ts cleans it up */
			}
		}
	}

	/** 当前目录清单（重扫 manifest，不重新 import）。 */
	async list(): Promise<UiPluginInfo[]> {
		return this.scan();
	}

	/**
	 * attach 时调用：重扫目录 + 激活尚未加载的新插件。
	 * 返回给浏览器的目录（含激活失败的条目，前端显示为不可用）。
	 */
	async ensureLoaded(lang?: () => ServerLang): Promise<UiPluginInfo[]> {
		const found = await this.scan();
		for (const info of found) {
			if (this.loaded.has(info.id) || this.attempted.has(info.id)) continue;
			if (!existsSync(join(this.pluginsDir, info.id, "index.mjs"))) continue; // 纯前端插件
			await this.activate(info, lang);
		}
		// 已被删除的插件：调用 deactivate 并移出缓存
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		for (const [id, p] of [...this.loaded]) {
			if (!found.some((f) => f.id === id)) {
				this.deactivateEntry(id, p);
			}
		}
		return found.map((f) => this.loaded.get(f.id)?.info ?? f);
	}

	/** 反激活单个插件：deactivate + 注销 AI 工具 + 清缓存。
	 *
	 *  注意这里必须把 id 从 attempted 里摘掉：目录一时不在（`pi-web-ui install --force`
	 *  先 rm 再 cp，扫描正好撞上窗口期）只是「暂时看成卸载」，目录回来后还要能重新激活；
	 *  留在 attempted 里 = 本进程内永远不再激活，插件的 HTTP 路由 / AI 工具全没了，
	 *  前端只会看到「代理请求失败 404 <url>」（插件的 /proxy 路由不存在），且 CLI 承诺的
	 *  「刷新浏览器即可加载」失效，必须重启服务才能恢复。 */
	private deactivateEntry(id: string, p: LoadedPlugin): void {
		try {
			p.deactivate?.();
		} catch (err) {
			console.error(`[plugin:${id}] deactivate failed:`, err);
		}
		// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: handlers may unsubscribe mid-emit
		for (const off of [...(p.agentToolUnsubscribers ?? [])]) {
			try {
				off();
			} catch {
				/* already gone */
			}
		}
		this.loaded.delete(id);
		this.messageHandlers.delete(id);
		this.attempted.delete(id);
		// 运行时 UI 注册随插件一起消失（manifest 基线留着，重扫时会重算）。
		this.uiRuntime.delete(id);
		this.uiBase.delete(id);
		// 重新激活时会 import 磁盘上的 index.mjs：Node 的 ESM 缓存按 URL（含 ?e=）
		// 命中，epoch 不变就会拿到旧模块（更新插件后还是旧代码）——所以这里也 +1，
		// 顺带让浏览器端 ?e= 变化、重拉插件的 client bundle。
		this.epochCounter += 1;
		console.log(`[plugin:${id}] removed`);
	}

	/** 关机时反激活全部插件。 */
	dispose(): void {
		for (const [id, p] of this.loaded) {
			try {
				p.deactivate?.();
			} catch (err) {
				console.error(`[plugin:${id}] deactivate failed:`, err);
			}
			for (const off of [...(p.agentToolUnsubscribers ?? []), ...(p.commandUnsubscribers ?? [])]) {
				try {
					off();
				} catch {
					/* shutting down */
				}
			}
			// 反激活时停掉它注册的常驻后台任务（轮询器等），不留孤儿计时器。
			for (const t of this.pluginBgTasks.get(id)?.values() ?? []) {
				try {
					t.stop?.();
				} catch {}
			}
		}
		this.pluginBgTasks.clear();
		this.loaded.clear();
		this.messageHandlers.clear();
	}

	/** 读 manifest 清单；坏目录（无 manifest/id 非法）直接跳过。 */
	private async scan(): Promise<UiPluginInfo[]> {
		let names: string[];
		try {
			names = await readdir(this.pluginsDir);
		} catch {
			return []; // 目录不存在 = 没装任何插件
		}
		const out: UiPluginInfo[] = [];
		for (const name of names.sort()) {
			if (!ID_RE.test(name)) continue;
			const dir = join(this.pluginsDir, name);
			try {
				if (!(await stat(dir)).isDirectory()) continue;
				const raw = await readFile(join(dir, "manifest.json"), "utf8");
				const m = JSON.parse(raw) as {
					id?: string;
					name?: string;
					version?: string;
					description?: string;
					icon?: string;
					apiVersion?: number;
					permissions?: unknown;
					settings?: unknown;
					renderers?: unknown;
					view?: unknown;
					ui?: unknown;
				};
				out.push({
					id: name,
					name: typeof m.name === "string" && m.name ? m.name : name,
					version: typeof m.version === "string" ? m.version : undefined,
					description: typeof m.description === "string" ? m.description : undefined,
					icon: typeof m.icon === "string" && m.icon.trim() ? m.icon.trim() : undefined,
					hasClient: existsSync(join(dir, "client", "entry.mjs")),
					error: this.loaded.get(name)?.info.error,
					// manifest 声明的能力清单（fs/net/tools…）——设置面板展示用
					permissions: Array.isArray(m.permissions)
						? m.permissions.filter((p): p is string => typeof p === "string" && p.length > 0).slice(0, 16)
						: undefined,
					// 声明式设置 schema + 当前存值（⚙ 面板自动渲染表单用）
					settingsSchema: parseSettingsSchema(m.settings),
					settingsValues: storedSettingsValues(dir, parseSettingsSchema(m.settings)),
					// 可渲染的 fenced-code 语言（manifest "renderers"）——前端据此按需加载
					renderers: Array.isArray(m.renderers)
						? m.renderers.filter((r): r is string => typeof r === "string" && r.length > 0).slice(0, 32)
						: undefined,
					// 是否有独立视图 tab（manifest "view"，缺省 true）；纯 renderer 插件写 false
					view: typeof m.view === "boolean" ? m.view : true,
					// 插件对宿主 UI 的贡献（manifest "ui"：slot 框架 + 整理意图，issue #146）。
					// 权限：与 activate 的 can("ui") **同一口径**（严格模式 = 声明了 permissions
					// 或 apiVersion>=2）：严格模式下必须含 "ui" 族，否则整份忽略；旧全权格式放行。
					ui: (() => {
						const perms = Array.isArray(m.permissions)
							? m.permissions.filter((x): x is string => typeof x === "string")
							: [];
						const apiVersion = Number(m.apiVersion ?? 1) || 1;
						const strict = perms.length > 0 || apiVersion >= 2;
						if (strict && !perms.some((x) => x.split(":")[0] === "ui")) {
							this.uiBase.delete(name);
							return undefined;
						}
						const base = parseUiContributions(m.ui);
						if (base) this.uiBase.set(name, base);
						else this.uiBase.delete(name);
						return this.uiOf(name);
					})(),
					// 安装来源（pi-web-ui install 写入的 .pi-source.json）——
					// 设置面板据此显示「更新」按钮；手工拷入的插件没有此文件。
					source: await readFile(join(dir, ".pi-source.json"), "utf8")
						.then((raw) => {
							try {
								const s = JSON.parse(raw) as { source?: unknown };
								return typeof s.source === "string" && s.source ? s.source : undefined;
							} catch {
								return undefined;
							}
						})
						.catch(() => undefined),
				});
			} catch {
				continue; // 无 manifest / JSON 坏 —— 不是插件
			}
		}
		return out;
	}

	private async activate(info: UiPluginInfo, lang?: () => ServerLang): Promise<void> {
		const l = lang?.() ?? "en";
		this.attempted.add(info.id);
		const dir = join(this.pluginsDir, info.id);
		const handlers = new Set<(payload: unknown) => void>();
		this.messageHandlers.set(info.id, handlers);
		const toolHandlers = new Set<(ev: PluginToolEvent) => void>();
		const runHandlers = new Set<(ev: PluginRunEvent) => void>();
		const convChangeHandlers = new Set<() => void>();
		const attachHandlers = new Set<(clientId: string) => void>();
		const cwdHandlers = new Set<(cwd: string) => void>();
		const httpRoutes = new Map<string, (req: Request, res: Response) => void>();
		const unregisterTools: Array<() => void> = [];
		const unregisterCommands: Array<() => void> = [];
		const bgTaskTable = new Map<string, PluginBgTask>();
		const settingsHandlers = new Set<(values: Record<string, unknown>) => void>();
		// 宿主 API 版本协商：插件要的比宿主新 → 明确拒绝（而不是让它在运行期
		// 撞 undefined 接口莫名其妙地坏）。与激活失败同一处理：error 字段 + 置灰。
		let apiVersion = 1;
		try {
			apiVersion = Number(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).apiVersion ?? 1) || 1;
		} catch {}
		if (apiVersion > PLUGIN_API_VERSION) {
			const msg = pick(
				l,
				`插件要求宿主 API v${apiVersion}，当前宿主 v${PLUGIN_API_VERSION} —— 请升级 pi-web-ui`,
				`Plugin requires host API v${apiVersion} but the host is v${PLUGIN_API_VERSION} — please upgrade pi-web-ui`,
				"plugins.host.api.mismatch",
				{ apiVersion, PLUGIN_API_VERSION },
			);
			console.error(`[plugin:${info.id}] ${msg}`);
			this.loaded.set(info.id, {
				info: { ...info, error: msg },
				toolHandlers,
				runHandlers,
				convChangeHandlers,
				attachHandlers,
				cwdHandlers,
				httpRoutes,
				settingsHandlers: new Set(),
			});
			return;
		}
		// 能力声明：写了 permissions → 严格模式（受控宿主 API 按声明族强制执行）；
		// 未写且 apiVersion < 2 → 旧全权模式（首次使用受控 API 时警告一次，v2 起默认拒绝）。
		const permsDeclared = (info.permissions ?? []).slice();
		const strict = permsDeclared.length > 0 || apiVersion >= 2;
		const permFamilies = new Set(permsDeclared.map((x) => x.split(":")[0]!));
		const p: LoadedPlugin = {
			info,
			toolHandlers,
			runHandlers,
			convChangeHandlers,
			attachHandlers,
			cwdHandlers,
			commandUnsubscribers: unregisterCommands,
			httpRoutes,
			settingsHandlers,
		};
		p.permsDeclared = permsDeclared;
		p.permFamilies = permFamilies;
		p.legacyWarned = false;
		// 每插件的私有设施：KV 存储 + 加密 secrets + 依赖自动补装（单飞）。
		const storage = new PluginStorage(join(dir, "storage.json"));
		const secrets = new PluginSecrets(this.dataDir, dir);
		// 受限工作区文件访问（能力 "fs" 门控；根随 set_cwd 活值移动）。
		const workspaceFs = new WorkspaceFS(() => self.cwdValue);
		/** 跨目录读写（issue #146）：每次操作都要求路径已在授权表里（或落在工作区内）。
		 *  与 workspaceFs 的分工：那个锚定当前工作区、越界拒绝；这个锚定「用户点过头的目录」。
		 *  两者都不允许插件无告知地碰任意路径 —— 这就是「受支持路径」与裸 node:fs 的差别。 */
		const allowAbs = (p: string): string => {
			const abs = normalizeGrantPath(p);
			if (!abs) throw new Error("路径必须是绝对路径");
			if (self.isInsideWorkspace(abs) || self.grants.has(info.id, abs)) return abs;
			throw new Error(`目录未授权：先 await host.fs.requestAccess(dir)（${abs}）`);
		};
		const crossDirFs = {
			list: async (absDir: string) => {
				const abs = allowAbs(absDir);
				const ents = await readdir(abs, { withFileTypes: true });
				return ents.slice(0, 2000).map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }) as const);
			},
			read: async (absPath: string) => readFile(allowAbs(absPath)),
			readText: async (absPath: string, maxBytes?: number) => {
				const buf = await readFile(allowAbs(absPath));
				const cap = Math.max(1024, Math.min(Number(maxBytes ?? 2 * 1024 * 1024), 8 * 1024 * 1024));
				return buf.subarray(0, cap).toString("utf8");
			},
			write: async (absPath: string, data: string | Uint8Array) => {
				const abs = allowAbs(absPath);
				await mkdir(dirname(abs), { recursive: true });
				await writeFile(abs, data);
			},
			remove: async (absPath: string) => {
				const abs = allowAbs(absPath);
				await rm(abs, { recursive: true, force: true });
			},
		};
		/** 能力门控：严格模式下查声明族；旧模式放行但每个激活期只警告一次。
		 *  返回 false = 已记日志，调用方应拒绝。 */
		const can = (family: string): boolean => {
			if (permFamilies.has(family)) return true;
			if (!strict) {
				if (!p.legacyWarned) {
					p.legacyWarned = true;
					console.warn(
						`[plugin:${info.id}] manifest 未声明 permissions（旧格式全权模式）——已放行 "${family}"；apiVersion 2 起将默认拒绝，请尽快声明`,
					);
				}
				return true;
			}
			console.error(`[plugin:${info.id}] 缺少能力声明 "${family}"（manifest.permissions）——请求被拒`);
			return false;
		};
		const self = this; // 对象字面量 getter 里不能用插件宿主的 this (oxlint no-this-alias: 誤報, getter closure 需要 host)
		const host: PluginHost = {
			broadcast: (payload) => this.broadcast(info.id, payload),
			notify: (level, text, textEn) => this.notifyAll(level, text, textEn),
			sendTo: (clientId, payload) => this.sendTo(clientId, info.id, payload),
			onMessage: (h) => {
				handlers.add(h);
				return () => handlers.delete(h);
			},
			onToolEvent: (h) => {
				toolHandlers.add(h);
				return () => toolHandlers.delete(h);
			},
			onRunEvent: (h) => {
				runHandlers.add(h);
				return () => runHandlers.delete(h);
			},
			onConversationChanged: (h) => {
				convChangeHandlers.add(h);
				return () => convChangeHandlers.delete(h);
			},
			getActiveConversation: () => self.getActiveConversation(),
			chat: (req) => {
				if (!can("chat")) return Promise.reject(new Error(`插件未声明能力 "chat"（manifest.permissions）——请求被拒`));
				if (!self.chatProvider) {
					return Promise.reject(new Error("宿主未提供无头调用（chatProvider 未接入）——请升级 pi-web-ui"));
				}
				const text = String((req as PluginChatRequest | undefined)?.text ?? "").trim();
				if (!text) return Promise.reject(new Error("chat: text 为空"));
				if (text.length > 8000) return Promise.reject(new Error("chat: text 超长（>8000 字），请裁剪后重发"));
				const accountId = String((req as PluginChatRequest | undefined)?.accountId ?? "default").slice(0, 64);
				return self.chatProvider(info.id, { text, accountId });
			},
			onAttach: (h) => {
				attachHandlers.add(h);
				return () => attachHandlers.delete(h);
			},
			onCwdChange: (h) => {
				cwdHandlers.add(h);
				return () => cwdHandlers.delete(h);
			},
			registerCommand: (cmd) => {
				const off = this.registerCommand(info.id, cmd);
				unregisterCommands.push(off);
				return () => {
					const i = unregisterCommands.indexOf(off);
					if (i >= 0) unregisterCommands.splice(i, 1);
					off();
				};
			},
			storage,
			secrets,
			ensureDeps: (specs, opts) => ensurePluginDeps(dir, specs ?? [], opts?.onProgress),
			route: (method, path, handler) => {
				if (!can("http")) return () => {};
				const m = String(method ?? "GET").toUpperCase();
				if (
					!["GET", "POST", "PUT", "DELETE"].includes(m) ||
					typeof path !== "string" ||
					!path.startsWith("/") ||
					typeof handler !== "function"
				) {
					console.error(`[plugin:${info.id}] route: 非法参数（method=${method} path=${path}），忽略`);
					return () => {};
				}
				httpRoutes.set(`${m} ${path}`, handler);
				return () => httpRoutes.delete(`${m} ${path}`);
			},
			// 包一层：插件反激活时自动注销它注册的全部 AI 工具，不留悬挂项。
			registerAgentTool: (tool) => {
				if (!can("tools")) return () => {};
				const off = this.registerAgentTool(info.id, tool);
				unregisterTools.push(off);
				return () => {
					const i = unregisterTools.indexOf(off);
					if (i >= 0) unregisterTools.splice(i, 1);
					off();
				};
			},
			dir,
			dataDir: this.dataDir,
			get cwd() {
				return self.cwdValue;
			},
			fs: {
				list: (relDir) => (can("fs") ? workspaceFs.list(relDir) : NO_FS_PROMISE),
				read: (p) => (can("fs") ? workspaceFs.read(p) : NO_FS_PROMISE),
				readText: (p, max) => (can("fs") ? workspaceFs.readText(p, max) : NO_FS_PROMISE),
				write: (p, data) => (can("fs") ? workspaceFs.write(p, data) : NO_FS_PROMISE),
				remove: (p) => (can("fs") ? workspaceFs.remove(p) : NO_FS_PROMISE),
				requestAccess: async (dir, reason) => {
					if (!can("fs")) return false;
					const abs = normalizeGrantPath(String(dir ?? ""));
					if (!abs) return false;
					// 工作区内的路径本来就能用，不必打扰用户。
					if (self.isInsideWorkspace(abs)) return true;
					if (self.grants.has(info.id, abs)) return true;
					if (!self.pathAccessRequester) return false;
					const ok = await self.pathAccessRequester(info.id, abs, reason);
					if (ok) {
						self.grants.grant(info.id, abs);
						// 授权表变了 → 通知宿主重推（设置面板即时可见）。 throws 不能拖塔授权本身。
						try {
							self.onGrantsChanged?.();
						} catch {
							/* 推送失败不影响已完成的授权 */
						}
					}
					return ok;
				},
				authorizedDirs: () => (can("fs") ? self.grants.get(info.id) : []),
				listPath: (absDir) => (can("fs") ? crossDirFs.list(absDir) : NO_FS_PROMISE),
				readPath: (absPath) => (can("fs") ? crossDirFs.read(absPath) : NO_FS_PROMISE),
				readTextPath: (absPath, max) => (can("fs") ? crossDirFs.readText(absPath, max) : NO_FS_PROMISE),
				writePath: (absPath, data) => (can("fs") ? crossDirFs.write(absPath, data) : NO_FS_PROMISE),
				removePath: (absPath) => (can("fs") ? crossDirFs.remove(absPath) : NO_FS_PROMISE),
			},
			project: {
				create: async (spec) => {
					if (!can("fs")) return { ok: false, error: "未声明能力 fs（manifest.permissions）", log: [], dir: "" };
					const dir = normalizeGrantPath(String((spec as { dir?: unknown })?.dir ?? ""));
					if (!dir) return { ok: false, error: "项目目录必须是绝对路径", log: [], dir: "" };
					if (!self.isInsideWorkspace(dir) && !self.grants.has(info.id, dir)) {
						return { ok: false, dir, log: [], error: `项目目录未授权：先 await host.fs.requestAccess("${dir}")` };
					}
					return createProject(spec, { onProgress: (line) => self.notifyAll("info", line) });
				},
			},
			registerBackgroundTask: (task) => {
				const id = String(task?.id ?? "").trim();
				if (!id || bgTaskTable.has(id)) {
					console.error(`[plugin:${info.id}] registerBackgroundTask: 非法/重复 id「${task?.id}」，忽略`);
					return { update: () => {}, unregister: () => {} };
				}
				const entry: PluginBgTask = {
					id,
					label: String(task?.label ?? id),
					since: Date.now(),
					...(typeof task?.stop === "function" ? { stop: task.stop } : {}),
					...(typeof task?.status === "string" ? { status: task.status } : {}),
				};
				bgTaskTable.set(id, entry);
				this.pluginBgTasks.set(info.id, bgTaskTable);
				const fire = () => {
					try {
						this.onBgTasksChanged?.();
					} catch {}
				};
				fire();
				return {
					update: (next) => {
						if (!bgTaskTable.has(id)) return;
						if (next.label !== undefined) entry.label = String(next.label);
						if (next.status !== undefined) entry.status = next.status;
						if (typeof next.stop === "function") entry.stop = next.stop;
						fire();
					},
					unregister: () => {
						if (bgTaskTable.delete(id)) {
							if (bgTaskTable.size === 0) this.pluginBgTasks.delete(info.id);
							fire();
						}
					},
				};
			},
			ui: {
				register: (items) => {
					if (!can("ui")) return () => {};
					const list = Array.isArray(items) ? items : [items];
					const added: string[] = [];
					const rt = self.uiRuntimeFor(info.id);
					for (const raw of list.slice(0, 32)) {
						const slotRaw =
							typeof (raw as { slot?: unknown })?.slot === "string" ? String((raw as { slot: string }).slot) : "";
						// 与 manifest 解析同口径：先查别名（topbar → topbar.primary）、再校枚举。
						// 运行时注册不校验的话，插件给个别名（或写错）会得到一个前端不认识的 slot
						// —— buildUiSlots 会静默丢掉它，表现为「注册了但界面上没有」，最难排。
						const slot = UI_SLOT_ALIASES[slotRaw] ?? slotRaw;
						const parsed = slot && UI_SLOTS.has(slot) ? parseUiItem(raw, slot) : null;
						if (!parsed) continue;
						rt.items.set(parsed.id, parsed);
						rt.removed.delete(parsed.id);
						added.push(parsed.id);
					}
					if (added.length) void self.pushToAll().catch(() => {});
					return () => {
						if (!added.length) return;
						for (const id of added) self.removeUiItem(info.id, id);
						void self.pushToAll().catch(() => {});
					};
				},
				update: (id, patch) => {
					if (!can("ui")) return;
					// 只能更新"当前生效"的条目：manifest 声明的与运行时注册的都算，
					// 不存在的一律忽略（避免插件凭空造条目绕过声明审查）。
					const base = self.uiOf(info.id)?.items.find((x) => x.id === id);
					if (!base) return;
					const merged: UiContribution = { ...base, ...(patch as Partial<UiContribution>), id, slot: base.slot };
					self.uiRuntimeFor(info.id).items.set(id, merged);
					void self.pushToAll().catch(() => {});
				},
				remove: (id) => {
					if (!can("ui")) return;
					self.removeUiItem(info.id, id);
					void self.pushToAll().catch(() => {});
				},
				arrange: (ops) => {
					if (!can("ui")) return;
					const list = parseUiArrange(Array.isArray(ops) ? ops : [ops]);
					if (!list.length) return;
					self.uiRuntimeFor(info.id).arrange.push(...list);
					void self.pushToAll().catch(() => {});
				},
				list: () => self.uiOf(info.id) ?? { items: [], arrange: [] },
			},
			getSettings: () => storedSettingsValues(dir, info.settingsSchema ?? []),
			onSettingsChanged: (h) => {
				settingsHandlers.add(h);
				return () => settingsHandlers.delete(h);
			},
			log: (...args) => console.log(`[plugin:${info.id}]`, ...args),
		};
		try {
			// Node 对同一 URL 的 import() 永远返回缓存模块——追加 epoch 作查询串
			// 击穿缓存，让 plugins_reload 后的重新激活能拿到磁盘上的新代码。
			const mod = (await import(pathToFileURL(join(dir, "index.mjs")).href + `?e=${this.epochCounter}`)) as {
				default?: {
					activate?: (host: PluginHost) => void | (() => void) | Promise<void | (() => void)>;
				};
			};
			const ret = await mod.default?.activate?.(host);
			this.loaded.set(info.id, {
				info: { ...info },
				deactivate: typeof ret === "function" ? ret : undefined,
				toolHandlers,
				runHandlers,
				convChangeHandlers,
				attachHandlers,
				cwdHandlers,
				agentToolUnsubscribers: unregisterTools,
				commandUnsubscribers: unregisterCommands,
				httpRoutes,
				settingsHandlers,
			});
			console.log(`[plugin:${info.id}] activated (v${info.version ?? "?"})`);
			// 首次安装/能力变更提醒（尽力而为）：<dir>/.pi-approved 记录上次激活时
			// 的能力清单——新装或 permissions 变更后向在线客户端推一条警告通知，
			// 用户装前可见、日常启动不打扰。
			void this.maybeConsentNotice(info, dir, permsDeclared);
		} catch (err) {
			httpRoutes.clear();
			this.loaded.set(info.id, {
				info: { ...info, error: (err as Error).message },
				toolHandlers,
				runHandlers,
				convChangeHandlers,
				attachHandlers,
				cwdHandlers,
				httpRoutes,
				settingsHandlers: new Set(),
			});
			console.error(`[plugin:${info.id}] activate failed:`, err);
		}
	}
}

/**
 * 把 /plugins/:id/client/<rest> 安全映射到 <pluginsDir>/<id>/client/<rest>。
 * 返回绝对路径；任何越界/非法 id 返回 null（调用方回 404）。
 */
export function resolvePluginClientFile(pluginsDir: string, id: string, rest: string): string | null {
	if (!ID_RE.test(id)) return null;
	const root = resolve(join(pluginsDir, id, "client"));
	// rest 由 express 路由保证不带 ".."，但双保险：resolve 后必须仍在 root 内
	const abs = resolve(root, rest);
	if (abs !== root && !abs.startsWith(root + sep)) return null;
	return abs;
}

/**
 * 把插件 AI 工具定义同步进一个「会话状对象」（SDK AgentSession 的结构子集：
 * 内部 _customTools 数组 + _refreshToolRegistry()——refresh 会重读数组，且新
 * 工具名自动加入活跃集）。新增/更新/移除三向 diff；对象不兼容（SDK 改名）返回
 * null 由调用方静默降级。返回新的已注入名单。
 *
 * 纯函数、不 import SDK —— vitest 直接测（tests/unit/plugin-tools.test.ts）。
 */
export function syncPluginToolsIntoSession(
	session: {
		_customTools?: Array<{ name: string } & Record<string, unknown>>;
		_refreshToolRegistry?: () => void;
	},
	defs: Array<{ name: string } & Record<string, unknown>>,
	prevNames: ReadonlySet<string>,
): ReadonlySet<string> | null {
	if (!Array.isArray(session._customTools) || typeof session._refreshToolRegistry !== "function") return null;
	const byName = new Map(session._customTools.map((d) => [d.name, d]));
	let changed = false;
	for (const d of defs) {
		if (byName.get(d.name) !== d) {
			byName.set(d.name, d);
			changed = true;
		}
	}
	for (const name of prevNames) {
		if (!defs.some((d) => d.name === name) && byName.has(name)) {
			byName.delete(name);
			changed = true;
		}
	}
	if (!changed) return new Set(defs.map((d) => d.name));
	session._customTools = [...byName.values()];
	session._refreshToolRegistry();
	return new Set(defs.map((d) => d.name));
}
