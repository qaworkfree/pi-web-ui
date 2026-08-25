/**
 * vscode-editor 客户端视图 —— 类 VSCode 的轻量编辑器。
 *
 * 技术栈：CodeMirror 6（经 esbuild 打包进本文件，无运行时外部依赖）。
 * 布局：左侧文件树 + 右侧多标签编辑区 + 底部状态栏；Ctrl+P 快速打开、
 * Ctrl+S 保存。纯 DOM 实现，颜色走主应用 CSS 变量（主题切换自动跟随）。
 *
 * 与服务端（index.mjs）的协议：{ action, reqId, ... } 上行，
 * { res:true, reqId, ok, ... } 下行，reqId 匹配并发响应。
 */
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor, dropCursor, highlightSpecialChars } from "@codemirror/view";
import { EditorState, Compartment, Prec } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { lintKeymap } from "@codemirror/lint";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";

function esc(s) {
	return String(s ?? "").replace(/[&<>"']/g, (c) => (
		{ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
	));
}

let reqSeq = 0;

// ---- 语言检测 -----------------------------------------------------------

const LANGS = [
	[/\.(jsx?|mjs|cjs)$/, () => javascript()],
	[/\.tsx?$/, () => javascript({ typescript: true })],
	[/\.json5?$/, () => json()],
	[/\.css$/, () => css()],
	[/\.(html?|vue|svelte)$/, () => html()],
	[/\.(md|markdown)$/, () => markdown()],
	[/\.py$/, () => python()],
];

function langFor(path) {
	const p = path.toLowerCase();
	for (const [re, make] of LANGS) if (re.test(p)) return make();
	return null;
}

function langName(path) {
	if (/\.tsx?$/.test(path)) return "TypeScript";
	if (/\.(jsx?|mjs|cjs)$/.test(path)) return "JavaScript";
	if (/\.json5?$/.test(path)) return "JSON";
	if (/\.css$/.test(path)) return "CSS";
	if (/\.(html?|vue|svelte)$/.test(path)) return "HTML";
	if (/\.(md|markdown)$/.test(path)) return "Markdown";
	if (/\.py$/.test(path)) return "Python";
	return "Plain Text";
}

// ---- 文件图标 ------------------------------------------------------------

function iconFor(name, type) {
	if (type === "dir") return "📁";
	const ext = (name.match(/\.([^.]+)$/) || [, ""])[1].toLowerCase();
	const map = {
		js: "🟨", mjs: "🟨", cjs: "🟨", jsx: "⚛️", ts: "🟦", tsx: "⚛️",
		json: "🔧", md: "📝", css: "🎨", html: "🌐", py: "🐍",
		png: "🖼", jpg: "🖼", jpeg: "🖼", gif: "🖼", webp: "🖼", svg: "🖼",
		lock: "🔒", yml: "⚙️", yaml: "⚙️", toml: "⚙️", sh: "💻", bat: "💻",
	};
	return map[ext] || "📄";
}

// ---- 模糊匹配（快速打开 Ctrl+P 用）：返回得分或 -1 -----------------------

export function fuzzyScore(query, target) {
	const q = query.toLowerCase();
	const t = target.toLowerCase();
	let qi = 0, score = 0, streak = 0;
	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] === q[qi]) {
			streak++;
			score += 1 + streak; // 连续命中加权
			qi++;
		} else streak = 0;
	}
	if (qi < q.length) return -1;
	// 短文件名 / 靠前命中加分
	score += Math.max(0, 40 - t.length) / 10;
	return score;
}

