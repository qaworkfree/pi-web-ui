import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientStateStore } from "../../server/client-state.js";

describe("ClientStateStore 最近项目删除全局持久化", () => {
	let dir: string;
	let file: string;
	let store: ClientStateStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-client-state-test-"));
		file = join(dir, "client-state.json");
		store = new ClientStateStore(file);
	});

	afterEach(() => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("在 client A 删除的项目，对新 client B 同样保持删除状态（全局 tombstone）", () => {
		store.remember("clientA", "/path/to/project1");
		store.remember("clientA", "/path/to/project2");
		store.remember("clientB", "/path/to/project1");

		// clientA 移除 project1
		store.removeProject("clientA", "/path/to/project1");

		// clientA 和 clientB 以及全新 clientC 均应视 project1 为已移除
		expect(store.getRemovedProjects("clientA")).toContain("/path/to/project1");
		expect(store.getRemovedProjects("clientB")).toContain("/path/to/project1");
		expect(store.getRemovedProjects("clientC")).toContain("/path/to/project1");

		// clientB 的 projects 列表中也应被移除
		expect(store.get("clientB").projects.map((p) => p.path)).not.toContain("/path/to/project1");
	});

	it("服务重启（新 ClientStateStore 实例）后 tombstone 依然有效", () => {
		store.remember("clientA", "/path/to/project1");
		store.removeProject("clientA", "/path/to/project1");

		const reopened = new ClientStateStore(file);
		expect(reopened.getRemovedProjects("brandNewClient")).toContain("/path/to/project1");
	});

	it("用户显式重新打开该项目时，清除全局 tombstone", () => {
		store.remember("clientA", "/path/to/project1");
		store.removeProject("clientA", "/path/to/project1");
		expect(store.getRemovedProjects("clientB")).toContain("/path/to/project1");

		// 用户重新打开 project1
		store.remember("clientB", "/path/to/project1");

		expect(store.getRemovedProjects("clientA")).not.toContain("/path/to/project1");
		expect(store.getRemovedProjects("clientB")).not.toContain("/path/to/project1");
		expect(store.getRemovedProjects("clientC")).not.toContain("/path/to/project1");
	});
});
