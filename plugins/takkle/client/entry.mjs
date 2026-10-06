import { dayKey, monthDays, tasksOnDay } from "./calendar.mjs";

function apiBase() {
	const url = new URL(import.meta.url);
	const root = url.pathname.slice(0, url.pathname.indexOf("/plugins/"));
	return `${url.origin}${root}/plugins-api/takkle`;
}
const node = (tag, text, className) => {
	const element = document.createElement(tag);
	if (text !== undefined) element.textContent = text;
	if (className) element.className = className;
	return element;
};
const plain = (value) =>
	String(value || "")
		.replace(/<br\s*\/?\s*>/gi, "\n")
		.replace(/<\/p>/gi, "\n")
		.replace(/<[^>]*>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&")
		.trim();

export default {
	mount(el) {
		const root = node("section", undefined, "takkle-view");
		el.replaceChildren(root);
		let snapshot = null;
		let selectedCalendar = "";
		let selectedProject = "";
		let selectedDay = "";
		let mode = "calendar";
		let month = new Date();
		let busy = false;
		let disposed = false;
		let error = "";
		let detail = null;
		let requestVersion = 0;
		const controller = new AbortController();
		async function api(path, params) {
			const response = await fetch(`${apiBase()}${path}`, {
				credentials: "same-origin",
				signal: controller.signal,
				...(params
					? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) }
					: {}),
			});
			const result = await response.json();
			if (!response.ok || result.error) throw new Error(result.error || "Takkle request failed");
			return result;
		}
		async function load() {
			const version = ++requestVersion;
			busy = true;
			error = "";
			render();
			try {
				const result = await api("/snapshot");
				if (disposed || version !== requestVersion) return;
				snapshot = result;
				if (!snapshot.calendars.some((c) => c.id === selectedCalendar))
					selectedCalendar = snapshot.calendars[0]?.id || "";
			} catch (e) {
				if (!disposed && e.name !== "AbortError") error = e.message;
			} finally {
				if (!disposed && version === requestVersion) {
					busy = false;
					render();
				}
			}
		}
		const button = (text, action, disabled = false) => {
			const b = node("button", text);
			b.type = "button";
			b.disabled = disabled || busy;
			b.onclick = action;
			return b;
		};
		function select(label, options, current, change) {
			const s = node("select");
			s.setAttribute("aria-label", label);
			s.disabled = busy;
			for (const [value, text] of options) {
				const option = node("option", text);
				option.value = value;
				s.append(option);
			}
			s.value = current;
			s.onchange = () => change(s.value);
			return s;
		}
		async function write(params) {
			busy = true;
			error = "";
			render();
			try {
				await api("/write", params);
				detail = null;
				await load();
			} catch (e) {
				if (!disposed) {
					error = e.message;
					busy = false;
					render();
				}
			}
		}
		async function openCard(task) {
			busy = true;
			render();
			try {
				const result = await api("/read", { action: "card", calendarId: selectedCalendar, id: task.id });
				if (!disposed) {
					detail = { type: "card", task: result.task, related: result.related };
					error = "";
				}
			} catch (e) {
				if (!disposed) error = e.message;
			} finally {
				if (!disposed) {
					busy = false;
					render();
				}
			}
		}
		function taskButton(task) {
			const b = button(task.title || "Untitled card", () => openCard(task));
			b.className = "takkle-task";
			if (task.completedAt) b.classList.add("takkle-task-done");
			b.title = `${task.title || "Card"} · ${task.dueDate || task.startDate || "Unscheduled"}`;
			return b;
		}
		function form(calendar, projects, columns) {
			const panel = node("form", undefined, "takkle-editor");
			const existing = detail.type === "card" ? detail.task : null;
			const original = existing?.data || {};
			panel.append(node("h3", detail.type === "project" ? "New project" : existing ? "Card details" : "New card"));
			const fields = {};
			const field = (key, label, type, value, options) => {
				value = detail.draft?.[key] ?? value;
				const l = node("label", label);
				const input = options
					? select(label, options, value, () => {})
					: node(type === "textarea" ? "textarea" : "input");
				if (!options) {
					if (type !== "textarea") input.type = type;
					input.value = value || "";
				}
				input.setAttribute("aria-label", label);
				input.disabled = !calendar.canWrite || busy;
				input.oninput = () => {
					detail.draft = { ...detail.draft, [key]: input.value };
				};
				l.append(input);
				panel.append(l);
				fields[key] = input;
				return input;
			};
			if (detail.type === "project") field("name", "Project name", "text", "");
			else {
				field("title", "Card title", "text", original.title);
				if (!existing) {
					const project = field(
						"projectId",
						"Project",
						"select",
						selectedProject || projects[0]?.id,
						projects.map((p) => [p.id, p.name]),
					);
					project.onchange = () => {
						for (const [key, input] of Object.entries(fields)) detail.draft = { ...detail.draft, [key]: input.value };
						delete detail.draft.columnId;
						selectedProject = project.value;
						render();
					};
				}
				const projectId = existing ? original.projectId : selectedProject || projects[0]?.id;
				const projectColumns = columns.filter((c) => c.projectId === projectId).sort((a, b) => a.position - b.position);
				field(
					"columnId",
					"Column",
					"select",
					original.columnId || projectColumns.find((c) => !c.isDone)?.id || projectColumns[0]?.id,
					projectColumns.map((c) => [c.id, c.name]),
				);
				field(
					"priority",
					"Priority",
					"select",
					original.priority || "none",
					["none", "low", "medium", "high", "urgent"].map((p) => [p, p]),
				);
				field("startDate", "Start date", "date", original.startDate);
				field("dueDate", "Due date", "date", existing ? original.dueDate || "" : selectedDay);
			}
			field("description", "Description", "textarea", plain(original.description));
			if (existing) {
				panel.append(node("p", `Card ID: ${existing.id}`, "takkle-muted"));
				for (const r of detail.related.slice(0, 50))
					panel.append(
						node(
							"p",
							`${r.collection}: ${plain(r.data?.title || r.data?.text || r.data?.body || r.data?.name || r.data?.type || r.id)}`,
							"takkle-related",
						),
					);
			}
			const controls = node("div", undefined, "takkle-toolbar");
			const save = button(existing ? "Save changes" : "Create", () => {}, !calendar.canWrite);
			save.type = "submit";
			controls.append(
				save,
				button("Close", () => {
					detail = null;
					error = "";
					render();
				}),
			);
			panel.append(controls);
			panel.onsubmit = (event) => {
				event.preventDefault();
				if (busy || !calendar.canWrite) return;
				const params = {
					action: detail.type === "project" ? "create_project" : existing ? "update_card" : "create_card",
					calendarId: calendar.id,
				};
				for (const [key, input] of Object.entries(fields)) {
					const value = input.value;
					if (existing && value === (key === "description" ? plain(original[key]) : original[key] || "")) continue;
					params[key] = ["startDate", "dueDate"].includes(key) ? value || null : value;
				}
				if (existing) {
					params.id = existing.id;
					params.expectedRevision = existing.updated_at;
				}
				write(params);
			};
			return panel;
		}
		function render() {
			if (disposed) return;
			root.replaceChildren();
			const head = node("div", undefined, "takkle-toolbar");
			head.append(node("h2", "Takkle"), button(busy ? "Loading…" : "Refresh", load));
			root.append(head);
			root.append(
				node(
					"p",
					"Projects, cards and calendar from your connected Takkle account. Changes sync through Supabase.",
					"takkle-muted",
				),
			);
			if (error) {
				const alert = node("p", error, "takkle-error");
				alert.setAttribute("role", "alert");
				root.append(alert);
			}
			if (!snapshot) {
				if (!busy)
					root.append(
						node(
							"p",
							"Configure Takkle under Settings → Interface plugins. Add the server secret, then refresh. Credentials stay on the server.",
							"takkle-empty",
						),
					);
				return;
			}
			const calendar = snapshot.calendars.find((c) => c.id === selectedCalendar);
			if (!calendar) {
				root.append(
					node("p", "No accessible calendars. Check account membership and allowed calendar IDs.", "takkle-empty"),
				);
				return;
			}
			const projects = calendar.projects.filter((p) => !p.archivedAt);
			if (selectedProject && !projects.some((p) => p.id === selectedProject)) selectedProject = "";
			const tasks = calendar.tasks.filter(
				(t) => !t.archivedAt && (!selectedProject || t.projectId === selectedProject),
			);
			root.append(
				node(
					"p",
					`${snapshot.accountEmail} · ${calendar.role} · ${calendar.canWrite ? "Changes enabled" : "Read only"}`,
					"takkle-muted",
				),
			);
			const tools = node("div", undefined, "takkle-toolbar");
			tools.append(
				select(
					"Calendar",
					snapshot.calendars.map((c) => [c.id, c.name || (c.kind === "personal" ? "My calendar" : c.id)]),
					selectedCalendar,
					(value) => {
						selectedCalendar = value;
						selectedProject = "";
						detail = null;
						render();
					},
				),
			);
			tools.append(
				select(
					"Project filter",
					[["", "All projects"], ...projects.map((p) => [p.id, p.name])],
					selectedProject,
					(value) => {
						selectedProject = value;
						selectedDay = "";
						render();
					},
				),
			);
			for (const item of ["calendar", "board"]) {
				const b = button(item === "calendar" ? "Calendar" : "Board", () => {
					mode = item;
					render();
				});
				b.setAttribute("aria-pressed", String(mode === item));
				tools.append(b);
			}
			tools.append(
				button(
					"New project",
					() => {
						detail = { type: "project" };
						render();
					},
					!calendar.canWrite,
				),
			);
			tools.append(
				button(
					"New card",
					() => {
						detail = { type: "new-card" };
						render();
					},
					!calendar.canWrite || !projects.length,
				),
			);
			root.append(tools);
			const summary = node("div", undefined, "takkle-summary");
			for (const [label, count] of [
				["Projects", projects.length],
				["Open cards", tasks.filter((t) => !t.completedAt).length],
				["Overdue", tasks.filter((t) => !t.completedAt && t.dueDate && t.dueDate < dayKey(new Date())).length],
			])
				summary.append(node("div", `${count} ${label}`));
			root.append(summary);
			if (detail) {
				root.append(form(calendar, projects, calendar.columns));
				return;
			}
			if (mode === "calendar") {
				const nav = node("div", undefined, "takkle-toolbar");
				nav.append(
					button("Previous month", () => {
						month = new Date(month.getFullYear(), month.getMonth() - 1, 1);
						selectedDay = "";
						render();
					}),
					node("strong", month.toLocaleDateString(undefined, { month: "long", year: "numeric" })),
					button("Next month", () => {
						month = new Date(month.getFullYear(), month.getMonth() + 1, 1);
						selectedDay = "";
						render();
					}),
					button("Today", () => {
						month = new Date();
						selectedDay = dayKey(month);
						render();
					}),
				);
				root.append(nav);
				const grid = node("div", undefined, "takkle-calendar");
				grid.setAttribute("aria-label", "Takkle month calendar");
				for (const name of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])
					grid.append(node("div", name, "takkle-weekday"));
				for (const day of monthDays(month.getFullYear(), month.getMonth())) {
					const key = dayKey(day);
					const cell = node(
						"div",
						undefined,
						`takkle-day${day.getMonth() !== month.getMonth() ? " takkle-day-outside" : ""}`,
					);
					const d = button(String(day.getDate()), () => {
						selectedDay = key;
						render();
					});
					d.setAttribute("aria-label", key);
					d.setAttribute("aria-pressed", String(selectedDay === key));
					cell.append(d);
					const onDay = tasksOnDay(tasks, key);
					for (const task of onDay.slice(0, 2)) cell.append(taskButton(task));
					if (onDay.length > 2)
						cell.append(
							button(`+${onDay.length - 2} more`, () => {
								selectedDay = key;
								render();
							}),
						);
					grid.append(cell);
				}
				root.append(grid);
				if (selectedDay) {
					root.append(node("h3", selectedDay));
					const list = node("div", undefined, "takkle-agenda");
					for (const task of tasksOnDay(tasks, selectedDay)) list.append(taskButton(task));
					if (!list.children.length) list.append(node("p", "No cards scheduled for this day."));
					root.append(list);
				}
				const unscheduled = tasks.filter((t) => !t.startDate && !t.dueDate && !t.completedAt);
				root.append(node("h3", `Unscheduled (${unscheduled.length})`));
				const list = node("div", undefined, "takkle-agenda");
				for (const task of unscheduled) list.append(taskButton(task));
				root.append(list);
			} else {
				for (const project of projects.filter((p) => !selectedProject || p.id === selectedProject)) {
					root.append(node("h3", project.name));
					const board = node("div", undefined, "takkle-board");
					for (const column of calendar.columns
						.filter((c) => c.projectId === project.id)
						.sort((a, b) => a.position - b.position)) {
						const col = node("section", undefined, "takkle-column");
						const items = tasks.filter((t) => t.columnId === column.id).sort((a, b) => a.position - b.position);
						col.append(node("h4", `${column.name} (${items.length})`));
						for (const task of items) {
							col.append(taskButton(task));
							if (task.dueDate) col.append(node("small", `${task.priority} · ${task.dueDate}`, "takkle-muted"));
						}
						board.append(col);
					}
					root.append(board);
				}
				if (!projects.length)
					root.append(node("p", "No projects yet. Create one when changes are enabled.", "takkle-empty"));
			}
		}
		load();
		return () => {
			disposed = true;
			controller.abort();
			el.replaceChildren();
		};
	},
};
