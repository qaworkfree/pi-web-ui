/**
 * voice-input 服务端入口 —— 语音输入插件的服务端一半。
 *
 * 两条转写引擎（`engine` 设置，默认 auto）：
 *   local  本地 Whisper（transformers.js + ONNX，CPU 跑，零 key）：
 *          点「一键安装」后经 host.ensureDeps 装运行时、下载模型到本插件目录
 *          （<dataDir>/plugins/voice-input/whisper-cache），转写全程不出本机；
 *   remote 远端 OpenAI 兼容接口（POST {base}/audio/transcriptions）。
 *   auto   本地装好了用本地，否则用远端（配了才可用）。
 *
 * 客户端录音统一发 16kHz 单声道 16-bit WAV（AudioWorklet 现场编码，
 * 无需服务端装 ffmpeg）；远端接口同时兼容其它音频 mime。
 *
 * 路由（挂载在 `/plugins-api/voice-input/*`，需 manifest `permissions` 含 `http`）：
 *   GET    /settings      → { lang, serverFallback, engine, localModel,
 *                             serverReady, localReady, localModels }（绝不下发密钥）
 *   POST   /transcribe    → 音频字节（WAV 最佳，?lang= 可选），回 { text, engine }
 *   GET    /local-status  → { installing, progress, error, ready, models, loaded }
 *   POST   /local-install → {started:true}（body {model?}；单飞，后台慢慢装）
 *   DELETE /local         → 删模型缓存（node_modules 留着，重装快）
 *
 * 约定：handler 内部一切抛错自己转成 HTTP 状态码，绝不让 promise reject 出去——
 * 宿主只 try/catch 同步抛错，异步 rejection 会变成 unhandledRejection 把整个
 * 服务打挂（image-toolkit 踩过的坑）。
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REMOTE_TRANSCRIBE_TIMEOUT_MS = 120_000;
/** 远端 Whisper 单文件上限 25MB；超了直接 413，不浪费一次转发。 */
const MAX_REMOTE_AUDIO_BYTES = 25 * 1024 * 1024;
/** 本地 WAV 上限 15MB（16k 单声道 ≈ 8 分钟，足够口述）。 */
const MAX_LOCAL_AUDIO_BYTES = 15 * 1024 * 1024;
/** transformers.js 运行时（ONNX 预编译，win/mac/linux 全平台，CPU 可跑）。 */
const TRANSFORMERS_SPEC = "@xenova/transformers@2.17.2";

/**
 * 本地模型档位 → HuggingFace 模型 id。白名单：install 接口只认这俩，
 * 杜绝「用户可控 URL 任意下载」的口子。
 */
export const LOCAL_MODELS = {
	tiny: "Xenova/whisper-tiny", // ~150MB，中英短句够用，老机器首选
	base: "Xenova/whisper-base", // ~290MB，中文长句明显更准（默认）
	small: "Xenova/whisper-small", // ~500MB，2.4 亿参数，中文同音字少很多；CPU 转写比 base 慢 3~4 倍
};

/** 档位名 → 模型 id，非法输入回 null。纯函数，单测覆盖。 */
export function resolveLocalModel(size) {
	const s = typeof size === "string" ? size.trim().toLowerCase() : "";
	return Object.prototype.hasOwnProperty.call(LOCAL_MODELS, s) ? LOCAL_MODELS[s] : null;
}

function str(v) {
	return typeof v === "string" ? v.trim() : "";
}

/**
 * 插件语言（zh-CN / en-US …）→ 远端 Whisper 的 language 参数（ISO-639-1）。
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

/**
 * 插件语言 → 本地 transformers.js Whisper 的 language 参数（英文全名）。
 * 纯函数，单测覆盖。
 */
