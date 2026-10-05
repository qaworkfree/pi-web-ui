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

The next step is to use this evaluator for Pi `read`, `write`, and `edit`
operations, then apply the same checks to UI file routes. Terminal and PTY
execution require an additional process-level boundary because shell commands
can otherwise bypass file-tool checks.
