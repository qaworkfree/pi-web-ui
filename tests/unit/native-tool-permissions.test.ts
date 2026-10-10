import { mkdtemp, mkdir, writeFile, symlink, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFindToolDefinition, createPowerShellToolDefinition } from "@earendil-works/pi-coding-agent";
import { ClientSession } from "../../server/agent-service.js";
import { withNativeReadPermission } from "../../server/native-tool-permissions.js";
import { normalizeFilesystemPolicy, type FilesystemPolicy } from "../../server/filesystem-policy.js";
import type { FilesystemApprovalRequest } from "../../server/filesystem-access.js";
import type { AnyToolDefinition, ToolOverrideSpec } from "../../server/tool-overrides.js";

const dirs: string[] = [];
const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
async function linkFileTarget(target: string, linkPath: string) {
	// Junctions exercise physical path changes without requiring Windows symlink privileges.
	await symlink(
		process.platform === "win32" ? dirname(target) : target,
		linkPath,
		process.platform === "win32" ? "junction" : "file",
	);
}
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "pi-native-policy-"));
	dirs.push(dir);
	const project = join(dir, "project");
	const outside = join(dir, "outside");
	await mkdir(project);
	await mkdir(outside);
	await mkdir(join(project, "nested"));
	await writeFile(join(project, "nested", "file.txt"), "allowed");
	await writeFile(join(outside, "secret.txt"), "secret");
	let policy: FilesystemPolicy = normalizeFilesystemPolicy({
		rules: [{ path: project, permissions: { read: "allow", execute: "allow" } }],
	});
	return {
		dir,
		project,
		outside,
		getPolicy: () => policy,
		setPolicy: (next: FilesystemPolicy) => {
			policy = next;
		},
	};
}
function base(name: string) {
	const execute = vi.fn(async () => ({ content: [{ type: "text", text: "native result" }], details: {} }));
	const tool = {
		name,
		label: name,
		description: "Native definition",
		parameters: {},
		execute,
	} as unknown as AnyToolDefinition;
	return { tool, execute };
}
function call(tool: AnyToolDefinition, params: unknown, cwd: string, signal?: AbortSignal) {
	return tool.execute("call", params, signal, undefined, { cwd } as never);
}
function composition(
	f: Awaited<ReturnType<typeof fixture>>,
	options: {
		permission?: string;
		plan?: boolean;
		delegate?: boolean;
		review?: boolean;
		approve?: FilesystemApprovalRequest;
	} = {},
) {
	return Object.assign(Object.create(ClientSession.prototype) as object, {
		convs: new Map([
			[
				"c1",
				{
					permissionPreset: options.permission ?? "danger-full-access",
					session: { model: { input: ["text"], contextWindow: 8192 } },
				},
			],
		]),
		roots: [f.project],
		settingsSvc: { current: {} },
		filesystemPolicy: { load: f.getPolicy },
		getLang: () => "en",
		planModeOf: () => options.plan ?? false,
		delegateModeOf: () => options.delegate ?? false,
		goalReviewTurnOf: () => options.review ?? false,
		approvalRules: { list: () => [] },
		askApproval: options.approve ?? (async () => ({ decision: "deny" })),
	}) as unknown as { toolOverrideSpecs: (owner: string, cwd: string) => ToolOverrideSpec[] };
}
describe.each(["ls", "grep", "find"] as const)("native %s read boundary", (kind) => {
	it("preserves the native definition and params, using execution cwd rather than factory cwd", async () => {
		const f = await fixture();
		const b = base(kind);
		const wrapped = withNativeReadPermission(b.tool, {
			cwd: f.outside,
			kind,
			getPolicy: f.getPolicy,
			getLang: () => "en",
		});
		const params = { pattern: "file", path: "@nested", limit: 3 };
		expect(wrapped.parameters).toBe(b.tool.parameters);
		expect(wrapped.description).toBe(b.tool.description);
		await call(wrapped, params, f.project);
		expect(b.execute).toHaveBeenCalledWith("call", params, undefined, undefined, { cwd: f.project });
		await call(wrapped, {}, f.project);
		expect(b.execute).toHaveBeenCalledTimes(2);
	});
	it("blocks a denied root, missing policy, and links escaping the project before native execution", async () => {
		const f = await fixture();
		const b = base(kind);
		const wrapped = withNativeReadPermission(b.tool, {
			cwd: f.project,
			kind,
			getPolicy: f.getPolicy,
			getLang: () => "en",
		});
		await expect(call(wrapped, { path: f.outside }, f.project)).rejects.toThrow("Permission Denied");
		await symlink(f.outside, join(f.project, "escape"), directoryLinkType);
		await expect(call(wrapped, {}, f.project)).rejects.toThrow("Permission Denied");
		f.setPolicy(normalizeFilesystemPolicy(undefined));
		await expect(call(wrapped, { path: "nested" }, f.project)).rejects.toThrow("Permission Denied");
		expect(b.execute).not.toHaveBeenCalled();
	});
	it("requests one approval for all Ask paths and asks again for the next operation", async () => {
		const f = await fixture();
		f.setPolicy(normalizeFilesystemPolicy({ rules: [{ path: f.project, permissions: { read: "ask" } }] }));
		const approve = vi.fn<FilesystemApprovalRequest>(async () => ({ decision: "approve" }));
		const b = base(kind);
		const wrapped = withNativeReadPermission(b.tool, {
			cwd: f.project,
			kind,
			getPolicy: f.getPolicy,
			getLang: () => "en",
			askApproval: approve,
			getConversationId: () => "c1",
		});
		await call(wrapped, {}, f.project);
		await call(wrapped, {}, f.project);
		expect(approve).toHaveBeenCalledTimes(2);
		expect(approve.mock.calls[0]).toMatchObject([
			"call",
			kind,
			{},
			expect.any(String),
			expect.stringContaining("paths require Ask"),
			"c1",
			{ id: `filesystem:read:${f.project}` },
		]);
		expect(b.execute).toHaveBeenCalledTimes(2);
	});
	it.each(["deny", "edit"] as const)("does not delegate after %s approval", async (decision) => {
		const f = await fixture();
		f.setPolicy(normalizeFilesystemPolicy({ defaultPermissions: { read: "ask" } }));
		const b = base(kind);
		const wrapped = withNativeReadPermission(b.tool, {
			cwd: f.project,
			kind,
			getPolicy: f.getPolicy,
			getLang: () => "en",
			askApproval: async () => ({ decision, editedParams: { path: f.outside } }),
		});
		await expect(call(wrapped, {}, f.project)).rejects.toThrow("Permission Denied");
		expect(b.execute).not.toHaveBeenCalled();
	});
	it.each(["block", "new-file", "link", "abort"] as const)("rechecks %s while approval is pending", async (change) => {
		const f = await fixture();
		await linkFileTarget(join(f.project, "nested", "file.txt"), join(f.project, "link"));
		f.setPolicy(normalizeFilesystemPolicy({ defaultPermissions: { read: "ask" } }));
		const controller = new AbortController();
		const b = base(kind);
		const wrapped = withNativeReadPermission(b.tool, {
			cwd: f.project,
			kind,
			getPolicy: f.getPolicy,
			getLang: () => "en",
			askApproval: async () => {
				if (change === "block") f.setPolicy(normalizeFilesystemPolicy({}));
				if (change === "new-file") await writeFile(join(f.project, "new.txt"), "changed");
				if (change === "link") {
					await unlink(join(f.project, "link"));
					await linkFileTarget(join(f.outside, "secret.txt"), join(f.project, "link"));
				}
				if (change === "abort") controller.abort();
				return { decision: "approve" };
			},
		});
		await expect(call(wrapped, {}, f.project, controller.signal)).rejects.toThrow();
		expect(b.execute).not.toHaveBeenCalled();
	});
});
it.each(["grep", "find"] as const)(
	"preflights every %s descendant and refuses blocked files even with a narrow glob",
	async (kind) => {
		const f = await fixture();
		f.setPolicy(
			normalizeFilesystemPolicy({
				...f.getPolicy(),
				rules: [
					...f.getPolicy().rules,
					{ path: join(f.project, "nested", "file.txt"), permissions: { read: "block" } },
				],
			}),
		);
		const b = base(kind);
		const spec = composition(f)
			.toolOverrideSpecs("c1", f.project)
			.find((s) => s.name === kind)!;
		await expect(call(spec.composeWith!(b.tool), { pattern: "*.md", glob: "*.md" }, f.project)).rejects.toThrow(
			"Permission Denied",
		);
		expect(b.execute).not.toHaveBeenCalled();
	},
);
it("ls and read-directory check immediate entries, without recursively inspecting grandchildren", async () => {
	const f = await fixture();
	f.setPolicy(
		normalizeFilesystemPolicy({
			...f.getPolicy(),
			rules: [...f.getPolicy().rules, { path: join(f.project, "nested", "file.txt"), permissions: { read: "block" } }],
		}),
	);
	const specs = composition(f).toolOverrideSpecs("c1", f.project);
	for (const name of ["ls", "read"]) {
		const result = await call(specs.find((s) => s.name === name)!.fallback(), { path: "." }, f.project);
		expect(result.content).toEqual(
			expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("nested/") })]),
		);
	}
	await symlink(f.outside, join(f.project, "escape"), directoryLinkType);
	for (const name of ["ls", "read"])
		await expect(call(specs.find((s) => s.name === name)!.fallback(), { path: "." }, f.project)).rejects.toThrow(
			"Permission Denied",
		);
});

