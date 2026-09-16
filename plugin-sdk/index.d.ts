/**
 * pi-web-ui 插件 SDK 类型（starter，自包含，不引用 server/ 目录）。
 * 与 server/plugins.ts 的 PluginHost 同语义的精简版：写插件时抄 autocomplete 用，
 * 运行时以宿主实际注入为准（宿主 API 版本见 PLUGIN_API_VERSION）。
 */

export type PluginPermissionFamily =
	| "fs"
	| "fs:read"
	| "fs:write"
	| "ui"
	| "tools"
	| "http"
	| "chat"
	| "net"
	| "dom"
	| "dom:anchor";

export interface WsEntry {
	name: string;
	type: "file" | "dir";
}

export interface WsStat extends WsEntry {
	/** 字节数（目录为 0）。 */
	size: number;
	/** 修改时间毫秒时间戳。 */
	mtime: number;
}

export interface UiSelectOption {
	value: string;
	label?: string;
	labelEn?: string;
}

export type UiItemKind =
	| "view"
	| "action"
	| "badge"
	| "menu"
	| "page"
	| "organizer"
	| "divider"
	| "toggle"
	| "input"
	| "progress"
	| "select";

export interface UiContribution {
	id: string;
	slot?: string;
	label: string;
	labelEn?: string;
	icon?: string;
	hint?: string;
	hintEn?: string;
	kind?: UiItemKind;
	children?: UiContribution[];
	order?: number;
	align?: "start" | "center" | "end";
	group?: string;
	hidden?: boolean;
	action?: string;
	view?: string;
	when?: string[];
	badge?: string;
	checked?: boolean;
	value?: string;
	progress?: number;
	options?: UiSelectOption[];
}

export interface PluginAgentTool {
	name: string;
	label?: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters?: Record<string, unknown>;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: (partial: unknown) => void,
	): Promise<unknown>;
}

export interface PluginCommandDef {
	name: string;
	description?: string;
	descriptionEn?: string;
	argumentHint?: string;
	argumentHintEn?: string;
	run(args: string, ctx: { clientId?: string }): unknown | Promise<unknown>;
}

/** host.requestPermission：运行时申请能力范围（net 补主机，llm 限模型作用域）。
 *  基础族必须已声明；用户逐条确认（可记住），无浏览器/拒绝一律 false。 */
export interface PluginPermissionRequest {
	family: "net" | "llm";
	hosts?: string[];
	models?: string[];
	reason?: string;
}
/** host.schedule：定时任务（毫秒间隔或 5 字段 cron）。persistent 落盘，重启后重调即重建。 */
export interface PluginHostScheduleOptions {
	/** 持久任务的稳定 id（必填且合法，重启后靠它重建；每次 activate 都要重调）。 */
	id?: string;
	/** 重启不丢（声明 + lastRun 落盘；停止=删声明）。持久任务毫秒底线 60s。 */
	persistent?: boolean;
	/** 重启发现漏跑："skip"（缺省）跳过，"once" 补跑一次（15s 缓冲）。 */
	catchUp?: "skip" | "once";
	/** 后台面板显示名（缺省 id）。 */
	label?: string;
}

/** host.fs：工作区相对方法 + 跨目录 *Path 方法（后者需用户授权）。 */
export interface PluginHostFs {
	list(relDir?: string): Promise<WsEntry[]>;
	read(relPath: string): Promise<Buffer>;
	readText(relPath: string, maxBytes?: number): Promise<string>;
	write(relPath: string, data: string | Uint8Array): Promise<void>;
	remove(relPath: string): Promise<void>;
	stat(relPath: string): Promise<WsStat>;
	mkdir(relDir: string): Promise<void>;
	append(relPath: string, data: string | Uint8Array): Promise<void>;
	glob(pattern: string, relDir?: string): Promise<string[]>;
	requestAccess(dir: string, reason?: string): Promise<boolean>;
	authorizedDirs(): string[];
	listPath(absDir: string): Promise<WsEntry[]>;
	readPath(absPath: string): Promise<Buffer>;
	readTextPath(absPath: string, maxBytes?: number): Promise<string>;
	writePath(absPath: string, data: string | Uint8Array): Promise<void>;
	removePath(absPath: string): Promise<void>;
	statPath(absPath: string): Promise<WsStat>;
	mkdirPath(absDir: string): Promise<void>;
	appendPath(absPath: string, data: string | Uint8Array): Promise<void>;
	globPath(absDir: string, pattern: string): Promise<string[]>;
	watch(relPath: string, handler: (ev: { type: string; path: string }) => void): () => void;
}