export function whisperFullLang(lang) {
	const l = str(lang).toLowerCase();
	if (l.startsWith("zh")) return "chinese";
	if (l.startsWith("en")) return "english";
	if (l.startsWith("ja")) return "japanese";
	if (l.startsWith("ko")) return "korean";
	if (l.startsWith("fr")) return "french";
	if (l.startsWith("de")) return "german";
	if (l.startsWith("es")) return "spanish";
	if (l.startsWith("ru")) return "russian";
	if (l.startsWith("it")) return "italian";
	if (l.startsWith("pt")) return "portuguese";
	return "";
}

/** 基址 + 路径拼接（容忍末尾斜杠）。纯函数，单测覆盖。 */
export function joinUrl(base, path) {
	return `${str(base).replace(/\/+$/, "")}${path}`;
}

/* ------------------------------------------------------------------ */
/* WAV 解码：客户端发的 16k 单声道 16-bit WAV 转 Float32Array（本地      */
/* Whisper 的输入）。兼容其它采样率/声道/位深（线性重采样 + 声道平均）， */
/* 保证手写编码器的小偏差不炸。纯函数，单测覆盖。                        */
/* ------------------------------------------------------------------ */

/** 线性重采样。纯函数，单测覆盖。 */
export function resampleLinear(samples, fromRate, toRate) {
	const src = samples instanceof Float32Array ? samples : Float32Array.from(samples ?? []);
	if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate <= 0 || toRate <= 0) {
		throw new Error("采样率非法");
	}
	if (src.length === 0) return new Float32Array(0);
	if (fromRate === toRate) return Float32Array.from(src);
	const outLen = Math.max(1, Math.round((src.length * toRate) / fromRate));
	const out = new Float32Array(outLen);
	const ratio = src.length / outLen;
	for (let i = 0; i < outLen; i++) {
		const pos = i * ratio;
		const i0 = Math.floor(pos);
		const i1 = Math.min(i0 + 1, src.length - 1);
		const frac = pos - i0;
		out[i] = src[i0] * (1 - frac) + src[i1] * frac;
	}
	return out;
}

function readAscii(view, offset, len) {
	let s = "";
	for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
	return s;
}

/**
 * WAV（PCM/Float）→ 16kHz 单声道 Float32Array。
 * 抛错信息直接面向用户（中文）。纯函数，单测覆盖。
 */
