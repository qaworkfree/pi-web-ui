# BOT tab (opt-in local game automation)

The BOT tab drives a local **game-control** controller: a separate script that
works on one game window using only screen capture and OS-level keyboard/mouse
input (no memory access, no injection, no network). pi-web-ui only starts it,
forwards commands and shows its state; the game logic lives in the controller.

## Enabling

Set `PI_WEB_GAME_CONTROL` to the absolute path of the controller's `bot.py`
(run with `uv run --script`; `PI_WEB_GAME_CONTROL_UV` overrides the `uv`
executable). Without it — the default — the tab is not drawn and the server
refuses every bot message. `PI_WEB_TABS` can also leave it out (`bot`).

## What the tab does

- **Fishing spot**: click a fishable water tile on the game screenshot.
- **Pokémon spot** (optional): switch the screenshot click to "Pokémon spot" and
  click a tile; the bot sends your Pokémon there with a middle click at the start,
  after every fight and every 30 s while idle (never during anti-AFK walks, the
  minigame or a revive). Clear it to stop.
- **Fishing**: cast → wait for the bite → reel in → scripted fight (call the
  Pokémon with Ctrl+N if it is not out, select the wild Pokémon in the Battle
  list, use the configured move keys as they come ready). Unusual fights
  (timeout) are handed to the local LLM when that option is on.
- **Attack wild Pokémon** (on by default): off = only shinies are targeted
  (plus attackers while your Pokémon's HP is low); your Pokémon is sent back to
  its tile every 10 s during a fight and the move hotkeys are still used. Like
  every setting it applies only after **Save** (an "Unsaved changes" mark shows
  a pending edit).
- **Shiny**: the star before the name in the Battle list is checked every fight
  round (pixels only); the shiny is targeted, its body verified with a Look and a
  ball thrown at it: the ball set for that species in "Ball per shiny Pokémon"
  (e.g. tentacool → Shift+4, krabby and "any other" → Shift+8), else the primary,
  then the secondary ball. **Clear ball** (e.g. Shift+5): when the Look on the
  shiny's spot shows a normal body of the same species lying on top of it, that
  ball is thrown at the top body to remove it, up to 3 times, until the Look
  shows the shiny; empty = off.
- **Stranger alarm** (off by default): a message from another player in the chat
  ("Name [level]: …") or a creature in the Battle list that is neither a Pokémon nor an
  NPC stops fishing and anti-AFK, then the configured keys are pressed in order
  (e.g. `ctrl+l, enter`). Your own character's name can be ignored.
- **Anti-AFK**: every random 8–12 minutes (default) one short routine that always
  returns to the starting tile and facing. Default routine `step`: one step out
  (up/down/left/right, whichever is free) and one step back; the older `turn`,
  `walk` and `walk+turn` can still be listed in "Routines".
- **Lure**: quick select of the lure (Worm, Seaweed, Fish, … Big Shrimp; default
  hotkeys Ctrl+Shift+1…9 / A…E, editable per lure because they can differ by
  spot). The selected lure is attached when fishing starts. Attach and Detach press
  its hotkey, check the chat and press once more if the result is the opposite.
  Until the chat has shown a message for it the badge says "not checked yet". Whether it is on the rod is read from the game's
  chat ("worm is now attached to the fishing rod." / "… detached …") and shown
  as a badge (`UiBotState.lure`, `bot_command lure_attach` / `lure_detach`).
- Layout: two sub-tabs, **Fishing** and **Hunt** (the last one used is
  remembered in the browser). The right column holds the settings both modes use
  (moves, attack, balls, clear ball, alarm) and the activity log; Fishing adds its
  own settings card (rod key, lure key, anti-AFK). Fishing and Hunt never run at
  the same time, and neither starts while a route is being recorded.

## Hunt (route walking)

- **Record a route**: type a name (the place, e.g. "Cerulean cave 1F"), click
  **Record**, switch to the game and walk the route once with the arrow keys or
  the numpad. The start is waypoint 1; add a waypoint at every stop with the
  waypoint key (default F9, pressed in the game) or **Add waypoint**. **Stop
  recording and save** stores it; **Discard** throws it away. A name that already
  exists is re-recorded (the old copy is kept in `Routes-replaced/`).
- Recording only _reads_ which step keys are down (`GetAsyncKeyState`, like the
  F12 kill switch) while the game window is in front, plus one screenshot per
  waypoint. No keyboard hook, nothing read from the game.
- **Saved routes**: the catalog lists every route (thumbnail of its first
  waypoint, waypoints, steps, last update). **Use** selects the route for the
  hunt; rename in place; delete asks for a second click and moves the folder to
  `Routes-deleted/` (never destroyed).
- **Start/Stop** walks the selected route: straight steps only (a diagonal only
  when stuck), the position checked against the minimap at every waypoint, every
  wild Pokémon fought there and shinies caught as in fishing. When stuck the bot
  alerts on Telegram, tries to get free, alerts again with the result and, still
  stuck, stops walking and waits (`/resume`, `/back`, `/stop`).
  **Status (27 Oct 2026):** recording and the catalog work; the walking engine
  waits for the minimap calibration, so Start reports that instead of walking
  blind.
- Storage: `Personal\Bot\Routes\<name>\` — `route.json` (steps with hold
  times, waypoints) and `wpNN.jpg`. Private, never published.
- Status, counters and the recent activity log; F12 (physical key) pauses all input.

## Implementation

- `server/game-bot.ts` — `GameBotService`: lazy child process (JSON lines:
  `{"cmd": ...}` on stdin, `{"event": ...}` on stdout), state broadcast as
  `bot_state`, screenshots as `bot_screenshot`, alerts as warning notices.
- Settings are the user's: `<dataDir>/bot-settings.json` (normalized by
  `normalizeBotConfig`). Nothing about the character is stored in the code.
- Protocol: `bot_command { action }` (incl. `hunt_start` / `hunt_stop`),
  `bot_save_config { config }` and `bot_route { op, name?, newName? }` (list,
  record_start/waypoint/stop/cancel, rename, delete, select) upstream;
  `bot_state` (with `hunt` and `routes`), `bot_screenshot` downstream. Route names
  are validated twice (`normalizeRouteName` on the server, again in the
  controller) because they are folder names; the controller's `routes` event is
  parsed by `parseRoutes`, its hunt block by `parseHunt`; `ready.bot` tells the client the tab
  is offered. Messages are owned by the `bot` tab in `server/tabs.ts`.
- UI: `web/src/components/BotPanel.tsx`, view `bot`, top-bar item `host:bot`.
- Tests: `tests/unit/game-bot.test.ts`.
