/**
 * voice-input 客户端 —— 输入框麦克风按钮的全部逻辑（裸 ESM，无依赖）。
 *
 * 链路：
 *   manifest `ui.composer` 声明 🎤 按钮（宿主渲染，见 ChatInput）→ 用户点击 →
 *   宿主 `triggerPluginUiAction` 按需 import 本文件（view:false，平时不加载）→
 *   顶层代码注册 `onUiAction("voice-input:toggle")` → toggle() 开始/结束录音 →
 *   文本经 `window.__piWebUiHost.compose({ text })` 并入输入框草稿（用户再自己发）。
 *
 * 识别策略（用户选的「两者都支持，自动降级」）：
 *   1. 有 Web Speech API（Chrome/Edge）→ 本地识别，免费实时出字；
 *   2. 没有 / 出错（network 等）且服务端已配置 → MediaRecorder 录音 →
 *      POST /plugins-api/voice-input/transcribe → Whisper 转写；
 *   3. 都不行 → 浮层报错，告诉用户去设置里配转写接口。
 *
 * 与宿主只有两条窄通道：`window.__piWebUiHost.compose/onUiAction`（动作）与
 * 自家服务端的 HTTP 路由（配置/转写）。拿不到 React 状态，也不需要。
 */

const ACTION = "voice-input:toggle";

/** 应用根前缀 + 本插件服务端基址（import.meta.url 推导，子路径反代也对）。 */
function apiBase() {
	try {
		const u = new URL(import.meta.url);
		const i = u.pathname.indexOf("/plugins/");
		const prefix = i >= 0 ? u.pathname.slice(0, i) : "";
		return `${u.origin}${prefix}/plugins-api/voice-input`;
	} catch {
		return "/plugins-api/voice-input";
	}
}

const isZh = (() => {
	try {
		return (navigator.language || "zh-CN").toLowerCase().startsWith("zh");
	} catch {
		return true;
	}
})();

const T = {
	listening: isZh ? "正在聆听…（再点 🎤 结束）" : "Listening… (click 🎤 again to finish)",
	recording: isZh ? "正在录音…（再点 🎤 结束并转写）" : "Recording… (click 🎤 again to transcribe)",
	uploading: isZh ? "转写中…" : "Transcribing…",
	done: isZh ? "完成" : "Done",
	cancel: isZh ? "取消" : "Cancel",
	noSpeech: isZh ? "浏览器语音识别不可用，已切换服务端录音" : "Browser recognition unavailable, using server recording",
	micDenied: isZh
		? "麦克风被拒绝：请在浏览器地址栏左侧允许本站使用麦克风"
		: "Microphone denied: allow this site to use the mic",
	srNotAllowed: isZh
		? "浏览器拒绝了语音识别（麦克风权限或网络）：已尝试服务端转写"
		: "Browser denied speech recognition; tried server transcription instead",
	serverMissing: isZh
		? "服务端转写未配置：设置面板 → 界面插件 → 语音输入 → 填写转写接口基址与密钥（OpenAI 兼容 /audio/transcriptions）"
		: "Server transcription not configured: Settings → Plugins → voice-input → fill in the transcription endpoint and key",
	empty: isZh ? "没听清，请再说一次" : "Didn't catch that, please try again",
	composeFailed: isZh
		? "输入框还没准备好，已复制到剪贴板，请粘贴发送"
		: "Composer not ready, copied to clipboard instead",
	copied: isZh ? "已复制" : "Copied",
	close: isZh ? "关闭" : "Close",
};

/** 插件服务端公开配置（GET /settings，不含密钥），60s 缓存。 */
let settingsCache = null;
let settingsAt = 0;
async function getSettings() {
	if (settingsCache && Date.now() - settingsAt < 60_000) return settingsCache;
	const d = await fetch(`${apiBase()}/settings`, { credentials: "same-origin" }).then((r) => {
		if (!r.ok) throw new Error(`settings ${r.status}`);
		return r.json();
	});
	settingsCache = { lang: d.lang || "zh-CN", serverFallback: d.serverFallback !== false, serverReady: !!d.serverReady };
	settingsAt = Date.now();
	return settingsCache;
}

function hostApi() {
	try {
		return window.__piWebUiHost ?? null;
	} catch {
		return null;
	}
}

