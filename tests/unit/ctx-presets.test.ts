/** Composer context chip presets (local llama.cpp models). */
import { describe, expect, it } from "vitest";
import { buildContextOptions, formatCtx } from "../../web/src/ctx-presets.js";

describe("buildContextOptions", () => {
	it("bounds presets by the GGUF limit and includes the limit itself", () => {
		const opts = buildContextOptions(40960, 32768);
		expect(opts.map((o) => o.value)).toEqual([4096, 8192, 16384, 32768, 40960]);
		expect(opts.at(-1)).toEqual({ value: 40960, isLimit: true });
	});
	it("keeps the saved current value even when it is not a preset", () => {
		const opts = buildContextOptions(262144, 200000);
		expect(opts.map((o) => o.value)).toContain(200000);
		expect(opts.at(-1)?.value).toBe(262144);
	});
	it("small limits collapse to just the limit", () => {
		expect(buildContextOptions(4096, 4096)).toEqual([{ value: 4096, isLimit: true }]);
	});
	it("ignores an out-of-range current value", () => {
		const opts = buildContextOptions(32768, 999999);
		expect(opts.map((o) => o.value)).toEqual([4096, 8192, 16384, 32768]);
	});
});

describe("formatCtx", () => {
	it("renders powers of 1024 as K", () => {
		expect(formatCtx(4096)).toBe("4K");
		expect(formatCtx(32768)).toBe("32K");
		expect(formatCtx(262144)).toBe("256K");
	});
	it("renders other large values as decimal k", () => {
		expect(formatCtx(200000)).toBe("200k");
		expect(formatCtx(40960)).toBe("40K");
	});
});