export function decodeWav16k(buf) {
	const u8 = Buffer.isBuffer(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : buf;
	if (!(u8 instanceof Uint8Array) || u8.length < 44) throw new Error("音频不是有效的 WAV（太短）");
	const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	if (readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "WAVE") {
		throw new Error("音频不是有效的 WAV（缺 RIFF/WAVE 头）");
	}
	// 遍历 chunk：fmt 拿格式，data 拿采样（跳过 fact/LIST 等）。
	let audioFormat = 0;
	let channels = 0;
	let sampleRate = 0;
	let bitsPerSample = 0;
	let dataStart = -1;
	let dataLen = 0;
	let off = 12;
	while (off + 8 <= u8.length) {
		const id = readAscii(view, off, 4);
		const size = view.getUint32(off + 4, true);
		if (id === "fmt " && size >= 16) {
			audioFormat = view.getUint16(off + 8, true);
			channels = view.getUint16(off + 10, true);
			sampleRate = view.getUint32(off + 12, true);
			bitsPerSample = view.getUint16(off + 22, true);
		} else if (id === "data") {
			dataStart = off + 8;
			dataLen = Math.min(size, u8.length - dataStart);
		}
		off += 8 + size + (size % 2);
	}
	if (audioFormat !== 1 && audioFormat !== 3) throw new Error(`WAV 编码不支持（format=${audioFormat}，只要 PCM/Float）`);
	if (channels < 1 || channels > 8) throw new Error("WAV 声道数异常");
	if (!Number.isFinite(sampleRate) || sampleRate < 3000 || sampleRate > 192000) throw new Error("WAV 采样率异常");
	if (![8, 16, 24, 32].includes(bitsPerSample)) throw new Error(`WAV 位深不支持（${bitsPerSample}bit）`);
	if (audioFormat === 3 && bitsPerSample !== 32) throw new Error("Float WAV 只要 32bit");
	if (dataStart < 0 || dataLen <= 0) throw new Error("WAV 里没有采样数据");
	const bytesPerSample = bitsPerSample / 8;
	const frames = Math.floor(dataLen / (bytesPerSample * channels));
	if (frames <= 0) throw new Error("WAV 里没有采样数据");
	const mono = new Float32Array(frames);
	const dv = new DataView(u8.buffer, u8.byteOffset + dataStart, dataLen - (dataLen % (bytesPerSample * channels)));
	for (let f = 0; f < frames; f++) {
		let sum = 0;
		for (let c = 0; c < channels; c++) {
			const p = (f * channels + c) * bytesPerSample;
			let v;
			if (audioFormat === 3) v = dv.getFloat32(p, true);
			else if (bitsPerSample === 8) v = (dv.getUint8(p) - 128) / 128;
			else if (bitsPerSample === 16) v = dv.getInt16(p, true) / 32768;
			else if (bitsPerSample === 24) {
				const b0 = dv.getUint8(p);
				const b1 = dv.getUint8(p + 1);
				const b2 = dv.getInt8(p + 2);
				v = (b2 * 65536 + b1 * 256 + b0) / 8388608;
			} else v = dv.getInt32(p, true) / 2147483648;
			sum += v;
		}
		mono[f] = sum / channels;
	}
	return resampleLinear(mono, sampleRate, 16000);
}

export default {
	activate(host) {
		const dir = host.dir;
		const cacheDir = join(dir, "whisper-cache");
		let cfg = host.getSettings?.() ?? {};
		const offSettings = host.onSettingsChanged?.((v) => {
			cfg = v && typeof v === "object" ? v : {};
		});

		/** 本地引擎运行态（常驻内存，重启服务清零；安装标记在 storage 里持久化）。 */
		const local = {
			installing: false,
			progress: null, // 0~100，null=未知/非下载阶段
			phase: "",
			error: "",
			pipe: null, // transformers pipeline（热缓存）
			loadedModel: "",
			transcribeBusy: false,
		};
		let installFlight = null;

		const engine = () => {
			const e = str(cfg.engine).toLowerCase();
			return e === "local" || e === "remote" ? e : "auto";
		};
		const wantedModelId = () => resolveLocalModel(cfg.localModel) ?? LOCAL_MODELS.base;
		const remoteReady = () => Boolean(str(cfg.transcribeUrl) && str(cfg.transcribeKey));
		const installedModels = () => {
			try {
				const v = host.storage.get("whisperModels", {});
				return v && typeof v === "object" ? v : {};
			} catch {
				return {};
			}
		};
		const localReady = () => Boolean(installedModels()[wantedModelId()]);

		const localStatus = () => ({
			installing: local.installing,
			progress: local.progress,
			phase: local.phase,
			error: local.error,
			ready: localReady(),
			model: wantedModelId(),
			loaded: Boolean(local.pipe) && local.loadedModel === wantedModelId(),
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

		/* ---------------- 本地引擎：装 / 状态 / 卸 ---------------- */

		async function importTransformers() {
			const ok = await host.ensureDeps?.([TRANSFORMERS_SPEC], {
				onProgress: (m) => {
					local.phase = str(m) || "正在安装本地语音运行时…";
				},
			});
			if (!ok) throw new Error("本地语音运行时安装失败（npm install 没跑通，请检查网络后重试）");
			// ESM 不支持目录 import（ERR_UNSUPPORTED_DIR_IMPORT）：先用 createRequire
			// 走 exports map 解出入口文件，再 import（文件 URL 恒可 import）。
			const req = createRequire(join(dir, "index.mjs"));
			let entry;
			try {
				entry = req.resolve("@xenova/transformers");
			} catch {
				throw new Error("本地语音运行时装上了但解析不到入口（node_modules 可能损坏，删了重装）");
			}
			const mod = await import(pathToFileURL(entry).href);
			if (!mod || !mod.pipeline) throw new Error("本地语音运行时加载失败（依赖装上了但 import 不到）");
			mod.env.cacheDir = cacheDir;
			return mod;
		}

		/** 后台安装全流程（单飞）：运行时 → 权重下载 → 预热。进度写 local.*。 */
		async function runInstall(modelId) {
			local.installing = true;
			local.progress = null;
			local.error = "";
			try {
				local.phase = "正在安装本地语音运行时（首次约几分钟）…";
				const tf = await importTransformers();
				local.phase = `正在下载语音模型（${modelId}，首次约几百 MB）…`;
				const seen = new Map(); // file → { loaded, total }
				const pipe = await tf.pipeline("automatic-speech-recognition", modelId, {
					progress_callback: (p) => {
						try {
							if (!p || typeof p !== "object") return;
							if (p.status === "progress" && typeof p.progress === "number") {
								seen.set(String(p.file ?? ""), {
									loaded: Number(p.loaded) || 0,
									total: Number(p.total) || 0,
								});
								let l = 0;
								let t = 0;
								for (const v of seen.values()) {
									l += v.loaded;
									t += v.total;
								}
								if (t > 0) local.progress = Math.min(99, Math.round((l / t) * 100));
							} else if (p.status === "done") {
								const k = String(p.file ?? "");
								if (seen.has(k)) {
									const v = seen.get(k);
									seen.set(k, { loaded: Math.max(v.loaded, v.total), total: v.total });
								}
							}
						} catch {
							/* 进度上报失败不影响安装 */
						}
					},
				});
				if (!pipe) throw new Error("语音模型加载返回空");
				local.phase = "预热…";
				// 3 秒静音过一遍：把 onnx session 真正跑起来，首句转写不冷启动。
				try {
					await pipe(new Float32Array(16000 * 3), { language: "english", task: "transcribe" });
				} catch {
					/* 预热失败不致命 */
				}
				try {
					if (local.pipe && local.loadedModel !== modelId) {
						await local.pipe.model?.dispose?.();
					}
				} catch {
					/* ignore */
				}
				local.pipe = pipe;
				local.loadedModel = modelId;
				const prev = installedModels();
				prev[modelId] = true;
				try {
					host.storage.set("whisperModels", prev);
				} catch {
					/* 标记写失败：下次重启会重新下载，不致命 */
				}
				local.progress = 100;
				local.phase = "完成";
				host.log(`voice-input 本地模型就绪: ${modelId}`);
			} catch (err) {
				local.error = err instanceof Error ? err.message : String(err);
				host.log("voice-input 本地安装失败:", err);
			} finally {
				local.installing = false;
				installFlight = null;
			}
		}

		/** 拿热 pipeline（内存里没有就懒加载；权重缺了会自动重下，自愈）。 */
		async function getPipe(modelId) {
			if (local.pipe && local.loadedModel === modelId) return local.pipe;
			const tf = await importTransformers();
			try {
				if (local.pipe) {
					await local.pipe.model?.dispose?.();
				}
			} catch {
				/* ignore */
			}
			local.pipe = await tf.pipeline("automatic-speech-recognition", modelId);
			local.loadedModel = modelId;
			return local.pipe;
		}

		async function transcribeLocal(audio, lang) {
			const modelId = wantedModelId();
			let samples;
			try {
				samples = decodeWav16k(audio);
			} catch (err) {
				const e = new Error(`本地引擎只要 WAV：${err instanceof Error ? err.message : String(err)}`);
				e.statusCode = 415;
				throw e;
			}
			if (samples.length < 1600) {
				const e = new Error("录音太短（不到 0.1 秒），请按住说完再结束");
				e.statusCode = 400;
				throw e;
			}
			// 8 分钟硬截：防超长音频把 CPU 跑死。
			const capped = samples.length > 16000 * 480 ? samples.slice(0, 16000 * 480) : samples;
			const pipe = await getPipe(modelId);
			const fullLang = whisperFullLang(lang);
			const out = await pipe(capped, {
				language: fullLang || undefined,
				task: "transcribe",
				chunk_length_s: 30,
				stride_length_s: 5,
			});
			const text = str(out?.text);
			if (!text) {
				const e = new Error("本地转写返回空（可能全是静音），请靠近麦克风再说一次");
				e.statusCode = 502;
				throw e;
			}
			return text;
		}

		/* ---------------- 远端引擎（OpenAI 兼容） ---------------- */

		async function transcribeRemote(audio, mime, lang) {
			const baseUrl = str(cfg.transcribeUrl);
			const apiKey = str(cfg.transcribeKey);
			if (!baseUrl || !apiKey) {
				const e = new Error(
					"服务端转写未配置：设置面板 → 界面插件 → 语音输入 → 填写「转写接口基址」与「密钥」，或一键安装本地 Whisper",
				);
				e.statusCode = 501;
				throw e;
			}
			if (audio.length > MAX_REMOTE_AUDIO_BYTES) {
				const e = new Error(`录音过大（${(audio.length / 1048576).toFixed(1)}MB > 25MB），请分段录制`);
				e.statusCode = 413;
				throw e;
			}
			const ext =
				mime.includes("mp4") || mime.includes("m4a")
					? "m4a"
					: mime.includes("ogg")
						? "ogg"
						: mime.includes("wav")
							? "wav"
							: "webm";
			const wl = whisperLang(lang);
			const form = new FormData();
			form.set("file", new Blob([audio], { type: mime }), `voice.${ext}`);
			form.set("model", str(cfg.transcribeModel) || "whisper-1");
			if (wl) form.set("language", wl);
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), REMOTE_TRANSCRIBE_TIMEOUT_MS);
			let r;
			try {
				r = await fetch(joinUrl(baseUrl, "/audio/transcriptions"), {
					method: "POST",
					headers: { Authorization: `Bearer ${apiKey}` },
					body: form,
					signal: ctrl.signal,
				});
			} catch (err) {
				const e = new Error(
					err?.name === "AbortError" ? "转写超时（120s），请分段录制" : `转写接口 unreachable：${err.message}`,
				);
				e.statusCode = 502;
				throw e;
			} finally {
				clearTimeout(timer);
			}
			if (!r.ok) {
				const body = (await r.text().catch(() => "")).slice(0, 500);
				const e = new Error(`转写接口报错 ${r.status}：${body || r.statusText}`);
				e.statusCode = 502;
				throw e;
			}
			const data = await r.json().catch(() => ({}));
			return str(data?.text);
		}

		/* ---------------- 路由 ---------------- */

		/** 客户端读公开配置（密钥永不下发）。 */
		const offGet = safe("GET", "/settings", async (_req, res) => {
			res.json({
				lang: str(cfg.lang) || "zh-CN",
				serverFallback: cfg.serverFallback !== false,
				engine: engine(),
				localModel: str(cfg.localModel) || "base",
				serverReady: remoteReady(),
				localReady: localReady(),
			});
		});

		const offStatus = safe("GET", "/local-status", async (_req, res) => {
			res.json(localStatus());
		});

		const offInstall = safe("POST", "/local-install", async (req, res) => {
			const eng = engine();
			if (eng === "remote") {
				res.status(409).json({ error: "当前引擎是「仅远端」：先把「转写引擎」切到自动或本地再安装" });
				return;
			}
			let body = req.body;
			if (!body || typeof body !== "object") body = {};
			const modelId = resolveLocalModel(body.model) ?? wantedModelId();
			if (local.installing) {
				res.json({ started: true, deduped: true, ...localStatus() });
				return;
			}
			if (!existsSync(dir)) {
				res.status(500).json({ error: "插件目录不可写，无法安装" });
				return;
			}
			local.phase = "准备…";
			installFlight = runInstall(modelId);
			void installFlight;
			res.status(202).json({ started: true, ...localStatus() });
		});

		const offUninstall = safe("DELETE", "/local", async (_req, res) => {
			if (local.installing) {
				res.status(409).json({ error: "正在安装中，请等它装完再卸" });
				return;
			}
			try {
				if (local.pipe) {
					await local.pipe.model?.dispose?.();
				}
			} catch {
				/* ignore */
			}
			local.pipe = null;
			local.loadedModel = "";
			let freed = false;
			try {
				await rm(cacheDir, { recursive: true, force: true });
				freed = true;
			} catch (err) {
				host.log("voice-input 删模型缓存失败:", err);
			}
			try {
				host.storage.delete("whisperModels");
			} catch {
				/* ignore */
			}
			local.progress = null;
			local.phase = "";
			local.error = "";
			res.json({ ok: true, freed });
		});

		/** 录音 → 本地/远端 → { text, engine }。 */
		const offPost = safe("POST", "/transcribe", async (req, res) => {
			const audio = await readRaw(req);
			if (!audio.length) {
				res.status(400).json({ error: "请求体为空（没有收到录音）" });
				return;
			}
			const mime = str(req.headers?.["content-type"]).split(";")[0] || "audio/wav";
			const lang = str(req.query?.lang) || str(cfg.lang) || "zh-CN";
			const eng = engine();
			const tryLocal = eng !== "remote" && localReady();
			const tryRemote = eng !== "local" && remoteReady();

			// auto：本地优先（免费不出网），本地炸了再试远端。
			if (eng === "auto" && tryLocal) {
				if (audio.length > MAX_LOCAL_AUDIO_BYTES) {
					res.status(413).json({ error: "录音太长（>8分钟），请分段录制" });
					return;
				}
				if (local.transcribeBusy) {
					res.status(429).json({ error: "本地正在转写上一段，稍等几秒再试" });
					return;
				}
				local.transcribeBusy = true;
				try {
					const text = await transcribeLocal(audio, lang);
					res.json({ text, engine: "local" });
					return;
				} catch (err) {
					// 本地挂了且有远端可兜：悄悄降级（415 非 WAV 之类客户端问题除外）。
					const status = err?.statusCode;
					if (tryRemote && status !== 415 && status !== 400) {
						host.log("voice-input 本地转写失败，切远端兜底:", err instanceof Error ? err.message : err);
					} else {
						res.status(status || 502).json({ error: err instanceof Error ? err.message : String(err) });
						return;
					}
				} finally {
					local.transcribeBusy = false;
				}
			} else if (eng === "local") {
				if (!localReady()) {
					res.status(501).json({ error: "本地 Whisper 还没装：麦克风浮层里点「一键安装本地 Whisper」" });
					return;
				}
				if (audio.length > MAX_LOCAL_AUDIO_BYTES) {
					res.status(413).json({ error: "录音太长（>8分钟），请分段录制" });
					return;
				}
				if (local.transcribeBusy) {
					res.status(429).json({ error: "本地正在转写上一段，稍等几秒再试" });
					return;
				}
				local.transcribeBusy = true;
				try {
					const text = await transcribeLocal(audio, lang);
					res.json({ text, engine: "local" });
				} catch (err) {
					res.status(err?.statusCode || 502).json({ error: err instanceof Error ? err.message : String(err) });
				} finally {
					local.transcribeBusy = false;
				}
				return;
			}

			if (!tryRemote) {
				res.status(501).json({
					error: localReady()
						? "转写失败：请重试"
						: "服务端转写没得用：要么一键安装本地 Whisper（麦克风浮层里有按钮），要么在设置里填远端转写接口",
				});
				return;
			}
			try {
				const text = await transcribeRemote(audio, mime, lang);
				res.json({ text, engine: "remote" });
			} catch (err) {
				res.status(err?.statusCode || 502).json({ error: err instanceof Error ? err.message : String(err) });
			}
		});

		host.log("voice-input activated");
		return () => {
			for (const off of [offGet, offStatus, offInstall, offUninstall, offPost]) {
				try {
					off();
				} catch {
					/* ignore */
				}
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
