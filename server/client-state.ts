/**
 * client-state — 每浏览器客户端的持久化 UI 状态（<dataDir>/client-state.json）：
 * 最近项目/工作目录、目标审查偏好、设置面板状态（提示词模式 + 技能/插件开关 +
 * 视觉桥偏好）、命名预设。文件 I/O 一律 best-effort：持久化故障绝不能
 * 弄崩 server 或阻塞会话。
 *
 * 从 agent-service.ts 抽出，行为保持不变。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** System-prompt mode: append the custom text to the built prompt, or replace
 *  the whole system prompt with it. */
export type PromptMode = "append" | "replace";

/** Settings-panel state (system prompt + disabled skills/extensions). */
export interface ClientSettings {
	promptMode: PromptMode;
	customSystemPrompt: string;
	disabledSkills: string[];
	disabledExtensions: string[];
	/** Vision bridge on/off (default on). Off → images are sent as-is. */
	visionBridgeEnabled: boolean;
	/** Preferred vision model as "provider/id", or null = auto-detect first. */
	visionBridgeModel: string | null;
	/** Vision-bridge transcription prompt mode: append to the built-in default
	 *  prompt, or replace it entirely (same semantics as promptMode). */
	visionBridgePromptMode: PromptMode;
	/** Custom vision-bridge transcription prompt text (empty = built-in default). */
	visionBridgePrompt: string;
	/** Extra instructions appended to the built-in goal-review prompt. */
	reviewPrompt: string;
	/** Skills disabled only for the isolated goal-reviewer. */
	reviewDisabledSkills: string[];
}

/** A named combo of prompt + skill/extension toggles the user can re-apply.
 *  Vision-bridge prefs are intentionally NOT part of a preset — they stay
 *  whatever the user currently has set when a preset is applied. */
export interface SettingsPreset
	extends Omit<
		ClientSettings,
		| "visionBridgeEnabled"
		| "visionBridgeModel"
		| "visionBridgePromptMode"
		| "visionBridgePrompt"
	> {
	name: string;
}

/** Stable identity of an extension for the enable/disable toggle: the npm
 *  spec for packages (survives version bumps), the resolved entry path
 *  otherwise. */
export function extensionKey(e: {
	sourceInfo?: { origin?: string; source?: string; path?: string };
	path: string;
}): string {
	const src = e.sourceInfo;
	if (src?.origin === "package" && src.source) return src.source;
	return src?.path ?? e.path;
}

export interface ClientState {
	/** Absolute path of the workspace this client last used. */
	lastCwd?: string;
	/** Workspaces this client opened before, most recent first (capped at 30). */
	projects: { path: string; lastUsed: number }[];
	/** Last-used goal / review preferences (model choice, max rounds, locked) so
	 *  they survive a reload — "全局记忆". maxRounds: 0 means unlimited. The model
	 *  choice is shared by both the goal-reviewer and the goal-wizard. */
	goalPrefs?: {
		reviewModel: string | null;
		maxRounds: number;
		locked: boolean;
	};
	/** Settings-panel state (system prompt mode/text + disabled skills/
	 *  extensions) so toggles survive a reload. */
	settings?: ClientSettings;
	/** Named settings presets (prompt + skill/extension toggles combos). */
	presets?: SettingsPreset[];
}

/**
 * Persists which workspace each browser client last used + which workspaces it
 * has opened, so a server restart / page reload restores the same project and
 * the UI can offer a one-click recent-project list. File I/O is best-effort:
 * persistence problems must never crash the server or block a session.
 */
export class ClientStateStore {
	private cache: Record<string, ClientState> | null = null;

	constructor(private filePath: string) {}

	private load(): Record<string, ClientState> {
		if (this.cache) return this.cache;
		try {
			const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Record<
				string,
				ClientState
			>;
			this.cache = parsed && typeof parsed === "object" ? parsed : {};
		} catch {
			this.cache = {};
		}
		return this.cache;
	}

