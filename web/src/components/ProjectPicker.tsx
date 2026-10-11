import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { requestDirectory } from "../directory-requests";
import {
	DirectoryBrowser,
	MACHINE_ROOT,
	browseQuery,
	joinProjectPath,
	isValidProjectName,
	parentOf,
} from "./DirectoryBrowser.js";

export { MACHINE_ROOT, browseQuery, joinProjectPath, isValidProjectName, parentOf };

interface ProjectPickerProps {
	open: boolean;
	currentCwd: string;
	pathCompletions: { name: string; path: string; type: "dir" | "file" }[];
	workspaceRoots: string[];
	onClose: () => void;
	/** Forced first-selection mode (UiState.needsProject): the picker cannot be
	 *  dismissed, and selecting a folder explicitly GRANTS it filesystem access
	 *  (grant_folder_access) before opening it. */
	required?: boolean;
}

export function ProjectPicker({
	open,
	currentCwd,
	pathCompletions,
	workspaceRoots,
	onClose,
	required,
}: ProjectPickerProps) {
	const t = useT();
	if (!open) return null;

	return createPortal(
		<DirectoryBrowser
			currentCwd={currentCwd}
			pathCompletions={pathCompletions}
			workspaceRoots={workspaceRoots}
			onClose={onClose}
			onSelectDirectory={async (path, signal) => {
				// In the forced flow the Select button is labeled "Allow and open":
				// the grant is the explicit consent, so no extra confirm dialog.
				if (required) await requestDirectory({ type: "grant_folder_access", path, preset: "development" }, signal);
				await requestDirectory({ type: "set_cwd", path }, signal);
			}}
			onCreateProject={async (path, signal) => {
				await requestDirectory({ type: "make_dir", path, setAsCwd: true }, signal);
			}}
			onAllowAccess={async (path, signal) => {
				await requestDirectory({ type: "grant_folder_access", path, preset: "development" }, signal);
			}}
			mode="project"
			required={required}
			className="project-picker"
			backdropClassName="project-picker-backdrop"
			role="dialog"
			ariaLabel={required ? t("projectSetupTitle") : t("projectPickerTitle")}
		/>,
		document.body,
	);
}