export default {
	mount(container, ctx) {
		container.innerHTML = `
<div class="vsc">
	<style>
		.vsc { position: relative; display: flex; height: 100%; min-height: 480px;
			border: 1px solid var(--border, #333); border-radius: 10px; overflow: hidden;
			background: var(--bg-elev0, #101016); color: var(--text, #e6e6ef); font-size: 13px; }
		.vsc-side { width: 240px; min-width: 160px; flex-shrink: 0; display: flex; flex-direction: column;
			border-right: 1px solid var(--border, #333); background: var(--bg-elev1, #16161d); }
		.vsc-side-head { display: flex; align-items: center; gap: 4px; padding: 8px 10px 6px;
			font-size: 11px; letter-spacing: .08em; text-transform: uppercase; opacity: .85; }
		.vsc-side-head b { flex: 1; font-weight: 600; }
		.vsc-side-head button { all: unset; cursor: pointer; padding: 2px 5px; border-radius: 4px; font-size: 12px; }
		.vsc-side-head button:hover { background: var(--bg-elev2, #20202b); }
		.vsc-tree { flex: 1; overflow: auto; padding: 2px 0 12px; user-select: none; }
		.vsc-row { display: flex; align-items: center; gap: 5px; padding: 2px 8px; cursor: pointer;
			white-space: nowrap; line-height: 1.7; }
		.vsc-row:hover { background: var(--bg-elev2, #20202b); }
		.vsc-row.active { background: color-mix(in srgb, var(--accent, #7c5cff) 22%, transparent); }
		.vsc-row .caret { width: 12px; text-align: center; opacity: .55; font-size: 9px; flex-shrink: 0; }
		.vsc-row .nm { overflow: hidden; text-overflow: ellipsis; }
		.vsc-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
		.vsc-tabs { display: flex; overflow-x: auto; border-bottom: 1px solid var(--border, #333);
			background: var(--bg-elev1, #16161d); scrollbar-width: thin; }
		.vsc-tab { display: inline-flex; align-items: center; gap: 6px; padding: 6px 8px 6px 12px;
			cursor: pointer; border-right: 1px solid var(--border, #333); white-space: nowrap;
			color: var(--text-dim, #9a9ab0); max-width: 200px; }
		.vsc-tab.active { background: var(--bg-elev0, #101016); color: var(--text, #e6e6ef);
			box-shadow: inset 0 2px 0 var(--accent, #7c5cff); }
		.vsc-tab .tn { overflow: hidden; text-overflow: ellipsis; }
		.vsc-tab .dot { color: var(--amber, #fbbf24); }
		.vsc-tab .x { all: unset; cursor: pointer; padding: 0 3px; border-radius: 4px; opacity: .55; }
		.vsc-tab .x:hover { opacity: 1; background: var(--bg-elev2, #20202b); }
		.vsc-edwrap { flex: 1; min-height: 0; position: relative; }
		.vsc-empty { position: absolute; inset: 0; display: grid; place-items: center;
			opacity: .45; text-align: center; line-height: 2; }
		.vsc-editor { height: 100%; }
		.vsc-editor .cm-editor { height: 100%; }
		.vsc-editor .cm-scroller { font-family: ui-monospace, Consolas, "Cascadia Mono", monospace; }
		.vsc-status { display: flex; align-items: center; gap: 14px; padding: 4px 12px;
			border-top: 1px solid var(--border, #333); background: var(--bg-elev1, #16161d);
			font-size: 11.5px; color: var(--text-dim, #9a9ab0); }
		.vsc-status .grow { flex: 1; }
		.vsc-status .dirty { color: var(--amber, #fbbf24); }
		.vsc-err { color: var(--red, #f87171); }
		/* 快速打开弹层 */
		.vsc-quickopen { position: absolute; left: 50%; top: 40px; transform: translateX(-50%);
			width: min(520px, 80%); z-index: 30; background: var(--bg-elev2, #20202b);
			border: 1px solid var(--border, #444); border-radius: 10px;
			box-shadow: 0 12px 40px rgba(0,0,0,.45); overflow: hidden; }
		.vsc-quickopen input { width: 100%; box-sizing: border-box; background: transparent; color: inherit;
			border: 0; outline: 0; padding: 10px 14px; font: inherit; border-bottom: 1px solid var(--border, #333); }
		.vsc-quickopen ul { list-style: none; margin: 0; padding: 4px 0; max-height: 300px; overflow: auto; }
		.vsc-quickopen li { padding: 5px 14px; cursor: pointer; display: flex; gap: 8px; align-items: baseline; }
		.vsc-quickopen li.sel, .vsc-quickopen li:hover { background: color-mix(in srgb, var(--accent, #7c5cff) 25%, transparent); }
		.vsc-quickopen li small { opacity: .5; margin-left: auto; direction: rtl; }
		.vsc-hidden { display: none !important; }
		/* 树上右键菜单 */
		.vsc-menu { position: absolute; z-index: 40; min-width: 150px; background: var(--bg-elev2, #20202b);
			border: 1px solid var(--border, #444); border-radius: 8px; padding: 4px;
			box-shadow: 0 10px 30px rgba(0,0,0,.4); }
		.vsc-menu button { all: unset; display: block; width: 100%; box-sizing: border-box; cursor: pointer;
			padding: 5px 10px; border-radius: 5px; font: inherit; }
		.vsc-menu button:hover { background: color-mix(in srgb, var(--accent, #7c5cff) 30%, transparent); }
	</style>
	<div class="vsc-side">
		<div class="vsc-side-head">
			<b>资源管理器</b>
			<button data-act="new-file" title="新建文件">＋📄</button>
			<button data-act="new-dir" title="新建文件夹">＋📁</button>
			<button data-act="refresh" title="刷新">⟳</button>
		</div>
		<div class="vsc-tree"></div>
	</div>
	<div class="vsc-main">
		<div class="vsc-tabs"></div>
		<div class="vsc-edwrap">
			<div class="vsc-empty">从左侧打开一个文件开始编辑<br><small>Ctrl+P 快速打开 · Ctrl+S 保存</small></div>
			<div class="vsc-editor vsc-hidden"></div>
		</div>
		<div class="vsc-status">
			<span class="vsc-path">—</span>
			<span class="grow"></span>
			<span class="vsc-lang"></span>
			<span class="vsc-pos"></span>
			<span class="vsc-state"></span>
		</div>
	</div>
	<div class="vsc-quickopen vsc-hidden">
		<input placeholder="输入文件名筛选…（Esc 关闭）" />
		<ul></ul>
	</div>
	<div class="vsc-menu vsc-hidden"></div>
</div>`;

		const root = container.querySelector(".vsc");
		const treeEl = root.querySelector(".vsc-tree");
		const tabsEl = root.querySelector(".vsc-tabs");
		const edHost = root.querySelector(".vsc-editor");
		const emptyEl = root.querySelector(".vsc-empty");
		const stPath = root.querySelector(".vsc-path");
		const stLang = root.querySelector(".vsc-lang");
		const stPos = root.querySelector(".vsc-pos");
		const stState = root.querySelector(".vsc-state");
		const quick = root.querySelector(".vsc-quickopen");
		const quickInput = quick.querySelector("input");
		const quickList = quick.querySelector("ul");
		const menuEl = root.querySelector(".vsc-menu");

		// ---- 请求/响应 -------------------------------------------------------
		const pending = new Map(); // reqId → {resolve}
		function request(payload) {
			const reqId = `r${++reqSeq}`;
			return new Promise((resolve) => {
				pending.set(reqId, resolve);
				ctx.send({ ...payload, reqId });
				setTimeout(() => {
					if (pending.delete(reqId)) resolve({ ok: false, error: "请求超时" });
				}, 30000);
			});
		}
		const offData = ctx.onData((payload) => {
			if (!payload || !payload.res) return;
			const p = pending.get(payload.reqId);
			if (!p) return;
			pending.delete(payload.reqId);
			p(payload);
		});

		function toast(text) {
			root.dispatchEvent(new CustomEvent("vsc-toast", { detail: text, bubbles: true }));
			// 无宿主 toast 时退化为状态栏错误显示
			stState.textContent = text;
			stState.classList.add("vsc-err");
			setTimeout(() => { stState.textContent = ""; stState.classList.remove("vsc-err"); }, 4000);
		}

		// ---- 状态 ------------------------------------------------------------
		const expanded = new Set([""]); // 已展开目录（"" = 根）
		const dirCache = new Map(); // 目录路径 wire → entries
		const flatFiles = new Map(); // path → true（Ctrl+P 数据源）
		const tabs = new Map(); // path → {path, name, savedText, binary}
		let activePath = null;

		// ---- 编辑器 ----------------------------------------------------------
		const langComp = new Compartment();

		function makeExtensions() {
			return [
				lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(),
				history(), foldGutter(), drawSelection(), dropCursor(),
				EditorState.allowMultipleSelections.of(true),
				indentOnInput(), indentUnit.of("    "), syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
				bracketMatching(), closeBrackets(), autocompletion(), rectangularSelection(),
				crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
				keymap.of([
					...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap,
					...historyKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap,
					indentWithTab,
					// 最高优先级：编辑器内 Ctrl+S / Ctrl+P 不被默认 keymap 吃掉
					Prec.highest(keymap.of([
						{ key: "Mod-s", run: () => { void saveActive(); return true; } },
						{ key: "Mod-p", run: () => { openQuickOpen(); return true; } },
					])),
				]),
				langComp.of(langFor(activePath ?? "") ?? []),
				oneDark,
				EditorView.updateListener.of((u) => {
					if (u.docChanged || u.selectionSet) updateStatus(u.state);
					if (u.docChanged) renderTabs();
				}),
			];
		}

		const view = new EditorView({ state: EditorState.create({ extensions: makeExtensions() }), parent: edHost });

		function currentDoc() { return view.state.doc.toString(); }

		function isDirty(tab) {
			return tab && !tab.binary && view && activePath === tab.path
				? currentDoc() !== tab.savedText
				: false;
		}

		function updateStatus(state) {
			const head = state.selection.main.head;
			const line = state.doc.lineAt(head);
			stPos.textContent = `第 ${line.number} 行 · 第 ${head - line.from + 1} 列`;
			if (activePath) {
				const t = tabs.get(activePath);
				stState.textContent = t?.binary ? "二进制（只读）"
					: currentDoc() !== t?.savedText ? "未保存 ●" : "已保存";
				stState.classList.toggle("dirty", t?.binary ? false : currentDoc() !== t?.savedText);
			}
		}

		// ---- 文件树渲染 ------------------------------------------------------
		async function ensureDir(dirWire) {
			if (!dirCache.has(dirWire)) {
				const r = await request({ action: "list", dir: dirWire });
				if (!r.ok) { toast(`读取目录失败：${r.error}`); return []; }
				dirCache.set(dirWire, r.entries);
				for (const e of r.entries) {
					if (e.type === "file") flatFiles.set(dirWire ? `${dirWire}/${e.name}` : e.name, true);
				}
			}
			return dirCache.get(dirWire);
		}

		async function renderTree() {
			treeEl.innerHTML = "";
			await renderDir("", treeEl, 0);
		}

		async function renderDir(dirWire, parentEl, depth) {
			const entries = await ensureDir(dirWire);
			for (const e of entries) {
				const p = dirWire ? `${dirWire}/${e.name}` : e.name;
				const row = document.createElement("div");
				row.className = "vsc-row" + (p === activePath ? " active" : "");
				row.style.paddingLeft = `${8 + depth * 14}px`;
				row.dataset.path = p;
				row.dataset.type = e.type;
				const isOpen = expanded.has(p);
				row.innerHTML = `<span class="caret">${e.type === "dir" ? (isOpen ? "▾" : "▸") : ""}</span>`
					+ `<span>${iconFor(e.name, e.type)}</span><span class="nm">${esc(e.name)}</span>`;
				row.addEventListener("click", async () => {
					if (e.type === "dir") {
						if (expanded.has(p)) expanded.delete(p);
						else expanded.add(p);
						await renderTree();
					} else {
						void openFile(p);
					}
				});
				row.addEventListener("contextmenu", (ev) => {
					ev.preventDefault();
					ev.stopPropagation();
					showMenu(ev.clientX, ev.clientY, p, e.type);
				});
				parentEl.appendChild(row);
				if (e.type === "dir" && isOpen) {
					const sub = document.createElement("div");
					parentEl.appendChild(sub);
					await renderDir(p, sub, depth + 1);
				}
			}
		}

		// ---- 标签页 ----------------------------------------------------------
		function renderTabs() {
			tabsEl.innerHTML = "";
			for (const t of tabs.values()) {
				const el = document.createElement("div");
				el.className = "vsc-tab" + (t.path === activePath ? " active" : "");
				el.innerHTML = `<span>${iconFor(t.name, "file")}</span><span class="tn">${esc(t.name)}</span>`
					+ (isDirty(t) ? '<span class="dot">●</span>' : "")
					+ `<button class="x" title="关闭">✕</button>`;
				el.addEventListener("click", (ev) => {
					if (ev.target.closest(".x")) return;
					void activateTab(t.path);
				});
				el.querySelector(".x").addEventListener("click", () => void closeTab(t.path));
				tabsEl.appendChild(el);
			}
		}

		async function openFile(p) {
			if (!tabs.has(p)) {
				const r = await request({ action: "read", path: p });
				if (!r.ok) { toast(`打开失败：${r.error}`); return; }
				tabs.set(p, { path: p, name: p.split("/").pop(), savedText: r.text ?? "", binary: !!r.binary });
				if (r.binary) { toast("二进制文件暂不支持编辑"); }
			}
			await activateTab(p);
		}

		async function activateTab(p) {
			const t = tabs.get(p);
			if (!t) return;
			activePath = p;
			emptyEl.classList.add("vsc-hidden");
			edHost.classList.remove("vsc-hidden");
			view.setState(EditorState.create({
				doc: t.binary ? "" : t.savedText,
				extensions: makeExtensions(),
			}));
			view.dispatch({ effects: langComp.reconfigure(langFor(p) ?? []) });
			stPath.textContent = p;
			stLang.textContent = langName(p);
			renderTabs();
			renderTreeHighlight();
			updateStatus(view.state);
			view.focus();
		}

		function renderTreeHighlight() {
			treeEl.querySelectorAll(".vsc-row").forEach((el) =>
				el.classList.toggle("active", el.dataset.path === activePath && el.dataset.type === "file"));
		}

		async function saveActive() {
			if (!activePath) return false;
			const t = tabs.get(activePath);
			if (!t || t.binary) return false;
			const text = currentDoc();
			const r = await request({ action: "write", path: activePath, text });
			if (!r.ok) { toast(`保存失败：${r.error}`); return true; }
			t.savedText = text;
			renderTabs();
			updateStatus(view.state);
			return true;
		}

		async function closeTab(p) {
			const t = tabs.get(p);
			if (t && activePath === p && currentDoc() !== t.savedText
				&& !confirm(`「${t.name}」有未保存的修改，确定关闭？`)) return;
			tabs.delete(p);
			if (activePath === p) {
				activePath = null;
				if (tabs.size) await activateTab([...tabs.keys()].pop());
				else {
					emptyEl.classList.remove("vsc-hidden");
					edHost.classList.add("vsc-hidden");
					stPath.textContent = "—"; stLang.textContent = ""; stPos.textContent = ""; stState.textContent = "";
					renderTabs();
				}
			} else renderTabs();
		}

		// ---- 快速打开（Ctrl+P） ----------------------------------------------
		let flatLoaded = false;
		async function loadFlat() {
			if (flatLoaded) return;
			const r = await request({ action: "flatlist" });
			if (r.ok) {
				flatLoaded = true;
				for (const f of r.files) flatFiles.set(f, true);
				if (r.truncated) toast("文件较多，列表已截断");
			}
		}

		let quickSel = 0;
		function quickMatches() {
			const q = quickInput.value.trim();
			const all = [...flatFiles.keys()];
			if (!q) return all.slice(0, 100);
			return all
				.map((f) => ({ f, s: fuzzyScore(q, f.split("/").pop()) + fuzzyScore(q, f) * 0.3 }))
				.filter((x) => x.s >= 0)
				.sort((a, b) => b.s - a.s)
				.slice(0, 100)
				.map((x) => x.f);
		}

		function renderQuick() {
			const ms = quickMatches();
			quickSel = Math.min(quickSel, Math.max(0, ms.length - 1));
			quickList.innerHTML = ms.map((f, i) =>
				`<li data-p="${esc(f)}" class="${i === quickSel ? "sel" : ""}">`
				+ `${iconFor(f.split("/").pop(), "file")} ${f.split("/").pop()}<small>${esc(f)}</small></li>`).join("")
				|| `<li style="opacity:.5;cursor:default">无匹配文件</li>`;
		}

		function openQuickOpen() {
			void loadFlat().then(() => { quickSel = 0; renderQuick(); quick.classList.remove("vsc-hidden"); quickInput.focus(); quickInput.select(); });
		}

		function closeQuickOpen() { quick.classList.add("vsc-hidden"); }

		quickInput.addEventListener("input", () => { quickSel = 0; renderQuick(); });
		quickInput.addEventListener("keydown", (ev) => {
			const ms = quickMatches();
			if (ev.key === "Escape") { closeQuickOpen(); view.focus(); }
			else if (ev.key === "ArrowDown") { quickSel = Math.min(quickSel + 1, ms.length - 1); renderQuick(); ev.preventDefault(); }
			else if (ev.key === "ArrowUp") { quickSel = Math.max(quickSel - 1, 0); renderQuick(); ev.preventDefault(); }
			else if (ev.key === "Enter" && ms[quickSel]) { closeQuickOpen(); void openFile(ms[quickSel]); }
		});
		quickList.addEventListener("click", (ev) => {
			const li = ev.target.closest("li[data-p]");
			if (li) { closeQuickOpen(); void openFile(li.dataset.p); }
		});

		// ---- 右键菜单 --------------------------------------------------------
		function showMenu(x, y, pathW, type) {
			menuEl.innerHTML = "";
			const items = [];
			if (type === "dir") {
				items.push(
					["新建文件", async () => { await promptCreate(pathW, "file"); }],
					["新建文件夹", async () => { await promptCreate(pathW, "dir"); }],
				);
			}
			items.push(
				["重命名", async () => {
					const nn = prompt("新名称：", pathW.split("/").pop());
					if (!nn || nn === pathW.split("/").pop()) return;
					const parent = pathW.includes("/") ? pathW.slice(0, pathW.lastIndexOf("/")) : "";
					const newPath = parent ? `${parent}/${nn}` : nn;
					const r = await request({ action: "rename", path: pathW, newName: nn });
					if (!r.ok) { toast(`重命名失败：${r.error}`); return; }
					dirCache.clear(); flatFiles.clear(); flatLoaded = false; expanded.clear(); expanded.add("");
					await refreshAll();
				}],
				["删除", async () => {
					if (!confirm(`确定删除「${pathW}」？（不可撤销）`)) return;
					const r = await request({ action: "delete", path: pathW });
					if (!r.ok) { toast(`删除失败：${r.error}`); return; }
					// 关闭被删文件（或其子目录下）的活跃标签
					if (activePath && (activePath === pathW || activePath.startsWith(pathW + "/"))) void closeTab(activePath);
					dirCache.clear(); flatFiles.clear(); flatLoaded = false; expanded.clear(); expanded.add("");
					await refreshAll();
				}],
			);
			for (const [label, fn] of items) {
				const b = document.createElement("button");
				b.textContent = label;
				b.addEventListener("click", () => { hideMenu(); void fn(); });
				menuEl.appendChild(b);
			}
			menuEl.classList.remove("vsc-hidden");
			// 限制在容器内
			const rect = root.getBoundingClientRect();
			menuEl.style.left = `${Math.min(x - rect.left, rect.width - 170)}px`;
			menuEl.style.top = `${Math.min(y - rect.top, rect.height - items.length * 32 - 20)}px`;
		}
		function hideMenu() { menuEl.classList.add("vsc-hidden"); }
		document.addEventListener("click", hideMenu);

		async function promptCreate(dirWire, kind) {
			const name = prompt(kind === "dir" ? "新文件夹名称：" : "新文件名称（可带子路径 a/b.js）：");
			if (!name) return;
			const p = dirWire ? `${dirWire}/${name.trim()}` : name.trim();
			const r = await request({ action: "create", path: p, kind });
			if (!r.ok) { toast(`创建失败：${r.error}`); return; }
			expanded.add(dirWire);
			if (kind === "file") { void openFile(p); }
			await refreshAll(true);
		}

		/** 全量刷新：清缓存重拉（结构变化后调用）；keepTabs=保留标签内容 */
		async function refreshAll(keepTabs) {
			dirCache.clear();
			flatFiles.clear();
			flatLoaded = false;
			if (!keepTabs) {
				for (const t of tabs.values()) {
					if (t.binary) continue;
					const r = await request({ action: "read", path: t.path });
					if (r.ok && r.text != null) t.savedText = r.text;
				}
			}
			await renderTree();
			renderTabs();
		}

		// ---- 工具栏 & 全局快捷键 ---------------------------------------------
		root.querySelector('.vsc-side-head').addEventListener("click", (ev) => {
			const btn = ev.target.closest("button[data-act]");
			if (!btn) return;
			const act = btn.dataset.act;
			if (act === "refresh") { void refreshAll(); }
			else if (act === "new-file") { void promptCreate("", "file"); }
			else if (act === "new-dir") { void promptCreate("", "dir"); }
		});

		function onGlobalKey(ev) {
			if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "p") {
				ev.preventDefault();
				openQuickOpen();
			} else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
				ev.preventDefault();
				void saveActive();
			} else if (ev.key === "Escape" && !quick.classList.contains("vsc-hidden")) {
				closeQuickOpen();
			}
		}
		container.ownerDocument.addEventListener("keydown", onGlobalKey, true);

		// ---- 启动 ------------------------------------------------------------
		void renderTree();

		return () => {
			container.ownerDocument.removeEventListener("keydown", onGlobalKey, true);
			document.removeEventListener("click", hideMenu);
			offData();
			view.destroy();
			root.remove();
		};
	},
};
