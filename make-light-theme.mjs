#!/usr/bin/env node
/**
 * Regenerates themes/light.css — a complete standalone light theme derived from
 * web/src/styles.css (the bundled dark theme).
 *
 * Theming in pi-web-ui works by swapping the WHOLE stylesheet: each theme file
 * is a full copy of styles.css with a different palette (no variable
 * extraction). The backend serves any CSS dropped into <pkg>/themes or
 * <dataDir>/themes; the frontend injects a <link> for the chosen one.
 *
 * This script is the generator for the built-in light theme: it re-reads
 * styles.css, replaces the :root palette and the handful of hardcoded dark
 * colors, and writes themes/light.css. Run it whenever styles.css changes:
 *
 *   node make-light-theme.mjs
 *
 * The terminal keeps its dark look (#0b0d12) in the light theme because the
 * xterm canvas itself is themed dark in TermXterm.tsx (TERM_THEME) — the
 * container background must keep blending with it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = join(here, "web", "src", "styles.css");
const outPath = join(here, "themes", "light.css");

const css = readFileSync(srcPath, "utf8")
	// styles.css may carry CRLF line endings (Windows editors); normalize so
	// every \n-based match below works regardless of checkout/editor settings.
	.replace(/\r\n/g, "\n");

// --- 1) :root palette block -------------------------------------------------
const lightRoot = `:root {
	color-scheme: light;
	--bg: #f5f6fa;
	--bg-elev: #ffffff;
	--bg-elev2: #eceef4;
	--border: #d3d7e0;
	--border-soft: #e2e5ee;
	--text: #1c2030;
	--text-dim: #4d5568;
	--text-faint: #7c8494;
	--accent: #7c3aed;
	--accent-soft: rgba(124, 58, 237, 0.12);
	--green: #059669;
	--green-soft: rgba(5, 150, 105, 0.12);
	--red: #dc2626;
	--red-soft: rgba(220, 38, 38, 0.1);
	--amber: #d97706;
	/* Terminal ANSI palette — light: canvas + padded area both light. */
	--term-bg: #f5f6fa;
	--term-fg: #1c2030;
	--term-cursor: #7c3aed;
	--term-cursor-accent: #f5f6fa;
	--term-selection: rgba(124, 58, 237, 0.3);
	--term-black: #e8eaf0;
	--term-red: #dc2626;
	--term-green: #059669;
	--term-yellow: #d97706;
	--term-blue: #2563eb;
	--term-magenta: #9333ea;
	--term-cyan: #0e7490;
	--term-white: #1c2030;
	--term-bright-black: #8a91a3;
	--term-bright-red: #dc2626;
	--term-bright-green: #059669;
	--term-bright-yellow: #d97706;
	--term-bright-blue: #2563eb;
	--term-bright-magenta: #9333ea;
	--term-bright-cyan: #0e7490;
	--term-bright-white: #000000;
	--mono: "SF Mono", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace;
	--sans:
		-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
		"Hiragino Sans GB", "Microsoft YaHei", Roboto, Helvetica, Arial, sans-serif;
}`;

// Match the existing :root { ... } block (lines 1..23 area).
const rootRe = /:root \{\n(?:[^\n]*\n)*?\}/;
const withLightRoot = css.replace(rootRe, lightRoot);
if (!withLightRoot.includes("color-scheme: light")) {
	throw new Error("make-light-theme: :root replacement did not apply (line-ending or format drift in styles.css?)");
}

// --- 2) hardcoded color mappings --------------------------------------------
// Simple exact hex / rgba → replacement table. Order matters (longer/earlier
// specific strings first). Applied globally to whatever remains after :root.
const colorMap = [
	// code-block text (dark gray → dark gray works on light)
	["color: #c9d1d9;", "color: #1f2937;"],
	// bash error text
	["color: #f0a5a5;", "color: #dc2626;"],
	// generic red texts
	["color: #fca5a5;", "color: #dc2626;"],
	["color: #f87171;", "color: #dc2626;"],
	// warning/amber texts + dir icon
	["color: #fcd34d;", "color: #b45309;"],
	["color: #fbbf24;", "color: #d97706;"],
	// info blue
	["color: #60a5fa;", "color: #2563eb;"],
	// links / markdown purple family
	["color: #a78bfa;", "color: #7c3aed;"],
	["color: #c4b5fd;", "color: #6d28d9;"],
	["color: #ddd6fe;", "color: #7c3aed;"],
	["color: #f3f4f6;", "color: #111827;"],
	// skill tag blue
	["color: #5eb3ff;", "color: #2563eb;"],
	["color-mix(in srgb, #5eb3ff 45%, transparent)", "color-mix(in srgb, #2563eb 45%, transparent)"],
	// auth badge green
	["color: #6ee7a0;", "color: #059669;"],
	// tooltips
	["background: #232733;", "background: #ffffff;"],
	["border-top-color: #232733;", "border-top-color: #ffffff;"],
	// scrollbars
	["background: #2a2f3d;", "background: #c7ccd8;"],
	["background: #3a4152;", "background: #aab2c0;"],
	// modal backdrop (keep near-black overlay)
	// notice backgrounds (dark solid → light solid, same tint over --bg-elev2)
	["background: #401d23;", "background: #eadadf;"],
	["background: #38251f;", "background: #eae2dc;"],
	["background: #1b2544;", "background: #d8e0f3;"],
	// white glows on dark surfaces → soft black glows on light surfaces
	["var(--bg-elev3, rgba(255, 255, 255, 0.06))", "var(--bg-elev3, rgba(0, 0, 0, 0.03))"],
	["background: rgba(255, 255, 255, 0.015);", "background: rgba(0, 0, 0, 0.02);"],
	["background: rgba(255, 255, 255, 0.025);", "background: rgba(0, 0, 0, 0.02);"],
	["background: rgba(255, 255, 255, 0.12);", "background: rgba(0, 0, 0, 0.08);"],
	["background: rgba(255, 255, 255, 0.18);", "background: rgba(0, 0, 0, 0.12);"],
	["background: rgba(255, 255, 255, 0.38);", "background: rgba(0, 0, 0, 0.25);"],
	["background: rgba(255, 255, 255, 0.22);", "background: rgba(0, 0, 0, 0.15);"],
	// card inner top highlight: subtle white stays, just strengthen for light bg
	["inset 0 1px 0 rgba(255, 255, 255, 0.04)", "inset 0 1px 0 rgba(255, 255, 255, 0.7)"],
];

let light = withLightRoot;
for (const [from, to] of colorMap) {
	light = light.split(from).join(to);
}

// --- 3) code-block / chat output surfaces → light ---------------------------
// The terminal panel (xterm canvas + padded .term-main) now follows the theme
// via the --term-* variables set in :root above — no hardcoded remap needed.
// Only lift the chat-side rendered code surfaces (termline bash command chip,
// codeblock pre, toolcall-output pre, bashblock).
light = light
	.split(".termline {\n\tdisplay: flex;\n\talign-items: center;\n\tgap: 8px;\n\tbackground: #0b0d12;")
	.join(".termline {\n\tdisplay: flex;\n\talign-items: center;\n\tgap: 8px;\n\tbackground: #f6f8fa;")
	.split(".codeblock pre {\n\tbackground: #0b0d12 !important;")
	.join(".codeblock pre {\n\tbackground: #f6f8fa !important;")
	.split(".toolcall-output pre {\n\tmargin: 0;\n\tmax-height: 320px;\n\toverflow: auto;\n\tbackground: #0b0d12;")
	.join(".toolcall-output pre {\n\tmargin: 0;\n\tmax-height: 320px;\n\toverflow: auto;\n\tbackground: #f6f8fa;")
	.split(".bashblock {\n\tmargin: 8px 0;\n\tborder: 1px solid var(--border);\n\tborder-radius: 8px;\n\tbackground: #0b0d12;")
	.join(".bashblock {\n\tmargin: 8px 0;\n\tborder: 1px solid var(--border);\n\tborder-radius: 8px;\n\tbackground: #f6f8fa;");

// --- 4) syntax highlighting (hljs) ------------------------------------------
// highlight.js/styles/github-dark.css is imported statically by the bundle; on
// the light theme its token colors are illegible on the light code surface, so
// override the whole .hljs palette with a GitHub-light-inspired set.
const hljsLight = `
/* ---- syntax highlighting (overrides static github-dark import) ---- */
.hljs {
	color: #1f2328;
	background: #f6f8fa;
}
.hljs-doctag,
.hljs-keyword,
.hljs-meta .hljs-keyword,
.hljs-template-tag,
.hljs-template-variable,
.hljs-type,
.hljs-variable.language_ {
	color: #cf222e;
}
.hljs-title,
.hljs-title.class_,
.hljs-title.class_.inherited__,
.hljs-title.function_ {
	color: #8250df;
}
.hljs-attr,
.hljs-attribute,
.hljs-literal,
.hljs-meta,
.hljs-number,
.hljs-operator,
.hljs-variable,
.hljs-selector-attr,
.hljs-selector-class,
.hljs-selector-id {
	color: #0550ae;
}
.hljs-regexp,
.hljs-string,
.hljs-meta .hljs-string {
	color: #0a3069;
}
.hljs-built_in,
.hljs-symbol {
	color: #953800;
}
.hljs-comment,
.hljs-code,
.hljs-formula {
	color: #6e7781;
}
.hljs-name,
.hljs-quote,
.hljs-selector-tag,
.hljs-selector-pseudo {
	color: #116329;
}
.hljs-subst {
	color: #24292f;
}
.hljs-section {
	color: #0550ae;
	font-weight: 700;
}
.hljs-bullet {
	color: #0550ae;
}
.hljs-emphasis {
	color: #24292f;
	font-style: italic;
}
.hljs-strong {
	color: #24292f;
	font-weight: 700;
}
.hljs-addition {
	color: #116329;
	background: #dafbe1;
}
.hljs-deletion {
	color: #82071e;
	background: #ffebe9;
}
`;

// Guard: key light mappings must have landed; a miss means styles.css drifted
// from these snippets and the generated theme would silently stay dark there.
for (const marker of ["color-scheme: light", "--term-bg: #f5f6fa", "background: #f6f8fa !important"]) {
	if (!light.includes(marker)) {
		throw new Error(`make-light-theme: expected light mapping missing (${marker})`);
	}
}

writeFileSync(outPath, light + hljsLight, "utf8");