	private save(): void {
		try {
			mkdirSync(dirname(this.filePath), { recursive: true });
			writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2) + "\n");
		} catch {
			// best effort
		}
	}

	get(clientId: string): ClientState {
		return this.load()[clientId] ?? { projects: [] };
	}

	/** Remember which workspace a client last used; bumps its project entry. */
	remember(clientId: string, cwd: string): void {
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		state.lastCwd = cwd;
		const now = Date.now();
		state.projects = [
			{ path: cwd, lastUsed: now },
			...state.projects.filter((p) => p.path !== cwd),
		].slice(0, 30);
		this.save();
	}

	/** Last-used goal/review prefs for a client, or undefined if never set. */
	getGoalPrefs(clientId: string): ClientState["goalPrefs"] {
		const s = this.load()[clientId];
		if (!s?.goalPrefs) return undefined;
		return {
			reviewModel: s.goalPrefs.reviewModel ?? null,
			maxRounds: s.goalPrefs.maxRounds ?? 0,
			locked: s.goalPrefs.locked ?? true,
		};
	}

	/** Persist the client's goal/review preferences (model choice, rounds, lock). */
	saveGoalPrefs(clientId: string, prefs: ClientState["goalPrefs"]): void {
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		state.goalPrefs = {
			reviewModel: prefs?.reviewModel ?? null,
			maxRounds: prefs?.maxRounds ?? 0,
			locked: prefs?.locked ?? true,
		};
		this.save();
	}

	/** Last-used settings-panel state for a client, or defaults. */
	getSettings(clientId: string): ClientSettings {
		const s = this.load()[clientId];
		return {
			promptMode: s?.settings?.promptMode === "replace" ? "replace" : "append",
			customSystemPrompt: s?.settings?.customSystemPrompt ?? "",
			disabledSkills: s?.settings?.disabledSkills ?? [],
			disabledExtensions: s?.settings?.disabledExtensions ?? [],
			visionBridgeEnabled: s?.settings?.visionBridgeEnabled ?? true,
			visionBridgeModel: s?.settings?.visionBridgeModel ?? null,
			visionBridgePromptMode:
				s?.settings?.visionBridgePromptMode === "replace" ? "replace" : "append",
			visionBridgePrompt: s?.settings?.visionBridgePrompt ?? "",
			reviewPrompt: s?.settings?.reviewPrompt ?? "",
			reviewDisabledSkills: s?.settings?.reviewDisabledSkills ?? [],
		};
	}

	/** Persist the client's settings-panel state (partial merge). */
	saveSettings(clientId: string, settings: Partial<ClientSettings>): void {
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		const cur = state.settings ?? ({} as ClientSettings);
		state.settings = {
			promptMode: settings.promptMode ?? cur.promptMode ?? "append",
			customSystemPrompt: settings.customSystemPrompt ?? cur.customSystemPrompt ?? "",
			disabledSkills: settings.disabledSkills ?? cur.disabledSkills ?? [],
			disabledExtensions: settings.disabledExtensions ?? cur.disabledExtensions ?? [],
			visionBridgeEnabled:
				settings.visionBridgeEnabled ?? cur.visionBridgeEnabled ?? true,
			visionBridgeModel: settings.visionBridgeModel ?? cur.visionBridgeModel ?? null,
			visionBridgePromptMode:
				settings.visionBridgePromptMode ??
				cur.visionBridgePromptMode ??
				"append",
			visionBridgePrompt:
				settings.visionBridgePrompt ?? cur.visionBridgePrompt ?? "",
			reviewPrompt: settings.reviewPrompt ?? cur.reviewPrompt ?? "",
			reviewDisabledSkills:
				settings.reviewDisabledSkills ?? cur.reviewDisabledSkills ?? [],
		};
		this.save();
	}

	/** Named settings presets for a client (empty if never saved). */
	getPresets(clientId: string): SettingsPreset[] {
		return (this.load()[clientId]?.presets ?? []).map((p) => ({
			...p,
			// Older client-state files predate review settings.
			reviewPrompt: p.reviewPrompt ?? "",
			reviewDisabledSkills: p.reviewDisabledSkills ?? [],
		}));
	}

	/** Persist the client's named settings presets. */
	savePresets(clientId: string, presets: SettingsPreset[]): void {
		const all = this.load();
		const state = (all[clientId] ??= { projects: [] });
		state.presets = presets;
		this.save();
	}
}
