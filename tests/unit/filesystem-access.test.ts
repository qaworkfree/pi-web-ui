import { mkdtemp, mkdir, writeFile, readFile, symlink, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	authorizeFilesystemTool,
	filesystemAccess,
	requireFilesystemAccessSync,
	requireFilesystemTreeAccess,
} from "../../server/filesystem-access.js";
import { normalizeFilesystemPolicy, type FilesystemPolicy } from "../../server/filesystem-policy.js";
import { WorkspaceFS } from "../../server/plugin-facilities.js";
import { createArchive, extractArchive } from "../../server/file-archives.js";
import { requireFilesystemAccess } from "../../server/filesystem-access.js";
import { approvalSuppressionReason } from "../../server/tool-approval.js";
import { ClientSession } from "../../server/agent-service.js";
import type { ToolOverrideSpec } from "../../server/tool-overrides.js";
const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "pi-fs-access-"));
	dirs.push(dir);
	const project = join(dir, "project");
	const outside = join(dir, "outside");
	await mkdir(project);
	await mkdir(outside);
	await writeFile(join(outside, "secret.txt"), "secret");
	const policy = normalizeFilesystemPolicy({
		rules: [
			{
				path: project,
				permissions: {
					read: "allow",
					create: "allow",
					write: "allow",
					edit: "allow",
					delete: "allow",
					execute: "allow",
				},
			},
		],
	});
	return { dir, project, outside, policy };
}
describe("physical filesystem boundaries", () => {
	it("blocks existing and new paths through links outside a granted project", async () => {
		const f = await fixture();
		const link = join(f.project, "escape");
		await symlink(f.outside, link, "dir");
		expect((await filesystemAccess(f.policy, "read", join(link, "secret.txt"))).decision).toBe("block");
		expect((await filesystemAccess(f.policy, "create", join(link, "new", "file.txt"))).decision).toBe("block");
		expect(() => requireFilesystemAccessSync(f.policy, "read", join(link, "secret.txt"))).toThrow("Permission denied");
	});
	it("blocks nested exceptions before deleting an otherwise allowed tree", async () => {
		const f = await fixture();
		const secret = join(f.project, "protected.txt");
		await writeFile(secret, "keep");
		const policy = normalizeFilesystemPolicy({
			...f.policy,
			rules: [...f.policy.rules, { path: secret, permissions: { delete: "block" } }],
		});
		await expect(requireFilesystemTreeAccess(policy, "delete", f.project)).rejects.toThrow("Permission denied");
		await expect(
			new WorkspaceFS(
				() => f.project,
				() => policy,
			).remove("protected.txt"),
		).rejects.toThrow("Permission denied");
		expect(await readFile(secret, "utf8")).toBe("keep");
	});
	it("intersects plugin facilities with project policy and follows live changes", async () => {
		const f = await fixture();
		let policy = f.policy;
		const fs = new WorkspaceFS(
			() => f.project,
			() => policy,
		);
		await fs.write("file.txt", "allowed");
		expect(await fs.readText("file.txt")).toBe("allowed");
		await symlink(f.outside, join(f.project, "escape"), "dir");
		await expect(fs.readText("escape/secret.txt")).rejects.toThrow("Permission denied");
		policy = normalizeFilesystemPolicy({});
		await expect(fs.read("file.txt")).rejects.toThrow("Permission denied");
	});
	it("checks every archive source, extraction target, overwrite and generated output", async () => {
		const f = await fixture();
		await writeFile(join(f.project, "protected.txt"), "secret");
		const denied = normalizeFilesystemPolicy({
			...f.policy,
			rules: [...f.policy.rules, { path: join(f.project, "protected.txt"), permissions: { read: "block" } }],
		});
		await expect(
			createArchive(f.project, f.dir, (action, path) => requireFilesystemAccess(denied, action, path)),
		).rejects.toThrow("Permission denied");
		const archive = await createArchive(f.project, f.dir);
		const dest = join(f.project, "unpacked");
		await mkdir(dest);
		const target = join(dest, "project", "protected.txt");
		const guarded = normalizeFilesystemPolicy({
			...f.policy,
			rules: [...f.policy.rules, { path: target, permissions: { create: "block" } }],
		});
		await expect(
			extractArchive(archive.path, dest, "overwrite", (action, path) => requireFilesystemAccess(guarded, action, path)),
		).rejects.toThrow("Permission denied");
		await expect(readFile(target)).rejects.toThrow();
		await mkdir(join(dest, "project"));
		await writeFile(target, "original");
		const overwrite = normalizeFilesystemPolicy({
			...f.policy,
			rules: [...f.policy.rules, { path: target, permissions: { write: "block" } }],
		});
		await expect(
			extractArchive(archive.path, dest, "overwrite", (action, path) =>
				requireFilesystemAccess(overwrite, action, path),
			),
		).rejects.toThrow("Permission denied");
		expect(await readFile(target, "utf8")).toBe("original");
		await expect(
			createArchive(f.project, undefined, (action, path) =>
				requireFilesystemAccess(
					normalizeFilesystemPolicy({ rules: [{ path: f.project, permissions: { read: "allow" } }] }),
					action,
					path,
				),
			),
		).rejects.toThrow("Permission denied");
	});
});
describe("one-operation filesystem approvals", () => {
	it("distinguishes creation from overwrite and never silently allows Ask", async () => {
		const f = await fixture();
		const target = join(f.project, "new.txt");
		const policy = normalizeFilesystemPolicy({
			rules: [{ path: f.project, permissions: { create: "allow", write: "block" } }],
		});
		const request = {
			getPolicy: () => policy,
			action: "write" as const,
			path: target,
			toolCallId: "id",
			toolName: "write",
			params: { path: target },
			detectCreate: true,
		};
		expect(await authorizeFilesystemTool(request)).toBe(true);
		await writeFile(target, "existing");
		expect(await authorizeFilesystemTool(request)).toBe(false);
		const ask = normalizeFilesystemPolicy({ defaultPermissions: { read: "ask" } });
		expect(
			await authorizeFilesystemTool({ ...request, getPolicy: () => ask, action: "read", detectCreate: false }),
		).toBe(false);
	});
	it("records exact categories and denies if policy changes or a link is retargeted while awaiting approval", async () => {
		const f = await fixture();
		let policy: FilesystemPolicy = normalizeFilesystemPolicy({ defaultPermissions: { read: "ask" } });
		const target = join(f.project, "link");
		await symlink(join(f.outside, "secret.txt"), target);
		const request = {
			getPolicy: () => policy,
			action: "read" as const,
			path: target,
			toolCallId: "id",
			toolName: "read",
			params: { path: target },
		};
		const approved = vi.fn(async () => ({ decision: "approve" as const }));
		expect(await authorizeFilesystemTool({ ...request, askApproval: approved })).toBe(true);
		expect(approved.mock.calls).toHaveLength(1);
		expect(
			await authorizeFilesystemTool({
				...request,
				askApproval: async () => {
					policy = normalizeFilesystemPolicy({});
					return { decision: "approve" };
				},
			}),
		).toBe(false);
		policy = normalizeFilesystemPolicy({ defaultPermissions: { read: "ask" } });
		expect(
			await authorizeFilesystemTool({
				...request,
				askApproval: async () => {
					await writeFile(join(f.project, "other.txt"), "changed");
					await unlink(target);
					await symlink(join(f.project, "other.txt"), target);
					return { decision: "approve" };
				},
			}),
		).toBe(false);
		expect(
			await authorizeFilesystemTool({ ...request, askApproval: async () => ({ decision: "edit", editedParams: {} }) }),
		).toBe(false);
		expect(
			approvalSuppressionReason({ allowAll: true, categories: new Map() }, false, "filesystem:read:/project"),
		).toBeNull();
	});
	it("enforces the final edited target in the real write-tool composition", async () => {
		const f = await fixture();
		const execute = vi.fn(async () => ({ content: [] }));
		const cs = Object.assign(Object.create(ClientSession.prototype) as object, {
			convs: new Map([["c1", { permissionPreset: "danger-full-access" }]]),
			roots: [],
			settingsSvc: { current: {} },
			filesystemPolicy: { load: () => f.policy },
			getLang: () => "en",
			planModeOf: () => false,
			delegateModeOf: () => false,
			goalReviewTurnOf: () => false,
			approvalRules: {
				list: () => [
					{
						id: "ask-write",
						enabled: true,
						tools: ["write"],
						field: "path",
						match: "glob",
						value: "**",
						action: "ask",
						label: "Ask",
					},
				],
			},
			askApproval: async () => ({
				decision: "edit",
				editedParams: { path: join(f.outside, "new.txt"), content: "denied" },
			}),
		}) as unknown as { toolOverrideSpecs: (owner: string, cwd: string) => ToolOverrideSpec[] };
		const spec = cs.toolOverrideSpecs("c1", f.project).find((s) => s.name === "write")!;
		const tool = spec.composeWith!({ name: "write", execute } as never);
		// A blocked destination is denied even when the session permits full access.
		const result = await tool.execute(
			"call",
			{ path: join(f.project, "new.txt"), content: "denied" } as never,
			undefined,
			undefined,
			{ cwd: f.project } as never,
		);
		expect(result).toMatchObject({ isError: true });
		expect(execute).not.toHaveBeenCalled();
	});
});