/** host.ui：运行时 UI 条目管理（manifest "ui" 是声明式基线）。 */
export interface PluginHostUi {
	register(items: unknown[] | unknown): () => void;
	update(id: string, patch: Record<string, unknown>): void;
	remove(id: string): void;
	arrange(ops: unknown[] | unknown): void;
	list(): { items: UiContribution[]; arrange: unknown[] };
}

/** host.llm.complete：孤立无工具的一次性补全（不建对话、不进历史）。
 *  需要 manifest.permissions 含 "llm"（花用户自己的模型额度）。 */
export interface PluginHostLlm {
	complete(req: {
		prompt: string;
		system?: string;
		model?: string;
		maxChars?: number;
		timeoutMs?: number;
	}): Promise<{
		ok: boolean;
		text?: string;
		model?: string;
		usage?: { input: number; output: number };
		error?: string;
	}>;
}

/** 插件服务端入口拿到的宿主接口（精简：全量见 server/plugins.ts PluginHost）。 */
export interface PluginHost {
	broadcast(payload: unknown): void;
	notify(level: "info" | "warning" | "error", text: string, textEn?: string): void;
	onMessage(handler: (payload: unknown, from?: string) => void): () => void;
	sendTo(clientId: string, payload: unknown): void;
	onAttach(handler: (clientId: string) => void): () => void;
	onToolEvent(handler: (ev: unknown) => void): () => void;
	onRunEvent(handler: (ev: unknown) => void): () => void;
	getActiveConversation(): unknown;
	onConversationChanged(handler: () => void): () => void;
	registerAgentTool(tool: PluginAgentTool): () => void;
	dir: string;
	dataDir: string;
	readonly cwd: string;
	onCwdChange(handler: (cwd: string) => void): () => void;
	registerCommand(cmd: PluginCommandDef): () => void;
	ui: PluginHostUi;
	llm: PluginHostLlm;
	storage: {
		get<T>(key: string, fallback?: T): T | undefined;
		set(key: string, value: unknown): void;
		delete(key: string): void;
		all(): Record<string, unknown>;
	};
	secrets: {
		set(name: string, value: string): void;
		get(name: string): string | undefined;
		has(name: string): boolean;
		delete(name: string): void;
		list(): string[];
	};
	ensureDeps(specs: string[], opts?: { onProgress?: (msg: string) => void }): Promise<boolean>;
	fs: PluginHostFs;
	schedule(spec: string | number, fn: () => void, opts?: PluginHostScheduleOptions): () => void;
	requestPermission(req: PluginPermissionRequest): Promise<boolean>;
	getSettings(): Record<string, unknown>;
	onSettingsChanged(handler: (values: Record<string, unknown>) => void): () => void;
	log(...args: unknown[]): void;
}

/** 插件服务端入口形状（activate 必填，deactivate 可选）。 */
export interface PluginModule {
	activate(host: PluginHost): void | Promise<void>;
	deactivate?: () => void;
}

/** 插件宿主动作桥（window.__piWebUiHost，client bundle 用）。版本号见 PLUGIN_HOST_API_VERSION。 */
export interface PluginHostBridge {
	version: number;
	setView(view: string): void;
	/** 打开一个 `modal.dialog` 槽位的条目（全局 id `<pluginId>:<itemId>`；
	 *  不存在/被隐藏返回 false，同一时刻只开一个）。 */
	openModal(id: string): boolean;
	/** 关掉当前弹窗（幂等）。 */
	closeModal(): boolean;
	onUiAction(action: string, handler: (itemId: string, value?: string) => void): () => void;
}

/** 插件视图入口形状（client/entry.mjs 默认导出）。 */
export interface PluginViewModule {
	mount(el: HTMLElement, ctx: PluginViewContext): void | (() => void);
	cleanup?: () => void;
	renderers?: Record<string, (code: string, ctx: PluginViewContext) => HTMLElement | null>;
}

/** 视图 ctx（窄通道：只依赖 send/onData；动作回调走 window.__piWebUiHost.onUiAction，见 sdk onUiAction）。 */
export interface PluginViewContext {
	send(payload: unknown): void;
	onData(handler: (payload: unknown) => void): () => void;
}

export declare function definePlugin(def: PluginModule): PluginModule;
export declare function defineView(view: PluginViewModule): PluginViewModule;
export declare function defineRenderer(
	renderers: Record<string, (code: string, ctx: PluginViewContext) => HTMLElement | null>,
): Pick<PluginViewModule, "renderers">;
export declare function actionHandler(map: Record<string, (value?: string) => void>): (
	itemId: string,
	value?: string,
) => void;
export declare function onUiAction(action: string, handler: (itemId: string, value?: string) => void): () => void;
export declare function getSetting<T>(host: PluginHost, key: string, fallback: T): T;
export declare function selectOptions(list: Array<string | UiSelectOption>): UiSelectOption[];
