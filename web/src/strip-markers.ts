/**
 * Display-side stripping of executed inline markers ([[todo:...]],
 * [[notify:...]], [[conv:rename:...]]) from assistant text.
 *
 * Final messages are already stripped server-side (server/serialize.ts, same
 * token grammar as server/markers/marker.ts — keep the two in sync). This
 * client copy exists for the live streaming path (message_delta), where raw
 * deltas bypass the serializer: without it, markers flash on screen while the
 * reply streams and only disappear when the final snapshot lands.
 */

/** Marker tools executed by the server (server/markers/index.ts builtins). */
const MARKER_TOOLS = new Set(["todo", "notify", "conv"]);

const TOKEN_RE = /\[\[\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*([A-Za-z][A-Za-z0-9_-]*)\s*:(.*?)\s*\]\]/g;

/**
 * Trailing fragment of a possible marker still being streamed, e.g. "[[",
 * "[[notify", "[[notify:info:Working…". Hidden until it closes; if it closes
 * into a non-marker token the full text is re-rendered untouched.
 */
const PARTIAL_TAIL_RE = /\[\[\s*(?:[A-Za-z][A-Za-z0-9_-]*\s*(?::\s*(?:[A-Za-z][A-Za-z0-9_-]*\s*(?::[^\]\n]*)?)?)?)?$/;

/** Remove complete marker tokens; drop lines that contained only markers. */
export function stripVisibleMarkers(text: string): string {
	if (!text || !text.includes("[[")) return text;
	const lines = text.split("\n");
	const out: string[] = [];
	for (const line of lines) {
		if (!line.includes("[[")) {
			out.push(line);
			continue;
		}
		TOKEN_RE.lastIndex = 0;
		const stripped = line.replace(TOKEN_RE, (raw, tool: string, _op: string, body: string) => {
			if (body.includes("[[")) return raw;
			return MARKER_TOOLS.has(tool) ? "" : raw;
		});
		if (stripped !== line && stripped.trim() === "") continue;
		out.push(stripped);
	}
	return out.join("\n");
}

/**
 * Streaming variant: also hides an unterminated marker fragment at the very
 * end of the buffer, so "[[notify:info:…" never flashes mid-stream.
 */
export function stripStreamingMarkers(text: string): string {
	const stripped = stripVisibleMarkers(text);
	const m = PARTIAL_TAIL_RE.exec(stripped);
	if (!m) return stripped;
	// Only hide the tail when it looks like one of our marker tools (or is too
	// short to tell yet); leave other "[[…" text alone.
	const frag = m[0];
	const name = /^\[\[\s*([A-Za-z][A-Za-z0-9_-]*)/.exec(frag)?.[1];
	if (name !== undefined && !isMarkerToolPrefix(name)) return stripped;
	return stripped.slice(0, m.index).replace(/[ \t]+$/, "");
}

function isMarkerToolPrefix(name: string): boolean {
	for (const tool of MARKER_TOOLS) {
		if (tool.startsWith(name) || name === tool) return true;
	}
	return false;
}
