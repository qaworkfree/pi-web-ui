/**
 * Wire protocol types — mirrors server/protocol.ts (kept in sync by hand).
 * Types only; no shared runtime code.
 */

export interface UiTextBlock {
	type: "text";
	text: string;
	truncated?: boolean;
}

export interface UiThinkingBlock {
	type: "thinking";
	thinking: string;
}

export interface UiToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	argumentsText?: string;
	argumentsTruncated?: boolean;
}

export interface UiImageBlock {
	type: "image";
	dataUrl?: string;
	mimeType?: string;
}

export interface UiBashBlock {
	type: "bash";
	command: string;
	output: string;
	exitCode?: number;
	cancelled?: boolean;
	truncated?: boolean;
}

export type UiContentBlock =
	| UiTextBlock
	| UiThinkingBlock
	| UiToolCallBlock
	| UiImageBlock
	| UiBashBlock
	| { type: string; [k: string]: unknown };

export interface UiMessage {
	id: string;
	role: string;
	content: UiContentBlock[];
	timestamp?: number;
	model?: string;
	provider?: string;
	stopReason?: string;
	errorMessage?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	customType?: string;
	details?: unknown;
}

export interface UiModelInfo {
	id: string;
	name: string;
	provider: string;
	/** Whether the model accepts image input (SDK `input` includes "image"). */
	vision: boolean;
}

export interface UiState {
	clientId: string;
	cwd: string;
	sessionId: string;
	sessionFile?: string;
	/** Id of the ACTIVE conversation (see `conversations` message). */
	conversationId: string;
	messages: UiMessage[];
	/**
	 * Live partial assistant message while a run is streaming (server sends the
	 * SDK's state.streamingMessage in every snapshot; null when idle). Rendered
	 * after `messages` with a live cursor.
	 */
	streamingMessage?: UiMessage | null;
	isStreaming: boolean;
	model: UiModelInfo | null;
	thinkingLevel: string;
	/** Model-supported thinking levels; UI must only offer these (mirror of protocol.ts). */
	availableThinkingLevels: string[];
	queue: { steering: number; followUp: number };
	errorMessage?: string;
	tools: string[];
	version: number;
	/** Whether the pi agent config looks ready (auth.json has credentials). */
	piConfigured?: boolean;
	/** Live session stats for the footer status bar. */
	stats: {
		totalMessages: number;
		tokens: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
		cost: number;
		contextUsage: {
			tokens: number | null;
			contextWindow: number;
			percent: number | null;
		};
	};
}

export interface CommandDef {
	name: string;
	/** Shell command to run in the terminal. */
	command: string;
	/** Working directory; supports ${pwd} (= the agent's current workspace dir). */
	cwd?: string;
}

/** Metadata for a persistent PTY owned by one conversation. */
export interface TerminalInfo {
	id: string;
	title: string;
	cwd: string;
	cols: number;
	rows: number;
	running: boolean;
	exitCode: number | null;
	command?: CommandDef;
}

/** A slash command available in the chat input (mirror of SlashCommandInfo). */
export interface SlashCommandInfo {
	/** Invokable command name without the leading slash (e.g. "new",
	 *  "skill:review", "templatename"). */
	name: string;
	description?: string;
	descriptionEn?: string;
	/** Argument placeholder shown in the picker (e.g. "<路径>", "[说明]"). */
	argumentHint?: string;
	argumentHintEn?: string;
	/** Where the command comes from: web-native builtin / SDK extension /
	 *  prompt template / skill. */
	source: "builtin" | "extension" | "prompt" | "skill";
}

