const net = require("node:net");
const [port, cmd] = process.argv.slice(2);
if (!/^\d+$/.test(port) || !["status", "quiesce", "unquiesce"].includes(cmd)) {
	console.error("Invalid local UI control request.");
	process.exit(1);
}
const socket = net.createConnection(`\\\\.\\pipe\\pi-web-ui-${port}`);
let buffer = "";
const timer = setTimeout(() => {
	console.error("Local UI control request timed out.");
	socket.destroy();
	process.exitCode = 1;
}, 3000);
socket.once("connect", () => socket.write(JSON.stringify({ cmd }) + "\n"));
socket.on("data", (chunk) => {
	buffer += chunk.toString("utf8");
	if (!buffer.includes("\n")) return;
	clearTimeout(timer);
	try {
		const response = JSON.parse(buffer.split("\n")[0]);
		if (!response.ok) throw new Error(response.error || "UI control failed.");
		console.log(JSON.stringify(response));
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
	socket.destroy();
});
socket.once("error", (error) => {
	clearTimeout(timer);
	console.error(error.message);
	process.exitCode = 1;
});
socket.once("close", () => clearTimeout(timer));
