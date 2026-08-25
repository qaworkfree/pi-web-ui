/**
 * ssh 插件客户端视图 —— SSH 远程管理界面。
 *
 * 布局：左侧主机列表（状态点 / 新建 / 编辑 / 删除），右侧连接工作区
 * （「终端」= xterm.js PTY；「文件」= SFTP 浏览器 + 内嵌文本编辑器 Ctrl+S 保存）。
 * 支持同时连接多台主机，切换不中断。
 *
 * 协议见 index.mjs：{action, reqId} 上行请求；res 响应 reqId 匹配；
 * event 事件流（shell_data / shell_exit / conn_closed）定向推送；
 * kind:"state" 广播（主机列表 / 连接列表 / 依赖状态，凭据脱敏）。
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import xtermCss from "@xterm/xterm/css/xterm.css";

function esc(s) {
	return String(s ?? "").replace(/[&<>"']/g, (c) => (
		{ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
	));
}

let reqSeq = 0;
const b64 = {
	enc: (s) => btoa(unescape(encodeURIComponent(s))),
	dec: (b64s) => decodeURIComponent(escape(atob(b64s))),
	bytes: (b64s) => Uint8Array.from(atob(b64s), (c) => c.charCodeAt(0)),
};

/** 模糊匹配得分（快速过滤主机/文件用） */
export function fuzzyScore(query, target) {
	const q = query.toLowerCase();
	const t = target.toLowerCase();
	let qi = 0, score = 0, streak = 0;
	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] === q[qi]) { streak++; score += 1 + streak; qi++; }
		else streak = 0;
	}
	return qi < q.length ? -1 : score;
}