export type ClientMessage =
	| { type: "hello"; clientId: string }
	/** Re-request the slash-command catalog (also pushed on attach / cwd change). */
	| { type: "get_commands" }
	| {
			type: "prompt";
			text: string;
			/**
			 * While the agent is streaming: queue this prompt and deliver it after
			 * the WHOLE run finishes (followUp) instead of steering (injecting it
			 * right after the current turn settles, skipping remaining tool calls).
			 * The 补充 (supplement) button sends queue=true; plain Enter keeps the
			 * steer semantic.
			 */
			queue?: boolean;
			attachments?: {
				path: string;
				mode?: "inline" | "reference" | "lines";
				/** 1-based inclusive line range (mode "lines" only). */
				lines?: { start: number; end: number };
				/**
				 * Raw image data (base64, no data: prefix) for images pasted,
				 * dropped or uploaded directly in the browser — no workspace path
				 * involved. When present the server sends it to the model as image
				 * content and ignores path/mode.
				 */
				imageData?: string;
				/**
				 * Raw uploaded file bytes (base64, no data: prefix) for files
				 * dropped/uploaded directly in the browser — no workspace path
				 * involved. The server persists them under the data dir and
				 * attaches as a path reference (or inlines small text files).
				 */
				fileData?: string;
				mimeType?: string;
				/** Display name for the attachment card (filename, or "粘贴图片.png"). */
				name?: string;
				/** Decoded byte size, for the card's size hint. */
				size?: number;
			}[];
	  }
	// -- terminal ------------------------------------------------------------
	| {
			type: "terminal_create";
			terminalId: string;
			cwd: string;
			cols: number;
			rows: number;
			conversationId?: string;
	  }
	| { type: "terminal_input"; terminalId: string; data: string; conversationId?: string }
	| { type: "terminal_resize"; terminalId: string; cols: number; rows: number; conversationId?: string }
	| { type: "terminal_kill"; terminalId: string; conversationId?: string }
	// Runs a command in a new shell; if the terminal already exists it is
	// RESTARTED in place (current process killed, fresh shell runs it again).
	| {
			type: "run_command";
			terminalId: string;
			command: CommandDef;
			cols: number;
			rows: number;
			conversationId?: string;
	  }
	// -- command list (.pi/commands.json) ------------------------------------
	| { type: "list_commands" }
	| { type: "save_commands"; commands: CommandDef[] }
	| { type: "abort" }
	/** Kill only the running bash command(s) — the agent run itself continues. */
	| { type: "abort_bash" }
	// -- background tasks (AI-started servers) ------------------------------
	/** Kill ONE background server the agent started (by listening port). */
	| { type: "kill_background_server"; port: number }
	/** Kill EVERY background server the agent started (frees all ports). */
	| { type: "kill_background_servers" }
	/** Re-push the current background-server list. */
	| { type: "list_bg_servers" }
	| { type: "new_chat" }
	/** Edit a past user question and re-ask it (forks a new session at that point). */
	| { type: "edit_message"; messageId: string; text: string }
	| { type: "cycle_model" }
	| { type: "cycle_thinking" }
	| { type: "get_state" }
	| { type: "list_sessions" }
	| { type: "switch_session"; path: string }
	| { type: "switch_conversation"; id: string }
	| { type: "list_projects" }
	| { type: "list_files"; path?: string }
	/** Read a workspace file for the preview panel (size-capped, binary-safe). */
	| { type: "read_file"; path: string }
	/** Save text edited in the file preview panel. */
	| { type: "write_file"; path: string; text: string }
	| { type: "list_models" }
	| { type: "set_model"; modelId: string }
	| { type: "set_thinking"; level: string }
	| { type: "set_cwd"; path: string }
	| { type: "complete_path"; path: string }
	| { type: "dialog_response"; id: number; value: string | boolean | null }
	// -- self-update ----------------------------------------------------------
	/** Check the npm registry for a newer pi-web-ui version. */
	| { type: "check_update" }
	/** npm i -g pi-web-ui@latest (restart required to take effect). */
	| { type: "update_app" }
	// -- pi agent setup ------------------------------------------------------
	| { type: "install_pi_agent" }
	| { type: "set_provider_api_key"; provider: string; apiKey: string }
	// -- custom model config (agentDir/models.json) ---------------------------
	| { type: "list_models_config" }
	| { type: "save_model_config"; providerId: string; config: UiProviderConfig }
	| { type: "delete_model_config"; providerId: string }
	| { type: "list_providers" }
	/** Probe a custom provider's OpenAI-compatible /models endpoint (server-side,
	 *  avoids browser CORS) and return the advertised model ids. reqId is echoed
	 *  back in fetch_models_result so the UI can match concurrent requests. */
	| {
			type: "fetch_models";
			reqId: number;
			baseUrl: string;
			apiKey?: string;
			authHeader?: boolean;
			/** api type: openai-completions / openai-responses / anthropic-messages / google-generative-ai. */
			api?: string;
	  }
	// -- goal / review -------------------------------------------------------
	/** Set (or clear) the active goal. See server/protocol.ts GoalStatus. */
	| {
			type: "set_goal";
			goal: string;
			reviewModel?: string;
			maxRounds: number;
			locked: boolean;
	  }
	| { type: "clear_goal" }
	/** Start the collaborative target wizard (isolated scoping session that
	 *  questions the user and auto-sets the refined goal). */
	| { type: "start_goal_wizard"; text: string; wizardModel?: string; maxRounds?: number; locked?: boolean }
	/** Persist goal/review preference defaults (model, rounds cap, locked). */
	| {
			type: "set_goal_prefs";
			reviewModel?: string;
			maxRounds?: number;
			locked?: boolean;
	  }
	// -- settings (system prompt / skills / extensions / presets) ------------
	/** Request the current settings state (also pushed automatically on attach). */
	| { type: "get_settings" }
	/** Apply a partial settings update for the main session or isolated reviewer. */
	| {
			type: "set_settings";
			promptMode?: "append" | "replace";
			customSystemPrompt?: string;
			disabledSkills?: string[];
			disabledExtensions?: string[];
			/** Vision bridge on/off + preferred "provider/id" model (null = auto). */
			visionBridgeEnabled?: boolean;
			visionBridgeModel?: string | null;
			/** Vision-bridge transcription prompt: mode (append/replace, same
			 *  semantics as promptMode) + custom text (empty = built-in default). */
			visionBridgePromptMode?: "append" | "replace";
			visionBridgePrompt?: string;
			/** Extra instructions and independently disabled skills for review. */
			reviewPrompt?: string;
			reviewDisabledSkills?: string[];
	  }
	/** Save the CURRENT settings as a named preset (overwrites if it exists). */
	| { type: "save_preset"; name: string }
	/** Replace the current settings with the named preset and apply it. */
	| { type: "apply_preset"; name: string }
	/** Remove the named preset. */
	| { type: "delete_preset"; name: string };

