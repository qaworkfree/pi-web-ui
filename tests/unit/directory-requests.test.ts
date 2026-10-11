// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAppSend } from "../../web/src/app-globals.js";
import {
	requestDirectory,
	receiveDirectoryReply,
	disconnectDirectoryRequests,
} from "../../web/src/directory-requests.js";
import type { ClientMessage } from "../../server/protocol.js";

afterEach(() => {
	disconnectDirectoryRequests();
	setAppSend(null);
	vi.useRealTimers();
});
describe("directory request correlation", () => {
	it("does not confuse composer completions or out-of-order picker responses", async () => {
		const sent: ClientMessage[] = [];
		setAppSend((message) => {
			sent.push(message);
			return true;
		});
		const first = requestDirectory({ type: "complete_path", path: "C:/first/" });
		const second = requestDirectory({ type: "complete_path", path: "C:/second/" });
		const id = (index: number) => (sent[index] as Extract<ClientMessage, { type: "complete_path" }>).requestId!;
		receiveDirectoryReply({
			type: "path_completions",
			completions: [{ name: "composer", path: "file.txt", type: "file" }],
		});
		receiveDirectoryReply({
			type: "path_completions",
			requestId: id(1),
			completions: [{ name: "second", path: "C:/second/folder", type: "dir" }],
		});
		expect((await second).type).toBe("path_completions");
		receiveDirectoryReply({ type: "path_completions", requestId: id(0), completions: [] });
		expect(await first).toMatchObject({ requestId: id(0), completions: [] });
	});
	it("rejects failed changes and permits a retry", async () => {
		setAppSend((message) => {
			if (message.type === "set_cwd")
				receiveDirectoryReply({
					type: "directory_result",
					requestId: message.requestId!,
					error: "Directory does not exist",
				});
			return true;
		});
		await expect(requestDirectory({ type: "set_cwd", path: "C:/missing" })).rejects.toThrow("does not exist");
		setAppSend((message) => {
			if (message.type === "set_cwd")
				receiveDirectoryReply({ type: "directory_result", requestId: message.requestId!, path: message.path });
			return true;
		});
		expect(await requestDirectory({ type: "set_cwd", path: "C:/valid" })).toMatchObject({ path: "C:/valid" });
	});
	it("clears operations on disconnect, cancellation and timeout", async () => {
		vi.useFakeTimers();
		setAppSend(() => true);
		const disconnected = expect(requestDirectory({ type: "set_cwd", path: "C:/folder" })).rejects.toThrow(
			"Connection lost",
		);
		disconnectDirectoryRequests();
		await disconnected;
		const controller = new AbortController();
		const cancelled = expect(
			requestDirectory({ type: "complete_path", path: "C:/" }, controller.signal),
		).rejects.toThrow("cancelled");
		controller.abort();
		await cancelled;
		const timedOut = expect(requestDirectory({ type: "make_dir", path: "C:/new" })).rejects.toThrow("timed out");
		await vi.advanceTimersByTimeAsync(60_000);
		await timedOut;
		expect(vi.getTimerCount()).toBe(0);
	});
	it("reports a closed socket immediately", async () => {
		setAppSend(() => false);
		await expect(requestDirectory({ type: "make_dir", path: "C:/new" })).rejects.toThrow("Not connected");
	});
});
