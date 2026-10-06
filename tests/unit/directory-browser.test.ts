import { describe, expect, it } from "vitest";
import {
	isValidProjectName,
	joinProjectPath,
	MACHINE_ROOT,
	parentOf,
	browseQuery,
	directoryBreadcrumbs,
	normalizeBrowsePath,
} from "../../web/src/components/DirectoryBrowser.js";

describe("DirectoryBrowser utils", () => {
	it("normalizes Windows separators and preserves spaces and drive roots", () => {
		expect(normalizeBrowsePath(" C:\\Users\\LUIZ\\Pictures\\Llama etc\\ ")).toBe("C:/Users/LUIZ/Pictures/Llama etc");
		expect(browseQuery("C:\\")).toBe("C:/");
		expect(parentOf("C:\\Users\\LUIZ")).toBe("C:/Users");
	});
	it("builds absolute Windows, UNC and POSIX breadcrumb paths", () => {
		expect(directoryBreadcrumbs("C:\\Users\\LUIZ\\Pictures\\Llama etc").at(-1)).toEqual({
			label: "Llama etc",
			path: "C:/Users/LUIZ/Pictures/Llama etc",
		});
		expect(directoryBreadcrumbs("/home/user")).toEqual([
			{ label: "/", path: "/" },
			{ label: "home", path: "/home" },
			{ label: "user", path: "/home/user" },
		]);
		expect(directoryBreadcrumbs("\\\\server\\share\\project")[0]).toEqual({
			label: "//server/share",
			path: "//server/share",
		});
		expect(parentOf("\\\\server\\share")).toBe(MACHINE_ROOT);
		expect(directoryBreadcrumbs(MACHINE_ROOT)).toEqual([]);
	});
	it("browseQuery: 确保路径以 / 结尾", () => {
		expect(browseQuery("/home/user")).toBe("/home/user/");
		expect(browseQuery("/home/user/")).toBe("/home/user/");
	});

	it("parentOf: 正常计算各种路径的父级", () => {
		expect(parentOf(MACHINE_ROOT)).toBeNull();
		expect(parentOf("/")).toBeNull();
		expect(parentOf("/home")).toBe("/");
		expect(parentOf("/home/user")).toBe("/home");
		expect(parentOf("C:")).toBe(MACHINE_ROOT);
		expect(parentOf("C:/")).toBe(MACHINE_ROOT);
		expect(parentOf("C:/Users")).toBe("C:/");
		expect(parentOf("C:/Users/name")).toBe("C:/Users");
	});

	it("joinProjectPath: 正确拼接子目录名", () => {
		expect(joinProjectPath("/home/user", "project1")).toBe("/home/user/project1");
		expect(joinProjectPath("/home/user/", "project1")).toBe("/home/user/project1");
		expect(joinProjectPath("C:", "project1")).toBe("C:/project1");
		expect(joinProjectPath("C:/", "project1")).toBe("C:/project1");
	});

	it("isValidProjectName: 校验项目名称合法性", () => {
		expect(isValidProjectName("")).toBe(false);
		expect(isValidProjectName("   ")).toBe(false);
		expect(isValidProjectName(".")).toBe(false);
		expect(isValidProjectName("..")).toBe(false);
		expect(isValidProjectName("foo/bar")).toBe(false);
		expect(isValidProjectName("foo\\bar")).toBe(false);
		expect(isValidProjectName("my-project")).toBe(true);
		expect(isValidProjectName("proj_1")).toBe(true);
	});
});
