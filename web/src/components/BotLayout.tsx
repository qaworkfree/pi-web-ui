import { useEffect, useRef, useState, type PointerEvent } from "react";
import { FiCrop, FiRefreshCw, FiRotateCcw } from "react-icons/fi";
import { appSend } from "../app-globals";
import { useT } from "../i18n";
import type { UiBotLayoutPart } from "../types";
import type { ChatState } from "../use-chat";

type Box = [number, number, number, number];

/**
 * BOT tab → Layout: what the controller found on the game screen (game view, Battle list, minimap, move bar, chat,
 * Pokemon portrait), framed on a screenshot. A part can be drawn by hand (pick it, then drag a box on the picture);
 * the box is kept per character by the controller and beats the automatic detection until it is reset.
 */
export function BotLayout({ chat }: { chat: ChatState }) {
	const t = useT();
	const layout = chat.botLayout;
	const [drawing, setDrawing] = useState<UiBotLayoutPart | null>(null);
	const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
	const frame = useRef<HTMLDivElement>(null);

	useEffect(() => {
		appSend({ type: "bot_layout", op: "get" });
	}, []);

	const send = (op: "check" | "set" | "clear", key?: UiBotLayoutPart, box?: Box) =>
		appSend({ type: "bot_layout", op, ...(key ? { key } : {}), ...(box ? { box } : {}) });

	const at = (e: PointerEvent<HTMLDivElement>) => {
		const r = frame.current!.getBoundingClientRect();
		const clamp = (v: number) => Math.max(0, Math.min(1000, v));
		return { x: clamp(((e.clientX - r.left) / r.width) * 1000), y: clamp(((e.clientY - r.top) / r.height) * 1000) };
	};
	const down = (e: PointerEvent<HTMLDivElement>) => {
		if (!drawing) return;
		e.currentTarget.setPointerCapture(e.pointerId);
		const p = at(e);
		setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
	};
	const move = (e: PointerEvent<HTMLDivElement>) => {
		if (!drag) return;
		const p = at(e);
		setDrag({ ...drag, x1: p.x, y1: p.y });
	};
	const up = () => {
		if (!drag || !drawing) return;
		const box: Box = [
			Math.min(drag.x0, drag.x1),
			Math.min(drag.y0, drag.y1),
			Math.max(drag.x0, drag.x1),
			Math.max(drag.y0, drag.y1),
		].map((v) => Math.round(v * 10) / 10) as Box;
		setDrag(null);
		if (box[2] - box[0] >= 5 && box[3] - box[1] >= 5) {
			send("set", drawing, box);
			setDrawing(null);
		}
	};

	const srcLabel: Record<string, string> = {
		auto: t("botLayoutAuto"),
		override: t("botLayoutOverride"),
		fixed: t("botLayoutFixed"),
		missing: t("botLayoutMissing"),
	};
	const dragBox = drag && {
		left: `${Math.min(drag.x0, drag.x1) / 10}%`,
		top: `${Math.min(drag.y0, drag.y1) / 10}%`,
		width: `${Math.abs(drag.x1 - drag.x0) / 10}%`,
		height: `${Math.abs(drag.y1 - drag.y0) / 10}%`,
	};

	return (
		<section className="bot-shot bot-layout">
			<p className="bot-muted">{t("botLayoutHint")}</p>
			{layout ? (
				<div
					ref={frame}
					className={`bot-shot-frame${drawing ? " drawing" : ""}`}
					onPointerDown={down}
					onPointerMove={move}
					onPointerUp={up}
				>
					<img
						src={`data:image/jpeg;base64,${layout.image}`}
						width={layout.width}
						height={layout.height}
						alt=""
						draggable={false}
					/>
					{dragBox && <span className="bot-layout-drag" style={dragBox} />}
				</div>
			) : (
				<p className="bot-muted">{t("botLayoutNone")}</p>
			)}
			<div className="bot-row">
				<button type="button" className="btn" onClick={() => send("check")}>
					<FiRefreshCw /> {t("botLayoutCheck")}
				</button>
				{layout && (
					<span className="bot-muted">
						{t("botLayoutCharacter")}: {layout.profile || layout.name || t("botLayoutUnknown")}
						{layout.panels.length > 0 && (
							<>
								{" "}
								· {t("botLayoutPanels")}: {layout.panels.filter(Boolean).join(", ")}
							</>
						)}
					</span>
				)}
			</div>
			{drawing && (
				<p className="bot-alert">
					{t("botLayoutDrawHint", { part: layout?.items.find((i) => i.key === drawing)?.label ?? drawing })}{" "}
					<button type="button" className="btn" onClick={() => setDrawing(null)}>
						{t("botLayoutCancel")}
					</button>
				</p>
			)}
			{layout?.problems.map((p) => (
				<p key={p} className="bot-alert">
					{p}
				</p>
			))}
			{layout && (
				<ul className="bot-layout-list">
					{layout.items.map((it) => (
						<li key={it.key}>
							<span className={`bot-badge ${it.src === "missing" ? "off" : it.src === "override" ? "unknown" : "on"}`}>
								{srcLabel[it.src] ?? it.src}
							</span>
							<span className="bot-layout-name">{it.label}</span>
							<span className="bot-muted">{it.box ? it.box.map((v) => Math.round(v)).join(", ") : "—"}</span>
							<span className="bot-layout-actions">
								<button
									type="button"
									className="btn"
									onClick={() => setDrawing(it.key)}
									aria-pressed={drawing === it.key}
									title={t("botLayoutDraw")}
								>
									<FiCrop /> {t("botLayoutDraw")}
								</button>
								{it.src === "override" && (
									<button
										type="button"
										className="btn"
										onClick={() => send("clear", it.key)}
										title={t("botLayoutReset")}
									>
										<FiRotateCcw /> {t("botLayoutReset")}
									</button>
								)}
							</span>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
