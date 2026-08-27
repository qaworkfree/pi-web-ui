import { useState } from "react";
import { FiChevronDown, FiChevronRight, FiCpu } from "react-icons/fi";
import { useT } from "../i18n";

interface ThinkingBlockProps {
	thinking: string;
	/** True while the assistant is still streaming this thinking block. */
	streaming?: boolean;
	/** 设置面板「完整显示思考」开关：true（开）→ 结束后默认展开完整显示并自动换行；
	 *  false（关）→ 折叠成一行摘要。 */
	wrap?: boolean;
}

export function ThinkingBlock({ thinking, streaming, wrap = true }: ThinkingBlockProps) {
	const t = useT();
	// null = 未手动点过 → 跟随默认。流式中默认折叠（一行里实时显示最新文本），
	// 结束后按设置开关决定展开/折叠：wrap=true → 完整展开，wrap=false → 一行摘要。
	const [open, setOpen] = useState<boolean | null>(null);
	const expanded = open ?? (wrap && !streaming);
	// 折叠预览：流式中取最新文本（实时尾巴），结束后取开头一行。
	const preview = streaming
		? thinking.trimEnd().slice(-80)
		: thinking.split("\n")[0].slice(0, 80);

	return (
		<div
			className={`thinking ${expanded ? "open" : ""} ${streaming ? "live" : ""}`}
		>
			<button
				type="button"
				className="thinking-toggle"
				onClick={() => setOpen(!expanded)}
			>
				{expanded ? <FiChevronDown /> : <FiChevronRight />}
				<FiCpu className="thinking-icon" />
				<span className="thinking-label">
					{streaming && expanded ? (
						<span className="thinking-live-label">
							{t("thinkingNow")}
							<span className="dots" />
						</span>
					) : expanded ? (
						t("thinking")
					) : (
						t("thinkingPreview", { preview })
					)}
				</span>
			</button>
			{expanded && <div className="thinking-body">{thinking}</div>}
		</div>
	);
}
