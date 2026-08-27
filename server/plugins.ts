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
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ServerMessage, UiPluginInfo } from "./protocol.js";

/** 合法插件 id：字母/数字/下划线/连字符，防路径穿越（同 themes.ts 的做法）。 */
const ID_RE = /^[A-Za-z0-9_-]+$/;

/** 插件收到的工具执行事件（agent-service 的 SDK tool_execution_start/end 转发）。 */
export interface PluginToolEvent {
	phase: "start" | "end";
	toolName: string;
	/** 事件所属对话（会话未就绪时可能为空）。 */
	conversationId?: string;
	/** end 独有：真实执行耗时毫秒 / 是否报错。 */
	durationMs?: number;
	isError?: boolean;
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
	notify(level: "info" | "warning" | "error", text: string): void;
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
	/** 带前缀的日志。 */
	log(...args: unknown[]): void;
}

interface LoadedPlugin {
	info: UiPluginInfo;
	/** deactivate() if the entry provided one. */
	deactivate?: () => void;
	toolHandlers: Set<(ev: PluginToolEvent) => void>;
	/** onAttach 钩子（新客户端接入时逐个回调）。 */
	attachHandlers: Set<(clientId: string) => void>;
	/** onCwdChange 钩子（工作区切换时逐个回调）。 */
	cwdHandlers: Set<(cwd: string) => void>;
	/** 该插件注册的全部 AI 工具注销函数（反激活时逐个调用）。 */
	agentToolUnsubscribers?: Array<() => void>;
}

/** 每个插件的 AI 工具注册表（name → 定义）。 */
type AgentToolTable = Map<string, PluginAgentTool>;

/** 每个 WS 连接注册一个 sender；cid() 返回该 socket 的 clientId（attach 前 null）。 */
interface Sender {
	cid: () => string | null;
	send: (msg: ServerMessage) => void;
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
	/** 服务端重载纪元：每次 reload() +1，前端用作 import 缓存击穿参数。 */
	private epochCounter = 0;

	/** 当前全局工作区（host.cwd 的背后存储）——随 notifyCwd 更新。 */
	private cwdValue: string;

