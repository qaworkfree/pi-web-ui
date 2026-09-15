/**
 * voice-input 服务端入口 —— 语音输入插件的服务端一半。
 *
 * 客户端（client/entry.mjs）优先用浏览器原生语音识别（Web Speech API，免费、
 * 零配置）；只有浏览器不支持或识别失败、且用户开了「服务端转写降级」时，
 * 才把录音 POST 到这里的 `/transcribe`，由本文件转发给 OpenAI 兼容的
 * `/audio/transcriptions` 接口（Whisper）。
 *
 * 路由（挂载在 `/plugins-api/voice-input/*`，需 manifest `permissions` 含 `http`）：
 *   GET  /settings    → { lang, serverFallback, serverReady }（绝不下发密钥）
 *   POST /transcribe  → raw 音频字节（Content-Type 即录音 mime，?lang= 可选），
 *                        回 { text }；未配置转写接口时 501。
 *
 * 约定：handler 内部一切抛错自己转成 HTTP 状态码，绝不让 promise reject 出去——
 * 宿主只 try/catch 同步抛错，异步 rejection 会变成 unhandledRejection 把整个
 * 服务打挂（image-toolkit 踩过的坑）。
 */

const TRANSCRIBE_TIMEOUT_MS = 120_000;
/** Whisper 单文件上限 25MB；超了直接 413，不浪费一次转发。 */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function str(v) {
	return typeof v === "string" ? v.trim() : "";
}

/**
 * 插件语言（zh-CN / en-US …）→ Whisper 的 language 参数（ISO-639-1）。
 * 纯函数，单测覆盖。
 */
export function whisperLang(lang) {
	const l = str(lang).toLowerCase();
	if (l.startsWith("zh")) return "zh";
	if (l.startsWith("en")) return "en";
	if (l.startsWith("ja")) return "ja";
	if (l.startsWith("ko")) return "ko";
	if (l.startsWith("fr")) return "fr";
	if (l.startsWith("de")) return "de";
	if (l.startsWith("es")) return "es";
	if (l.startsWith("ru")) return "ru";
	if (l.startsWith("it")) return "it";
	if (l.startsWith("pt")) return "pt";
	return "";
}

/** 基址 + 路径拼接（容忍末尾斜杠）。纯函数，单测覆盖。 */
export function joinUrl(base, path) {
	return `${str(base).replace(/\/+$/, "")}${path}`;
}

export default {
	activate(host) {
		let cfg = host.getSettings?.() ?? {};
		const offSettings = host.onSettingsChanged?.((v) => {
			cfg = v && typeof v === "object" ? v : {};
		});

		const safe = (method, path, handler) =>
			host.route(method, path, async (req, res) => {
				try {
					await handler(req, res);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					host.log(`voice-input ${method} ${path} 失败:`, err);
					if (!res.headersSent) res.status(500).json({ error: msg || "internal error" });
					else res.end();
				}
			});

		const serverReady = () => Boolean(str(cfg.transcribeUrl) && str(cfg.transcribeKey));

		/** 客户端读公开配置（密钥永不下发）。 */
		const offGet = safe("GET", "/settings", async (_req, res) => {
			res.json({
				lang: str(cfg.lang) || "zh-CN",
				serverFallback: cfg.serverFallback !== false,
				serverReady: serverReady(),
			});
		});

		/** 读原始请求体（JSON 小包或二进制大包，抄 image-toolkit 的 readBody）。 */
		async function readRaw(req) {
			const b = req.body;
			if (b && typeof b === "object" && typeof b.dataBase64 === "string") {
				return Buffer.from(b.dataBase64, "base64");
			}
			if (Buffer.isBuffer(b)) return b;
			const chunks = [];
			for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
			return Buffer.concat(chunks);
		}

		/** 录音 → OpenAI 兼容转写接口 → { text }。 */
		const offPost = safe("POST", "/transcribe", async (req, res) => {
			const baseUrl = str(cfg.transcribeUrl);
			const apiKey = str(cfg.transcribeKey);
			if (!baseUrl || !apiKey) {
				res.status(501).json({
					error: "服务端转写未配置：请在设置面板 → 界面插件 → 语音输入里填写「转写接口基址」与「密钥」",
				});
				return;
			}
			const audio = await readRaw(req);
			if (!audio.length) {
				res.status(400).json({ error: "请求体为空（没有收到录音）" });
				return;
			}
			if (audio.length > MAX_AUDIO_BYTES) {
				res.status(413).json({ error: `录音过大（${(audio.length / 1048576).toFixed(1)}MB > 25MB），请分段录制` });
				return;
			}
			const mime = str(req.headers?.["content-type"]).split(";")[0] || "audio/webm";
			const ext =
				mime.includes("mp4") || mime.includes("m4a")
					? "m4a"
					: mime.includes("ogg")
						? "ogg"
						: mime.includes("wav")
							? "wav"
							: "webm";
			const lang = whisperLang(str(req.query?.lang) || str(cfg.lang));
			const form = new FormData();
			form.set("file", new Blob([audio], { type: mime }), `voice.${ext}`);
			form.set("model", str(cfg.transcribeModel) || "whisper-1");
			if (lang) form.set("language", lang);
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), TRANSCRIBE_TIMEOUT_MS);
			let r;
			try {
				r = await fetch(joinUrl(baseUrl, "/audio/transcriptions"), {
					method: "POST",
					headers: { Authorization: `Bearer ${apiKey}` },
					body: form,
					signal: ctrl.signal,
				});
			} catch (err) {
				res.status(502).json({
					error: err?.name === "AbortError" ? "转写超时（120s），请分段录制" : `转写接口 unreachable：${err.message}`,
				});
				return;
			} finally {
				clearTimeout(timer);
			}
			if (!r.ok) {
				const body = (await r.text().catch(() => "")).slice(0, 500);
				res.status(502).json({ error: `转写接口报错 ${r.status}：${body || r.statusText}` });
				return;
			}
			const data = await r.json().catch(() => ({}));
			res.json({ text: str(data?.text) });
		});

		host.log("voice-input activated");
		return () => {
			try {
				offGet();
			} catch {
				/* ignore */
			}
			try {
				offPost();
			} catch {
				/* ignore */
			}
			try {
				offSettings?.();
			} catch {
				/* ignore */
			}
			host.log("voice-input deactivated");
		};
	},
};
