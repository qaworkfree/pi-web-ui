import { afterEach, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";

afterEach(() => vi.unstubAllEnvs());

it("does not reopen or prompt interrupted work when automatic resume is disabled", async () => {
	vi.stubEnv("PI_WEB_AUTO_RESUME", "0");
	const fake = {
		emit: vi.fn(),
		switchSession: vi.fn(),
		promptResumedConversation: vi.fn(),
		getLang: vi.fn(),
	};
	await ClientSession.prototype.resumeInterrupted.call(fake as unknown as ClientSession, [
		{ title: "Interrupted work", cwd: "/project", at: 1, sessionFile: "/saved.jsonl" },
		{ title: "Unsaved work", cwd: "/project", at: 1 },
	]);
	expect(fake.switchSession).not.toHaveBeenCalled();
	expect(fake.promptResumedConversation).not.toHaveBeenCalled();
	expect(fake.emit).not.toHaveBeenCalled();
	expect(fake.getLang).not.toHaveBeenCalled();
});

it("retains automatic resume for deployments that explicitly enable it", async () => {
	vi.stubEnv("PI_WEB_AUTO_RESUME", "1");
	const fake = {
		emit: vi.fn(),
		switchSession: vi.fn(async () => {}),
		promptResumedConversation: vi.fn(async () => {}),
		getLang: () => "en",
	};
	await ClientSession.prototype.resumeInterrupted.call(fake as unknown as ClientSession, [
		{ title: "Interrupted work", cwd: "/project", at: 1, sessionFile: "/saved.jsonl" },
	]);
	expect(fake.switchSession).toHaveBeenCalledWith("/saved.jsonl");
	expect(fake.promptResumedConversation).toHaveBeenCalledWith("/saved.jsonl", "Continue");
});
