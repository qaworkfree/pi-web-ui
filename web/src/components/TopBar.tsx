import { Fragment, useEffect, useState, type ReactNode } from "react";
import {
	FiDownload,
	FiFolder,
	FiGitBranch,
	FiGithub,
	FiGlobe,
	FiMenu,
	FiMessageSquare,
	FiMoreHorizontal,
	FiSearch,
	FiSun,
	FiPlus,
	FiSettings,
	FiLayers,
	FiTerminal,
	FiVolume2,
} from "react-icons/fi";
import type { ChatState, UpdateAllItem } from "../use-chat";
import type { CommandDef } from "../types";
import { buildUpdateCommand } from "../update-command";
import { randomUuid } from "../uuid";
import { Dropdown, DropdownItem } from "./Dropdown";
import { SoundSettingsPanel } from "./SoundSettings";
import { BrowserControl } from "./BrowserControl";
import { BROWSER_PAGE_TOOL_NAME } from "../../../server/tool-manager.js";
import { NotifyToggle } from "./NotifyToggle";
import type { SoundKind, SoundSettings } from "../sounds";
import { useI18n, localeShort } from "../i18n";
import type { UiSlotEntry } from "../ui-slots";
import { openContextMenu } from "../context-menu-state";
import { appSend, useAppGlobals, useIsManaged, useServiceInfo } from "../app-globals";
import { LocaleModal } from "./LocaleModal";

interface TopBarProps {
	chat: ChatState;
	/** Minimal terminal-tab bridge (same shape SCMPanel uses) — updates run there. */
	terminal: {
		create: (meta: {
			id: string;
			conversationId: string;
			title: string;
			cwd: string;
			cols: number;
			rows: number;
			running: boolean;
			exitCode: number | null;
			command?: CommandDef;
		}) => void;
		restart: (id: string) => void;
	};
	view: "chat" | "terminal" | "git" | `plugin:${string}`;
	onViewChange: (view: "chat" | "terminal" | "git" | `plugin:${string}`) => void;
	/** Installed optional plugins (<dataDir>/plugins) — one view tab each
	 *  (view:false renderer-only plugins are filtered out by the caller). */
	plugins: { id: string; name: string; icon?: string; description?: string; error?: string; view?: boolean }[];
	/** 顶栏主栏条目（内置 + 插件的最终结果，已按用户偏好/插件 arrange 排好；由 App 计算）。 */
	uiPrimary?: UiSlotEntry[];
	/** 溢出菜单条目：被隐藏/被移到 overflow 的条目（用户仍能从这里找回）。 */
	uiOverflow?: UiSlotEntry[];
	/** 点击一个条目：view 由宿主切视图，其余（action）交给贡献它的插件。 */
	onUiAction?: (item: UiSlotEntry) => void;
	/** 顶栏右键菜单的条目（contextmenu.topbar 槽位；插件可往里加项）。 */
	uiContextTopbar?: UiSlotEntry[];
	/** Open a side panel as a mobile drawer ("left" = history, "right" = files). */
	onOpenPanel: (side: "left" | "right") => void;
	/** Open the settings panel (system prompt / skills / extensions / presets). */
	onOpenSettings: () => void;
	/** Open the background-task panel (AI-started servers — stop individually or all). */
	onOpenBgTasks: () => void;
	/** Open the global search panel (sessions / projects / workspace files). */
	onOpenGlobalSearch: () => void;
	/** Sound notification settings + change handler (owned by App). */
	sound: SoundSettings;
	onSoundChange: (settings: SoundSettings) => void;
	onSoundPreview: (kind: SoundKind) => void;
	/** Theme list + current selection + switch handler (owned by App). */
	themes: { id: string; name: string; builtin: boolean; nameEn?: string }[];
	theme: string | null;
	onThemeChange: (id: string | null) => void;
	/** Re-fetch the theme list (called when a theme menu opens with an empty list). */
	reloadThemes: () => void;
}

