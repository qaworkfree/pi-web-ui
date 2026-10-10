import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readWebBuildId } from "../../server/web-build-id.js";

const roots: string[] = [];
function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-web-build-id-"));
	roots.push(root);
	writeFileSync(join(root, "index.html"), '<script src="/assets/index-differentHash.js"></script>');
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("reports the frontend identifier instead of the unrelated asset hash", () => {
	const root = fixture();
	writeFileSync(join(root, "build-id.json"), JSON.stringify({ id: "frontend-build-123" }));
	expect(readWebBuildId(root)).toBe("frontend-build-123");
});

it("does not invent a mismatched identifier for an older build", () => {
	expect(readWebBuildId(fixture())).toBe("");
});

it.each(["{", "null", "[]", '{"id":12}', JSON.stringify({ id: "x".repeat(257) })])(
	"ignores invalid build metadata %s",
	(content) => {
		const root = fixture();
		writeFileSync(join(root, "build-id.json"), content);
		expect(readWebBuildId(root)).toBe("");
	},
);
