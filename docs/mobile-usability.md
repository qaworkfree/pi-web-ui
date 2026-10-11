# Mobile usability

The mobile layout targets 430 × 932 CSS pixels and also supports smaller phone
widths. The shared `styles.css` retains the desktop layout and adds mobile
typography, 44px button targets, wrapping controls and readable model names.
Provider filters become a horizontal strip rather than narrowing the model list.
Editable controls remain at least 16px; gesture zoom remains available.
Tables retain readable column widths and scroll inside the message when needed.

The viewport enables `viewport-fit=cover`. Normal app flow owns one set of
safe-area insets. Fixed drawers and body portals own their insets separately;
do not add safe-area padding again to the footer or composer. Modals fill their
backdrop's usable content area and scroll internally.

`mobile-viewport.ts` tracks VisualViewport height and offset as the keyboard and
browser chrome change. Updates are coalesced into an animation frame, with a
window-size fallback. Pinch zoom does not reflow the app. The shared floating
panel hook constrains menus to the visible safe area and repositions on viewport
resize/scroll without closing them. Desktop positioning retains its old margin.
When the usable viewport is under 600px tall, quick-action suggestions temporarily
hide to keep typing and Send visible, including with the Goal editor expanded.
The editor scrolls internally; floating Goal and Back to bottom controls keep a
4px gap after their touch targets are enlarged. Model rows grow with their labels
and the model sheet covers composer actions to prevent overlapping tap targets.

`tests/mobile-layout-test.mjs` launches a disposable authenticated server on
port 8997 with a fake model and read-only fixture workspace. No inference is
requested. It checks login, chat, model management, all Settings tabs, menus,
drawers, file preview, projects, Goal editing, terminal/Git views, short viewports and synthetic
safe areas at 430/390/375px. Desktop geometry is compared with the committed
stylesheet. `PI_WEB_MOBILE_ARTIFACT_DIR` selects a private output directory for
screenshots and metrics. Never save test artifacts inside tracked source folders.

Unit coverage includes visual viewport changes, cleanup, pinch zoom and floating
panel positioning. Browser emulation and synthetic insets cannot establish real
iOS Safari keyboard animation, device safe-area values or native touch behaviour;
those require a physical iPhone check.