describe("auxiliary file tools", () => {
	it("checks the complete patch plan before writing or deleting, including symlink destinations", async () => {
		const { makePatchTool } = await import("../../server/patch-tool.js");
		const f = await fixture();
		await writeFile(join(f.project, "old.txt"), "original\n");
		const policy = normalizeFilesystemPolicy({
			...f.policy,
			rules: [...f.policy.rules, { path: join(f.project, "old.txt"), permissions: { delete: "block" } }],
		});
		const tool = makePatchTool({ cwd: f.project, getPolicy: () => policy });
		await expect(
			tool.execute("call", { patch: "[new.txt]\nPUT <1:\n+created\n[old.txt]\nREM" }, undefined, undefined, {
				cwd: f.project,
			} as never),
		).rejects.toThrow("Permission denied");
		await expect(readFile(join(f.project, "new.txt"))).rejects.toThrow();
		expect(await readFile(join(f.project, "old.txt"), "utf8")).toBe("original\n");
		await symlink(f.outside, join(f.project, "escape"), "dir");
		await expect(
			tool.execute("call", { patch: "[escape/new.txt]\nPUT <1:\n+denied" }, undefined, undefined, {
				cwd: f.project,
			} as never),
		).rejects.toThrow("Permission denied");
	});
	it("does not leak blocked excerpts through present_files", async () => {
		const { makePresentFilesTool } = await import("../../server/present-files-tool.js");
		const f = await fixture();
		const tool = makePresentFilesTool(f.project, { getPolicy: () => f.policy });
		await expect(
			tool.execute("call", { items: [{ path: join(f.outside, "secret.txt") }] } as never, undefined, undefined, {
				cwd: f.project,
			} as never),
		).rejects.toThrow("Permission denied");
	});
});

