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
	/** 订阅智能体的工具执行事件（bash/读写文件等，start+end 成对）；返回注销函数。 */
	onToolEvent(handler: (ev: PluginToolEvent) => void): () => void;
	/** 插件自己的持久化目录（<dataDir>/plugins/<id>）——凭据等放这里。 */
	dir: string;
	/** 全局数据目录（~/.pi-web）。 */
	dataDir: string;
	/** 当前智能体工作区（服务启动目录）。 */
	cwd: string;
	/** 带前缀的日志。 */
	log(...args: unknown[]): void;
}

interface LoadedPlugin {
	info: UiPluginInfo;
	/** deactivate() if the entry provided one. */
	deactivate?: () => void;
	toolHandlers: Set<(ev: PluginToolEvent) => void>;
}

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
	/** 服务端重载纪元：每次 reload() +1，前端用作 import 缓存击穿参数。 */
	private epochCounter = 0;

	constructor(
		private readonly dataDir: string,
		private readonly cwd: string,
	) {}

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

	/** 客户端上行：路由给对应插件的处理器；未知/未激活的插件静默丢弃。 */
	handleMessage(pluginId: string, payload: unknown, from?: string): void {
		if (!ID_RE.test(pluginId)) return;
		const handlers = this.messageHandlers.get(pluginId);
		if (!handlers) return;
		for (const h of handlers) {
			try {
				h(payload, from);
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
	 *  返回新目录清单（含激活结果）。 */
	async reload(): Promise<UiPluginInfo[]> {
		this.dispose();
		this.attempted.clear();
		this.epochCounter += 1;
		return this.ensureLoaded();
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
				try {
					p.deactivate?.();
				} catch (err) {
					console.error(`[plugin:${id}] deactivate failed:`, err);
				}
				this.loaded.delete(id);
				this.messageHandlers.delete(id);
				console.log(`[plugin:${id}] removed`);
			}
		}
		return found.map((f) => this.loaded.get(f.id)?.info ?? f);
	}

	/** 关机时反激活全部插件。 */
	dispose(): void {
		for (const [id, p] of this.loaded) {
			try {
				p.deactivate?.();
			} catch (err) {
				console.error(`[plugin:${id}] deactivate failed:`, err);
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
			dir,
			dataDir: this.dataDir,
			cwd: this.cwd,
			log: (...args) => console.log(`[plugin:${info.id}]`, ...args),
		};
		try {
			const mod = (await import(
				pathToFileURL(join(dir, "index.mjs")).href
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
			});
			console.log(`[plugin:${info.id}] activated (v${info.version ?? "?"})`);
		} catch (err) {
			this.loaded.set(info.id, {
				info: { ...info, error: (err as Error).message },
				toolHandlers,
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
