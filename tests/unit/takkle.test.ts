import { describe, expect, it, vi } from "vitest";
import { createTakkleService, SUPABASE_URL } from "../../plugins/takkle/service.mjs";
import { withPluginMutationGate } from "../../server/plugin-mutation.js";
import { dayKey, monthDays, tasksOnDay } from "../../plugins/takkle/client/calendar.mjs";
import { pluginNetFetch, parseUiContributions } from "../../server/plugins.js";
import { readFileSync } from "node:fs";

const userId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const calendarId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const foreignId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const revision = "2026-10-06T00:00:00Z";
function fixture() {
	const settings: Record<string, unknown> = {
		secretKey: "sb_secret_fixture_only",
		accountEmail: "account@example.com",
		allowWrites: true,
	};
	let role = "owner";
	let approved = true;
	let loseMembership = false;
	let membershipsRead = 0;
	let conflict = false;
	const records: any[] = [
		{
			collection: "projects",
			id: "p1",
			updated_at: revision,
			data: { id: "p1", name: "Board", position: 0, ws: calendarId, custom: "preserve" },
		},
		{ collection: "columns", id: "c1", data: { id: "c1", projectId: "p1", name: "To Do", position: 0 } },
		{
			collection: "columns",
			id: "done",
			data: { id: "done", projectId: "p1", name: "Completed", position: 1, isDone: true, system: "done" },
		},
		{
			collection: "tasks",
			id: "t1",
			updated_at: revision,
			data: {
				id: "t1",
				projectId: "p1",
				columnId: "c1",
				title: "Existing",
				dueDate: "2026-10-08",
				startDate: "2026-10-06",
				custom: { keep: true },
			},
		},
		{ collection: "checklist", id: "i1", data: { id: "i1", taskId: "t1", title: "Check" } },
	];
	const writes: any[] = [];
	const requests: URL[] = [];
	const request = vi.fn(async (url: string, init: any) => {
		const u = new URL(url);
		requests.push(u);
		expect(u.origin).toBe(SUPABASE_URL);
		expect(init.headers.apikey).toBe(settings.secretKey);
		expect(init.redirect).toBe("error");
		let body: any;
		if (u.pathname === "/auth/v1/admin/users") body = { users: [{ id: userId, email: "account@example.com" }] };
		else if (u.pathname.endsWith("access_requests")) body = [{ status: approved ? "approved" : "denied" }];
		else if (u.pathname.endsWith("workspace_members")) {
			membershipsRead++;
			body = loseMembership && membershipsRead > 1 ? [] : [{ workspace_id: calendarId, role }];
		} else if (u.pathname.endsWith("workspaces")) body = [{ id: calendarId, name: "My calendar", kind: "personal" }];
		else if (init.method !== "GET") {
			writes.push({ url: u, ...init });
			const data = JSON.parse(init.body);
			body =
				init.method === "PATCH"
					? conflict
						? []
						: [
								{
									...records.find((r) => r.id === u.searchParams.get("id")?.slice(3)),
									...data,
									updated_at: "new-revision",
								},
							]
					: data;
		} else body = Number(u.searchParams.get("offset")) === 0 ? records : [];
		return { ok: true, status: 200, text: JSON.stringify(body) };
	});
	const service = createTakkleService({ getSettings: () => settings, request, getEnv: () => undefined });
	return {
		service,
		settings,
		records,
		requests,
		writes,
		request,
		setRole: (v: string) => (role = v),
		deny: () => (approved = false),
		revoke: () => (loseMembership = true),
		conflict: () => (conflict = true),
	};
}

