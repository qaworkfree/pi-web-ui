/**
 * Inline-marker display stripping — server (markers/marker.ts stripMarkers,
 * used by serialize.ts) and client (web/src/strip-markers.ts, used by
 * Message.tsx for the live stream). The two must agree on the token grammar.
 */
import { describe, expect, it } from "vitest";
import { stripMarkers } from "../../server/markers/marker.js";
import { stripVisibleMarkers, stripStreamingMarkers } from "../../web/src/strip-markers.js";

const TOOLS: ReadonlySet<string> = new Set(["todo", "notify", "conv"]);

describe("server stripMarkers", () => {
	it("removes executed markers inline", () => {
		expect(stripMarkers("done [[todo:set:1,completed]] next", TOOLS)).toBe("done  next");
	});
	it("drops lines that contained only markers", () => {
		const text = "Result below.\n[[todo:set:1,completed]]\n[[notify:info:All done. Reports generated.]]\nBye.";
		expect(stripMarkers(text, TOOLS)).toBe("Result below.\nBye.");
	});
	it("keeps unknown [[x:y:z]] tokens (not registered markers)", () => {
		expect(stripMarkers("see [[ref:page:12]] for details", TOOLS)).toBe("see [[ref:page:12]] for details");
	});
	it("keeps tokens whose body contains [[ (parser skips them too)", () => {
		const t = "[[notify:info:nested [[inner]] body]]";
		expect(stripMarkers(t, TOOLS)).toBe(t);
	});
	it("returns text without [[ unchanged (fast path)", () => {
		expect(stripMarkers("plain text", TOOLS)).toBe("plain text");
	});
});

describe("client stripVisibleMarkers", () => {
	it("matches the server behavior on the user-reported shape", () => {
		const text = "[[todo:set:1,completed]]\n[[notify:info:Analysis complete. PnL confirmed: -3.88 USDT (PENGU).]]";
		expect(stripVisibleMarkers(text)).toBe("");
		expect(stripMarkers(text, TOOLS)).toBe("");
	});
	it("keeps non-marker text", () => {
		expect(stripVisibleMarkers("a [[custom:x:y]] b")).toBe("a [[custom:x:y]] b");
	});
});

describe("client stripStreamingMarkers", () => {
	it("hides an unterminated marker fragment at the end", () => {
		expect(stripStreamingMarkers("working…\n[[notify:info:Reports being gen")).toBe("working…\n");
		expect(stripStreamingMarkers("working… [[")).toBe("working…");
		expect(stripStreamingMarkers("working… [[tod")).toBe("working…");
	});
	it("leaves non-marker trailing [[ text alone", () => {
		expect(stripStreamingMarkers("math [[example:foo")).toBe("math [[example:foo");
	});
	it("still strips complete markers", () => {
		expect(stripStreamingMarkers("done [[todo:set:2,completed]]")).toBe("done ");
	});
});
