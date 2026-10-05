# Filesystem policy

`server/filesystem-policy.ts` is the first layer of the Workfree AI security
architecture. It defines one shared policy vocabulary for UI file operations,
Pi tools, terminals, plugins, and future runtime workers.

Rules are persisted in `<dataDir>/filesystem-policy.json` by
`server/filesystem-policy-store.ts`. The file is optional; when it is absent,
the existing session permission presets remain the fallback behavior.

## Policy semantics

The supported actions are `read`, `create`, `write`, `edit`, `delete`, and
`execute`. Each action has one of three decisions: `allow`, `ask`, or `block`.

The default policy is deny-by-default. A rule only grants the actions it
explicitly declares. Rules are path-scoped and the most specific matching rule
wins.

## Important boundary

The evaluator is intentionally pure and does not access the filesystem. An
enforcement adapter must evaluate immediately before the operation and resolve
symlinks/reparse points before treating a path as inside an allowed root. This
module is not an OS sandbox.

The evaluator is used by Pi filesystem tools and UI file routes. Terminal and
PTY execution are gated at the application entry points, but remain subject to
the shell limitation described below.

## Phase 1 status

The application-level Phase 1 implementation is complete. The policy now gates
Pi filesystem tools, UI file operations, archive/file-transfer routes, file
search, Bash project execution, and persistent terminal project execution.

The deliberate limitation is that this is not an OS sandbox. A permitted shell
process can still issue an absolute-path command or launch another process that
the application cannot inspect reliably. This is an accepted Phase 1 risk after
deferring Docker and OS-level isolation.
