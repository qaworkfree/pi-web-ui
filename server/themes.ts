/**
 * Theme management: complete standalone CSS files that replace the whole UI
 * stylesheet. Each theme is a full copy of web/src/styles.css with a different
 * palette — no variable extraction, the browser just swaps the entire file.
 *
 * Theme sources (merged, user wins over builtin on id collision):
 *   - builtin: <pkgRoot>/themes/*.css   (ships with the npm package)
 *   - user   : <dataDir>/themes/*.css   (drop a css file here to add a theme)
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ThemeInfo {
	id: string;
	name: string;
	builtin: boolean;
}

/** Only simple file ids — no path traversal. */
const ID_RE = /^[A-Za-z0-9_-]+$/;

export function listThemes(builtinDir: string, userDir: string): ThemeInfo[] {
	const scan = (dir: string, builtin: boolean): ThemeInfo[] => {
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((f) => f.endsWith(".css"))
			.filter((f) => ID_RE.test(f.slice(0, -4)))
			.sort()
			.map((f) => ({ id: f.slice(0, -4), name: f.slice(0, -4), builtin }));
	};
	const builtin = scan(builtinDir, true);
	const user = scan(userDir, false);
	const seen = new Set<string>();
	return [...builtin, ...user]
		.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve a theme id to its css file path (user dir first). */
export function resolveThemeFile(
	builtinDir: string,
	userDir: string,
	id: string,
): string | null {
	if (!ID_RE.test(id)) return null;
	const userPath = join(userDir, `${id}.css`);
	if (existsSync(userPath) && statSync(userPath).isFile()) return userPath;
	const builtinPath = join(builtinDir, `${id}.css`);
	if (existsSync(builtinPath) && statSync(builtinPath).isFile()) {
		return builtinPath;
	}
	return null;
}