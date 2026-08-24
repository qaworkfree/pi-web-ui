import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Dev: Vite serves the web UI on :5173 and proxies the WebSocket + any API
// traffic to the backend server (which runs separately via `npm run dev:server`).
// The dev backend is pinned to :8788 (see the dev:server script) so it never
// collides with a globally-installed pi-web-ui running on the default :8787.
export default defineConfig({
	root: __dirname,
	plugins: [react()],
	build: {
		outDir: join(__dirname, "dist"),
		emptyOutDir: true,
		rollupOptions: {
			output: {
				// 手动分包：大体积第三方库拆出主 chunk，利于浏览器缓存——
				// 业务代码变动时不让用户重新下载 xterm / markdown 渲染器
				manualChunks: {
					react: ["react", "react-dom"],
					markdown: ["react-markdown", "remark-gfm", "rehype-highlight", "highlight.js"],
					xterm: ["@xterm/xterm", "@xterm/addon-fit"],
				},
			},
		},
	},
	server: {
		port: 5173,
		proxy: {
			"/api": "http://localhost:8788",
			"/themes": "http://localhost:8788",
			"/plugins": "http://localhost:8788",
			"/ws": {
				target: "ws://localhost:8788",
				ws: true,
				// Don't leak sockets when the backend is down/restarting (avoids
				// ERR_INSUFFICIENT_RESOURCES from accumulated dead proxy sockets).
				configure(proxy) {
					proxy.on("error", (_err, _req, socket) => {
						(socket as { destroy?: () => void } | undefined)?.destroy?.();
					});
					proxy.on("proxyReqWs", (_proxyReq, _req, socket) => {
						socket.on("error", () => {});
					});
				},
			},
		},
	},
});
