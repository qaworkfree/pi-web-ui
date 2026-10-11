/** Track the usable viewport without changing the user's pinch-zoom scale. */
export function installMobileViewport(): () => void {
	const root = document.documentElement;
	const viewport = window.visualViewport;
	let frame = 0;
	const update = () => {
		frame = 0;
		// Pinch zoom should magnify the existing layout, never reflow it.
		if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
		const height = viewport?.height ?? window.innerHeight;
		const top = viewport?.offsetTop ?? 0;
		root.classList.toggle("mobile-viewport-compact", height < 600);
		root.style.setProperty("--mobile-viewport-height", `${height}px`);
		root.style.setProperty("--mobile-viewport-top", `${top}px`);
		root.style.setProperty("--mobile-viewport-bottom", `${Math.max(0, window.innerHeight - height - top)}px`);
	};
	const schedule = () => {
		if (!frame) frame = window.requestAnimationFrame(update);
	};
	update();
	window.addEventListener("resize", schedule);
	viewport?.addEventListener("resize", schedule);
	viewport?.addEventListener("scroll", schedule);
	return () => {
		root.classList.remove("mobile-viewport-compact");
		window.cancelAnimationFrame(frame);
		window.removeEventListener("resize", schedule);
		viewport?.removeEventListener("resize", schedule);
		viewport?.removeEventListener("scroll", schedule);
	};
}