it("retains the real SDK find operation and result formatting after authorization", async () => {
	const f = await fixture();
	const glob = vi.fn(async () => [join(f.project, "nested", "file.txt")]);
	const native = createFindToolDefinition(f.project, { operations: { exists: () => true, glob } });
	const spec = composition(f)
		.toolOverrideSpecs("c1", f.project)
		.find((s) => s.name === "find")!;
	const result = await call(spec.composeWith!(native), { pattern: "*.txt" }, f.project);
	expect(glob).toHaveBeenCalledWith("*.txt", f.project, expect.any(Object));
	expect(result.content).toEqual([{ type: "text", text: "nested/file.txt" }]);
});

it.each(["blank-primary", "file_path", "file"])(
	"checks the %s read directory argument against policy",
	async (field) => {
		const f = await fixture();
		const b = base("read");
		const spec = composition(f)
			.toolOverrideSpecs("c1", f.project)
			.find((s) => s.name === "read")!;
		const params = field === "blank-primary" ? { path: "", file_path: f.outside } : { [field]: f.outside };
		await expect(call(spec.composeWith!(b.tool), params, f.project)).rejects.toThrow("Permission Denied");
		expect(b.execute).not.toHaveBeenCalled();
	},
);

it("checks the final target after a separate risk approval edits native arguments", async () => {
	const f = await fixture();
	const b = base("grep");
	const cs = composition(f, {
		approve: async () => ({ decision: "edit", editedParams: { path: f.outside, pattern: "secret" } }),
	});
	Object.assign(cs, {
		approvalRules: {
			list: () => [
				{
					id: "ask-search",
					enabled: true,
					tools: ["grep"],
					field: "path",
					match: "glob",
					value: "**",
					action: "ask",
					label: "Ask",
				},
			],
		},
	});
	const spec = cs.toolOverrideSpecs("c1", f.project).find((s) => s.name === "grep")!;
	await expect(call(spec.composeWith!(b.tool), { path: f.project, pattern: "allowed" }, f.project)).rejects.toThrow(
		"Permission Denied",
	);
	expect(b.execute).not.toHaveBeenCalled();
});