export function TopBar({
	chat,
	terminal,
	view,
	plugins,
	uiPrimary,
	uiOverflow,
	uiContextTopbar,
	onUiAction,
	onViewChange,
	onOpenPanel,
	onOpenSettings,
	onOpenBgTasks,
	onOpenGlobalSearch,
	sound,
	onSoundChange,
	onSoundPreview,
	themes,
	theme,
	onThemeChange,
	reloadThemes,
}: TopBarProps) {
	const { locale, setLocale, t, packs } = useI18n();
	// 插件顶栏条目：主栏最多显示前几个，其余进「⋯」溢出菜单（宿主自己的菜单，
	// 插件不碰 DOM；顺序与设置面板里看到的一致，见 plugin-topbar.ts）。
	const [topbarMenuOpen, setTopbarMenuOpen] = useState(false);
	// 主栏容量：内置 tab 之外最多再放 4 个插件条目。宿主内置条目的隐藏状态由
	// uiPrimary 里"有没有 host:xxx"决定（插件 hide 掉的内置入口会出现在溢出菜单里，
	// 用户仍能点回来 —— 插件能整理一切，但锁不死用户）。
	const pluginEntryLimit = 4;
	const hostIds = new Set((uiPrimary ?? []).filter((e) => e.source === "host").map((e) => e.id));
	const pluginEntries = (uiPrimary ?? []).filter((e) => e.source !== "host");
	const inlineTopbarItems = pluginEntries.slice(0, pluginEntryLimit);
	const overflowTopbarItems = [...pluginEntries.slice(pluginEntryLimit), ...(uiOverflow ?? [])];
	/** 内置入口可见性：TABS 白名单 + 未被插件/用户隐藏。
	 *  `uiPrimary` 完全没给（未接线 / 单测）时按「全部可见」—— 没拿到 slot 数据就把宿主
	 *  自己的入口全藏了，是最难查的一类“顶栏忽然空了”。 */
	const hostOn = (name: string) => tabOn(name) && (uiPrimary === undefined || hostIds.has(`host:${name}`));
	/**
	 * 溢出菜单里的**宿主内置动作**：点下去得真干活。
	 *
	 * 为什么需要它：布局页（或插件 arrange）隐藏一个内置入口后，它会从主栏落到「⋯」溢出菜单
	 * （见 uiOverflow 的组成）—— 此时点它走的是 App 的 onUiAction，而那个函数只分发**插件**
	 * 动作（`source !== "host"`）。宿主自己的入口实现全在 TopBar 里（与 T1 的教训一致：
	 * `host:*` 的实现留在拥有它的组件内），所以这里按 id 映射到本地处理器；返回 false = 不认识
	 * 这个 id（比如插件条目、或 kind="view" 的条目）→ 交回 onUiAction。
	 */
	const dispatchHostOverflow = (entry: UiSlotEntry): boolean => {
		if (entry.source !== "host") return false;
		switch (entry.id) {
			case "host:history":
				onOpenPanel("left");
				return true;
			case "host:files":
				onOpenPanel("right");
				return true;
			case "host:new-chat":
				appSend({ type: "new_chat" });
				return true;
			case "host:search":
				onOpenGlobalSearch();
				return true;
			case "host:tasks":
				onOpenBgTasks();
				return true;
			case "host:settings":
				onOpenSettings();
				return true;
			default:
				// 视图三连（chat/terminal/git）交给 App 的 onUiAction（它自己 setView）；
				// 其余登记了位置但渲染层不消费的条目（声音/语言/主题/版本/GitHub）本就不进溢出菜单。
				return false;
		}
	};

	/** 右键一个顶栏条目 → 打开 contextmenu.topbar 槽位（插件可往里贡献菜单项）。 */
	const openItemMenu = (e: React.MouseEvent, id: string, label: string) => {
		e.preventDefault();
		openContextMenu({
			x: e.clientX,
			y: e.clientY,
			slot: "contextmenu.topbar",
			target: { id, label },
			entries: uiContextTopbar ?? [],
		});
	};
	// 受管标记与自身版本号：走全局（web/src/app-globals.ts），整个连接内不变。
	const { appVersion } = useAppGlobals();
	const managed = useIsManaged();
	// 由 pi-web-ui 服务启动的实例（launchd/systemd/Windows watchdog）：退出后会被
	// supervisor 拉起，所以更新面板给出「重启服务」按钮；前台/dev 实例没有值。
	const service = useServiceInfo();
	const [restarting, setRestarting] = useState(false);
	// 「重启服务」会断开连接（进程退出→supervisor 拉起）：重新连上（open）后
	// 把按钮恢复可用，否则它会永远停在「重启中…」。
	useEffect(() => {
		if (restarting && chat.status === "open") setRestarting(false);
	}, [restarting, chat.status]);
	const [soundOpen, setSoundOpen] = useState(false);
	const [langOpen, setLangOpen] = useState(false);
	const [themeOpen, setThemeOpen] = useState(false);
	const [updateOpen, setUpdateOpen] = useState(false);
	const [moreOpen, setMoreOpen] = useState(false);
	const [localeModalOpen, setLocaleModalOpen] = useState(false);

	/** Switcher shows each pack's native name verbatim (never translated). */

	const connLabel = chat.ready ? t("connected") : chat.status === "closed" ? t("reconnecting") : t("connecting");
	const connClass = chat.ready ? "ok" : "busy";

	/** Run `npm i -g pi-web-ui@latest` in a visible terminal tab (SCM-style):
	 *  reuse the tab with the same title, otherwise create one; switch to the
	 *  terminal view so the user watches the install live. */
	const runUpdate = () => {
		if (!chat.ready) return;
		const title = t("updateTabTitle");
		const cmd: CommandDef = {
			name: title,
			command: "npm i -g pi-web-ui@latest",
			cwd: "${pwd}",
		};
		const existing = chat.terminals.find((tm) => tm.title === title);
		if (existing) {
			terminal.restart(existing.id);
			appSend({
				type: "run_command",
				terminalId: existing.id,
				conversationId: existing.conversationId,
				command: cmd,
				cols: 80,
				rows: 24,
			});
		} else {
			terminal.create({
				id: randomUuid(),
				conversationId: chat.activeConversationId || chat.state?.conversationId || "",
				title,
				cwd: chat.state?.cwd ?? "",
				cols: 80,
				rows: 24,
				running: true,
				exitCode: null,
				command: cmd,
			});
		}
		setUpdateOpen(false);
		setMoreOpen(false);
		onViewChange("terminal");
	};

	/** Run the right update command for one or more components in a visible
	 *  terminal tab (same SCM-style pattern as the self-update above): pi
	 *  extensions go through `pi update npm:<name>` (they live under
	 *  <agentDir>/npm), everything globally installed via `npm i -g`.
	 *  Multi-target runs are chained with `;` so one failing step never
	 *  blocks the rest. Reuses the tab with the same title, else creates one. */
	const runPkgUpdate = (items: UpdateAllItem[], title: string) => {
		if (!chat.ready || items.length === 0) return;
		const cmd: CommandDef = {
			name: title,
			command: buildUpdateCommand(items),
			cwd: "${pwd}",
		};
		const existing = chat.terminals.find((tm) => tm.title === title);
		if (existing) {
			terminal.restart(existing.id);
			appSend({
				type: "run_command",
				terminalId: existing.id,
				conversationId: existing.conversationId,
				command: cmd,
				cols: 80,
				rows: 24,
			});
		} else {
			terminal.create({
				id: randomUuid(),
				conversationId: chat.activeConversationId || chat.state?.conversationId || "",
				title,
				cwd: chat.state?.cwd ?? "",
				cols: 80,
				rows: 24,
				running: true,
				exitCode: null,
				command: cmd,
			});
		}
		setUpdateOpen(false);
		setMoreOpen(false);
		onViewChange("terminal");
	};

	// Shared by the desktop update dropdown and the mobile "⋯" panel.
	/* PI_WEB_TABS: an instance can be set up to offer only some tabs — the
	   server refuses the messages of the others anyway (server/tabs.ts), so
	   drawing them would only offer an action that comes back refused. No list
	   means every tab, which is the default. */
	const tabOn = (tab: string) => !chat.tabs || tab === "chat" || chat.tabs.includes(tab);

	const allUpdates = chat.updatesAll ?? [];
	// Pure errors don't count as "updates" — they're shown as failed rows.
	const updatesCount = allUpdates.filter((i) => !i.upToDate && !i.error).length;
	// Packages (+ the pi core) with a real newer version — targets of the
	// per-row and "update all" buttons. The web UI itself is excluded: it has
	// its own dedicated update flow above the all-components section.
	const updatable = allUpdates.filter((i) => !i.upToDate && !i.error && i.kind !== "webui");
	const renderAllUpdatesBody = () => (
		<div className="dd-updates-all">
			<div className="dd-header">{t("updatesAllTitle")}</div>
			{chat.updatesAll === null ? (
				<div className="dd-note">{t("checkingUpdate")}</div>
			) : allUpdates.length === 0 ? (
				<div className="dd-note">{t("updatesAllUpToDate")}</div>
			) : (
				<ul className="dd-all-list">
					{allUpdates.map((item) => (
						<li
							key={`${item.kind}:${item.name}`}
							className={`dd-all-item${item.error ? " err" : item.upToDate ? "" : " warn"}`}
						>
							<span className="dd-all-name" title={item.name}>
								{item.name}
							</span>
							<span className="dd-all-kind">
								{item.kind === "webui" ? t("kindWebUi") : item.kind === "pi-core" ? t("kindPiCore") : t("kindPackage")}
							</span>
							<span className="dd-all-vers">
								{item.error ? (
									t("updateCheckFailed")
								) : item.upToDate ? (
									`v${item.current}`
								) : (
									<>
										v{item.current} → v{item.latest}
									</>
								)}
							</span>
							{item.kind !== "webui" && !item.upToDate && !item.error && (
								<button
									type="button"
									className="dd-update-btn"
									onClick={() => runPkgUpdate([item], t("updatePkgTabTitle", { name: item.name }))}
								>
									{t("updateBtn")}
								</button>
							)}
						</li>
					))}
				</ul>
			)}
			<div className="dd-actions">
				{updatable.length > 0 && (
					<button
						type="button"
						className="dd-refresh accent"
						style={{ flex: 1 }}
						onClick={() => runPkgUpdate(updatable, t("updateAllTabTitle"))}
					>
						{t("updateAllBtn")}
					</button>
				)}
				<button
					type="button"
					className="dd-refresh"
					style={updatable.length > 0 ? { flex: 1 } : undefined}
					onClick={() => appSend({ type: "check_updates_all", force: true })}
				>
					{t("updatesAllRefresh")}
				</button>
			</div>
		</div>
	);
	const renderUpdateBody = () => (
		<>
			<div className="dd-update">
				<div className="dd-row">
					<span>{t("currentVersion")}</span>
					<b>v{chat.update?.current ?? "…"}</b>
				</div>
				<div className="dd-row">
					<span>{t("latestVersion")}</span>
					<b>
						{chat.update === null
							? t("checkingUpdate")
							: chat.update.error
								? chat.update.error
								: chat.update.latest
									? `v${chat.update.latest}`
									: t("checkingUpdate")}
					</b>
				</div>
				{chat.update && chat.update.upToDate && <div className="dd-note ok">{t("upToDate")}</div>}
				{chat.update && !chat.update.upToDate && chat.update.latest && (
					<div className="dd-note warn">{t("updateAvailable", { version: chat.update.latest })}</div>
				)}
				{chat.update?.latestPublishedAt &&
					Date.now() - new Date(chat.update.latestPublishedAt).getTime() < 30 * 60_000 && (
						<div className="dd-note warn">
							{t("updateJustPublished", {
								version: chat.update.latest ?? "",
							})}
						</div>
					)}
				{chat.update && !chat.update.upToDate && chat.update.latest && (
					<div className="dd-note">{t("updateTerminalHint")}</div>
				)}
			</div>
			<div className="dd-actions">
				<button type="button" className="dd-refresh" onClick={() => appSend({ type: "check_update" })}>
					{chat.update === null ? t("checkingUpdate") : t("checkUpdate")}
				</button>
				{chat.update && !chat.update.upToDate && chat.update.latest && (
					<button type="button" className="dd-refresh accent" onClick={runUpdate}>
						{t("updateNow")}
					</button>
				)}
				{service && (
					<button
						type="button"
						className="dd-refresh accent"
						disabled={restarting}
						title={t("restartServiceTip", { name: service.name })}
						onClick={() => {
							if (restarting) return;
							setRestarting(true);
							appSend({ type: "restart_service" });
						}}
					>
						{restarting ? t("restartingService") : t("restartService")}
					</button>
				)}
			</div>
		</>
	);

	/**
	 * 桌面工具组的节点工厂（issue #146 的「位置登记」真正落地）：**成员、顺序、可见性**全部来自
	 * `uiPrimary`（= `buildUiSlots` 的结果，App 已滤掉 hidden 的）—— 用户在设置面板「界面布局」里勾掉
	 * 「声音」，它真的从顶栏消失、并落到「⋯」溢出菜单里（整块组件搬过去，不是只剩个标题）；↑↓ 调序也真的换位置。
	 *
	 * `uiPrimary` 整个没给（未接线 / 单测）→ 按内置默认顺序全画：没拿到 slot 数据就把顶栏清空是最糟的降级。
	 */
	const hostNodes: Record<string, ReactNode> = {
		"host:search": (
			<button type="button" className="chip" title={t("searchGlobalTip")} onClick={onOpenGlobalSearch}>
				<FiSearch />
				<span className="chip-sub">{t("searchGlobal")}</span>
			</button>
		),
		"host:browser": !(chat.settings?.disabledAgentTools?.includes(BROWSER_PAGE_TOOL_NAME) ?? false) ? (
			<BrowserControl />
		) : null,
		"host:tasks": (
			<button type="button" className="chip bg-task-chip" data-tip={t("bgTasksTip")} onClick={onOpenBgTasks}>
				<FiLayers />
				<span className="chip-sub">{t("bgTasks")}</span>
				{chat.bgServers.length > 0 && <span className="bg-task-badge">{chat.bgServers.length}</span>}
			</button>
		),
		"host:settings": (
			<button type="button" className="chip" title={t("settingsTitle")} onClick={onOpenSettings}>
				<FiSettings />
				<span className="chip-sub">{t("settings")}</span>
			</button>
		),
		"host:sound": (
			<Dropdown
				trigger={
					<>
						<FiVolume2 />
						<span className="chip-sub">{t("sound")}</span>
					</>
				}
				open={soundOpen}
				onOpenChange={setSoundOpen}
			>
				<SoundSettingsPanel settings={sound} onChange={onSoundChange} onPreview={onSoundPreview} />
				<NotifyToggle />
			</Dropdown>
		),
		"host:language": (
			<Dropdown
				trigger={
					<>
						<FiGlobe />
						<span className="chip-sub">{localeShort(locale)}</span>
					</>
				}
				open={langOpen}
				onOpenChange={setLangOpen}
			>
				<div className="dd-header">{t("language")}</div>
				{packs.map((l) => (
					<DropdownItem
						key={l.code}
						active={locale === l.code}
						onClick={() => {
							setLocale(l.code);
							setLangOpen(false);
						}}
					>
						{l.nativeName}
					</DropdownItem>
				))}
				<DropdownItem
					onClick={() => {
						setLangOpen(false);
						setLocaleModalOpen(true);
					}}
				>
					<FiDownload /> {t("localeGetMore")}
				</DropdownItem>
			</Dropdown>
		),
		"host:theme": (
			<Dropdown
				trigger={
					<>
						<FiSun />
						<span className="chip-sub">{t("theme")}</span>
					</>
				}
				open={themeOpen}
				onOpenChange={(v) => {
					setThemeOpen(v);
					// 挂载那次拉取若撞上服务端重启会扑空：打开时列表还空就补拉一次
					if (v && themes.length === 0) reloadThemes();
				}}
			>
				<div className="dd-header">{t("theme")}</div>
				<DropdownItem
					active={theme === null}
					onClick={() => {
						onThemeChange(null);
						setThemeOpen(false);
					}}
				>
					{t("themeDefault")}
				</DropdownItem>
				{themes.map((th) => (
					<DropdownItem
						key={th.id}
						active={theme === th.id}
						onClick={() => {
							onThemeChange(th.id);
							setThemeOpen(false);
						}}
					>
						{locale === "zh" ? th.name : (th.nameEn ?? th.name)}
					</DropdownItem>
				))}
			</Dropdown>
		),
		"host:update": managed ? (
			<span className="chip" title={t("updatesManaged")}>
				<FiDownload />
				<span className="chip-sub">v{appVersion ?? chat.update?.current ?? "…"}</span>
			</span>
		) : (
			<Dropdown
				trigger={
					<>
						<FiDownload />
						<span className="chip-sub">v{chat.update?.current ?? "…"}</span>
						{chat.update && !chat.update.upToDate && (
							<span
								className="update-dot"
								title={t("updateAvailable", {
									version: chat.update.latest ?? "",
								})}
							/>
						)}
						{updatesCount > 0 && <span className="update-badge">{t("updatesAllBadge", { n: updatesCount })}</span>}
					</>
				}
				open={updateOpen}
				onOpenChange={(v) => {
					setUpdateOpen(v);
					if (v) {
						appSend({ type: "check_update" });
						appSend({ type: "check_updates_all" });
					}
				}}
				fit
			>
				<div className="dd-header">{t("update")}</div>
				{renderUpdateBody()}
				{renderAllUpdatesBody()}
			</Dropdown>
		),
		"host:github": (
			<a
				className="chip github"
				href="https://github.com/xing-shuyin/pi-web-ui"
				target="_blank"
				rel="noreferrer noopener"
				title={t("githubRepo")}
			>
				<FiGithub />
			</a>
		),
	};

	/** 桌面工具组的成员（顺序 = BUILTIN_UI_ITEMS 里的默认次序；自定义顺序由 uiPrimary 决定）。 */
	const DESKTOP_GROUP_IDS = [
		"host:search",
		"host:browser",
		"host:tasks",
		"host:settings",
		"host:sound",
		"host:language",
		"host:theme",
		"host:update",
		"host:github",
	];
	/** 这几个组成员的显隐**还**受 PI_WEB_TABS 白名单管（历史上就是它们，别扩大范围）。 */
	const TABS_GATED_IDS = new Set(["host:search", "host:tasks", "host:settings"]);
	/** 溢出菜单里**整块搬进来**的宿主条目（菜单型：下拉/外链/自带面板）。
	 *  其余宿主条目（history / files / new-chat / search / tasks / settings）在菜单里是一条扁平
	 *  菜单项，由 dispatchHostOverflow 分派到本地处理器 —— 扁平的更像菜单，整块的才需要搬组件。 */
	const OVERFLOW_AS_NODE_IDS = new Set([
		"host:sound",
		"host:language",
		"host:theme",
		"host:update",
		"host:github",
		"host:browser",
	]);
	const DESKTOP_GROUP_SET = new Set(DESKTOP_GROUP_IDS);
	/** 当前要画的成员工厂**顺序**：`uiPrimary` 没给 → 内置默认；给了就**按它的顺序**
	 *  （App 传进来的那份已经滤掉 hidden、并应用了插件 arrange 与用户 ↑↓），这样布局页里
	 *  调序在顶栏上真的看得出来。 */
	const desktopGroupIds =
		uiPrimary === undefined
			? DESKTOP_GROUP_IDS.filter((id) => tabOn(id.slice("host:".length)))
			: uiPrimary
					.filter((e) => e.source === "host" && DESKTOP_GROUP_SET.has(e.id))
					.filter((e) => (TABS_GATED_IDS.has(e.id) ? tabOn(e.id.slice("host:".length)) : true))
					.map((e) => e.id);

	return (
		<header className="topbar">
			<div className="brand">
				{/* 抽屉开合按钮只在 chat 视图渲染：抽屉节点躺在 chat 视图的面板树里
				   （App.tsx 的 .panel-drawer 是 `.view-pane` 的子节点，非 chat 视图整棵
				   display:none），所以终端 / Git / 插件视图里点它只会拉出一层遮罩、
				   抽屉永远不出现 —— 而且顶栏这个 ☰ 会和终端面板自己的 ☰ 并排成两个。 */}
				{view === "chat" && hostOn("history") && (
					<button type="button" className="panel-toggle" title={t("openHistory")} onClick={() => onOpenPanel("left")}>
						<FiMenu />
					</button>
				)}
				<span className="brand-logo">π</span>
				<span className="brand-name">pi-web-ui</span>
				<span className={`conn-dot ${connClass}`} title={connLabel} />
				<span className="conn-label">{connLabel}</span>
			</div>

			<div className="topbar-actions">
				<div className="view-switch" role="tablist" aria-label={t("viewSwitch")}>
					<button
						type="button"
						role="tab"
						aria-selected={view === "chat"}
						className={view === "chat" ? "active" : ""}
						onClick={() => onViewChange("chat")}
					>
						<FiMessageSquare />
						<span>{t("chat")}</span>
					</button>
					{hostOn("terminal") && (
						<button
							type="button"
							role="tab"
							aria-selected={view === "terminal"}
							className={view === "terminal" ? "active" : ""}
							onClick={() => onViewChange("terminal")}
						>
							<FiTerminal />
							<span>{t("terminal")}</span>
						</button>
					)}
					{hostOn("git") && (
						<button
							type="button"
							role="tab"
							aria-selected={view === "git"}
							className={view === "git" ? "active" : ""}
							onClick={() => onViewChange("git")}
						>
							<FiGitBranch />
							<span>{t("scmTab")}</span>
						</button>
					)}
					{(tabOn("plugins") ? plugins : [])
						.filter((p) => p.view !== false)
						.map((p) => {
							const tip = p.error ? `${p.name}: ${p.error}` : p.description ? `${p.name} — ${p.description}` : p.name;
							return (
								<button
									key={p.id}
									type="button"
									role="tab"
									aria-selected={view === `plugin:${p.id}`}
									className={`plugin-tab${view === `plugin:${p.id}` ? " active" : ""}${p.error ? " broken" : ""}`}
									title={tip}
									onClick={() => onViewChange(`plugin:${p.id}`)}
								>
									{p.icon ? <span aria-hidden>{p.icon}</span> : null}
									<span>{p.name}</span>
								</button>
							);
						})}
					{/* 插件贡献的顶栏条目（issue #146）：宿主渲染 + 溢出菜单，插件只声明。 */}
					{inlineTopbarItems.map((it) => (
						<button
							key={it.id}
							type="button"
							className="plugin-topbar-item"
							title={it.hint ?? it.label}
							onClick={() => onUiAction?.(it)}
							onContextMenu={(e) => openItemMenu(e, it.id, it.label)}
						>
							{it.icon ? <span aria-hidden>{it.icon}</span> : null}
							<span>{it.label}</span>
						</button>
					))}
					{overflowTopbarItems.length > 0 && (
						<div className="plugin-topbar-more">
							<button
								type="button"
								className="plugin-topbar-item"
								aria-haspopup="menu"
								aria-expanded={topbarMenuOpen}
								title={t("pluginTopbarMore")}
								onClick={() => setTopbarMenuOpen((v) => !v)}
							>
								⋯
							</button>
							{topbarMenuOpen && (
								<div className="plugin-topbar-menu" role="menu">
									{overflowTopbarItems.map((it) => {
										// 被隐藏的**宿主菜单型**条目（声音/语言/主题/版本/GitHub/浏览器操作）：
										// 它们不是一次性动作，扁平按钮点了没意义 —— 把整块组件搬进溢出菜单，
										// 这样「隐藏」只是换了个位置，功能一点不少（与内建条目的实现留在组件内一致）。
										const asNode =
											it.source === "host" && OVERFLOW_AS_NODE_IDS.has(it.id) ? hostNodes[it.id] : undefined;
										if (asNode !== undefined) {
											return <Fragment key={it.id}>{asNode}</Fragment>;
										}
										return (
											<button
												key={it.id}
												type="button"
												role="menuitem"
												title={it.hint ?? it.label}
												onClick={() => {
													setTopbarMenuOpen(false);
													// 宿主内置动作在本地分派（见 dispatchHostOverflow），其余交回 onUiAction。
													if (!dispatchHostOverflow(it)) onUiAction?.(it);
												}}
											>
												{it.icon && !/[a-z]/i.test(it.icon) ? `${it.icon} ` : ""}
												{it.label}
											</button>
										);
									})}
								</div>
							)}
						</div>
					)}{" "}
				</div>

				{/* Desktop toolbar — hidden on mobile (model/thinking move into the
				    input row; sound/lang/update/github fold into "⋯" below). */}
				<div className="topbar-desktop">
					{/* 桌面工具组（issue #146）：成员、顺序、可见性全部来自 slot 列表（见 hostNodes /
					    DESKTOP_GROUP_IDS）—— 布局页勾掉「声音」它真的消失并落到「⋯」溢出菜单里，
					    ↑↓ 调序也真的换位置。 */}
					{desktopGroupIds.map((id) => (
						<Fragment key={id}>{hostNodes[id] ?? null}</Fragment>
					))}
				</div>

				{/* 新建对话（用户可在布局页隐藏它——隐藏后从顶部「⋯」溢出菜单里仍能点到，
				    见 dispatchHostOverflow）。 */}
				{hostOn("new-chat") && (
					<button
						type="button"
						className="chip newchat"
						data-tip={t("newChatTip")}
						onClick={() => appSend({ type: "new_chat" })}
					>
						<FiPlus />
						<span>{t("newChat")}</span>
					</button>
				)}

				{/* Mobile "⋯" panel — folds sound / language / update / GitHub.
				    Hidden on desktop (each stays its own chip up there). */}
				<div className="topbar-more">
					<Dropdown
						trigger={
							<>
								<FiMoreHorizontal />
								<span className="chip-sub">{t("more")}</span>
								{!managed && chat.update && !chat.update.upToDate && <span className="update-dot" />}
							</>
						}
						open={moreOpen}
						onOpenChange={(v) => {
							setMoreOpen(v);
							// 溢出菜单里同样有主题区：列表空就补拉一次（同上）
							if (v && themes.length === 0) reloadThemes();
							if (v && !managed) {
								appSend({ type: "check_update" });
								appSend({ type: "check_updates_all" });
							}
						}}
					>
						<div className="dd-header">{t("sound")}</div>
						<div className="dd-header">{t("settings")}</div>
						<DropdownItem
							onClick={() => {
								setMoreOpen(false);
								onOpenSettings();
							}}
						>
							<FiSettings /> {t("settingsTitle")}
						</DropdownItem>
						<DropdownItem
							onClick={() => {
								setMoreOpen(false);
								onOpenGlobalSearch();
							}}
						>
							<FiSearch /> {t("searchGlobal")}
						</DropdownItem>
						<DropdownItem
							onClick={() => {
								setMoreOpen(false);
								onOpenBgTasks();
							}}
						>
							<FiLayers /> {t("bgTasks")}
							{chat.bgServers.length > 0 && <em className="bg-task-badge">{chat.bgServers.length}</em>}
						</DropdownItem>
						<SoundSettingsPanel settings={sound} onChange={onSoundChange} onPreview={onSoundPreview} />
						<NotifyToggle />
						<div className="dd-header">{t("language")}</div>
						{packs.map((l) => (
							<DropdownItem key={l.code} active={locale === l.code} onClick={() => setLocale(l.code)}>
								{l.nativeName}
							</DropdownItem>
						))}
						<div className="dd-header">{t("theme")}</div>
						<DropdownItem
							active={theme === null}
							onClick={() => {
								onThemeChange(null);
								setMoreOpen(false);
							}}
						>
							{t("themeDefault")}
						</DropdownItem>
						{themes.map((th) => (
							<DropdownItem
								key={th.id}
								active={theme === th.id}
								onClick={() => {
									onThemeChange(th.id);
									setMoreOpen(false);
								}}
							>
								{locale === "zh" ? th.name : (th.nameEn ?? th.name)}
							</DropdownItem>
						))}
						<div className="dd-header">{t("update")}</div>
						{renderUpdateBody()}
						{renderAllUpdatesBody()}
						<a
							className="dd-refresh dd-more-link"
							href="https://github.com/xing-shuyin/pi-web-ui"
							target="_blank"
							rel="noreferrer noopener"
						>
							<FiGithub /> {t("githubRepo")}
						</a>
					</Dropdown>
				</div>
			</div>

			{/* 文件面板折叠按钮：顶栏直接子项，不能放进可横滑的 .topbar-actions，
			   否则窄屏下会被 tab/chip 挤出屏幕（固定在右上角，永不被推走）。 */}
			{view === "chat" && hostOn("files") && (
				<button type="button" className="panel-toggle" title={t("openFiles")} onClick={() => onOpenPanel("right")}>
					<FiFolder />
				</button>
			)}
			{localeModalOpen && <LocaleModal onClose={() => setLocaleModalOpen(false)} />}
		</header>
	);
}
