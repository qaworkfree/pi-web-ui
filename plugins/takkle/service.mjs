import { randomUUID } from "node:crypto";

export const SUPABASE_URL = "https://exampleproject.supabase.co";
const COLLECTIONS = [
	"projects",
	"columns",
	"tasks",
	"labels",
	"members",
	"checklist",
	"comments",
	"activities",
	"attachments",
	"views",
];
const PRIORITIES = ["none", "low", "medium", "high", "urgent"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (message) => {
	throw new Error(message);
};
const text = (value, field, max = 200) => {
	if (typeof value !== "string" || !value.trim() || value.length > max) fail(`Invalid ${field}`);
	return value.trim();
};
const id = (value, field) => text(value, field);
const date = (value, field) => {
	if (value === null || value === "") return null;
	const parsed = typeof value === "string" ? new Date(value + "T00:00:00Z") : new Date(NaN);
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
		!Number.isFinite(parsed.getTime()) ||
		parsed.toISOString().slice(0, 10) !== value
	)
		fail(`Invalid ${field}`);
	return value;
};
const html = (value) =>
	String(value).replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);
const plainDescription = (value) => {
	if (typeof value !== "string" || value.length > 20000) fail("Description must be plain text up to 20,000 characters");
	return value;
};
const description = (value) => {
	if (typeof value !== "string" || value.length > 20000) fail("Description must be plain text up to 20,000 characters");
	return value ? `<p>${html(value).replace(/\n/g, "<br>")}</p>` : "";
};
const newId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
const query = (values) => new URLSearchParams(values).toString();

/** Fixed destination, explicit account membership and role checks on every operation.
 * A server key bypasses RLS; no caller may provide an arbitrary table, URL or account.
 */