it("refuses a blocked descendant before requesting approval for an otherwise Ask tree", async () => {
	const f = await fixture();
	f.setPolicy(
		normalizeFilesystemPolicy({
			defaultPermissions: { read: "ask" },
			rules: [{ path: join(f.project, "nested", "file.txt"), permissions: { read: "block" } }],
		}),
	);
	const approve = vi.fn<FilesystemApprovalRequest>(async () => ({ decision: "approve" }));
	const b = base("grep");
	const wrapped = withNativeReadPermission(b.tool, {
		cwd: f.project,
		kind: "grep",
		getPolicy: f.getPolicy,
		getLang: () => "en",
		askApproval: approve,
	});
	await expect(call(wrapped, {}, f.project)).rejects.toThrow("Permission Denied");
	expect(approve).not.toHaveBeenCalled();
	expect(b.execute).not.toHaveBeenCalled();
});
describe("native PowerShell composition", () => {
	it("delegates approved execution to the real SDK PowerShell definition", async () => {
		const f = await fixture();
		const exec = vi.fn(async () => ({ exitCode: 0 }));
		const native = createPowerShellToolDefinition(f.project, { operations: { exec }, exposeSessionEnvironment: false });
		const spec = composition(f)
			.toolOverrideSpecs("c1", f.project)
			.find((s) => s.name === "powershell")!;
		await call(spec.composeWith!(native), { command: "Get-Date" }, f.project);
		expect(exec).toHaveBeenCalledWith("Get-Date", f.project, expect.any(Object));
	});
	it.each(["read-only", "plan", "delegate", "review", "blocked-execute"])(
		"blocks %s before launching scripts",
		async (mode) => {
			const f = await fixture();
			if (mode === "blocked-execute")
				f.setPolicy(normalizeFilesystemPolicy({ rules: [{ path: f.project, permissions: { read: "allow" } }] }));
			const b = base("powershell");
			const spec = composition(f, {
				permission: mode === "read-only" ? mode : undefined,
				plan: mode === "plan",
				delegate: mode === "delegate",
				review: mode === "review",
			})
				.toolOverrideSpecs("c1", f.project)
				.find((s) => s.name === "powershell")!;
			try {
				expect(
					await call(spec.composeWith!(b.tool), { command: "Set-Content file.txt changed" }, f.project),
				).toMatchObject({ isError: true });
			} catch (error) {
				if (mode !== "plan") throw error;
				expect(String(error)).toContain("powershell");
			}
			expect(b.execute).not.toHaveBeenCalled();
		},
	);
	it("uses execution cwd and the same one-operation Execute approval bridge as Bash", async () => {
		const f = await fixture();
		f.setPolicy(normalizeFilesystemPolicy({ rules: [{ path: f.project, permissions: { execute: "ask" } }] }));
		const approve = vi.fn<FilesystemApprovalRequest>(async () => ({ decision: "approve" }));
		const b = base("powershell");
		const spec = composition(f, { approve })
			.toolOverrideSpecs("c1", f.outside)
			.find((s) => s.name === "powershell")!;
		const wrapped = spec.composeWith!(b.tool);
		await call(wrapped, { command: "Get-Date" }, f.project);
		expect(approve.mock.calls[0]?.[6]?.id).toBe(`filesystem:execute:${f.project}`);
		expect(b.execute).toHaveBeenCalledOnce();
		expect(await call(wrapped, { command: "Get-Date" }, f.outside)).toMatchObject({ isError: true });
		expect(b.execute).toHaveBeenCalledOnce();
	});
});
