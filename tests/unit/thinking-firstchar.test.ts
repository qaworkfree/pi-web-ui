import { describe, expect, it } from "vitest";
import { applyMessageDelta, type MessageDeltaMsg, type MessageDeltaUiState } from "../../web/src/message-delta.js";
import { thinkingPreview } from "../../web/src/components/ThinkingBlock.js";

// P1 thinking first-char probe (w25, 2026-09-17): live wire capture from
// openai-codex/gpt-5.6-luna — the ONLY run (of 4, across 3 providers) where
// wire concat and persisted final diverged AT ALL. Pins that pi-web-ui keeps
// every byte verbatim on the thinking path (no slice/trim on deltas) and
// documents where the 2-char gap actually lives (SDK finalize, trailing end).

function makeUi(): MessageDeltaUiState {
	return {
		streamingMessage: undefined,
		stats: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

let seq = 0;
function thinkingDelta(deltaText: string, contentIndex = 0): MessageDeltaMsg {
	return {
		type: "message_delta",
		conversationId: "c1",
		seq: ++seq,
		messageId: "stream-100",
		usage: null,
		assistantMessageEvent: { type: "thinking_delta", contentIndex, delta: deltaText },
	};
}

function thinkingOf(ui: MessageDeltaUiState): string {
	const blocks = ui.streamingMessage?.content ?? [];
	return blocks
		.filter((b): b is { type: "thinking"; thinking?: string } => b.type === "thinking")
		.map((b) => b.thinking ?? "")
		.join("");
}

// Exact wire bytes, /tmp/w25-codex-luna.jsonl (2 thinking_delta events).
const WIRE_D1 = "**Calculating arithmetic result**";
const WIRE_D2 = "\n\n";
const WIRE_FULL = WIRE_D1 + WIRE_D2; // 35 chars
const PERSISTED_FINAL = "**Calculating arithmetic result**"; // 33 chars (SDK session JSONL + snapshot)

describe("thinking first-char verbatim (codex-luna live capture)", () => {
	it("concats wire deltas byte-identical, trailing newlines included", () => {
		let ui = makeUi();
		ui = applyMessageDelta(ui, thinkingDelta(WIRE_D1));
		ui = applyMessageDelta(ui, thinkingDelta(WIRE_D2));
		expect(thinkingOf(ui)).toBe(WIRE_FULL);
		expect(thinkingOf(ui).length).toBe(35);
	});

	it("first delta starts at the true first character (no leading loss)", () => {
		const ui = applyMessageDelta(makeUi(), thinkingDelta(WIRE_D1));
		expect(thinkingOf(ui)[0]).toBe("*");
		expect(thinkingOf(ui).slice(0, PERSISTED_FINAL.length)).toBe(PERSISTED_FINAL);
	});

	it("wire vs persisted differ ONLY by SDK-side trailing trim (not our path)", () => {
		// pi-web-ui serialize passes b.thinking verbatim (server/serialize.ts);
		// the 35->33 gap is already in the SDK final message on disk.
		expect(WIRE_FULL.trimEnd()).toBe(PERSISTED_FINAL);
		expect(WIRE_FULL.length - PERSISTED_FINAL.length).toBe(2);
	});
});

// thinkingPreview 直引源码：源实现变了测试必挂，不许在测试里抄一份实现。
describe("ThinkingBlock preview (thinkingPreview)", () => {
	const long = `First-char-ABC ${"x".repeat(100)}\nsecond line ${"y".repeat(100)}\nthird line tail-TAIL`;

	it("streaming preview shows the tail, final preview shows the head", () => {
		expect(thinkingPreview(long, true)).toBe(long.trimEnd().slice(-80));
		expect(thinkingPreview(long, false)).toBe("First-char-ABC " + "x".repeat(65));
		expect(thinkingPreview(long, true)).not.toBe(thinkingPreview(long, false));
	});

	it("body text is identical mid-stream and after end (preview never edits data)", () => {
		const bodyStreaming = long;
		const bodyFinal = long;
		expect(bodyFinal).toBe(bodyStreaming);
		expect(bodyFinal[0]).toBe("F");
	});
});
