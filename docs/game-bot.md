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
- **Attack wild Pokémon** (on by default): off = the bot never clicks a wild
  Pokémon, so yours stays where it is; the move hotkeys are still used while wild
  ones are around. A shiny, and attackers while your Pokémon's HP is low, are
  still targeted.
- **Shiny**: the star before the name in the Battle list is checked every fight
  round (pixels only); the shiny is targeted, its body verified with a Look and a
  ball thrown at it: the ball set for that species in "Ball per shiny Pokémon"
  (e.g. tentacool → Shift+4, krabby and "any other" → Shift+8), else the primary,
  then the secondary ball.
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
- Layout: screenshot, Start/Stop + lure, status and activity on the left; the
  right column holds only the settings.
- Status, counters and the recent activity log; F12 (physical key) pauses all input.

## Implementation

- `server/game-bot.ts` — `GameBotService`: lazy child process (JSON lines:
  `{"cmd": ...}` on stdin, `{"event": ...}` on stdout), state broadcast as
  `bot_state`, screenshots as `bot_screenshot`, alerts as warning notices.
- Settings are the user's: `<dataDir>/bot-settings.json` (normalized by
  `normalizeBotConfig`). Nothing about the character is stored in the code.
- Protocol: `bot_command { action }`, `bot_save_config { config }` upstream;
  `bot_state`, `bot_screenshot` downstream; `ready.bot` tells the client the tab
  is offered. Messages are owned by the `bot` tab in `server/tabs.ts`.
- UI: `web/src/components/BotPanel.tsx`, view `bot`, top-bar item `host:bot`.
- Tests: `tests/unit/game-bot.test.ts`.