/* ------------------------------------------------------------------ */
/* 浮层（录音状态 + 中间结果 + 完成/取消，纯 DOM）                      */
/* ------------------------------------------------------------------ */

let overlay = null;

function closeOverlay() {
	if (overlay) {
		overlay.remove();
		overlay = null;
	}
}

/** 建浮层。返回 { setText, setState, onDone, onCancel } 由调用方接线。 */
function openOverlay() {
	closeOverlay();
	const root = document.createElement("div");
	root.className = "vi-overlay";
	root.innerHTML = `
<style>
	.vi-overlay {
		position: fixed; left: 50%; bottom: 132px; transform: translateX(-50%);
		z-index: 9999; min-width: 300px; max-width: min(560px, 92vw);
		background: var(--bg-elev, #16161d); color: inherit;
		border: 1px solid var(--border, #333); border-radius: 12px;
		padding: 12px 14px; font-size: 13px;
		box-shadow: 0 8px 32px rgba(0,0,0,.45);
	}
	.vi-row { display: flex; align-items: center; gap: 8px; }
	.vi-dot { width: 10px; height: 10px; border-radius: 50%; background: #e5484d; flex: none;
		animation: vi-pulse 1.2s ease-in-out infinite; }
	@keyframes vi-pulse { 50% { opacity: .25; } }
	.vi-status { opacity: .75; }
	.vi-time { margin-left: auto; opacity: .55; font-variant-numeric: tabular-nums; }
	.vi-text { margin: 8px 0 10px; max-height: 120px; overflow-y: auto;
		white-space: pre-wrap; line-height: 1.6; }
	.vi-text:empty { display: none; }
	.vi-btns { display: flex; gap: 8px; justify-content: flex-end; }
	.vi-btns button {
		border: 1px solid var(--border, #333); border-radius: 6px;
		background: transparent; color: inherit; font: inherit;
		padding: 5px 14px; cursor: pointer;
	}
	.vi-btns .primary { background: var(--accent, #7c5cff); border-color: transparent; color: #fff; }
	.vi-err { color: #e5484d; }
</style>
<div class="vi-row"><span class="vi-dot"></span><span class="vi-status"></span><span class="vi-time"></span></div>
<div class="vi-text"></div>
<div class="vi-btns"></div>`;
	document.body.append(root);
	const statusEl = root.querySelector(".vi-status");
	const textEl = root.querySelector(".vi-text");
	const timeEl = root.querySelector(".vi-time");
	const btnsEl = root.querySelector(".vi-btns");
	overlay = root;
	const t0 = Date.now();
	const timer = setInterval(() => {
		if (!overlay) {
			clearInterval(timer);
			return;
		}
		const s = Math.floor((Date.now() - t0) / 1000);
		timeEl.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
	}, 500);
	return {
		setStatus(s) {
			statusEl.textContent = s;
		},
		setText(s, isErr = false) {
			textEl.textContent = s;
			textEl.classList.toggle("vi-err", isErr);
		},
		setButtons(btns) {
			btnsEl.innerHTML = "";
			for (const b of btns) {
				const el = document.createElement("button");
				el.type = "button";
				el.textContent = b.label;
				if (b.primary) el.className = "primary";
				el.addEventListener("click", b.onClick);
				btnsEl.append(el);
			}
		},
	};
}

/* ------------------------------------------------------------------ */
/* 会话状态机：idle | listening(SR) | recording(MediaRecorder)         */
/* ------------------------------------------------------------------ */

const session = {
	mode: "idle", // idle | sr | rec
	recognition: null,
	stream: null,
	recorder: null,
	chunks: [],
	finalText: "",
	manualStop: false,
	ui: null,
};

function stopTracks() {
	try {
		session.stream?.getTracks().forEach((t) => t.stop());
	} catch {
		/* ignore */
	}
	session.stream = null;
}

function resetSession() {
	try {
		session.recognition?.abort();
	} catch {
		/* ignore */
	}
	try {
		if (session.recorder && session.recorder.state !== "inactive") session.recorder.stop();
	} catch {
		/* ignore */
	}
	stopTracks();
	session.mode = "idle";
	session.recognition = null;
	session.recorder = null;
	session.chunks = [];
	session.finalText = "";
	session.manualStop = false;
}