export interface SessionSummary {
	path: string;
	name?: string;
	firstMessage: string;
	messageCount: number;
	modified: number;
	/** Where the session lives: this UI's per-client dir, or the pi CLI/TUI dir. */
	source?: "web" | "tui";
}

/** A workspace directory this client has opened before (recent-project picker). */
export interface ProjectSummary {
	/** Absolute path of the workspace directory. */
	path: string;
	/** Last time this workspace was used (ms epoch) — drives the sort order. */
	lastUsed: number;
}

/** A background server the agent left running (listening-port diff around a
 *  bash tool run). Keyed by port. Managed from the 后台任务 panel: each entry
 *  can be stopped individually or all at once, and the list persists even
 *  after the conversation that started them ends. */
export interface BgServer {
	/** Port the server listens on (the stable key). */
	port: number;
	/** Process id of the listening process. */
	pid: number;
	/** When the server was first detected (ms epoch). */
	since: number;
	/** Best-effort process name (tasklist / ps), undefined when unknown. */
	name?: string;
}
/** One RUNNING conversation of the current project (each runs its own session
 *  in parallel). The list is per project and only contains conversations that
 *  were displaced to the background while still streaming; background-finish
 *  keeps them listed, opening-and-leaving-without-continuing removes them. */
export interface ConversationSummary {
	id: string;
	/** Display title: first user prompt (truncated) or the default. */
	title: string;
	cwd: string;
	messageCount: number;
	isStreaming: boolean;
}