describe("Takkle account scope and records", () => {
	it("declares a visible Takkle tab using the reserved pin/unpin view item", () => {
		const manifest = JSON.parse(readFileSync(new URL("../../plugins/takkle/manifest.json", import.meta.url), "utf8"));
		const diagnostics: string[] = [];
		const ui = parseUiContributions(manifest.ui, diagnostics);
		expect(diagnostics).toEqual([]);
		expect(ui?.items[0]).toMatchObject({ id: "__view", kind: "view", view: "plugin:takkle", slot: "topbar.primary" });
	});
	it("returns scoped snapshots without server credentials", async () => {
		const f = fixture();
		const result = await f.service.snapshot();
		expect(result.calendars[0].tasks[0].revision).toBe(revision);
		expect(JSON.stringify(result)).not.toContain("sb_secret_");
		expect(
			f.requests
				.filter((u) => u.pathname.endsWith("records"))
				.every((u) => u.searchParams.get("workspace_id") === `eq.${calendarId}`),
		).toBe(true);
	});
	it("refuses a calendar outside account membership before reading its records", async () => {
		const f = fixture();
		await expect(f.service.read({ action: "cards", calendarId: foreignId })).rejects.toThrow("outside");
		expect(f.requests.some((u) => u.pathname.endsWith("records"))).toBe(false);
	});
	it("requires an approved account", async () => {
		const f = fixture();
		f.deny();
		await expect(f.service.snapshot()).rejects.toThrow("not approved");
	});
	it("narrows scope using allowed calendar IDs", async () => {
		const f = fixture();
		f.settings.calendarIds = foreignId;
		expect((await f.service.snapshot()).calendars).toEqual([]);
	});
	it("rejects malformed allowlists", async () => {
		const f = fixture();
		f.settings.calendarIds = "bad,id";
		await expect(f.service.snapshot()).rejects.toThrow("UUID");
		expect(f.request).not.toHaveBeenCalled();
	});
	it("rejects missing credentials without network calls", async () => {
		const f = fixture();
		delete f.settings.secretKey;
		await expect(f.service.snapshot()).rejects.toThrow("Configure");
		expect(f.request).not.toHaveBeenCalled();
	});
	it("returns checklist detail and current revisions", async () => {
		const f = fixture();
		const card = await f.service.read({ action: "card", id: "t1" });
		expect(card.task.updated_at).toBe(revision);
		expect(card.related?.[0].collection).toBe("checklist");
	});
	it("includes multi-day cards in the requested agenda range", async () => {
		const f = fixture();
		expect((await f.service.read({ action: "agenda", from: "2026-10-07", to: "2026-10-07" })).total).toBe(1);
	});
	it("includes start-only cards only on their start date", async () => {
		const f = fixture();
		f.records.find((r) => r.id === "t1").data.dueDate = null;
		expect((await f.service.read({ action: "agenda", from: "2026-10-06" })).total).toBe(1);
		expect((await f.service.read({ action: "agenda", from: "2026-10-07" })).total).toBe(0);
	});
	it("rejects reversed or invalid dates", async () => {
		const f = fixture();
		await expect(f.service.read({ action: "agenda", from: "2026-02-30" })).rejects.toThrow("Invalid");
	});
	it("bounds searches and reports truncation", async () => {
		const f = fixture();
		f.records.push({ collection: "tasks", id: "t2", data: { title: "Other" } });
		const result = await f.service.read({ action: "cards", limit: 1 });
		expect(result.truncated).toBe(true);
		expect(result.records).toHaveLength(1);
	});
	it("does not return provider error bodies containing secrets", async () => {
		const f = fixture();
		f.request.mockImplementation(async () => ({ ok: false, status: 401, text: "sb_secret_fixture_only" }));
		await expect(f.service.snapshot()).rejects.toThrow("401");
		await expect(f.service.snapshot()).rejects.not.toThrow("sb_secret_");
	});
});
describe("Takkle writes", () => {
	it("blocks writes when disabled", async () => {
		const f = fixture();
		f.settings.allowWrites = false;
		await expect(f.service.write({ action: "create_project", calendarId, name: "New" })).rejects.toThrow("disabled");
		expect(f.writes).toHaveLength(0);
	});
	it("keeps viewers read only", async () => {
		const f = fixture();
		f.setRole("viewer");
		await expect(f.service.write({ action: "create_project", calendarId, name: "New" })).rejects.toThrow("cannot edit");
		expect(f.writes).toHaveLength(0);
	});
	it("does not write to a foreign calendar", async () => {
		const f = fixture();
		await expect(f.service.write({ action: "create_project", calendarId: foreignId, name: "New" })).rejects.toThrow(
			"cannot edit",
		);
		expect(f.writes).toHaveLength(0);
	});
	it("creates a project and its system Completed column atomically", async () => {
		const f = fixture();
		const result = await f.service.write({
			action: "create_project",
			calendarId,
			name: "Agent board",
			description: "Plan & verify",
		});
		expect(f.writes).toHaveLength(1);
		expect(result.records).toHaveLength(4);
		const project = result.records[0].data;
		expect(project.description).toBe("Plan & verify");
		expect(result.records.at(-1).data).toMatchObject({ id: `${project.id}_c_done`, system: "done", isDone: true });
	});
	it("creates a card without inventing its server-assigned number", async () => {
		const f = fixture();
		const result = await f.service.write({ action: "create_card", calendarId, projectId: "p1", title: "New" });
		expect(result.records[0].data.number).toBeUndefined();
		expect(result.records[0].data.columnId).toBe("c1");
	});
	it("escapes plain-text descriptions for the Takkle HTML editor", async () => {
		const f = fixture();
		const result = await f.service.write({
			action: "create_card",
			calendarId,
			projectId: "p1",
			title: "New",
			description: "<img src=x onerror=alert(1)>",
		});
		expect(result.records[0].data.description).toContain("&lt;img");
	});
	it("rejects columns from a different project", async () => {
		const f = fixture();
		await expect(
			f.service.write({ action: "create_card", calendarId, projectId: "p1", columnId: "foreign", title: "New" }),
		).rejects.toThrow("Column");
		expect(f.writes).toHaveLength(0);
	});
	it("refuses stale updates and requires a revision", async () => {
		const f = fixture();
		await expect(f.service.write({ action: "update_card", calendarId, id: "t1", title: "New" })).rejects.toThrow(
			"revision",
		);
		expect(f.writes).toHaveLength(0);
	});
	it("preserves unknown fields and conditionally updates the fetched revision", async () => {
		const f = fixture();
		const result = await f.service.write({
			action: "update_card",
			calendarId,
			id: "t1",
			title: "Changed",
			expectedRevision: revision,
		});
		expect(result.records[0].data.custom).toEqual({ keep: true });
		expect(f.writes[0].url.searchParams.get("updated_at")).toBe(`eq.${revision}`);
	});
	it("detects a race after reading the revision", async () => {
		const f = fixture();
		f.conflict();
		await expect(
			f.service.write({ action: "update_card", calendarId, id: "t1", title: "New", expectedRevision: revision }),
		).rejects.toThrow("concurrently");
	});
	it("rechecks membership immediately before a write", async () => {
		const f = fixture();
		f.revoke();
		await expect(f.service.write({ action: "create_project", calendarId, name: "New" })).rejects.toThrow(
			"access changed",
		);
		expect(f.writes).toHaveLength(0);
	});
	it("creates a column before Completed without overwriting that column", async () => {
		const f = fixture();
		const result = await f.service.write({ action: "create_column", calendarId, projectId: "p1", name: "Review" });
		expect(result.records).toHaveLength(1);
		expect(result.records[0].data.position).toBe(0.5);
	});
	it("preserves project metadata on conditional rename", async () => {
		const f = fixture();
		const result = await f.service.write({
			action: "update_project",
			calendarId,
			id: "p1",
			name: "Renamed",
			expectedRevision: revision,
		});
		expect(result.records[0].data.custom).toBe("preserve");
	});
	it("records completion and reopening when moving a card", async () => {
		const f = fixture();
		const result = await f.service.write({
			action: "update_card",
			calendarId,
			id: "t1",
			columnId: "done",
			expectedRevision: revision,
		});
		expect(Date.parse(result.records[0].data.completedAt)).toBeGreaterThan(0);
	});
	it("rejects invalid date ordering before writing", async () => {
		const f = fixture();
		await expect(
			f.service.write({
				action: "create_card",
				calendarId,
				projectId: "p1",
				title: "New",
				startDate: "2026-10-10",
				dueDate: "2026-10-09",
			}),
		).rejects.toThrow("Start");
		expect(f.writes).toHaveLength(0);
	});
	it("refuses cancellation before a request", async () => {
		const f = fixture();
		const controller = new AbortController();
		controller.abort();
		await expect(f.service.snapshot(controller.signal)).rejects.toThrow("canceled");
		expect(f.request).not.toHaveBeenCalled();
	});
});
describe("external mutation conversation gates", () => {
	it.each([
		undefined,
		{ permissionPreset: "read-only" },
		{ planMode: true },
		{ delegateMode: true },
		{ goalReview: true },
	])("blocks a mutation in %j", async (context) => {
		const execute = vi.fn();
		const tool = withPluginMutationGate({ execute }, () => context);
		await expect(tool.execute()).rejects.toThrow("Permission Denied");
		expect(execute).not.toHaveBeenCalled();
	});
	it("checks the current owning conversation on every call", async () => {
		let context = {};
		const execute = vi.fn(async () => "changed");
		const tool = withPluginMutationGate({ execute }, () => context);
		expect(await tool.execute()).toBe("changed");
		context = { planMode: true };
		await expect(tool.execute()).rejects.toThrow("Permission Denied");
		expect(execute).toHaveBeenCalledTimes(1);
	});
});
describe("credential-bearing plugin requests", () => {
	it("rejects redirects without forwarding the API key, even to an allowlisted host", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(null, {
					status: 302,
					headers: { location: "http://exampleproject.supabase.co/rest/v1/records" },
				}),
		);
		const result = await pluginNetFetch(
			SUPABASE_URL + "/rest/v1/records",
			{ redirect: "error", headers: { apikey: "sb_secret_fixture_only" } },
			{ hostAllowed: () => true, fetchImpl },
		);
		expect(result.ok).toBe(false);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});
describe("date-only calendar", () => {
	it("places a start-only card on its date", () => {
		expect(tasksOnDay([{ id: "start", startDate: "2026-10-06" }], "2026-10-06")).toHaveLength(1);
		expect(tasksOnDay([{ id: "start", startDate: "2026-10-06" }], "2026-10-07")).toHaveLength(0);
	});
	it("builds a six-week Monday-first month grid", () => {
		const days = monthDays(2026, 9);
		expect(days).toHaveLength(42);
		expect(days[0].getDay()).toBe(1);
		expect(dayKey(days[0])).toBe("2026-09-28");
	});
	it("shows multi-day cards, omitting archived and unscheduled cards", () => {
		expect(
			tasksOnDay(
				[
					{ id: "range", startDate: "2026-10-01", dueDate: "2026-10-03" },
					{ id: "old", dueDate: "2026-10-02", archivedAt: 1 },
					{ id: "none" },
				],
				"2026-10-02",
			).map((t: any) => t.id),
		).toEqual(["range"]);
	});
});