export default {
	mount(container, ctx) {
		container.innerHTML = `
<div class="sshx">
	<style>${xtermCss}</style>
	<style>
		.sshx { display: flex; gap: 10px; height: 100%; min-height: 480px; font-size: 13px; color: var(--text, #e6e6ef); }
		/* ---- 左侧主机栏 ---- */
		.sshx-side { width: 230px; min-width: 170px; flex-shrink: 0; display: flex; flex-direction: column;
			border: 1px solid var(--border, #333); border-radius: 10px; background: var(--bg-elev1, #16161d); overflow: hidden; }
		.sshx-side-head { display: flex; align-items: center; padding: 9px 10px 6px; font-size: 11px;
			letter-spacing: .08em; text-transform: uppercase; opacity: .85; }
		.sshx-side-head b { flex: 1; font-weight: 600; }
		.sshx-side-head button { all: unset; cursor: pointer; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
		.sshx-side-head button:hover { background: var(--bg-elev2, #20202b); }
		.sshx-hosts { flex: 1; overflow: auto; padding-bottom: 8px; user-select: none; }
		.sshx-hrow { display: flex; align-items: center; gap: 7px; padding: 7px 10px; cursor: pointer; white-space: nowrap; }
		.sshx-hrow:hover { background: var(--bg-elev2, #20202b); }
		.sshx-hrow.active { background: color-mix(in srgb, var(--accent, #7c5cff) 20%, transparent); }
		.sshx-hrow .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: var(--text-dim, #666); }
		.sshx-hrow .dot.on { background: var(--green, #4ade80); box-shadow: 0 0 6px var(--green, #4ade80); }
		.sshx-hrow .dot.busy { background: var(--amber, #fbbf24); animation: sshxpulse 1s infinite alternate; }
		@keyframes sshxpulse { from { opacity: .4 } to { opacity: 1 } }
		.sshx-hrow .info { flex: 1; min-width: 0; overflow: hidden; }
		.sshx-hrow .nm { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
		.sshx-hrow .addr { font-size: 11px; opacity: .55; overflow: hidden; text-overflow: ellipsis; }
		.sshx-hrow .ops { display: none; gap: 2px; }
		.sshx-hrow:hover .ops { display: flex; }
		.sshx-hrow .ops button { all: unset; cursor: pointer; padding: 1px 4px; border-radius: 4px; font-size: 11px; opacity: .7; }
		.sshx-hrow .ops button:hover { opacity: 1; background: var(--bg-elev3, #2a2a38); }
		.sshx-empty { padding: 18px 14px; opacity: .5; line-height: 1.9; text-align: center; }
		/* ---- 右侧主区 ---- */
		.sshx-main { flex: 1; min-width: 0; display: flex; flex-direction: column;
			border: 1px solid var(--border, #333); border-radius: 10px; background: var(--bg-elev0, #101016); overflow: hidden; position: relative; }
		.sshx-placeholder { flex: 1; display: grid; place-items: center; opacity: .45; text-align: center; line-height: 2.1; }
		.sshx-topbar { display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-bottom: 1px solid var(--border, #333);
			background: var(--bg-elev1, #16161d); }
		.sshx-topbar .lbl { font-weight: 600; }
		.sshx-topbar .tabs { display: flex; gap: 4px; margin-left: 12px; }
		.sshx-topbar .tab { all: unset; cursor: pointer; padding: 3px 12px; border-radius: 6px; font-size: 12.5px; opacity: .65; }
		.sshx-topbar .tab.active { background: color-mix(in srgb, var(--accent, #7c5cff) 25%, transparent); opacity: 1; font-weight: 600; }
		.sshx-topbar .grow { flex: 1; }
		.sshx-topbar button.act { all: unset; cursor: pointer; padding: 3px 10px; border-radius: 6px; font-size: 12px;
			border: 1px solid var(--border, #444); }
		.sshx-topbar button.act:hover { background: var(--bg-elev2, #20202b); }
		.sshx-term-wrap { flex: 1; min-height: 0; padding: 6px 8px; background: var(--term-bg, #101016); }
		.sshx-term-wrap .xterm { height: 100%; }
		/* ---- 文件面板 ---- */
		.sshx-files { flex: 1; min-height: 0; display: flex; flex-direction: column; }
		.sshx-files-bar { display: flex; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--border, #333); align-items: center; }
		.sshx-files-bar input.path { flex: 1; background: var(--bg-elev2, #20202b); color: inherit; border: 1px solid var(--border, #333);
			border-radius: 6px; padding: 4px 9px; font: ui-monospace, Consolas, monospace; font-size: 12px; }
		.sshx-files-bar button { all: unset; cursor: pointer; padding: 4px 9px; border-radius: 6px; font-size: 12px;
			border: 1px solid var(--border, #444); white-space: nowrap; }
		.sshx-files-bar button:hover { background: var(--bg-elev2, #20202b); }
		.sshx-flist { flex: 1; overflow: auto; }
		table.sshx-ftable { width: 100%; border-collapse: collapse; font-size: 12.5px; }
		.sshx-ftable th { text-align: left; padding: 6px 10px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
			opacity: .55; border-bottom: 1px solid var(--border, #333); position: sticky; top: 0; background: var(--bg-elev0, #101016); }
		.sshx-ftable td { padding: 5px 10px; border-bottom: 1px solid color-mix(in srgb, var(--border, #333) 45%, transparent); }
		.sshx-ftable tr.frow { cursor: pointer; }
		.sshx-ftable tr.frow:hover td { background: var(--bg-elev2, #20202b); }
		.sshx-ftable td.sz, .sshx-ftable th.sz { text-align: right; opacity: .6; white-space: nowrap; width: 90px; }
		.sshx-ftable td.mt { opacity: .5; white-space: nowrap; width: 150px; font-size: 11.5px; }
		.sshx-ftable td.ops { width: 70px; white-space: nowrap; }
		.sshx-ftable td.ops button { all: unset; cursor: pointer; padding: 1px 5px; border-radius: 4px; opacity: 0; font-size: 12px; }
		.sshx-ftable tr.frow:hover td.ops button { opacity: .75; }
		.sshx-ftable td.ops button:hover { opacity: 1 !important; background: var(--bg-elev3, #2a2a38); }
		/* ---- 编辑器浮层 ---- */
		.sshx-editor { position: absolute; inset: 42px 10px 10px; z-index: 20; display: flex; flex-direction: column;
			background: var(--bg-elev1, #16161d); border: 1px solid var(--accent, #7c5cff); border-radius: 10px;
			box-shadow: 0 16px 50px rgba(0,0,0,.55); overflow: hidden; }
		.sshx-editor.hidden { display: none; }
		.sshx-ed-head { display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-bottom: 1px solid var(--border, #333); }
		.sshx-ed-head .fn { font-family: ui-monospace, Consolas, monospace; font-size: 12px; font-weight: 600; }
		.sshx-ed-head .st { font-size: 11px; opacity: .6; }
		.sshx-ed-head .grow { flex: 1; }
		.sshx-ed-head button { all: unset; cursor: pointer; padding: 3px 12px; border-radius: 6px; font-size: 12px;
			border: 1px solid var(--border, #444); }
		.sshx-ed-head button.primary { background: var(--accent, #7c5cff); border-color: transparent; color: #fff; }
		.sshx-ed-head button:hover { filter: brightness(1.15); }
		.sshx-editor textarea { flex: 1; resize: none; border: 0; outline: 0; background: transparent; color: inherit;
			font: 13px/1.55 ui-monospace, Consolas, "Cascadia Mono", monospace; padding: 12px 14px; tab-size: 4; }
		.sshx-err { color: var(--red, #f87171); font-size: 12px; padding: 4px 12px; }
		/* ---- 主机表单弹层 ---- */
		.sshx-modal-bg { position: absolute; inset: 0; z-index: 30; background: rgba(0,0,0,.45); display: grid; place-items: center; }
		.sshx-modal-bg.hidden { display: none; }
		.sshx-modal { width: min(430px, 92%); max-height: 92%; overflow: auto; background: var(--bg-elev2, #20202b);
			border: 1px solid var(--border, #444); border-radius: 12px; padding: 16px 18px; }
		.sshx-modal h3 { margin: 0 0 12px; }
		.sshx-modal label { display: block; font-size: 11.5px; opacity: .7; margin: 10px 0 4px; }
		.sshx-modal input, .sshx-modal textarea { width: 100%; box-sizing: border-box; background: var(--bg-elev0, #101016);
			color: inherit; border: 1px solid var(--border, #444); border-radius: 6px; padding: 6px 9px; font: inherit; }
		.sshx-modal textarea { font: 12px ui-monospace, monospace; min-height: 64px; resize: vertical; }
		.sshx-modal .grid2 { display: grid; grid-template-columns: 1fr 110px; gap: 10px; }
		.sshx-modal .btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
		.sshx-modal .btns button { all: unset; cursor: pointer; padding: 6px 16px; border-radius: 7px; font-size: 13px;
			border: 1px solid var(--border, #444); }
		.sshx-modal .btns button.primary { background: var(--accent, #7c5cff); border-color: transparent; color: #fff; }
		.sshx-modal .hint { font-size: 11px; opacity: .5; margin-top: 6px; line-height: 1.6; }
	</style>
	<div class="sshx-side">
		<div class="sshx-side-head"><b>SSH 主机</b><button data-act="add" title="新建主机">＋</button></div>
		<div class="sshx-deps vsc-err"></div>
		<div class="sshx-hosts"></div>
	</div>
	<div class="sshx-main">
		<div class="sshx-placeholder">👈 选择左侧主机建立连接<br><small>终端 · 文件浏览 · 远程编辑</small></div>
		<div class="sshx-work vsc-hidden" style="display:flex;flex-direction:column;flex:1;min-height:0">
			<div class="sshx-topbar">
				<span class="lbl"></span>
				<span class="tabs">
					<button class="tab active" data-tab="term">终端</button>
					<button class="tab" data-tab="files">文件</button>
				</span>
				<span class="grow"></span>
				<button class="act disconnect">断开</button>
			</div>
			<div class="sshx-term-wrap"></div>
			<div class="sshx-files vsc-hidden">
				<div class="sshx-files-bar">
					<button class="up" title="上级目录">⬆</button>
					<input class="path" spellcheck="false" />
					<button class="refresh" title="刷新">⟳</button>
					<button class="mkdir">＋📁</button>
					<button class="newfile">＋📄</button>
				</div>
				<div class="sshx-flist"><table class="sshx-ftable"><thead><tr>
					<th>名称</th><th class="sz">大小</th><th class="mt">修改时间</th><th></th>
				</tr></thead><tbody></tbody></table></div>
			</div>
			<div class="sshx-err"></div>
		</div>
		<div class="sshx-editor hidden">
			<div class="sshx-ed-head">
				<span class="fn"></span><span class="st"></span><span class="grow"></span>
				<button class="save primary">保存 (Ctrl+S)</button>
				<button class="close">关闭</button>
			</div>
			<textarea spellcheck="false"></textarea>
		</div>
		<div class="sshx-modal-bg hidden">
			<div class="sshx-modal">
				<h3 class="m-title">新建主机</h3>
				<label>名称（可选）</label><input name="name" placeholder="my-server" />
				<div class="grid2">
					<span><label>主机地址 *</label><input name="host" placeholder="192.168.1.10" /></span>
					<span><label>端口</label><input name="port" value="22" /></span>
				</div>
				<label>用户名</label><input name="username" value="root" />
				<label>密码（编辑时留空 = 保持不变）</label><input name="password" type="password" autocomplete="off" />
				<label>私钥（PEM，可选）</label><textarea name="privateKey" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea>
				<div class="hint">凭据只保存在本机插件目录（ssh-hosts.json），不会上传。密码与私钥二选一即可。</div>
				<div class="btns"><button class="cancel">取消</button><button class="primary save-host">保存</button></div>
			</div>
		</div>
	</div>
</div>`;

		const root = container.querySelector(".sshx");
		const hostsEl = root.querySelector(".sshx-hosts");
		const depsEl = root.querySelector(".sshx-deps");
		const mainEl = root.querySelector(".sshx-main");
		const phEl = root.querySelector(".sshx-placeholder");
		const workEl = root.querySelector(".sshx-work");
		const lblEl = root.querySelector(".sshx-topbar .lbl");
		const termWrapEl = root.querySelector(".sshx-term-wrap");
		const filesEl = root.querySelector(".sshx-files");
		const pathInput = root.querySelector(".sshx-files-bar .path");
		const ftBody = root.querySelector(".sshx-ftable tbody");
		const errEl = root.querySelector(".sshx-err");
		const edEl = root.querySelector(".sshx-editor");
		const edFn = root.querySelector(".sshx-ed-head .fn");
		const edSt = root.querySelector(".sshx-ed-head .st");
		const edTa = root.querySelector(".sshx-editor textarea");
		const modalBg = root.querySelector(".sshx-modal-bg");

		// ---- 全局状态 --------------------------------------------------------
		let state = { depsOk: true, depsInstalling: false, hosts: [], conns: [] };
		let activeConnId = null;
		let activeTab = "term";
		const conns = new Map(); // connId → {term, fit, shellId, opened, cwd, entries}
		let editing = null; // {connId, path, saved}
		let modalEditId = null;

		function showErr(text) {
			errEl.textContent = text ?? "";
			if (text) setTimeout(() => { if (errEl.textContent === text) errEl.textContent = ""; }, 5000);
		}

		// ---- 请求通道 --------------------------------------------------------
		const pending = new Map();
		function request(payload) {
			const reqId = `r${++reqSeq}`;
			return new Promise((resolve) => {
				pending.set(reqId, resolve);
				ctx.send({ ...payload, reqId });
				setTimeout(() => { if (pending.delete(reqId)) resolve({ ok: false, error: "请求超时" }); }, 60000);
			});
		}
		const offData = ctx.onData((p) => {
			if (!p) return;
			if (p.res && pending.has(p.reqId)) {
				pending.get(p.reqId)(p);
				pending.delete(p.reqId);
				return;
			}
			if (p.kind === "state") {
				state = p.state;
				renderHosts();
				renderDeps();
				syncWorkVisibility();
				return;
			}
			switch (p.event) {
				case "shell_data": {
					const c = conns.get(p.connId);
					c?.term?.write(b64.bytes(p.b64));
					break;
				}
				case "shell_exit": {
					const c = conns.get(p.connId);
					if (c?.term) c.term.write("\r\n\x1b[90m〔shell 已退出〕\r\n\x1b[0m");
					break;
				}
				case "conn_closed": {
					showErr(`连接断开：${p.connId} ${p.reason ?? ""}`);
					conns.delete(p.connId);
					if (activeConnId === p.connId) {
						activeConnId = null;
						syncWorkVisibility();
						renderHosts();
					}
					break;
				}
			}
		});

		// ---- 主机列表 --------------------------------------------------------
		function connStatus(hostId) {
			const c = state.conns.find((x) => x.hostId === hostId && st_conns_has(x.connId));
			return c?.status === "connecting" ? "busy" : c ? "on" : "";
		}
		// 只认本视图真实持有终端的连接（其他标签页的连接不可操作）
		function st_conns_has(connId) { return conns.has(connId); }

		function renderHosts() {
			hostsEl.innerHTML = "";
			if (!state.hosts.length) {
				hostsEl.innerHTML = `<div class="sshx-empty">还没有主机<br>点右上角 ＋ 添加</div>`;
				return;
			}
			for (const h of state.hosts) {
				const row = document.createElement("div");
				row.className = "sshx-hrow" + (connOfHost(h.id) ? " active" : "");
				row.innerHTML = `<span class="dot ${connStatus(h.id)}"></span>`
					+ `<span class="info"><span class="nm">${esc(h.name || h.host)}</span>`
					+ `<span class="addr">${esc(h.username)}@${esc(h.host)}:${h.port}</span></span>`
					+ `<span class="ops"><button data-op="edit" title="编辑">✎</button><button data-op="del" title="删除">🗑</button></span>`;
				row.addEventListener("click", (ev) => {
					const btn = ev.target.closest("button[data-op]");
					if (!btn) return void toggleConnect(h.id);
					ev.stopPropagation();
					if (btn.dataset.op === "edit") openModal(h);
					else if (confirm(`删除主机「${h.name || h.host}」？`)) void request({ action: "hosts_delete", id: h.id });
				});
				hostsEl.appendChild(row);
			}
		}

		function renderDeps() {
			depsEl.textContent = "";
			if (state.depsOk) return;
			const b = document.createElement("button");
			b.textContent = state.depsInstalling ? "依赖安装中…" : "⚠ 依赖未安装，点击安装 (ssh2)";
			b.disabled = state.depsInstalling;
			b.style.cssText = "all:unset;display:block;width:100%;box-sizing:border-box;padding:8px 12px;cursor:pointer;font-size:12px;color:var(--amber,#fbbf24)";
			if (!state.depsInstalling) b.addEventListener("click", () => void request({ action: "deps_install" }));
			depsEl.appendChild(b);
		}

		function connOfHost(hostId) {
			for (const id of conns.keys()) {
				const meta = state.conns.find((x) => x.connId === id);
				if (meta?.hostId === hostId) return id;
			}
			return null;
		}

		async function toggleConnect(hostId) {
			const existing = connOfHost(hostId);
			if (existing) { activateConn(existing); return; }
			const r = await request({ action: "connect", id: hostId });
			if (!r.ok) { showErr(`连接失败：${r.error}`); renderHosts(); return; }
			await setupConn(r.connId, r.label);
		}

		// ---- 连接工作区 ------------------------------------------------------
		async function setupConn(connId, label) {
			const c = { term: null, fit: null, shellId: null, opened: false, cwd: ".", entries: [] };
			conns.set(connId, c);
			activeConnId = connId;
			activeTab = "term";
			buildTerminal(connId);
			lblEl.textContent = label;
			syncWorkVisibility();
			renderHosts();
			// 探测远端 home 目录作为文件面板起始路径（失败则留在 "."）
			const pwd = await request({ action: "exec", connId, cmd: "pwd" });
			if (pwd.ok && pwd.exitCode === 0 && conns.get(connId) === c) {
				const home = pwd.output.trim().split(/\r?\n/).pop()?.trim();
				if (home?.startsWith("/")) c.cwd = home;
			}
			void listDir();
		}

		function buildTerminal(connId) {
			const c = conns.get(connId);
			const term = new Terminal({
				fontFamily: 'ui-monospace, Consolas, "Cascadia Mono", monospace',
				fontSize: 13,
				cursorBlink: true,
				theme: {
					background: "#101016", foreground: "#e6e6ef",
					cursor: "#7c5cff", selectionBackground: "#7c5cff44",
				},
			});
			const fit = new FitAddon();
			term.loadAddon(fit);
			c.term = term;
			c.fit = fit;
			term.onData((d) => {
				if (c.shellId) ctx.send({ action: "shell_input", connId, shellId: c.shellId, b64: b64.enc(d) });
			});
		}

		async function ensureShell(connId) {
			const c = conns.get(connId);
			if (!c || c.shellId || !c.opened) return;
			// 先挂载拿到真实尺寸再开 shell
			try { c.fit.fit(); } catch {}
			const r = await request({
				action: "shell_open", connId,
				cols: c.term.cols, rows: c.term.rows,
			});
			if (!r.ok) { showErr(`打开终端失败：${r.error}`); return; }
			c.shellId = r.shellId;
			c.term.focus();
		}

		function syncWorkVisibility() {
			const c = conns.get(activeConnId);
			workEl.classList.toggle("vsc-hidden", !c);
			phEl.classList.toggle("vsc-hidden", !!c);
			if (!c) return;
			lblEl.textContent = c.label ?? lblEl.textContent;
			// 标签页可见性
			termWrapEl.classList.toggle("vsc-hidden", activeTab !== "term");
			filesEl.classList.toggle("vsc-hidden", activeTab !== "files");
			// 终端挂载一次
			if (!c.opened) {
				c.opened = true;
				c.term.open(termWrapEl);
				try { c.fit.fit(); } catch {}
				void ensureShell(activeConnId);
				// 尺寸变化 → 重排 + 通知远端
				c.ro = new ResizeObserver(() => {
					try {
						c.fit.fit();
						if (c.shellId) ctx.send({ action: "shell_resize", connId: activeConnId, shellId: c.shellId, cols: c.term.cols, rows: c.term.rows });
					} catch {}
				});
				c.ro.observe(termWrapEl);
			} else if (activeTab === "term") {
				requestAnimationFrame(() => { try { c.fit.fit(); } catch {} });
			}
		}

		root.querySelector(".sshx-topbar .tabs").addEventListener("click", (ev) => {
			const t = ev.target.closest(".tab");
			if (!t) return;
			activeTab = t.dataset.tab;
			root.querySelectorAll(".sshx-topbar .tab").forEach((x) => x.classList.toggle("active", x === t));
			syncWorkVisibility();
			if (activeTab === "files") void listDir(conns.get(activeConnId)?.cwd ?? ".");
			else conns.get(activeConnId)?.term?.focus();
		});

		root.querySelector(".disconnect").addEventListener("click", async () => {
			if (!activeConnId) return;
			await request({ action: "disconnect", connId: activeConnId });
			// conn_closed 事件会做清理
		});

		root.querySelector('.sshx-side-head button[data-act="add"]').addEventListener("click", () => openModal(null));

		// ---- 主机表单 --------------------------------------------------------
		function openModal(host) {
			modalEditId = host?.id ?? null;
			root.querySelector(".m-title").textContent = host ? "编辑主机" : "新建主机";
			const q = (n) => modalBg.querySelector(`input[name="${n}"], textarea[name="${n}"]`); // 注意不能用 f.name——那是 form 自带属性
			q("name").value = host?.name ?? "";
			q("host").value = host?.host ?? "";
			q("port").value = host?.port ?? 22;
			q("username").value = host?.username ?? "root";
			q("password").value = "";
			q("privateKey").value = "";
			q("password").placeholder = host?.hasPass ? "已保存（留空保持不变）" : "";
			q("privateKey").placeholder = host?.hasKey ? "已保存（留空保持不变）" : "-----BEGIN OPENSSH PRIVATE KEY-----";
			modalBg.classList.remove("hidden");
			q("host").focus();
		}
		modalBg.querySelector(".cancel").addEventListener("click", () => modalBg.classList.add("hidden"));
		modalBg.addEventListener("click", (ev) => { if (ev.target === modalBg) modalBg.classList.add("hidden"); });
		modalBg.querySelector(".save-host").addEventListener("click", async () => {
			const q = (n) => modalBg.querySelector(`input[name="${n}"], textarea[name="${n}"]`);
			const body = {
				name: q("name").value.trim(),
				host: q("host").value.trim(),
				port: Number(q("port").value) || 22,
				username: q("username").value.trim() || "root",
				password: q("password").value || undefined,
				privateKey: q("privateKey").value.trim() || undefined,
			};
			if (modalEditId) {
				body.id = modalEditId;
				if (!body.password && !body.privateKey) {
					const h = state.hosts.find((x) => x.id === modalEditId);
					if (!(h?.hasPass || h?.hasKey)) { showErr("请填写密码或私钥"); return; }
				}
			}
			const r = await request({ action: "hosts_save", host: body });
			if (!r.ok) { showErr(`保存失败：${r.error}`); return; }
			modalBg.classList.add("hidden");
		});

		// ---- SFTP 文件面板 ----------------------------------------------------
		async function listDir(dir) {
			const c = conns.get(activeConnId);
			if (!c) return;
			if (dir != null) c.cwd = dir;
			pathInput.value = c.cwd;
			const r = await request({ action: "sftp_list", connId: activeConnId, path: c.cwd });
			if (!r.ok) { showErr(`读取目录失败：${r.error}`); return; }
			c.entries = r.entries;
			renderFiles();
		}

		function fmtSize(n) {
			if (n < 1024) return `${n} B`;
			if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
			if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
			return `${(n / 1073741824).toFixed(2)} GB`;
		}
		function fmtTime(ms) {
			if (!ms) return "";
			return new Date(ms).toLocaleString([], {
				year: "numeric", month: "2-digit", day: "2-digit",
				hour: "2-digit", minute: "2-digit",
			});
		}
		function iconFor(e) {
			if (e.type === "dir") return "📁";
			if (e.type === "link") return "🔗";
			const ext = (e.name.match(/\.([^.]+)$/) || [, ""])[1].toLowerCase();
			return ({ js: "🟨", ts: "🟦", json: "🔧", md: "📝", css: "🎨", html: "🌐", py: "🐍", sh: "💻", png: "🖼", jpg: "🖼" })[ext] || "📄";
		}

		function joinPath(dir, name) {
			if (dir === "." || dir === "" || dir.endsWith("/")) return dir === "." ? name : dir + name;
			return dir + "/" + name;
		}

		function renderFiles() {
			const c = conns.get(activeConnId);
			ftBody.innerHTML = "";
			if (!c) return;
			for (const e of c.entries) {
				const full = e.type === "dir" && e.name === ".." ? parentOf(c.cwd)
					: joinPath(c.cwd, e.name);
				const tr = document.createElement("tr");
				tr.className = "frow";
				tr.innerHTML = `<td>${iconFor(e)} ${esc(e.name)}</td>`
					+ `<td class="sz">${e.type === "dir" ? "—" : fmtSize(e.size)}</td>`
					+ `<td class="mt">${fmtTime(e.mtime)}</td>`
					+ `<td class="ops">${e.name !== ".." ? '<button data-op="ren" title="重命名">✎</button><button data-op="del" title="删除">🗑</button>' : ""}</td>`;
				tr.addEventListener("click", (ev) => {
					const btn = ev.target.closest("button[data-op]");
					if (btn) {
						ev.stopPropagation();
						if (btn.dataset.op === "ren") {
							const nn = prompt("新名称：", e.name);
							if (nn && nn !== e.name) void request({ action: "sftp_rename", connId: activeConnId, path: full, newName: nn }).then((r) => { r.ok ? listDir() : showErr(r.error); });
						} else if (confirm(`删除「${e.name}」？${e.type === "dir" ? "（目录必须为空）" : ""}`)) {
							void request({ action: "sftp_delete", connId: activeConnId, path: full, isDir: e.type === "dir" }).then((r) => { r.ok ? listDir() : showErr(r.error); });
						}
						return;
					}
					if (e.type === "dir") void listDir(full);
					else void openEditor(full);
				});
				ftBody.appendChild(tr);
			}
		}

		function parentOf(dir) {
			if (!dir || dir === "." || dir === "/") return "/";
			const idx = dir.replace(/\/$/, "").lastIndexOf("/");
			return idx <= 0 ? "/" : dir.slice(0, idx);
		}

		pathInput.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter") void listDir(pathInput.value.trim() || ".");
		});
		root.querySelector(".sshx-files-bar .up").addEventListener("click", () => void listDir(parentOf(conns.get(activeConnId)?.cwd ?? ".")));
		root.querySelector(".sshx-files-bar .refresh").addEventListener("click", () => void listDir());
		root.querySelector(".sshx-files-bar .mkdir").addEventListener("click", () => {
			const name = prompt("新文件夹名称：");
			if (name) void request({ action: "sftp_mkdir", connId: activeConnId, path: joinPath(conns.get(activeConnId).cwd, name.trim()) })
				.then((r) => { r.ok ? listDir() : showErr(r.error); });
		});
		root.querySelector(".sshx-files-bar .newfile").addEventListener("click", () => {
			const name = prompt("新文件名称（可带子路径 a/b.txt）：");
			if (name) void request({ action: "sftp_write", connId: activeConnId, path: joinPath(conns.get(activeConnId).cwd, name.trim()), text: "" })
				.then((r) => { r.ok ? (listDir(), openEditor(joinPath(conns.get(activeConnId).cwd, name.trim()))) : showErr(r.error); });
		});

		// ---- 远程编辑器 -------------------------------------------------------
		async function openEditor(path) {
			const r = await request({ action: "sftp_read", connId: activeConnId, path });
			if (!r.ok) { showErr(`打开失败：${r.error}`); return; }
			if (r.binary) { showErr("二进制文件不支持在线编辑"); return; }
			editing = { connId: activeConnId, path, saved: r.text };
			edFn.textContent = path;
			markClean();
			edTa.value = r.text;
			edEl.classList.remove("hidden");
			edTa.focus();
		}
		function markClean() { edSt.textContent = ""; }
		function markDirty() { edSt.textContent = "未保存 ●"; edSt.style.color = "var(--amber,#fbbf24)"; }
		edTa.addEventListener("input", markDirty);
		edTa.addEventListener("keydown", (ev) => {
			if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") { ev.preventDefault(); void saveEditor(); }
			if (ev.key === "Tab") {
				ev.preventDefault();
				const s = edTa.selectionStart, e = edTa.selectionEnd;
				edTa.setRangeText("    ", s, e, "end");
				markDirty();
			}
		});
		async function saveEditor() {
			if (!editing) return;
			const text = edTa.value;
			const r = await request({ action: "sftp_write", connId: editing.connId, path: editing.path, text });
			if (!r.ok) { showErr(`保存失败：${r.error}`); return; }
			editing.saved = text;
			markClean();
		}
		root.querySelector(".sshx-ed-head .save").addEventListener("click", () => void saveEditor());
		root.querySelector(".sshx-ed-head .close").addEventListener("click", () => {
			if (editing && edTa.value !== editing.saved && !confirm("有未保存的修改，确定关闭？")) return;
			editing = null;
			edEl.classList.add("hidden");
		});

		// ---- 启动 ------------------------------------------------------------
		ctx.send({ action: "state" });

		return () => {
			for (const c of conns.values()) {
				try { c.ro?.disconnect(); } catch {}
				try { c.term?.dispose(); } catch {}
			}
			conns.clear();
			offData();
			root.remove();
		};
	},
};