export interface FileEntry {
	name: string;
	/** Path relative to the workspace root ('' for the root itself). */
	path: string;
	type: "file" | "dir";
	/**
	 * Preview category (files only; undefined for dirs). "none" files are
	 * never previewed — the UI doesn't open them and read_file refuses them.
	 */
	kind?: "image" | "video" | "text" | "none";
}

export interface FileListing {
	path: string;
	parent: string | null;
	entries: FileEntry[];
	/**
	 * The directory had more entries than the platform cap (win32: 2000,
	 * posix: 500) — the list was cut short. UI shows a hint when true.
	 */
	truncated: boolean;
}

/** Content of a workspace file fetched for the preview panel. */
export interface FileContent {
	path: string;
	name: string;
	/**
	 * Preview category: media kinds render via the /api/file HTTP endpoint
	 * (text stays empty); "none" means not previewable.
	 */
	kind: "image" | "video" | "text" | "none";
	text: string;
	truncated: boolean;
	binary: boolean;
	lines: number;
	size: number;
}

/** Current state of the goal-review loop, shown in the goal bar UI. */
export interface GoalStatus {
	/** Conversation that owns this goal; null when no goal is set. */
	conversationId: string | null;
	/** Active goal text; null when no goal is set. */
	goal: string | null;
	/** Reviewer model id ("provider/id"), or null to use the main model. */
	reviewModel: string | null;
	/** Maximum number of review rounds per goal run. */
	maxRounds: number;
	/** Whether the goal persists across turns (locked) or just the next one. */
	locked: boolean;
	/** True while a review is running right now. */
	reviewing: boolean;
	/** 1-based round counter for the current goal (review rounds). */
	round: number;
	/** Human-readable status line (e.g. "审查中", "已通过", "本轮不通过"). */
	status: string;
	/** Latest review verdict: "pending" | "pass" | "fail". */
	verdict: "pending" | "pass" | "fail";
	/** Latest review feedback text (reviewer's verdict reason, pass or fail). */
	feedback?: string;
	/** Collaborative target-wizard progress (null when no wizard is running). */
	wizard: WizardStatus;
}

/** Progress of the collaborative target wizard (see GoalStatus.wizard). */
export interface WizardStatus {
	active: boolean;
	draft: string;
	model: string | null;
	step: number;
	maxSteps: number;
	status: string;
}

export interface ModelInfo {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	/** Whether the model accepts image input (SDK `input` includes "image"). */
	vision: boolean;
}

/** One model definition inside a custom provider (agentDir/models.json). */
export interface UiModelConfigEntry {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
}

/** A custom provider block in models.json (providers.<id>). */
export interface UiProviderConfig {
	providerId: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	apiKey?: string;
	authHeader?: boolean;
	/** headers never reach the browser (may contain Authorization / API keys). */
	models: UiModelConfigEntry[];
}

/** One of pi's built-in providers, with whether auth is configured. */
export interface ProviderStatus {
	id: string;
	name: string;
	configured: boolean;
	source?: string;
}

/** A tool FINISHED executing (mirrors the tool_status ServerMessage). */
export interface ToolStatus {
	toolCallId: string;
	toolName: string;
	isError: boolean;
	/** Exit code when the tool result carries one (bash: parsed from error text). */
	exitCode?: number;
	/** tool_execution_start → tool_execution_end, in ms. */
	durationMs?: number;
}


// ---------------------------------------------------------------------------
// Settings (system prompt / skills / extensions / presets)
// ---------------------------------------------------------------------------

