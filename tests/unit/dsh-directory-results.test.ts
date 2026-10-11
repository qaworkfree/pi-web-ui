import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshClientSession } from "../../server/dsh/dsh-agent-service.js";

const owned: string[] = [];
afterEach(async () => {
	for (const path of owned.splice(0)) await rm(path, { recursive: true, force: true });
});
it("reports a failed DSH workspace restart rather than confirming a successful switch", async () => {
	const root = await mkdtemp(join(tmpdir(), "dsh-directory-result-"));
	owned.push(root);
	const target = join(root, "project");
	await mkdir(target);
	const emit = vi.fn();
	const remember = vi.fn();
	const session = Object.assign(Object.create(DshClientSession.prototype) as object, {
		cwd: root,
		roots: [],
		clientId: "fixture",
		model: "fixture",
		stateStore: { getWorkspaceRoots: () => [], remember },
		runtime: { restart: vi.fn().mockRejectedValue(new Error("Fixture runtime failure")) },
		emit,
	}) as unknown as DshClientSession;
	await session.setCwd(target, "switch");
	expect(emit).toHaveBeenCalledWith({
		type: "directory_result",
		requestId: "switch",
		error: "Failed to switch directory: Fixture runtime failure",
	});
	expect(emit.mock.calls.some(([message]) => message.type === "directory_result" && message.path)).toBe(false);
	expect(remember).toHaveBeenLastCalledWith("fixture", root);
	await session.setCwd(root, "same");
	expect(emit).toHaveBeenLastCalledWith({ type: "directory_result", requestId: "same", path: root });
});
