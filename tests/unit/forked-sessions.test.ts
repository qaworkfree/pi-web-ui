import { describe, expect, it } from "vitest";

interface MockSessionInfo {
	path: string;
	parentSessionPath?: string;
	name?: string;
	modified: Date;
}

function deduplicateForkedSessions<T extends { path: string; parentSessionPath?: string }>(infos: T[]): T[] {
	const normSessionPath = (p: string) => String(p).replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
	const forkedParentPaths = new Set<string>();
	for (const info of infos) {
		if (typeof info.parentSessionPath === "string" && info.parentSessionPath) {
			forkedParentPaths.add(normSessionPath(info.parentSessionPath));
		}
	}
	if (forkedParentPaths.size === 0) return infos;
	const kept = infos.filter((info) => !forkedParentPaths.has(normSessionPath(info.path)));
	return kept.length > 0 ? kept : infos;
}

describe("Fork 会话历史去重", () => {
	it("隐藏被后续 fork 掉的父会话，只保留链尾叶子会话", () => {
		const now = Date.now();
		const sessions: MockSessionInfo[] = [
			{ path: "/sessions/session-1.jsonl", modified: new Date(now - 3000) },
			{
				path: "/sessions/session-2.jsonl",
				parentSessionPath: "/sessions/session-1.jsonl",
				modified: new Date(now - 2000),
			},
			{
				path: "/sessions/session-3.jsonl",
				parentSessionPath: "/sessions/session-2.jsonl",
				modified: new Date(now - 1000),
			},
			{ path: "/sessions/independent.jsonl", modified: new Date(now - 500) },
		];

		const visible = deduplicateForkedSessions(sessions);
		expect(visible.map((s) => s.path)).toEqual(["/sessions/session-3.jsonl", "/sessions/independent.jsonl"]);
	});

	it("跨平台路径大小写与斜杠格式归一化比对", () => {
		const sessions: MockSessionInfo[] = [
			{ path: "C:\\Sessions\\Parent.jsonl", modified: new Date() },
			{
				path: "C:\\Sessions\\Child.jsonl",
				parentSessionPath: "c:/sessions/parent.jsonl",
				modified: new Date(),
			},
		];

		const visible = deduplicateForkedSessions(sessions);
		expect(visible.map((s) => s.path)).toEqual(["C:\\Sessions\\Child.jsonl"]);
	});

	it("当所有父子链异常（例如全被当作 parent）时回退原列表，不返回空", () => {
		const sessions: MockSessionInfo[] = [
			{ path: "/sessions/a.jsonl", parentSessionPath: "/sessions/b.jsonl", modified: new Date() },
			{ path: "/sessions/b.jsonl", parentSessionPath: "/sessions/a.jsonl", modified: new Date() },
		];
		const visible = deduplicateForkedSessions(sessions);
		expect(visible).toEqual(sessions);
	});
});
