/**
 * buildUpdateCommand 单测：单个包 / 多包 `;` 连接 / 空数组。
 */
import { describe, expect, it } from "vitest";
import { buildUpdateCommand } from "../../web/src/update-command.js";

describe("buildUpdateCommand", () => {
	it("single package", () => {
		expect(buildUpdateCommand(["foo"])).toBe("npm i -g foo@latest");
	});

	it("scoped package", () => {
		expect(buildUpdateCommand(["@scope/bar"])).toBe(
			"npm i -g @scope/bar@latest",
		);
	});

	it("chains multiple packages with `;`", () => {
		expect(
			buildUpdateCommand(["@earendil-works/pi-coding-agent", "foo", "pi-x"]),
		).toBe(
			"npm i -g @earendil-works/pi-coding-agent@latest; npm i -g foo@latest; npm i -g pi-x@latest",
		);
	});

	it("empty list → empty command", () => {
		expect(buildUpdateCommand([])).toBe("");
	});
});