export function createTakkleService({ getSettings, request, getEnv = (name) => process.env[name] }) {
	const config = () => {
		const settings = getSettings();
		const key = settings.secretKey || getEnv("TAKKLE_SUPABASE_SECRET_KEY");
		const email = settings.accountEmail || getEnv("TAKKLE_ACCOUNT_EMAIL");
		if (!key || !email) fail("Configure the Takkle server secret and account email in plugin settings.");
		if (typeof key !== "string" || !key.trim() || (settings.secretKey && !key.startsWith("sb_secret_")))
			fail("A Supabase server secret key is required.");
		const accountEmail = text(email, "account email", 254).toLowerCase();
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(accountEmail)) fail("Invalid account email");
		const allowed = String(settings.calendarIds || "")
			.split(",")
			.map((v) => v.trim())
			.filter(Boolean);
		if (allowed.some((v) => !UUID.test(v))) fail("Allowed calendar IDs must be UUIDs");
		return { key, email: accountEmail, allowed, allowWrites: settings.allowWrites === true };
	};
	async function call(cfg, path, { method = "GET", body, headers = {} } = {}, signal) {
		if (signal?.aborted) fail("Takkle operation canceled");
		let result;
		try {
			result = await request(`${SUPABASE_URL}${path}`, {
				method,
				redirect: "error",
				headers: { apikey: cfg.key, "Content-Type": "application/json", ...headers },
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			});
		} catch {
			fail("Takkle connection failed");
		}
		if (!result.ok || result.status >= 300)
			fail(
				`Takkle request failed (${result.status || "network"}). Check credentials, access and schema; changes were not confirmed.`,
			);
		if (!result.text) return null;
		try {
			return JSON.parse(result.text);
		} catch {
			fail("Takkle returned an invalid response");
		}
	}
	async function rows(cfg, table, filters, signal) {
		const all = [];
		for (let offset = 0; offset < 20000; offset += 100) {
			const page = await call(
				cfg,
				`/rest/v1/${table}?${query({ ...filters, limit: "100", offset: String(offset) })}`,
				{},
				signal,
			);
			if (!Array.isArray(page)) fail("Unexpected Takkle records response");
			all.push(...page);
			if (page.length < 100) return all;
		}
		fail("Takkle scope is too large. Narrow the allowed calendar IDs.");
	}
	async function scope(signal) {
		const cfg = config();
		let user;
		for (let page = 1; page <= 40; page++) {
			const data = await call(cfg, `/auth/v1/admin/users?page=${page}&per_page=250`, {}, signal);
			if (!Array.isArray(data?.users)) fail("Unexpected Takkle account response");
			user = data.users.find((u) => u.email?.toLowerCase() === cfg.email);
			if (user || data.users.length < 250) break;
		}
		if (
			!user ||
			!UUID.test(user.id) ||
			user.deleted_at ||
			(user.banned_until && new Date(user.banned_until) > new Date())
		)
			fail("Configured Takkle account is unavailable");
		const access = await rows(
			cfg,
			"access_requests",
			{ select: "status", user_id: `eq.${user.id}`, order: "user_id.asc" },
			signal,
		);
		if (access.length !== 1 || access[0].status !== "approved") fail("Configured Takkle account is not approved");
		const memberships = await rows(
			cfg,
			"workspace_members",
			{ select: "workspace_id,role", user_id: `eq.${user.id}`, order: "workspace_id.asc" },
			signal,
		);
		const calendars = [];
		for (const member of memberships) {
			if (!UUID.test(member.workspace_id) || (cfg.allowed.length && !cfg.allowed.includes(member.workspace_id)))
				continue;
			const items = await rows(
				cfg,
				"workspaces",
				{ select: "id,name,kind", id: `eq.${member.workspace_id}`, order: "id.asc" },
				signal,
			);
			for (const item of items)
				calendars.push({
					...item,
					role: member.role,
					canWrite: cfg.allowWrites && ["owner", "editor"].includes(member.role),
				});
		}
		return { cfg, userId: user.id, calendars };
	}
	async function records(s, calendarId, signal) {
		const calendar = s.calendars.find((c) => c.id === calendarId);
		if (!calendar) fail("Calendar is outside the configured account scope");
		const data = await rows(
			s.cfg,
			"records",
			{
				select: "collection,id,data,updated_at",
				workspace_id: `eq.${calendarId}`,
				deleted: "eq.false",
				collection: `in.(${COLLECTIONS.join(",")})`,
				order: "collection.asc,id.asc",
			},
			signal,
		);
		return data.map((r) => ({ ...r, data: { ...r.data, id: r.id } }));
	}
	async function snapshot(signal) {
		const s = await scope(signal);
		const calendars = [];
		for (const c of s.calendars) {
			const data = await records(s, c.id, signal);
			calendars.push({
				...c,
				projects: data.filter((r) => r.collection === "projects").map((r) => ({ ...r.data, id: r.id })),
				columns: data.filter((r) => r.collection === "columns").map((r) => ({ ...r.data, id: r.id })),
				tasks: data
					.filter((r) => r.collection === "tasks")
					.map((r) => ({ ...r.data, id: r.id, revision: r.updated_at })),
			});
		}
		return {
			accountEmail: s.cfg.email,
			allowWrites: s.cfg.allowWrites,
			calendars,
			fetchedAt: new Date().toISOString(),
		};
	}
	async function read(params, signal) {
		const s = await scope(signal);
		if (params.action === "calendars") return { calendars: s.calendars };
		const wanted = params.calendarId ? s.calendars.filter((c) => c.id === params.calendarId) : s.calendars;
		if (!wanted.length && params.calendarId) fail("Calendar is outside the configured account scope");
		const data = [];
		for (const c of wanted) for (const r of await records(s, c.id, signal)) data.push({ calendarId: c.id, ...r });
		if (params.action === "card") {
			const taskId = id(params.id, "card id");
			const task = data.find((r) => r.collection === "tasks" && r.id === taskId);
			if (!task) fail("Card not found in scope");
			return {
				task,
				columns: data.filter(
					(r) =>
						r.calendarId === task.calendarId &&
						r.collection === "columns" &&
						r.data?.projectId === task.data?.projectId,
				),
				related: data.filter((r) => r.calendarId === task.calendarId && r.data?.taskId === taskId).slice(0, 200),
			};
		}
		if (params.action === "board") {
			const projectId = id(params.projectId, "project id");
			const found = data.filter((r) => r.id === projectId || r.data?.projectId === projectId);
			return { records: found.slice(0, 500), total: found.length, truncated: found.length > 500 };
		}
		if (!["projects", "cards", "agenda"].includes(params.action)) fail("Unknown read action");
		let found = data.filter((r) => r.collection === (params.action === "projects" ? "projects" : "tasks"));
		if (params.projectId)
			found = found.filter((r) => r.data?.projectId === params.projectId || r.id === params.projectId);
		if (params.search)
			found = found.filter((r) =>
				JSON.stringify(r.data)
					.toLowerCase()
					.includes(text(params.search, "search", 200).toLowerCase()),
			);
		if (params.action === "agenda") {
			const from = params.from ? date(params.from, "from") : new Date().toISOString().slice(0, 10);
			const to = params.to ? date(params.to, "to") : from;
			if (!from || !to || to < from) fail("Invalid agenda range");
			found = found.filter(
				(r) =>
					!r.data?.archivedAt &&
					(r.data?.dueDate || r.data?.startDate) &&
					(r.data.dueDate || r.data.startDate) >= from &&
					(r.data.startDate || r.data.dueDate) <= to,
			);
		}
		const limit = Math.min(200, Math.max(1, Number(params.limit) || 50));
		return { total: found.length, records: found.slice(0, limit), truncated: found.length > limit };
	}
	async function write(params, signal) {
		const s = await scope(signal);
		if (!s.cfg.allowWrites) fail("Takkle changes are disabled in plugin settings");
		const calendarId = id(params.calendarId, "calendar id");
		if (!s.calendars.some((c) => c.id === calendarId && c.canWrite))
			fail("This account cannot edit the selected calendar");
		const data = await records(s, calendarId, signal);
		const entity = (collection, value) => {
			const row = data.find((r) => r.collection === collection && r.id === id(value, `${collection} id`));
			if (!row || !row.data || row.data.archivedAt) fail(`${collection} not found or archived`);
			return row;
		};
		const now = new Date().toISOString();
		const actorId = data.find((r) => r.collection === "members" && r.data?.authUserId === s.userId)?.id || null;
		const changes = [];
		const put = (collection, value) =>
			changes.push({
				workspace_id: calendarId,
				collection,
				id: value.id,
				data: value,
				deleted: false,
				origin: "workfree-takkle",
			});
		let created;
		if (params.action === "create_project") {
			const name = text(params.name, "project name", 120);
			created = {
				id: newId("prj"),
				ws: calendarId,
				name,
				key:
					name
						.toUpperCase()
						.replace(/[^A-Z0-9]/g, "")
						.slice(0, 6) || "PRJ",
				color: "#3E7BFA",
				description: params.description === undefined ? "" : plainDescription(params.description),
				position:
					Math.max(-1, ...data.filter((r) => r.collection === "projects").map((r) => Number(r.data?.position) || 0)) +
					1,
				taskCounter: 0,
				createdAt: now,
				updatedAt: now,
				archivedAt: null,
				detail: "complete",
			};
			put("projects", created);
			for (const [position, name] of ["To Do", "In Progress", "Completed"].entries())
				put("columns", {
					id: position === 2 ? `${created.id}_c_done` : newId("col"),
					projectId: created.id,
					name,
					color: position === 2 ? "#30A46C" : "#7C8594",
					isDone: position === 2,
					...(position === 2 ? { system: "done" } : {}),
					position,
					createdAt: now,
				});
		} else if (params.action === "create_column") {
			const project = entity("projects", params.projectId).data;
			const columns = data
				.filter((r) => r.collection === "columns" && r.data?.projectId === project.id)
				.map((r) => r.data);
			const finish = columns.find((c) => c.system === "done");
			const lastOpen = Math.max(-1, ...columns.filter((c) => c.system !== "done").map((c) => Number(c.position) || 0));
			const position = finish ? (lastOpen + finish.position) / 2 : lastOpen + 1;
			created = {
				id: newId("col"),
				projectId: project.id,
				name: text(params.name, "column name", 60),
				position,
				isDone: false,
				color: "#7C8594",
				createdAt: now,
			};
			put("columns", created);
		} else if (params.action === "create_card" || params.action === "update_card") {
			const previous = params.action === "update_card" ? entity("tasks", params.id) : null;
			const project = entity("projects", previous?.data.projectId || params.projectId).data;
			const columns = data
				.filter((r) => r.collection === "columns" && r.data?.projectId === project.id)
				.map((r) => r.data)
				.sort((a, b) => a.position - b.position);
			const column = params.columnId
				? columns.find((c) => c.id === params.columnId)
				: previous
					? columns.find((c) => c.id === previous.data.columnId)
					: columns.find((c) => !c.isDone) || columns[0];
			if (!column) fail("Column must belong to the selected project");
			created = previous
				? { ...previous.data }
				: {
						id: newId("task"),
						projectId: project.id,
						ws: calendarId,
						title: text(params.title, "card title", 500),
						description: "",
						priority: "none",
						assigneeIds: [],
						assigneeId: null,
						labels: [],
						dueDate: null,
						startDate: null,
						dueTime: null,
						position:
							Math.max(
								0,
								...data
									.filter((r) => r.collection === "tasks" && r.data?.columnId === column.id)
									.map((r) => Number(r.data.position) || 0),
							) + 1024,
						createdAt: now,
						createdBy: actorId,
						repeat: null,
						archivedAt: null,
					};
			if (params.title !== undefined) created.title = text(params.title, "card title", 500);
			if (params.description !== undefined) created.description = description(params.description);
			if (params.priority !== undefined) {
				if (!PRIORITIES.includes(params.priority)) fail("Invalid priority");
				created.priority = params.priority;
			}
			for (const field of ["dueDate", "startDate"])
				if (params[field] !== undefined) created[field] = date(params[field], field);
			if (created.startDate && created.dueDate && created.startDate > created.dueDate)
				fail("Start date must not follow due date");
			if (!created.dueDate) created.dueTime = null;
			if (params.columnId && params.columnId !== created.columnId)
				created.position =
					Math.max(
						0,
						...data
							.filter((r) => r.collection === "tasks" && r.data?.columnId === column.id)
							.map((r) => Number(r.data.position) || 0),
					) + 1024;
			created.columnId = column.id;
			created.updatedAt = now;
			if (column.isDone) {
				if (!created.completedAt) {
					created.completedAt = now;
					created.completedFromId = previous?.data.columnId || null;
					created.completedOffset = -new Date(now).getTimezoneOffset();
				}
				created.firstCompletedAt ||= now;
			} else {
				if (created.completedAt) {
					created.reopenedAt = now;
					created.reopenCount = (created.reopenCount || 0) + 1;
				}
				created.completedAt = null;
				created.completedOffset = null;
			}
			if (previous) {
				if (!params.expectedRevision || params.expectedRevision !== previous.updated_at)
					fail("Card changed or revision missing. Read the card again before updating.");
				// Conditional PATCH preserves unknown Takkle fields and refuses stale writes.
				const latest = await scope(signal);
				if (latest.cfg.email !== s.cfg.email || !latest.calendars.some((c) => c.id === calendarId && c.canWrite))
					fail("Calendar edit access changed");
				const result = await call(
					latest.cfg,
					`/rest/v1/records?${query({ workspace_id: `eq.${calendarId}`, collection: "eq.tasks", id: `eq.${previous.id}`, updated_at: `eq.${previous.updated_at}`, deleted: "eq.false" })}`,
					{
						method: "PATCH",
						body: { data: created, origin: "workfree-takkle" },
						headers: { Prefer: "return=representation" },
					},
					signal,
				);
				if (!Array.isArray(result) || result.length !== 1)
					fail("Card changed concurrently. Read it again; no update was confirmed.");
				return { records: result };
			}
			put("tasks", created);
		} else if (params.action === "update_project") {
			const previous = entity("projects", params.id);
			if (!params.expectedRevision || params.expectedRevision !== previous.updated_at)
				fail("Project changed or revision missing. Read the project again before updating.");
			created = { ...previous.data, updatedAt: now };
			if (params.name !== undefined) created.name = text(params.name, "project name", 120);
			if (params.description !== undefined) created.description = plainDescription(params.description);
			const latest = await scope(signal);
			if (latest.cfg.email !== s.cfg.email || !latest.calendars.some((c) => c.id === calendarId && c.canWrite))
				fail("Calendar edit access changed");
			const result = await call(
				latest.cfg,
				`/rest/v1/records?${query({ workspace_id: `eq.${calendarId}`, collection: "eq.projects", id: `eq.${previous.id}`, updated_at: `eq.${previous.updated_at}`, deleted: "eq.false" })}`,
				{
					method: "PATCH",
					body: { data: created, origin: "workfree-takkle" },
					headers: { Prefer: "return=representation" },
				},
				signal,
			);
			if (!Array.isArray(result) || result.length !== 1)
				fail("Project changed concurrently. Read it again; no update was confirmed.");
			return { records: result };
		} else fail("Unknown write action");
		const latest = await scope(signal);
		if (latest.cfg.email !== s.cfg.email || !latest.calendars.some((c) => c.id === calendarId && c.canWrite))
			fail("Calendar edit access changed");
		const result = await call(
			latest.cfg,
			"/rest/v1/records",
			{ method: "POST", body: changes, headers: { Prefer: "return=representation" } },
			signal,
		);
		if (!Array.isArray(result) || result.length !== changes.length)
			fail("Takkle did not confirm every created record. Refresh before retrying.");
		return { records: result };
	}
	return { snapshot, read, write };
}
