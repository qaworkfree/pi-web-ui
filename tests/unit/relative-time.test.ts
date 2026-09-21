import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "../../web/src/relative-time.js";

describe("formatRelativeTime", () => {
	const NOW = 1_000_000_000_000;

	it("1 分钟内 → 刚刚 / just now", () => {
		expect(formatRelativeTime(NOW - 30_000, NOW, "zh")).toBe("刚刚");
		expect(formatRelativeTime(NOW - 30_000, NOW, "en")).toBe("just now");
		expect(formatRelativeTime(NOW, NOW, "zh")).toBe("刚刚");
	});

	it("1 小时内 → N 分钟前", () => {
		expect(formatRelativeTime(NOW - 5 * 60_000, NOW, "zh")).toBe("5 分钟前");
		expect(formatRelativeTime(NOW - 5 * 60_000, NOW, "en")).toBe("5m ago");
		expect(formatRelativeTime(NOW - 59 * 60_000, NOW, "zh")).toBe("59 分钟前");
	});

	it("24 小时内 → N 小时前", () => {
		expect(formatRelativeTime(NOW - 3 * 3_600_000, NOW, "zh")).toBe("3 小时前");
		expect(formatRelativeTime(NOW - 3 * 3_600_000, NOW, "en")).toBe("3h ago");
		expect(formatRelativeTime(NOW - 23 * 3_600_000, NOW, "zh")).toBe("23 小时前");
	});

	it("超过 24 小时 → N 天前", () => {
		expect(formatRelativeTime(NOW - 2 * 86_400_000, NOW, "zh")).toBe("2 天前");
		expect(formatRelativeTime(NOW - 2 * 86_400_000, NOW, "en")).toBe("2d ago");
	});

	it("未来时间戳钳制为 0 → 刚刚", () => {
		expect(formatRelativeTime(NOW + 60_000, NOW, "zh")).toBe("刚刚");
		expect(formatRelativeTime(NOW + 60_000, NOW, "en")).toBe("just now");
	});
});
