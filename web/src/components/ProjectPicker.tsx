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
}

export function ProjectPicker({ open, currentCwd, pathCompletions, workspaceRoots, onClose }: ProjectPickerProps) {
	const t = useT();
	if (!open) return null;

	return createPortal(
		<DirectoryBrowser
			currentCwd={currentCwd}
			pathCompletions={pathCompletions}
			workspaceRoots={workspaceRoots}
			onClose={onClose}
			onSelectDirectory={async (path, signal) => {
				await requestDirectory({ type: "set_cwd", path }, signal);
			}}
			onCreateProject={async (path, signal) => {
				await requestDirectory({ type: "make_dir", path, setAsCwd: true }, signal);
			}}
			mode="project"
			className="project-picker"
			backdropClassName="project-picker-backdrop"
			role="dialog"
			ariaLabel={t("projectPickerTitle")}
		/>,
		document.body,
	);
}