	constructor(
		private readonly dataDir: string,
		cwd: string,
	) {
		this.cwdValue = resolve(cwd);
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

	get pluginsDir(): string {
		return join(this.dataDir, "plugins");
	}

	/** 当前重载纪元（随 plugins 消息下发）。 */
	get epoch(): number {
		return this.epochCounter;
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
				}
			} catch (err) {
				console.error(`[plugin:${pluginId}] message handler failed:`, err);
			}
		}
	}

	broadcast(pluginId: string, payload: unknown): void {
		this.deliverAll({ type: "plugin_data", pluginId, payload });
	}

	/** 系统通知：发给所有 socket（复用 notice 消息，前端 toast 展示）。 */
	notifyAll(level: "info" | "warning" | "error", text: string): void {
		this.deliverAll({ type: "notice", level, text });
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
	async reload(): Promise<UiPluginInfo[]> {
		this.dispose();
		this.attempted.clear();
		this.epochCounter += 1;
		const list = await this.ensureLoaded();
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

	/** 当前全部插件注册的 AI 工具（扁平化，按插件 id 稳定排序）。 */
	getAgentTools(): PluginAgentTool[] {
		const out: PluginAgentTool[] = [];
		for (const table of [...this.agentTools.values()].sort())
			out.push(...table.values());
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
	async ensureLoaded(): Promise<UiPluginInfo[]> {
		const found = await this.scan();
		for (const info of found) {
			if (this.loaded.has(info.id) || this.attempted.has(info.id)) continue;
			if (!existsSync(join(this.pluginsDir, info.id, "index.mjs"))) continue; // 纯前端插件
			await this.activate(info);
		}
		// 已被删除的插件：调用 deactivate 并移出缓存
		for (const [id, p] of [...this.loaded]) {
			if (!found.some((f) => f.id === id)) {
				this.deactivateEntry(id, p);
			}
		}
		return found.map((f) => this.loaded.get(f.id)?.info ?? f);
	}

	/** 反激活单个插件：deactivate + 注销 AI 工具 + 清缓存。 */
	private deactivateEntry(id: string, p: LoadedPlugin): void {
		try {
			p.deactivate?.();
		} catch (err) {
			console.error(`[plugin:${id}] deactivate failed:`, err);
		}
		for (const off of [...(p.agentToolUnsubscribers ?? [])]) {
			try {
				off();
			} catch {
				/* already gone */
			}
		}
		this.loaded.delete(id);
		this.messageHandlers.delete(id);
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
			for (const off of [...(p.agentToolUnsubscribers ?? [])]) {
				try {
					off();
				} catch {
					/* shutting down */
				}
			}
		}
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
				};
				out.push({
					id: name,
					name: typeof m.name === "string" && m.name ? m.name : name,
					version: typeof m.version === "string" ? m.version : undefined,
					description:
						typeof m.description === "string" ? m.description : undefined,
					icon: typeof m.icon === "string" && m.icon.trim() ? m.icon.trim() : undefined,
					hasClient: existsSync(join(dir, "client", "entry.mjs")),
					error: this.loaded.get(name)?.info.error,
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

	private async activate(info: UiPluginInfo): Promise<void> {
		this.attempted.add(info.id);
		const dir = join(this.pluginsDir, info.id);
		const handlers = new Set<(payload: unknown) => void>();
		this.messageHandlers.set(info.id, handlers);
		const toolHandlers = new Set<(ev: PluginToolEvent) => void>();
		const attachHandlers = new Set<(clientId: string) => void>();
		const cwdHandlers = new Set<(cwd: string) => void>();
		const unregisterTools: Array<() => void> = [];
		const p: LoadedPlugin = { info, toolHandlers, attachHandlers, cwdHandlers };
		const self = this; // 对象字面量 getter 里不能用插件宿主的 this
		const host: PluginHost = {
			broadcast: (payload) => this.broadcast(info.id, payload),
			notify: (level, text) => this.notifyAll(level, text),
			sendTo: (clientId, payload) => this.sendTo(clientId, info.id, payload),
			onMessage: (h) => {
				handlers.add(h);
				return () => handlers.delete(h);
			},
			onToolEvent: (h) => {
				toolHandlers.add(h);
				return () => toolHandlers.delete(h);
			},
			onAttach: (h) => {
				attachHandlers.add(h);
				return () => attachHandlers.delete(h);
			},
			onCwdChange: (h) => {
				cwdHandlers.add(h);
				return () => cwdHandlers.delete(h);
			},
			// 包一层：插件反激活时自动注销它注册的全部 AI 工具，不留悬挂项。
			registerAgentTool: (tool) => {
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
			log: (...args) => console.log(`[plugin:${info.id}]`, ...args),
		};
		try {
			// Node 对同一 URL 的 import() 永远返回缓存模块——追加 epoch 作查询串
			// 击穿缓存，让 plugins_reload 后的重新激活能拿到磁盘上的新代码。
			const mod = (await import(
				pathToFileURL(join(dir, "index.mjs")).href + `?e=${this.epochCounter}`
			)) as {
				default?: {
					activate?: (host: PluginHost) => void | (() => void) | Promise<void | (() => void)>;
				};
			};
			const ret = await mod.default?.activate?.(host);
			this.loaded.set(info.id, {
				info: { ...info },
				deactivate: typeof ret === "function" ? ret : undefined,
				toolHandlers,
				attachHandlers,
				cwdHandlers,
				agentToolUnsubscribers: unregisterTools,
			});
			console.log(`[plugin:${info.id}] activated (v${info.version ?? "?"})`);
		} catch (err) {
			this.loaded.set(info.id, {
				info: { ...info, error: (err as Error).message },
				toolHandlers,
				attachHandlers,
				cwdHandlers,
			});
			console.error(`[plugin:${info.id}] activate failed:`, err);
		}
	}
}

/**
 * 把 /plugins/:id/client/<rest> 安全映射到 <pluginsDir>/<id>/client/<rest>。
 * 返回绝对路径；任何越界/非法 id 返回 null（调用方回 404）。
 */
export function resolvePluginClientFile(
	pluginsDir: string,
	id: string,
	rest: string,
): string | null {
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
	if (!Array.isArray(session._customTools) || typeof session._refreshToolRegistry !== "function")
		return null;
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
