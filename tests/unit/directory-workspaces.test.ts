import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesService } from "../../server/files-service.js";
import { normalizeFilesystemPolicy } from "../../server/filesystem-policy.js";

const owned: string[] = [];
afterEach(async () => {
	for (const path of owned.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "directory-workspaces-"));
	owned.push(root);
	const workspace = join(root, "Personal", "Workspace");
	await mkdir(workspace, { recursive: true });
	await mkdir(join(workspace, "blocked"));
	const policy = normalizeFilesystemPolicy({
		rules: [
			{ path: workspace, permissions: { read: "allow", create: "allow", write: "allow", edit: "allow" } },
			{ path: join(workspace, "blocked"), permissions: { read: "block", create: "block" } },
		],
	});
	const emit = vi.fn();
	const service = new FilesService({
		emit,
		isDisposed: () => false,
		getCwd: () => workspace,
		getActiveCwd: () => workspace,
		getFilesystemPolicy: () => policy,
	});
	return { root, workspace, policy, emit, service };
}
it("distinguishes blocked, unavailable and empty folders while exposing readable shortcuts", async () => {
	const { root, workspace, service, emit, policy } = await fixture();
	const before = JSON.stringify(policy);
	await service.completePath(`${root}/`, "blocked-parent");
	expect(emit).toHaveBeenLastCalledWith(
		expect.objectContaining({
			requestId: "blocked-parent",
			completions: [],
			roots: [workspace],
			error: expect.stringContaining("Permission denied"),
		}),
	);
	await service.completePath(`${workspace}/missing/`, "missing");
	expect(emit).toHaveBeenLastCalledWith(
		expect.objectContaining({ requestId: "missing", error: expect.stringContaining("Cannot browse") }),
	);
	await mkdir(join(workspace, "empty"));
	await service.completePath(`${workspace}/empty/`, "empty");
	expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: "empty", completions: [] }));
	expect(emit.mock.lastCall![0].error).toBeUndefined();
	expect(JSON.stringify(policy)).toBe(before);
});
it("confirms creation, rejects collisions and blocked children without changing policy", async () => {
	const { workspace, service, emit, policy } = await fixture();
	const before = JSON.stringify(policy);
	const path = join(workspace, "New Project");
	expect(await service.makeDir(path, "create")).toBe(path);
	expect((await stat(path)).isDirectory()).toBe(true);
	expect(emit).toHaveBeenCalledWith({ type: "directory_result", requestId: "create", path });
	expect(await service.makeDir(path, "duplicate")).toBeNull();
	expect(emit).toHaveBeenCalledWith(
		expect.objectContaining({ requestId: "duplicate", error: expect.stringContaining("already exists") }),
	);
	const blocked = join(workspace, "blocked", "child");
	expect(await service.makeDir(blocked, "denied")).toBeNull();
	await expect(stat(blocked)).rejects.toThrow();
	expect(emit).toHaveBeenCalledWith(
		expect.objectContaining({ requestId: "denied", error: expect.stringContaining("Permission denied") }),
	);
	expect(JSON.stringify(policy)).toBe(before);
});
it("follows Windows directory junctions without allowing a blocked destination", async () => {
	const { root, workspace, service, emit } = await fixture();
	const alias = join(root, "workspace-alias");
	await symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir");
	await service.completePath(`${alias}/`, "alias");
	expect(emit.mock.lastCall![0]).toMatchObject({ requestId: "alias" });
	expect(emit.mock.lastCall![0].error).toBeUndefined();
	const outside = join(root, "outside");
	await mkdir(outside);
	await writeFile(join(outside, "private.txt"), "fixture");
	await symlink(outside, join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
	await service.completePath(`${workspace}/escape/`, "escape");
	expect(emit.mock.lastCall![0]).toMatchObject({
		requestId: "escape",
		completions: [],
		error: expect.stringContaining("Permission denied"),
	});
});
