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
Policy input is normalized before persistence and evaluation: blank paths are
discarded and unknown permission values become unspecified, which continues to
resolve as `block`.

## Explicit project scopes

Settings → Filesystem access provides Block, Read only and Development presets
for the current project. The server derives and canonicalizes the project root;
the browser cannot submit a wider scope. Applying a preset replaces only that
root's rule. Global defaults, rules for other projects and more-specific nested
exceptions remain unchanged. Review the displayed rule list when nested grants
should also change. No preset is applied merely by opening a project.

Development allows reading, creating, writing and editing files; deletion and
execution use Ask. Read only permits reading; Block blocks all six actions for
the root unless a more-specific exception exists. Project grants persist in the
shared policy file. They are not a per-user isolation or multi-tenant boundary.

Explicit filesystem rules remain authoritative even in the conversation's
full-access mode. Conversation read-only mode can further restrict writes.
Direct UI file operations and PTYs require Allow; Ask is conservatively denied
where the entry point has no approval bridge. Allow once in a tool dialog affects
that request only; conversation/category tool allowances last for that live
conversation, while a project policy allowance persists for the path.

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