/** 文本收尾：进输入框草稿；进不去就给复制按钮（不丢字）。 */
async function finishWithText(text) {
	const t = String(text ?? "").trim();
	resetSession();
	if (!t) {
		const ui = openOverlay();
		ui.setStatus("🎤");
		ui.setText(T.empty, true);
		ui.setButtons([{ label: T.close, primary: true, onClick: closeOverlay }]);
		setTimeout(closeOverlay, 2500);
		return;
	}
	const ok = (() => {
		try {
			return hostApi()?.compose({ text: t }) ?? false;
		} catch {
			return false;
		}
	})();
	if (ok) {
		closeOverlay();
		return;
	}
	const ui = openOverlay();
	ui.setStatus("🎤");
	ui.setText(t);
	ui.setButtons([
		{
			label: T.copied === "已复制" ? "复制" : "Copy",
			primary: true,
			onClick: async () => {
				try {
					await navigator.clipboard.writeText(t);
				} catch {
					/* ignore */
				}
				closeOverlay();
			},
		},
		{ label: T.close, onClick: closeOverlay },
	]);
}

function showError(msg) {
	resetSession();
	const ui = openOverlay();
	ui.setStatus("🎤");
	ui.setText(msg, true);
	ui.setButtons([{ label: T.close, primary: true, onClick: closeOverlay }]);
}

/* ---------------- 浏览器原生识别（Web Speech API） ---------------- */

function srSupported() {
	try {
		return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
	} catch {
		return false;
	}
}

function startSpeechRecognition(lang, fallback) {
	const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
	const rec = new Ctor();
	rec.lang = lang;
	rec.continuous = true;
	rec.interimResults = true;
	session.recognition = rec;
	session.mode = "sr";
	session.finalText = "";
	session.manualStop = false;
	const ui = openOverlay();
	session.ui = ui;
	ui.setStatus(`🎤 ${T.listening}`);
	ui.setButtons([
		{ label: T.done, primary: true, onClick: () => finishWithText(session.finalText) },
		{
			label: T.cancel,
			onClick: () => {
				resetSession();
				closeOverlay();
			},
		},
	]);
	let interim = "";
	rec.onresult = (ev) => {
		interim = "";
		for (let i = ev.resultIndex; i < ev.results.length; i++) {
			const r = ev.results[i];
			if (r.isFinal) session.finalText += r[0].transcript;
			else interim += r[0].transcript;
		}
		ui.setText((session.finalText + interim).trim());
	};
	rec.onerror = (ev) => {
		const err = ev?.error || "";
		// 权限问题：直接报错（重试也没用）；其余错误走服务端降级。
		if (err === "not-allowed" || err === "service-not-allowed") {
			showError(T.srNotAllowed);
			if (fallback) void startRecorderFlow();
			return;
		}
		if (fallback) {
			ui.setStatus(`🎤 ${T.noSpeech}`);
			try {
				rec.abort();
			} catch {
				/* ignore */
			}
			void startRecorderFlow();
			return;
		}
		showError(`${T.noSpeech}`);
	};
	rec.onend = () => {
		// 用户点的完成/取消：finishWithText 里已经 reset，不能复活。
		if (session.mode !== "sr") return;
		if (session.manualStop) {
			void finishWithText(session.finalText);
			return;
		}
		// 浏览器因静音自动断句：有字就收尾，没字就悄悄续上（ continuous 的 Chrome 仍会断）。
		if (session.finalText.trim()) {
			void finishWithText(session.finalText);
			return;
		}
		try {
			rec.start();
		} catch {
			void finishWithText("");
		}
	};
	try {
		rec.start();
	} catch {
		if (fallback) void startRecorderFlow();
		else showError(T.noSpeech);
	}
}

/* ---------------- 服务端降级：录音 → Whisper ---------------- */

function pickMime() {
	try {
		const cands = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/wav"];
		for (const m of cands) if (window.MediaRecorder?.isTypeSupported(m)) return m;
	} catch {
		/* ignore */
	}
	return "";
}

