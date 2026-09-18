import { beforeEach, describe, expect, it } from "vitest";
import {
	UNKNOWN_WS_WARN_INTERVAL_MS,
	recordUnknownWsType,
	resetUnknownWsTypes,
	unknownWsCounts,
} from "../../server/ws-unknown-types.js";

beforeEach(() => {
	resetUnknownWsTypes();
});

describe("recordUnknownWsType", () => {
	it("首次 warn 并从 1 开始计数", () => {
		expect(recordUnknownWsType("bogus_type_xyz", 0)).toEqual({ count: 1, warn: true });
	});

	it("同 type 一分钟内只 warn 一次，但计数照加", () => {
		recordUnknownWsType("bogus_type_xyz", 0);
		expect(recordUnknownWsType("bogus_type_xyz", 1_000)).toEqual({ count: 2, warn: false });
		expect(recordUnknownWsType("bogus_type_xyz", UNKNOWN_WS_WARN_INTERVAL_MS)).toEqual({
			count: 3,
			warn: true,
		});
	});

	it("不同 type 各自计数、各自节流", () => {
		recordUnknownWsType("aaa", 0);
		expect(recordUnknownWsType("bbb", 0)).toEqual({ count: 1, warn: true });
		expect(unknownWsCounts().get("aaa")).toBe(1);
		expect(unknownWsCounts().get("bbb")).toBe(1);
	});
});