/** One loaded skill, with whether it is currently enabled. Disabled skills are
 *  excluded from the system prompt and from the /skill: command catalog. */
export interface UiSkillInfo {
	name: string;
	description: string;
	enabled: boolean;
}

/** One loaded extension, with whether it is currently enabled. Disabled
 *  extensions are unloaded from the runtime (tools/commands disappear). */
export interface UiExtensionInfo {
	/** Stable identity for the toggle: the npm spec for packages, the resolved
	 *  entry path otherwise. */
	id: string;
	/** Display label: npm package spec (npm:pi-foo) or the path basename. */
	name: string;
	/** Resolved entry path. */
	path: string;
	enabled: boolean;
}

/** A named combination of prompt mode/text + disabled skills/extensions that
 *  the user can re-apply in one click. Persisted per client. */
export interface UiSettingsPreset {
	name: string;
	promptMode: "append" | "replace";
	customSystemPrompt: string;
	disabledSkills: string[];
	disabledExtensions: string[];
	/** Extra instructions and skill toggles for the isolated goal-reviewer. */
	reviewPrompt: string;
	reviewDisabledSkills: string[];
}

/** One vision-capable model the vision bridge can use (picker option). */
export interface UiVisionBridgeModel {
	provider: string;
	id: string;
	/** Human-readable label: "qwen3-vl-plus (dashscope)". */
	label: string;
}

/** Full settings state pushed to the browser (settings_state). */
export interface UiSettingsState {
	promptMode: "append" | "replace";
	customSystemPrompt: string;
	disabledSkills: string[];
	disabledExtensions: string[];
	/** Vision bridge on/off (default on). Off → images are sent as-is. */
	visionBridgeEnabled: boolean;
	/** Preferred vision model as "provider/id", or null = auto-detect first. */
	visionBridgeModel: string | null;
	/** Vision-bridge transcription prompt mode: append to the built-in default
	 *  prompt, or replace it entirely (empty text = built-in default). */
	visionBridgePromptMode: "append" | "replace";
	/** Custom vision-bridge transcription prompt text. */
	visionBridgePrompt: string;
	/** Extra instructions appended to the built-in goal-review prompt. */
	reviewPrompt: string;
	/** Skills disabled only for the isolated goal-reviewer. */
	reviewDisabledSkills: string[];
	/** The built-in default system prompt (what replace mode would otherwise
	 *  replace) — prefill source for the replace-mode editor. Empty until the
	 *  resource-loader has run at least once. */
	defaultSystemPrompt: string;
	/** The built-in default vision-bridge transcription prompt. */
	visionBridgeDefaultPrompt: string;
	/** Vision-capable configured models available on this machine. */
	visionModels: UiVisionBridgeModel[];
	skills: UiSkillInfo[];
	/** Same skill catalog with enabled flags evaluated for the reviewer. */
	reviewSkills: UiSkillInfo[];
	extensions: UiExtensionInfo[];

	presets: UiSettingsPreset[];
}