async function startRecorderFlow() {
	let cfg;
	try {
		cfg = await getSettings();
	} catch {
		showError(T.serverMissing);
		return;
	}
	if (!cfg.serverReady) {
		showError(T.serverMissing);
		return;
	}
	let stream;
	try {
		stream = await navigator.mediaDevices.getUserMedia({ audio: true });
	} catch {
		showError(T.micDenied);
		return;
	}
	const mime = pickMime();
	let recorder;
	try {
		recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
	} catch {
		try {
			stream.getTracks().forEach((t) => t.stop());
		} catch {
			/* ignore */
		}
		showError(T.micDenied);
		return;
	}
	resetSession();
	session.mode = "rec";
	session.stream = stream;
	session.recorder = recorder;
	session.chunks = [];
	session.manualStop = false;
	const ui = openOverlay();
	session.ui = ui;
	ui.setStatus(`🎤 ${T.recording}`);
	ui.setButtons([
		{
			label: T.done,
			primary: true,
			onClick: () => {
				session.manualStop = true;
				try {
					recorder.stop();
				} catch {
					/* ignore */
				}
			},
		},
		{
			label: T.cancel,
			onClick: () => {
				resetSession();
				closeOverlay();
			},
		},
	]);
	recorder.ondataavailable = (ev) => {
		if (ev.data && ev.data.size > 0) session.chunks.push(ev.data);
	};
	recorder.onstop = () => {
		stopTracks();
		const type = mime || recorder.mimeType || "audio/webm";
		const blob = new Blob(session.chunks, { type });
		session.chunks = [];
		if (!session.manualStop) {
			resetSession();
			closeOverlay();
			return;
		}
		void uploadTranscribe(blob, type, cfg.lang);
	};
	try {
		recorder.start();
	} catch {
		showError(T.micDenied);
	}
}

async function uploadTranscribe(blob, mime, lang) {
	const ui = openOverlay();
	ui.setStatus(`🎤 ${T.uploading}`);
	ui.setButtons([
		{
			label: T.cancel,
			onClick: () => {
				resetSession();
				closeOverlay();
			},
		},
	]);
	let text = "";
	try {
		const r = await fetch(`${apiBase()}/transcribe?lang=${encodeURIComponent(lang || "zh-CN")}`, {
			method: "POST",
			headers: { "Content-Type": mime },
			body: blob,
			credentials: "same-origin",
		});
		const data = await r.json().catch(() => ({}));
		if (!r.ok) throw new Error(data?.error || `transcribe ${r.status}`);
		text = String(data?.text ?? "");
	} catch (err) {
		showError(err instanceof Error ? err.message : String(err));
		return;
	}
	await finishWithText(text);
}

/* ---------------- 入口：🎤 按钮 ---------------- */

async function toggle() {
	// 录音中再点 = 结束并收尾。
	if (session.mode === "sr") {
		session.manualStop = true;
		try {
			session.recognition?.stop();
		} catch {
			void finishWithText(session.finalText);
		}
		return;
	}
	if (session.mode === "rec") {
		session.manualStop = true;
		try {
			session.recorder?.stop();
		} catch {
			resetSession();
			closeOverlay();
		}
		return;
	}
	// 空闲 → 开始：先读配置（语言 + 降级开关 + 服务端是否就绪）。
	let cfg = { lang: "zh-CN", serverFallback: true, serverReady: false };
	try {
		cfg = await getSettings();
	} catch {
		/* 读不到就按纯浏览器模式跑，降级时再报错 */
	}
	const fallback = cfg.serverFallback !== false && cfg.serverReady;
	if (srSupported()) startSpeechRecognition(cfg.lang || "zh-CN", fallback);
	else if (fallback) void startRecorderFlow();
	else showError(cfg.serverFallback === false ? T.noSpeech : T.serverMissing);
}

function register() {
	try {
		hostApi()?.onUiAction?.(ACTION, () => {
			void toggle();
		});
	} catch {
		/* 宿主太旧：按钮点了没反应总比崩好（manifest 里 apiVersion 会先拦住旧版） */
	}
}

register();

/**
 * loadOne 要求 default.mount 是函数（否则记 failed → 首次点击只注册不执行）。
 * view:false 插件没有可见视图，这里给一个空挂载；真正的注册在顶层 register()。
 * mount 被调用时（隐藏 pane）再注册一次——Set 去重，幂等。
 */
export default {
	mount() {
		register();
		return () => {};
	},
};
