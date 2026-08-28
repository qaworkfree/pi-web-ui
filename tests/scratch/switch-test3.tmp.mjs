import WebSocket from "ws";
const ws = new WebSocket("ws://localhost:8787/ws");
const t = setTimeout(() => {
	console.error("TIMEOUT");
	process.exit(1);
}, 30000);
let phase = 0;
ws.on("open", () =>
	ws.send(JSON.stringify({ type: "hello", clientId: "srv-test" })),
);
ws.on("message", (d) => {
	const m = JSON.parse(d.toString());
	if (m.type === "ready")
		ws.send(JSON.stringify({ type: "prompt", text: "Reply with exactly: ok" }));
	else if (m.type === "snapshot") {
		const last = m.state.messages[m.state.messages.length - 1];
		if (phase === 0 && last?.role === "assistant" && last.stopReason) {
			phase = 1;
			ws.send(JSON.stringify({ type: "list_sessions" }));
		}
	} else if (m.type === "sessions" && phase === 1) {
		phase = 2;
		console.log("sent switch at", Date.now());
		ws.send(
			JSON.stringify({ type: "switch_session", path: m.sessions[0].path }),
		);
	} else if (
		m.type === "snapshot" &&
		phase === 2 &&
		m.state.messages.length === 2
	) {
		console.log("SWITCH OK");
		clearTimeout(t);
		process.exit(0);
	} else if (m.type === "notice") console.log("notice:", m.level, m.text);
});
