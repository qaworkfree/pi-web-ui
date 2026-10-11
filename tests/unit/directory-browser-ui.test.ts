// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DirectoryBrowser } from "../../web/src/components/DirectoryBrowser.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { resetAppGlobals, setAppGlobals, setAppSend } from "../../web/src/app-globals.js";
import type { ClientMessage } from "../../server/protocol.js";
import { disconnectDirectoryRequests, receiveDirectoryReply } from "../../web/src/directory-requests.js";

const cwd = "C:/Users/LUIZ/Pictures/Llama etc";
let root: Root;
let container: HTMLDivElement;
let sent: ClientMessage[];
const selected = vi.fn();
const created = vi.fn();
const closed = vi.fn();

beforeEach(async () => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	localStorage.setItem("pi-web-ui:lang", "en");
	resetAppGlobals();
	setAppGlobals({ homeDir: "C:/Users/LUIZ" });
	sent = [];
	setAppSend((message) => {
		sent.push(message);
		if (message.type === "complete_path" && message.requestId) {
			receiveDirectoryReply({
				type: "path_completions",
				requestId: message.requestId,
				roots: ["C:/Personal/Workspace"],
				completions:
					message.path === `${cwd}/`
						? [
								{ name: "test project", path: `${cwd}/test project`, type: "dir" },
								{ name: "logs", path: `${cwd}/logs`, type: "dir" },
								{ name: "file.txt", path: `${cwd}/file.txt`, type: "file" },
							]
						: [],
			});
		}
		return true;
	});
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() =>
		root.render(
			createElement(
				LanguageProvider,
				null,
				createElement(DirectoryBrowser, {
					currentCwd: cwd,
					pathCompletions: [
						{ name: "test project", path: `${cwd}/test project`, type: "dir" },
						{ name: "logs", path: `${cwd}/logs`, type: "dir" },
						{ name: "file.txt", path: `${cwd}/file.txt`, type: "file" },
					],
					workspaceRoots: [],
					onClose: closed,
					onSelectDirectory: selected,
					onCreateProject: created,
					mode: "project",
					role: "dialog",
					ariaLabel: "Choose a working directory",
				}),
			),
		),
	);
	await act(async () => vi.advanceTimersByTime(70));
});
afterEach(() => {
	act(() => root.unmount());
	disconnectDirectoryRequests();
	setAppSend(null);
	resetAppGlobals();
	vi.useRealTimers();
	container.remove();
});
function click(selector: string) {
	const button = container.querySelector<HTMLButtonElement>(selector);
	expect(button).toBeTruthy();
	act(() => button!.click());
}
function input(selector: string, value: string) {
	const element = container.querySelector<HTMLInputElement>(selector)!;
	act(() => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
	return element;
}
describe("project folder browser", () => {
	it("uses the server's absolute home directory for browsing and selection", () => {
		click('.cwd-shortcuts button[title="Home directory"]');
		act(() => vi.advanceTimersByTime(70));
		expect(sent).toContainEqual(expect.objectContaining({ type: "complete_path", path: "C:/Users/LUIZ/" }));
		click(".cwd-picker-row .primary");
		expect(selected).toHaveBeenCalledWith("C:/Users/LUIZ", expect.any(AbortSignal));
	});
	it("selects existing folders without sending permission grants", () => {
		click(".cwd-item .cwd-choose-btn");
		expect(selected).toHaveBeenCalledWith(`${cwd}/test project`, expect.any(AbortSignal));
		expect(sent.some((message) => /policy|preset|workspace_roots/.test(message.type))).toBe(false);
	});
	it("browses a typed Windows path with spaces before explicitly selecting it", () => {
		const element = input(".cwd-picker-input", "C:\\Users\\LUIZ\\Pictures\\Other Folder");
		expect(container.querySelector<HTMLButtonElement>(".cwd-picker-row .primary")!.disabled).toBe(false);
		act(() => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
		act(() => vi.advanceTimersByTime(70));
		expect(selected).not.toHaveBeenCalled();
		expect(sent).toContainEqual(
			expect.objectContaining({ type: "complete_path", path: "C:/Users/LUIZ/Pictures/Other Folder/" }),
		);
		click(".cwd-picker-row .primary");
		expect(selected).toHaveBeenCalledWith("C:/Users/LUIZ/Pictures/Other Folder", expect.any(AbortSignal));
	});
	it("lets a new project choose its parent and previews the resulting path", () => {
		click(".cwd-project-modes .cwd-newbtn");
		input(".cwd-newrow input", "My New Project");
		click(".cwd-item .cwd-choose-btn");
		expect(selected).not.toHaveBeenCalled();
		expect(container.querySelector(".cwd-project-preview")!.textContent).toContain(
			`${cwd}/test project/My New Project`,
		);
		click(".cwd-newrow .primary");
		expect(created).toHaveBeenCalledWith(`${cwd}/test project/My New Project`, expect.any(AbortSignal));
	});
	it("cannot create a project under the virtual machine root", () => {
		click(".cwd-project-modes .cwd-newbtn");
		click(".cwd-breadcrumbs button");
		const element = input(".cwd-newrow input", "invalid-parent");
		act(() => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
		expect(container.querySelector<HTMLButtonElement>(".cwd-newrow .primary")!.disabled).toBe(true);
		expect(created).not.toHaveBeenCalled();
	});
	it("creates under the typed parent without requiring a separate Browse click", () => {
		click(".cwd-project-modes .cwd-newbtn");
		input(".cwd-newrow input", "project");
		input(".cwd-picker-input", "C:/Other Parent");
		click(".cwd-newrow .primary");
		expect(created).toHaveBeenCalledWith("C:/Other Parent/project", expect.any(AbortSignal));
	});
	it("filters folder names and excludes files", () => {
		input(".cwd-filter input", "LOG");
		expect(container.querySelectorAll(".cwd-item")).toHaveLength(1);
		expect(container.querySelector(".cwd-name")!.textContent).toBe("logs");
		input(".cwd-filter input", "file.txt");
		expect(container.querySelectorAll(".cwd-item")).toHaveLength(0);
	});
	it("navigates breadcrumbs and requests the selected ancestor", () => {
		click('.cwd-breadcrumbs button[title="C:/Users"]');
		act(() => vi.advanceTimersByTime(70));
		expect(sent).toContainEqual(expect.objectContaining({ type: "complete_path", path: "C:/Users/" }));
		expect(selected).not.toHaveBeenCalled();
	});
	it("Escape dismisses new-project entry first, then the browser", () => {
		click(".cwd-project-modes .cwd-newbtn");
		act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
		expect(container.querySelector(".cwd-newrow")).toBeNull();
		expect(closed).not.toHaveBeenCalled();
		act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
		expect(closed).toHaveBeenCalledOnce();
	});
	it("waits for server confirmation and keeps failed project creation available for retry", async () => {
		let rejectCreation!: (error: Error) => void;
		created.mockImplementationOnce(
			() =>
				new Promise<void>((_, reject) => {
					rejectCreation = reject;
				}),
		);
		click(".cwd-project-modes .cwd-newbtn");
		input(".cwd-newrow input", "New Project");
		click(".cwd-newrow .primary");
		expect(closed).not.toHaveBeenCalled();
		expect(container.querySelector<HTMLButtonElement>(".cwd-newrow .primary")!.disabled).toBe(true);
		await act(async () => rejectCreation(new Error("Permission denied: create directory")));
		expect(container.querySelector('[role="alert"]')!.textContent).toContain("Permission denied");
		expect(container.querySelector<HTMLInputElement>(".cwd-newrow input")!.value).toBe("New Project");
		expect(closed).not.toHaveBeenCalled();
		await act(async () => container.querySelector<HTMLButtonElement>(".cwd-newrow .primary")!.click());
		expect(closed).toHaveBeenCalledOnce();
	});
	it("opens a pasted path directly and keeps a failed selection open", async () => {
		selected.mockRejectedValueOnce(new Error("Directory does not exist"));
		input(".cwd-picker-input", '"C:\\Missing Folder"');
		await act(async () => container.querySelector<HTMLButtonElement>(".cwd-picker-row .primary")!.click());
		expect(selected).toHaveBeenCalledWith("C:/Missing Folder", expect.any(AbortSignal));
		expect(container.querySelector('[role="alert"]')!.textContent).toContain("does not exist");
		expect(closed).not.toHaveBeenCalled();
	});
	it("shows blocked browsing explicitly and offers configured readable roots", async () => {
		setAppSend((message) => {
			if (message.type === "complete_path" && message.requestId)
				receiveDirectoryReply({
					type: "path_completions",
					requestId: message.requestId,
					completions: [],
					roots: ["C:/Personal/Workspace"],
					error: "Permission denied: folder blocked",
				});
			return true;
		});
		click('.cwd-shortcuts button[title="Home directory"]');
		await act(async () => vi.advanceTimersByTime(70));
		expect(container.querySelector('[role="alert"]')!.textContent).toContain("Permission denied");
		expect(container.querySelector('.cwd-shortcuts button[title="C:/Personal/Workspace"]')).toBeTruthy();
		expect(container.querySelector(".cwd-empty")).toBeNull();
	});
	it.each(["CON", "nul.txt", "bad:name", "trailing."])("rejects invalid Windows folder name %s", (name) => {
		click(".cwd-project-modes .cwd-newbtn");
		input(".cwd-newrow input", name);
		click(".cwd-newrow .primary");
		expect(created).not.toHaveBeenCalled();
		expect(container.querySelector('[role="alert"]')).toBeTruthy();
	});
});
