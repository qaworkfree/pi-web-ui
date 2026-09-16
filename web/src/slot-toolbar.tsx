import type { UiSlotEntry } from "./ui-slots";

/** 工具条槽位通用渲染（terminal.toolbar / scm.toolbar / goalbar.actions / chat.header /
 *  chat.empty / file.preview.toolbar 共用形状 —— ui-slots.ts 只做合并，不放渲染）。
 *  toggle 显示 checked 态（aria-pressed + .on），progress 显示条，input 渲染小输入框
 *  （回车触发 action），其余画成按钮（title=hint||label，点击交回 onUiAction）。
 *  无条目返回 null。
 *
 *  单独成模块的原因：TerminalPanel.tsx 静态 import 会把 xterm 拉进主包
 *  （App 对 TerminalPanel 用 lazy 拆包，见 App.tsx）。各渲染层都从这里 import，
 *  TerminalPanel 只 re-export 保持兼容。
 */
export function renderSlotToolbar(
	entries: UiSlotEntry[] | undefined,
	onUiAction: ((item: UiSlotEntry, value?: string) => void) | undefined,
) {
	if (!entries || entries.length === 0) return null;
	return (
		<span className="slot-toolbar">
			{entries.map((entry, i) => {
				const key = `${entry.id}#${i}`;
				const label = entry.label || entry.id;
				const tip = entry.hint || label;
				if (entry.kind === "divider") return <span key={key} className="slot-divider" aria-hidden="true" />;
				if (entry.kind === "badge")
					return (
						<span key={key} className="slot-badge" title={tip}>
							{entry.badge ?? label}
						</span>
					);
				if (entry.kind === "toggle")
					return (
						<button
							key={key}
							type="button"
							className={`slot-btn${entry.checked ? " on" : ""}`}
							title={tip}
							aria-label={label}
							aria-pressed={!!entry.checked}
							onClick={() => onUiAction?.(entry)}
						>
							{entry.icon ? <span aria-hidden>{entry.icon}</span> : null}
							<span>{label}</span>
						</button>
					);
				if (entry.kind === "progress")
					return (
						<span key={key} className="slot-progress" title={`${tip} ${entry.progress ?? 0}%`}>
							<progress value={entry.progress ?? 0} max={100} />
						</span>
					);
				if (entry.kind === "input")
					return (
						<input
							key={`${key}:${entry.value ?? ""}`}
							className="slot-input"
							defaultValue={entry.value ?? ""}
							placeholder={label}
							title={tip}
							aria-label={label}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.nativeEvent.isComposing)
									onUiAction?.(entry, (e.target as HTMLInputElement).value);
							}}
						/>
					);
				// kind="select"：下拉框（当前值取 value ?? options[0]；切换直接回插件）。
				if (entry.kind === "select" && entry.options?.length)
					return (
						<select
							key={key}
							className="slot-select"
							title={tip}
							aria-label={label}
							value={
								entry.options.some((o) => o.value === entry.value) ? (entry.value as string) : entry.options[0]!.value
							}
							onChange={(e) => onUiAction?.(entry, e.target.value)}
						>
							{entry.options.map((o) => (
								<option key={o.value} value={o.value}>
									{o.label}
								</option>
							))}
						</select>
					);
				return (
					<button
						key={key}
						type="button"
						className="slot-btn"
						title={tip}
						aria-label={label}
						onClick={() => onUiAction?.(entry)}
					>
						{entry.icon ? <span aria-hidden>{entry.icon}</span> : null}
						<span>{label}</span>
					</button>
				);
			})}
		</span>
	);
}