export type ServerMessage =
	| { type: "ready"; clientId: string; serverVersion: string }
	| { type: "snapshot"; state: UiState }
	| {
			// Per-project running-conversation list (see ConversationSummary):
			// only conversations of the CURRENT cwd that are listed. activeId is
			// the active conversation even when it isn't listed (fresh chat).
			type: "conversations";
			conversations: ConversationSummary[];
			activeId: string;
	  }
	| { type: "tool_delta"; toolCallId: string; toolName: string; delta: string }
	/** A tool finished executing (SDK tool_execution_end) — flips the tool card
	 *  to "done" immediately, before the model's next response lands. */
	| {
			type: "tool_status";
			toolCallId: string;
			toolName: string;
			isError: boolean;
			exitCode?: number;
			durationMs?: number;
	  }
	// -- terminal ------------------------------------------------------------
	| { type: "terminal_output"; conversationId?: string; terminalId: string; data: string }
	| { type: "terminal_exit"; conversationId?: string; terminalId: string; exitCode: number | null }
	| { type: "terminal_list"; conversationId?: string; terminals: TerminalInfo[] }
	// -- command list (.pi/commands.json) ------------------------------------
	| { type: "commands"; commands: CommandDef[]; path: string }
	/** The slash-command catalog for the chat input (builtin + extension +
	 *  prompt template + skill commands). */
	| { type: "slash_commands"; commands: SlashCommandInfo[] }
	| { type: "notice"; level: "info" | "warning" | "error"; text: string }
	/** Sent every ~10s so clients can detect half-open connections. */
	| { type: "heartbeat" }
	| { type: "sessions"; sessions: SessionSummary[] }
	| { type: "projects"; projects: ProjectSummary[] }
	| {
			type: "files";
			path: string;
			parent: string | null;
			entries: FileEntry[];
			truncated: boolean;
	  }
	/** Content of a workspace file for the preview panel. */
	/** The server fs.watches the currently-listed directory and pushes this on
	 *  any file change so the client can refresh the listing instantly
	 *  (path = the listed directory; unknown/unsupported fs falls back to the
	 *  10s polling). */
	| { type: "file_changed"; path: string }
	| {
			type: "file_content";
			path: string;
			name: string;
			kind: "image" | "video" | "text" | "none";
			text: string;
			truncated: boolean;
			binary: boolean;
			lines: number;
			size: number;
	  }
	| { type: "models"; models: ModelInfo[] }
	| { type: "models_config"; providers: UiProviderConfig[] }
	| { type: "providers_status"; providers: ProviderStatus[] }
	/** Result of a fetch_models probe: ok + the advertised models (id plus
	 *  whatever metadata the endpoint provided — contextWindow / vision input /
	 *  reasoning / name / maxTokens — same shape as models.json rows), or an
	 *  error string. */
	| {
			type: "fetch_models_result";
			reqId: number;
			ok: boolean;
			models?: UiModelConfigEntry[];
			error?: string;
	  }
	| { type: "install_result"; ok: boolean; detail: string }
	| {
			type: "path_completions";
			completions: { name: string; path: string; type: "dir" | "file" }[];
	  }
	| { type: "widgets"; widgets: { key: string; lines: string[] }[] }
	| { type: "statuses"; statuses: { key: string; text: string | undefined }[] }
	| {
			type: "dialog";
			id: number;
			kind: "select" | "confirm" | "input";
			title: string;
			args: unknown[];
	  }
	/** Server resolved (or abandoned) a dialog — the client must close it. */
	| { type: "dialog_closed"; id: number }
	// -- self-update ----------------------------------------------------------
	/** Result of a check_update run (current/latest from the npm registry). */
	| {
			type: "update_status";
			/** Version of the RUNNING process (from its own package.json). */
			current: string;
			latest: string | null;
			/** Publish timestamp (ISO) of the latest version — lets the UI hint
			 * when it was just published and registry caches may lag. */
			latestPublishedAt: string | null;
			upToDate: boolean;
			/** True after a successful update — restart required to take effect. */
			pendingRestart: boolean;
			error?: string;
	  }
	/** Result of an update_app run (npm i -g). */
	| { type: "update_result"; ok: boolean; detail: string }
	// -- goal / review -------------------------------------------------------
	/** Goal status pushed whenever it changes (drives the goal bar UI). */
	| { type: "goal_status"; status: GoalStatus }
	/** Current settings state (system prompt mode/text, enabled skills &
	 *  extensions, saved presets). Pushed on attach and after every settings
	 *  change. */
	| { type: "settings_state"; settings: UiSettingsState }
	// -- background tasks ---------------------------------------------------
	/** The background-server list (servers the agent left running). Per CLIENT,
	 *  not per conversation — survives conversation switches/ends. Pushed on
	 *  change, on attach and on request. */
	| { type: "bg_servers"; servers: BgServer[] }
