import { useEffect, useRef, useState } from "react";
import { FiFolder, FiHome, FiMonitor, FiSearch, FiX } from "react-icons/fi";
import { useT } from "../i18n";
import { appSend, useAppField } from "../app-globals";

/** 机器根（此电脑/盘符列表）wire 字面量 —— 与 server/files-service.ts 的 MACHINE_ROOT 同值。 */
export const MACHINE_ROOT = "@root";

export const normalizeBrowsePath = (path: string) => {
	const value = path.trim().replace(/\\/g, "/");
	if (!value || value === MACHINE_ROOT) return value;
	if (/^[A-Za-z]:\/*$/.test(value)) return value.slice(0, 2) + "/";
	return value.replace(/\/+$/, "") || "/";
};

export const browseQuery = (p: string) => {
	const normalized = normalizeBrowsePath(p);
	return normalized.endsWith("/") ? normalized : normalized + "/";
};

/**
 * 规范拼接工作目录父路径与新建子目录名称。
 * 该函数只负责正斜杠路径连接；服务端负责解析为原生绝对路径。
 */
export function joinProjectPath(parent: string, name: string): string {
	const trimmedName = name.trim();
	const normParent = parent.replace(/\\/g, "/");
	if (normParent.endsWith("/")) {
		return normParent + trimmedName;
	}
	if (/^[A-Za-z]:$/.test(normParent)) {
		return normParent + "/" + trimmedName;
	}
	return normParent + "/" + trimmedName;
}

/** 校验新建项目名称：不能包含分隔符、不能为 . 或 ..、不能唯空。 */
export function isValidProjectName(name: string): boolean {
	const trimmed = name.trim();
	if (!trimmed) return false;
	if (trimmed === "." || trimmed === "..") return false;
	if (trimmed.includes("/") || trimmed.includes("\\")) return false;
	return true;
}

/** Parent of an absolute "/"-separated path; null at the filesystem root. */
export const parentOf = (p: string): string | null => {
	const normalized = normalizeBrowsePath(p);
	const s = normalized.endsWith("/") && normalized !== "/" ? normalized.slice(0, -1) : normalized;
	if (s === MACHINE_ROOT || s === "/") return null;
	if (/^\/\/[^/]+\/[^/]+$/.test(s)) return MACHINE_ROOT;
	const i = s.lastIndexOf("/");
	if (i < 0) {
		return /^[A-Za-z]:$/.test(s) ? MACHINE_ROOT : null;
	}
	if (i === 0) return "/";
	const parent = s.slice(0, i);
	return /^[A-Za-z]:$/.test(parent) ? parent + "/" : parent;
};

/** Clickable segments retain absolute Windows/POSIX paths, including spaces. */
export function directoryBreadcrumbs(path: string): { label: string; path: string }[] {
	const normalized = normalizeBrowsePath(path);
	if (!normalized || normalized === MACHINE_ROOT) return [];
	const drive = normalized.match(/^[A-Za-z]:\//)?.[0];
	const unc = normalized.match(/^\/\/[^/]+\/[^/]+/);
	const root = drive || unc?.[0] || (normalized.startsWith("/") ? "/" : "");
	const segments = normalized.slice(root.length).split("/").filter(Boolean);
	const result = root ? [{ label: root === "/" ? "/" : root.replace(/\/$/, ""), path: root }] : [];
	let current = root;
	for (const label of segments) {
		current = current ? joinProjectPath(current, label) : label;
		result.push({ label, path: current });
	}
	return result;
}

interface DirectoryBrowserProps {
	currentCwd: string;
	pathCompletions: { name: string; path: string; type: "dir" | "file" }[];
	workspaceRoots: string[];
	onClose: () => void;
	onSelectDirectory: (path: string) => void;
	mode?: "folder" | "project";
	onCreateProject?: (path: string) => void;
	className?: string;
	backdropClassName?: string;
	role?: string;
	ariaLabel?: string;
}

export function DirectoryBrowser({
	currentCwd,
	pathCompletions,
	workspaceRoots,
	onClose,
	onSelectDirectory,
	mode = "folder",
	onCreateProject,
	className,
	backdropClassName,
	role,
	ariaLabel,
}: DirectoryBrowserProps) {
	const t = useT();
	const homeDir = useAppField("homeDir");
	const [browsePath, setBrowsePath] = useState("");
	const [draft, setDraft] = useState("");
	const [showNew, setShowNew] = useState(false);
	const [newName, setNewName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [filter, setFilter] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const newInputRef = useRef<HTMLInputElement>(null);

	const dirs = pathCompletions.filter((c) => c.type === "dir");
	const visibleDirs = dirs.filter((dir) => dir.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
	const navigate = (path: string) => {
		const normalized = normalizeBrowsePath(path);
		if (!normalized) return;
		setBrowsePath(normalized);
		setDraft(normalized);
		setFilter("");
		setError(null);
	};

	// 初始化与重置状态
	useEffect(() => {
		const norm = normalizeBrowsePath(currentCwd || "");
		setBrowsePath(norm);
		setDraft(norm);
		setShowNew(false);
		setNewName("");
		setError(null);
		setFilter("");
	}, [currentCwd]);

	// 打开后聚焦输入框
	useEffect(() => {
		const frame = requestAnimationFrame(() => {
			inputRef.current?.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, []);

	// 全局 Escape 键监听
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				if (showNew) {
					setShowNew(false);
					setNewName("");
					setError(null);
				} else {
					onClose();
				}
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [showNew, onClose]);

	// 目录浏览请求（60ms 防抖）
	useEffect(() => {
		const timer = setTimeout(() => {
			appSend({ type: "complete_path", path: browseQuery(browsePath) });
		}, 60);
		return () => clearTimeout(timer);
	}, [browsePath]);

	const commit = (path: string) => {
		const trimmed = normalizeBrowsePath(path);
		if (!trimmed || trimmed === MACHINE_ROOT) return;
		onSelectDirectory(trimmed);
	};

	const handleCreate = () => {
		const trimmed = newName.trim();
		if (!trimmed || !browsePath || browsePath === MACHINE_ROOT || normalizeBrowsePath(draft) !== browsePath) return;
		if (!isValidProjectName(trimmed)) {
			setError(t("invalidProjectName"));
			return;
		}

		if (mode === "project") {
			const fullPath = joinProjectPath(browsePath, trimmed);
			onCreateProject?.(fullPath);
			setShowNew(false);
			setNewName("");
			setError(null);
			onClose();
		} else {
			appSend({ type: "make_dir", path: `${browseQuery(browsePath)}${trimmed}` });
			setTimeout(() => {
				appSend({ type: "complete_path", path: browseQuery(browsePath) });
			}, 80);
			setNewName("");
			setShowNew(false);
		}
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Escape") {
			e.stopPropagation();
			if (showNew) {
				setShowNew(false);
				setNewName("");
				setError(null);
			} else {
				onClose();
			}
		} else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
			e.preventDefault();
			navigate(draft);
		}
	};

	const upPath = parentOf(browsePath);

	const norm = (p: string) => {
		const f = p.replace(/\\/g, "/").replace(/\/+$/, "");
		return /^[A-Za-z]:/.test(f) ? f.toLowerCase() : f;
	};
	const cur = norm(browsePath);
	const canAddRoot =
		Boolean(browsePath) &&
		browsePath !== MACHINE_ROOT &&
		cur !== norm(currentCwd) &&
		!workspaceRoots.some((r) => norm(r) === cur);
	const choosingParent = mode === "project" && showNew;
	const pendingPath = normalizeBrowsePath(draft) !== browsePath;
	const shortcuts = [...new Set([currentCwd, ...workspaceRoots].filter(Boolean))];

	return (
		<>
			<div className={`status-cwd-backdrop ${backdropClassName ?? ""}`.trim()} onClick={onClose} />
			<div className={`cwd-picker ${className ?? ""}`.trim()} role={role} aria-label={ariaLabel}>
				<div className="cwd-picker-head">
					<span className="cwd-picker-title" title={browsePath === MACHINE_ROOT ? t("computer") : browsePath}>
						{browsePath === MACHINE_ROOT ? "💻" : <FiFolder />}
						<span>{ariaLabel || t("projectPickerTitle")}</span>
					</span>
					<button
						type="button"
						className="cwd-up"
						disabled={browsePath === MACHINE_ROOT}
						title={t("computer")}
						onClick={() => navigate(MACHINE_ROOT)}
					>
						💻
					</button>
					<button
						type="button"
						className="cwd-up"
						disabled={!upPath}
						title={t("cwdGoUp")}
						onClick={() => {
							if (upPath) {
								navigate(upPath);
							}
						}}
					>
						↑ {t("cwdGoUp")}
					</button>
					<button
						type="button"
						className="cwd-up"
						disabled={!canAddRoot}
						title={t("addWorkspaceRootHint")}
						onClick={() => {
							if (!canAddRoot) return;
							appSend({ type: "set_workspace_roots", roots: [...workspaceRoots, browsePath] });
						}}
					>
						+ {t("addWorkspaceRoot")}
					</button>
					<button type="button" className="cwd-close" title={t("close")} aria-label={t("close")} onClick={onClose}>
						<FiX />
					</button>
				</div>
				{mode === "project" && (
					<div className="cwd-project-modes" role="group" aria-label={t("projectPickerTitle")}>
						<button type="button" className="cwd-up" aria-pressed={!showNew} onClick={() => setShowNew(false)}>
							{t("cwdExisting")}
						</button>
						<button type="button" className="cwd-newbtn" aria-pressed={showNew} onClick={() => setShowNew(true)}>
							+ {t("newProject")}
						</button>
					</div>
				)}
				<div className="cwd-shortcuts">
					{homeDir && (
						<button type="button" className="cwd-up" onClick={() => navigate(homeDir)} title={t("homeDir")}>
							<FiHome /> {t("homeDir")}
						</button>
					)}
					{shortcuts.map((path) => (
						<button key={path} type="button" className="cwd-up" title={path} onClick={() => navigate(path)}>
							<FiFolder /> {path === currentCwd ? t("rootDir") : directoryBreadcrumbs(path).at(-1)?.label || path}
						</button>
					))}
				</div>
				<nav className="cwd-breadcrumbs" aria-label={t("cwdPathLabel")}>
					<button type="button" onClick={() => navigate(MACHINE_ROOT)} title={t("computer")}>
						<FiMonitor /> {t("computer")}
					</button>
					{directoryBreadcrumbs(browsePath).map((part) => (
						<button key={part.path} type="button" title={part.path} onClick={() => navigate(part.path)}>
							<span aria-hidden="true">›</span> {part.label}
						</button>
					))}
				</nav>
				<div className="cwd-picker-row">
					<input
						ref={inputRef}
						className="status-cwd-input cwd-picker-input"
						value={draft}
						placeholder={t("cwdPathLabel")}
						aria-label={t("cwdPathLabel")}
						spellCheck={false}
						onChange={(e) => {
							setDraft(e.target.value);
						}}
						onKeyDown={onKeyDown}
					/>
					<button type="button" className="cwd-up" disabled={!draft.trim()} onClick={() => navigate(draft)}>
						{t("cwdBrowse")}
					</button>
					<button
						type="button"
						className="cwd-choose-btn primary"
						title={t("cwdPickCurrent")}
						disabled={!browsePath || browsePath === MACHINE_ROOT || pendingPath || choosingParent}
						onClick={() => commit(browsePath)}
					>
						{t("cwdPickCurrent")}
					</button>
				</div>
				<p className="cwd-picker-hint">{t("cwdPermissionHint")}</p>
				<label className="cwd-filter">
					<FiSearch aria-hidden="true" />
					<input
						value={filter}
						onChange={(event) => setFilter(event.target.value)}
						placeholder={t("cwdFilterFolders")}
						aria-label={t("cwdFilterFolders")}
					/>
				</label>
				<div className="cwd-list">
					{visibleDirs.length === 0 && (
						<div className="cwd-empty">{filter ? t("searchNoResults") : t("cwdNoFolders")}</div>
					)}
					{visibleDirs.map((d) => (
						<div key={d.path} className="cwd-item">
							<button
								type="button"
								className="cwd-enter"
								title={`${t("cwdEnter")} ${d.path}`}
								onClick={() => {
									navigate(d.path);
								}}
							>
								<FiFolder />
								<span className="cwd-name">{d.name}</span>
							</button>
							<button
								type="button"
								className="cwd-choose-btn"
								title={d.path}
								onClick={() => (choosingParent ? navigate(d.path) : commit(d.path))}
							>
								{choosingParent ? t("cwdParentFolder") : t("cwdChoose")}
							</button>
						</div>
					))}
				</div>
				<div className="cwd-picker-foot">
					{showNew && (
						<p className="cwd-project-preview">
							{t("cwdParentFolder")}: {browsePath === MACHINE_ROOT ? t("computer") : browsePath}
							{newName.trim() && browsePath !== MACHINE_ROOT && (
								<span>
									{t("newProject")}: {joinProjectPath(browsePath, newName)}
								</span>
							)}
						</p>
					)}
					{showNew ? (
						<div className="cwd-newrow">
							<input
								ref={newInputRef}
								value={newName}
								autoFocus
								spellCheck={false}
								placeholder={mode === "project" ? t("projectName") : t("cwdNewName")}
								aria-label={mode === "project" ? t("projectName") : t("cwdNewName")}
								onChange={(e) => {
									setNewName(e.target.value);
									if (error) setError(null);
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.nativeEvent.isComposing) {
										e.preventDefault();
										handleCreate();
									} else if (e.key === "Escape") {
										e.stopPropagation();
										setShowNew(false);
										setNewName("");
										setError(null);
									}
								}}
							/>
							<button
								type="button"
								className="cwd-choose-btn primary"
								disabled={browsePath === MACHINE_ROOT || pendingPath}
								onClick={handleCreate}
							>
								{mode === "project" ? t("createAndOpenProject") : t("cwdCreate")}
							</button>
							<button
								type="button"
								className="cwd-choose-btn"
								onClick={() => {
									setShowNew(false);
									setNewName("");
									setError(null);
								}}
							>
								{t("cwdCancel")}
							</button>
						</div>
					) : mode === "folder" ? (
						<button type="button" className="cwd-newbtn" onClick={() => setShowNew(true)}>
							+ {t("cwdNewFolder")}
						</button>
					) : null}
					{error && (
						<div className="project-picker-error" role="alert">
							{error}
						</div>
					)}
				</div>
			</div>
		</>
	);
}