it("blocks directory-picker writes, completion, OS open/reveal and Git before effects outside policy", async () => {
	const { FilesService } = await import("../../server/files-service.js");
	const f = await fixture();
	const emit = vi.fn();
	const service = new FilesService({
		emit,
		isDisposed: () => false,
		getCwd: () => f.project,
		getActiveCwd: () => f.project,
		getPermission: () => "danger-full-access",
		getFilesystemPolicy: () => f.policy,
	});
	expect(await service.makeDir(join(f.outside, "new"))).toBeNull();
	await expect(readFile(join(f.outside, "new"))).rejects.toThrow();
	await service.completePath(`${f.outside}/`);
	expect(emit).toHaveBeenCalledWith({ type: "path_completions", completions: [] });
	await service.revealEntry(join(f.outside, "secret.txt"));
	await service.openDefaultEntry(join(f.outside, "secret.txt"));
	expect(emit.mock.calls.filter(([row]) => row.type === "notice" && /Permission denied/.test(row.textEn)).length).toBe(
		3,
	);
	const denied = new FilesService({
		emit,
		isDisposed: () => false,
		getCwd: () => f.project,
		getActiveCwd: () => f.project,
		getFilesystemPolicy: () => normalizeFilesystemPolicy({}),
	});
	await denied.scmQuery("status", 9);
	expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "scm_data", reqId: 9, ok: false }));
});

it("keeps filesystem requests pending when approvals are disabled and forces malicious broad scopes back to once", async () => {
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const { readApprovalHistory } = await import("../../server/approval-history.js");
	const manager = SessionManager.inMemory();
	const emit = vi.fn();
	const cs = Object.assign(Object.create(ClientSession.prototype) as object, {
		disposed: false,
		activeId: "c1",
		approvalSeq: 0,
		pendingApprovals: new Map(),
		convs: new Map([["c1", { id: "c1", session: { sessionManager: manager }, title: "Test" }]]),
		settingsSvc: { current: { toolApprovalEnabled: false }, push: vi.fn() },
		emit,
		flushSnapshot: vi.fn(),
	}) as unknown as ClientSession;
	const category = { id: "filesystem:read:/project/file", label: "Read", labelEn: "Read" };
	const first = cs.askApproval("call-1", "read", {}, undefined, undefined, "c1", category);
	const second = cs.askApproval("call-2", "read", {}, undefined, undefined, "c1", category);
	cs.autoApprovePendingApprovals("disabled", "disabled");
	const pending = emit.mock.calls.map(([row]) => row).filter((row) => row.type === "tool_approval_pending");
	expect(pending).toHaveLength(2);
	expect(cs.resolveToolApproval(pending[0].id, "approve", undefined, undefined, "all")).toBe(true);
	expect((await first).decision).toBe("approve");
	cs.cancelPendingApprovals();
	expect((await second).decision).toBe("deny");
	expect(readApprovalHistory(manager, new Set()).find((row) => row.id === pending[0].id)).toMatchObject({
		status: "approved",
		scope: "once",
	});
});
