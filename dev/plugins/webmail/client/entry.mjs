/**
 * webmail 客户端视图 —— 邮件管理界面。
 *
 * 纯 DOM 实现（不依赖主应用 React）。ctx.send() 上行 plugin_message，
 * ctx.onData() 订阅 plugin_data；协议见 index.mjs 的 onMessage 分支。
 * 样式自带 <style>，颜色走主应用的 CSS 变量（主题切换自动跟随）。
 */

let instanceSeq = 0;

function esc(s) {
	return String(s ?? "").replace(/[&<>"']/g, (c) => (
		{ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
	));
}

function fmtDate(iso) {
	if (!iso) return "";
	const d = new Date(iso);
	const today = new Date();
	return d.toDateString() === today.toDateString()
		? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
		: d.toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default {
	mount(container, ctx) {
		container.innerHTML = `
<div class="wmx">
	<style>
		.wmx { max-width: 860px; margin: 0 auto; font-size: 13px; display: grid; gap: 10px; }
		.wmx h2 { margin: 0; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
		.wmx .chip {
			font-size: 11px; padding: 2px 8px; border-radius: 99px;
			border: 1px solid var(--border, #333); opacity: .85;
		}
		.wmx .chip.ok { color: var(--green, #4ade80); border-color: color-mix(in srgb, var(--green, #4ade80) 40%, transparent); }
		.wmx .chip.err { color: var(--red, #f87171); border-color: color-mix(in srgb, var(--red, #f87171) 40%, transparent); }
		.wmx .chip.badge { color: var(--amber, #fbbf24); }
		.wmx button {
			background: var(--bg-elev1, #16161d); color: inherit;
			border: 1px solid var(--border, #333); border-radius: 6px;
			padding: 5px 12px; cursor: pointer; font: inherit;
		}
		.wmx button.primary { background: var(--accent, #7c5cff); color: #fff; border-color: transparent; }
		.wmx button.danger:hover { color: var(--red, #f87171); border-color: var(--red, #f87171); }
		.wmx input, .wmx select, .wmx textarea {
			background: var(--bg-elev1, #16161d); color: inherit;
			border: 1px solid var(--border, #333); border-radius: 6px;
			padding: 5px 8px; font: inherit; resize: vertical;
		}
		.wmx details.settings > summary { cursor: pointer; opacity: .75; user-select: none; }
		.wmx fieldset {
			border: 1px solid var(--border, #333); border-radius: 8px;
			display: grid; grid-template-columns: auto 1fr auto 1fr; gap: 6px 10px;
			padding: 10px; align-items: center; margin: 8px 0 0;
		}
		.wmx fieldset legend { font-size: 11px; opacity: .6; padding: 0 6px; }
		.wmx fieldset label { font-size: 12px; opacity: .7; }
		.wmx .full { grid-column: 1 / -1; }
		.wmx .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
		.wmx .toolbar input[type="search"] { flex: 1; min-width: 160px; }
		.wmx ul.maillist { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
		.wmx ul.maillist li {
			border: 1px solid var(--border, #333); border-radius: 8px;
			padding: 8px 12px; cursor: pointer; display: grid;
			grid-template-columns: minmax(120px, 220px) 1fr auto; gap: 4px 12px;
			align-items: baseline;
		}
		.wmx ul.maillist li:hover { border-color: var(--accent, #7c5cff); }
		.wmx ul.maillist li.active { border-color: var(--accent, #7c5cff); background: color-mix(in srgb, var(--accent, #7c5cff) 8%, transparent); }
		.wmx ul.maillist li.unread { border-left: 3px solid var(--amber, #fbbf24); }
		.wmx ul.maillist .from { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.wmx ul.maillist .subj { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.wmx ul.maillist .date { opacity: .55; font-size: 11px; white-space: nowrap; }
		.wmx .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--amber, #fbbf24); margin-right: 6px; }
		.wmx .reader {
			border: 1px solid var(--border, #333); border-radius: 8px; padding: 12px 14px;
			display: grid; gap: 8px;
		}
		.wmx .reader pre.body {
			margin: 0; white-space: pre-wrap; word-break: break-word;
			font: inherit; max-height: 46vh; overflow: auto;
			background: var(--bg-elev1, #16161d); border-radius: 6px; padding: 10px;
		}
		.wmx .reader .actions { display: flex; gap: 8px; flex-wrap: wrap; }
		.wmx form.compose { display: grid; gap: 8px; border: 1px dashed var(--border, #333); border-radius: 8px; padding: 12px; }
		.wmx form.compose input, .wmx form.compose textarea { width: 100%; box-sizing: border-box; }
		.wmx form.compose .row { display: flex; gap: 8px; justify-content: flex-end; }
		.wmx .hint { opacity: .55; font-size: 11px; margin-top: -4px; }
		.wmx .empty { text-align: center; opacity: .5; padding: 28px 0; grid-column: 1/-1; }
	</style>

	<h2>📬 网页邮箱
		<span class="chip st">…</span>
		<span class="chip unseen badge" hidden></span>
		<span style="flex:1"></span>
		<button class="btn-compose primary">✉ 写邮件</button>
		<button class="btn-refresh">刷新</button>
	</h2>
	<p class="hint deps" hidden>缺少运行依赖（imapflow / mailparser / nodemailer）。
		<button class="btn-deps">安装依赖</button></p>

	<details class="settings">
		<summary>⚙ 账号设置（IMAP / SMTP / 通知 / AI 权限）</summary>
		<form class="cfg">
			<fieldset>
				<legend>收信 IMAP</legend>
				<label>服务器</label><input name="imapHost" placeholder="imap.example.com" />
				<label>端口</label><input name="imapPort" type="number" placeholder="993" />
				<label>用户名</label><input name="imapUser" autocomplete="off" />
				<label>密码 / 授权码</label><input name="imapPass" type="password" autocomplete="new-password" />
				<label class="full"><input type="checkbox" name="imapTls" /> 使用 SSL/TLS（端口通常 993；关闭则 143 明文/STARTTLS）</label>
			</fieldset>
			<fieldset>
				<legend>发信 SMTP</legend>
				<label>服务器</label><input name="smtpHost" placeholder="smtp.example.com" />
				<label>端口</label><input name="smtpPort" type="number" placeholder="465" />
				<label>用户名</label><input name="smtpUser" autocomplete="off" />
				<label>密码 / 授权码</label><input name="smtpPass" type="password" autocomplete="new-password" />
				<label>显示发件人</label><input name="smtpFrom" placeholder="Me &lt;me@example.com&gt;" />
				<label class="full"><input type="checkbox" name="smtpTls" /> 使用 SSL/TLS（端口通常 465）</label>
			</fieldset>
			<fieldset>
				<legend>行为</legend>
				<label>轮询间隔(秒)</label><input name="pollSec" type="number" min="15" />
				<label></label><span></span>
				<label class="full"><input type="checkbox" name="notifyEnabled" /> 新邮件桌面通知条</label>
				<label class="full"><input type="checkbox" name="aiEnabled" />
					允许 AI 管理邮箱 —— 注册 mail_list / mail_read / mail_search / mail_send /
					mail_manage 工具给对话中的智能体（发邮件前 AI 会先向你确认）</label>
			</fieldset>
			<p class="hint">凭据明文保存在本机 &lt;dataDir&gt;/plugins/webmail/config.json，不上传。保存后立即生效，无需重启。</p>
			<div class="row" style="display:flex;justify-content:flex-end"><button type="submit" class="primary">保存并应用</button></div>
		</form>
	</details>

	<div class="toolbar">
		<select class="folder"><option value="INBOX">INBOX</option></select>
		<input type="search" class="q" placeholder="搜索主题 / 发件人…" />
		<button class="btn-search">搜索</button>
		<label style="opacity:.7"><input type="checkbox" class="unseen-only" /> 只看未读</label>
	</div>

	<ul class="maillist"><li class="empty" style="list-style:none;border:0;cursor:default">尚未加载</li></ul>

	<section class="reader" hidden></section>

	<form class="compose" hidden>
		<input name="to" placeholder="收件人 to@example.com" required />
		<input name="subject" placeholder="主题" />
		<textarea name="body" rows="6" placeholder="正文…"></textarea>
		<div class="row">
			<button type="button" class="btn-cancel">取消</button>
			<button type="submit" class="primary">发送</button>
		</div>
	</form>
</div>`;

		const root = container.querySelector(".wmx");
		const $ = (sel) => root.querySelector(sel);
		const st = { mails: [], activeUid: null };

		function setStateChips(state) {
			const chip = $(".st");
			chip.textContent = state.status || "未知";
			chip.className = `chip st ${state.configured ? (state.status.startsWith("连接失败") ? "err" : "ok") : ""}`;
			const badge = $(".unseen");
			badge.hidden = !state.unseen;
			badge.textContent = `${state.unseen} 封未读`;
			$(".deps").hidden = state.depsOk || state.depsInstalling;
			$(".btn-deps").disabled = Boolean(state.depsInstalling);
			$(".btn-deps").textContent = state.depsInstalling ? "安装中…" : "安装依赖";
		}

		function fillSettings(cfg) {
			if (!cfg) return;
			const f = $(".cfg");
			f.imapHost.value = cfg.imap?.host ?? "";
			f.imapPort.value = cfg.imap?.port ?? 993;
			f.imapUser.value = cfg.imap?.user ?? "";
			f.imapPass.placeholder = cfg.imap?.hasPass ? "已保存（输入可覆盖）" : "密码";
			f.imapTls.checked = cfg.imap?.tls !== false;
			f.smtpHost.value = cfg.smtp?.host ?? "";
			f.smtpPort.value = cfg.smtp?.port ?? 465;
			f.smtpUser.value = cfg.smtp?.user ?? "";
			f.smtpPass.placeholder = cfg.smtp?.hasPass ? "已保存（输入可覆盖）" : "密码";
			f.smtpFrom.value = cfg.smtp?.from ?? "";
			f.smtpTls.checked = cfg.smtp?.tls !== false;
			f.pollSec.value = cfg.pollSec ?? 60;
			f.notifyEnabled.checked = cfg.notifyEnabled !== false;
			f.aiEnabled.checked = Boolean(cfg.aiEnabled);
		}

		function renderList() {
			const ul = $(".maillist");
			if (!st.mails.length) {
				ul.innerHTML = `<li class="empty" style="list-style:none;border:0;cursor:default">${
					st.mails.length === 0 ? "没有匹配的邮件" : "尚未加载"
				}</li>`;
				return;
			}
			ul.innerHTML = st.mails
				.map(
					(m) => `
<li data-uid="${m.uid}" class="${m.seen ? "" : "unread"}${m.uid === st.activeUid ? " active" : ""}">
	<span class="from">${m.seen ? "" : '<span class="dot"></span>'}${esc(m.fromName || m.from)}</span>
	<span class="subj">${esc(m.subject)}</span>
	<span class="date">${esc(fmtDate(m.date))}</span>
</li>`,
				)
				.join("");
		}

		function renderReader(mail) {
			const r = $(".reader");
			r.hidden = false;
			r.innerHTML = `
<div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap">
	<b style="font-size:14px">${esc(mail.subject)}</b>
	<span style="opacity:.55;font-size:11px">${esc(fmtDate(mail.date))}</span>
</div>
<div style="opacity:.7;font-size:12px">${esc(mail.fromName)} &lt;${esc(mail.from)}&gt; → ${esc(mail.to)}
	${mail.hasAttachments ? " · 📎 含附件（正文下方不展示）" : ""}</div>
<pre class="body">${esc(mail.text)}${mail.truncated ? "\n\n…(过长截断)" : ""}</pre>
<div class="actions">
	<button class="act-toggle-seen">${mail.seen ? "标为未读" : "标为已读"}</button>
	<button class="act-delete danger">删除</button>
	<button class="act-reply">回复</button>
</div>`;
			$(".act-toggle-seen").onclick = () =>
				ctx.send({ action: "mark", uids: [mail.uid], seen: !mail.seen });
			$(".act-delete").onclick = () => ctx.send({ action: "delete", uids: [mail.uid] });
			$(".act-reply").onclick = () => openCompose({ to: mail.from, subject: `Re: ${mail.subject}` });
		}

		function openCompose(prefill = {}) {
			const f = $("form.compose");
			f.hidden = false;
			f.to.value = prefill.to ?? "";
			f.subject.value = prefill.subject ?? "";
			if (prefill.to) f.body.focus();
			else f.to.focus();
		}

		async function refreshList() {
			ctx.send({
				action: "list",
				folder: $(".folder").value,
				unseenOnly: $(".unseen-only").checked,
			});
		}

		// ---- events ----
		root.addEventListener("click", async (e) => {
			const li = e.target.closest("ul.maillist li[data-uid]");
			if (li) {
				st.activeUid = Number(li.dataset.uid);
				renderList();
				ctx.send({ action: "read", folder: $(".folder").value, uid: st.activeUid });
				return;
			}
			if (e.target.closest(".btn-refresh")) refreshList();
			if (e.target.closest(".btn-compose")) openCompose();
			if (e.target.closest(".btn-deps")) ctx.send({ action: "install_deps" });
			if (e.target.closest(".btn-search")) {
				const q = $(".q").value.trim();
				if (q) ctx.send({ action: "search", query: q, folder: $(".folder").value });
				else refreshList();
			}
		});
		root.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && e.target.classList.contains("q")) $(".btn-search").click();
		});
		$(".unseen-only").addEventListener("change", refreshList);

		$(".cfg").addEventListener("submit", (e) => {
			e.preventDefault();
			const f = e.target;
			const cfg = {
				imap: {
					host: f.imapHost.value.trim(),
					port: Number(f.imapPort.value) || 993,
					tls: f.imapTls.checked,
					user: f.imapUser.value.trim(),
					pass: f.imapPass.value || undefined, // 留空=沿用已存值
				},
				smtp: {
					host: f.smtpHost.value.trim(),
					port: Number(f.smtpPort.value) || 465,
					tls: f.smtpTls.checked,
					user: f.smtpUser.value.trim(),
					pass: f.smtpPass.value || undefined,
					from: f.smtpFrom.value.trim(),
				},
				pollSec: Math.max(15, Number(f.pollSec.value) || 60),
				notifyEnabled: f.notifyEnabled.checked,
				aiEnabled: f.aiEnabled.checked,
			};
			// 清掉 undefined 让服务端 merge 语义生效（空密码字段保留旧值）
			for (const box of ["imap", "smtp"]) {
				for (const k of Object.keys(cfg[box])) {
					if (cfg[box][k] === undefined) delete cfg[box][k];
				}
			}
			ctx.send({ action: "save_config", config: cfg });
		});

		$("form.compose").addEventListener("submit", (e) => {
			e.preventDefault();
			const f = e.target;
			ctx.send({
				action: "send",
				to: f.to.value.trim(),
				subject: f.subject.value,
				body: f.body.value,
			});
			f.reset();
			f.hidden = true;
		});
		$("form.compose .btn-cancel").addEventListener("click", () => {
			$("form.compose").reset();
			$("form.compose").hidden = true;
		});

		// ---- server → view ----
		const off = ctx.onData((payload) => {
			const msg = payload ?? {};
			switch (msg.kind) {
				case "state":
					setStateChips(msg.state);
					fillSettings(msg.config);
					break;
				case "mails":
					st.mails = msg.mails ?? [];
					renderList();
					break;
				case "mail":
					renderReader(msg.mail);
					break;
				case "new-mail":
					refreshList();
					break;
				case "result":
					if (msg.action === "mark" || msg.action === "delete") {
						if (msg.action === "delete") $(".reader").hidden = true;
						refreshList();
					}
					break;
			}
		});

		ctx.send({ action: "get_state" });
		refreshList();

		instanceSeq += 1; // 实例计数（保留挂载/卸载对称性）
		return () => {
			off();
			root.remove();
		};
	},
};
