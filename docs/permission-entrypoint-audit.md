# Application permission entry-point audit

This audit covers the supported Pi engine in `pi-web-ui`. Authentication protects
HTTP, WebSocket and plugin proxy entry points. All authenticated users operate the
same server account and share project policy; this is a personal/team operator
interface, not per-user filesystem isolation. OS sandboxing is outside scope.

## Shared decisions

The persisted policy is authoritative, including in full-access conversations.
An absent, malformed or unreadable policy now blocks all six actions. Existing
installations must explicitly apply a project preset or save rules in Settings →
Filesystem access. Opening a project does not grant access. Canonical paths follow
existing symlinks and the nearest existing ancestor of new paths; an explicitly
blocked alias is also blocked. Checks do not prevent another process racing a
filesystem operation or bypassing application APIs.

`Allow once` authorizes the original filesystem tool request. It cannot become a
conversation/category allowance, bypass Block, survive an abort, approve an
edited filesystem request, or authorize a different physical target. Turning off
risk approvals does not suppress explicit filesystem Ask. Pending approvals and
outcomes use the existing conversation journal. Persistent grants require editing
the project policy. A separate risk approval may still precede filesystem approval.

## Native SDK search and PowerShell

The UI wraps the SDK's native `powershell`, `grep`, `find` and `ls` definitions
after session creation, preserving same-name extension definitions and core
toggles. Failed override installation blocks session creation. Plugin pre/post
guards and risk approval rules also cover these native names. Extensions/plugins
still run as trusted code; wrapping their declared path is not confinement of
arbitrary extension effects.

`grep`/`find` check all descendants of the requested root before native execution.
They do not follow nested directory links; every encountered alias is checked
against its physical target. A permitted root link is traversed, with descendant
checks against the destination. `ls` and read-directory support check only the
root and immediate entries, including the metadata targets followed by SDK ls.
Unlike recursive search, shallow listing does not require reading grandchildren.

This preflight is deliberately conservative: a blocked path rejects the whole
operation even if a pattern, ignore file or output limit might exclude it. Trees
over 20,000 checked paths fail with a request to select a narrower subdirectory.
Paths are not silently skipped. All Ask paths use one explicit original-operation
approval; the dialog describes the scope/count and sample paths. Before delegation
the tree is checked again using live policy. Changed membership, changed physical
targets, Block, newly introduced Ask, Edit & Run, denial or abort cannot reuse the
approval. Global risk approval suppression and conversation/category grants cannot
suppress filesystem Ask. As elsewhere, these checks do not eliminate OS races.

PowerShell requires canonical Execute on the actual execution cwd, using the same
one-operation approval bridge as Bash. Session read-only, plan, delegated-review
and goal-review modes deny arbitrary PowerShell scripts rather than interpreting
them through Bash's read-only command parser. Execute authorizes a trusted process
and does not constrain every path that its script can access.

## Entry-point inventory

| Entry point                                                            | Application checks                                                                                                                                                                                    | Ask behavior / trust boundary                                                                                                                                          |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi read/write/edit/edit_soft                                           | Canonical read/create/write/edit at the final effective path; session read-only restricts mutations                                                                                                   | Existing approval bridge; original operation only, policy and target rechecked after approval                                                                          |
| Hashline patch                                                         | Read checks; complete computed create/edit/delete plan checked before any write, then at each write/delete; move targets included; restricted fuzzy-search branches skipped                           | Requires Allow; synchronous engine has no approval bridge; conversation read-only blocks mutations                                                                     |
| present_files                                                          | Read before metadata/content excerpts; HTTP card downloads checked separately                                                                                                                         | Requires Allow                                                                                                                                                         |
| Bash, eval and LSP tool calls                                          | Execute at project root; LSP also checks explicit read target                                                                                                                                         | Tool calls can Ask; approval grants permission to launch a process, not restrictions on every effect of that process                                                   |
| PTY and persistent terminal tools                                      | Execute at project root, plus existing plan/review/session guards                                                                                                                                     | Requires Allow where no approval bridge exists; already-running processes are not terminated by a policy edit                                                          |
| UI file operations and directory creation                              | Canonical read/create/write/delete; copy/move/delete check descendants and destinations; rename/move also require Delete on source                                                                    | Requires Allow; project navigation/settings remain available to configure grants                                                                                       |
| File search and path completion                                        | Read on selected root; recursive search checks each target                                                                                                                                            | Requires Allow; shallow allowed directory lists and virtual machine-root navigation may expose child names, not grant child content access                             |
| HTTP media, previews and downloads                                     | Read per requested target, including absolute paths, preview subresources and requests without a connected client                                                                                     | Requires Allow; missing client never bypasses global policy                                                                                                            |
| Uploads, compression and extraction                                    | Create on actual upload destination/missing parents; read each archived source; create archive output except private temporary downloads; create/write each extracted destination with full preflight | Requires Allow; existing archive traversal, link, conflict and size protections retained                                                                               |
| Git panel                                                              | Execute/read on project; refuses bulk output when a nested rule restricts Read                                                                                                                        | Requires Allow; Git is an external process with the same process trust boundary                                                                                        |
| Plugin host.fs and cross-directory facilities                          | Manifest capability **and** directory grant **and** live canonical project policy; recursive removal and glob checked; append follows write/create rules                                              | Requires Allow; requestAccess records a plugin directory grant, not a global filesystem allowance                                                                      |
| Plugin watchers, host.bash and project.create                          | Read checked when subscribing/delivering notifications; Execute on bash cwd; Create/Write/Execute before project creation                                                                             | Requires Allow; project creation can run scaffolding commands, which are trusted processes                                                                             |
| MCP tools and server startup                                           | Existing server enable/disable, installation consent, routing and conversation tool/plan gates                                                                                                        | External server effects cannot be inferred from arbitrary tool JSON. Enabled servers are trusted. They do not acquire a claim of filesystem confinement from UI policy |
| Extension/plugin code, proxy routes and background callbacks           | Existing install/enable/capability/consent controls; supported host facilities retain their checks on each call                                                                                       | Code executes as the host account and can import node:fs or launch processes directly. Install only code you trust; manifest declarations are not OS isolation         |
| Scheduled agent turns and sub-agents                                   | Tools reuse their owning conversation's application guards and shared persisted policy                                                                                                                | Ask requires an actual approval; schedules do not create silent grants. In-process callbacks and external workers remain trusted code                                  |
| Attachments, locales, themes, credentials, journals and plugin storage | Authenticated managed application-data APIs, bounded names/paths, existing format/capability/consent checks                                                                                           | These are server-managed configuration/data operations rather than project filesystem grants. Installing a plugin/extension authorizes trusted code to run             |
| DSH engine                                                             | HTTP transfer/preview routes still use global policy                                                                                                                                                  | DSH does not expose Pi's tool override hooks. Do not claim parity for DSH agent tools; this plan targets Pi                                                            |

| Native entry point       | Application checks                                                  | Ask behavior / trust boundary                                                          |
| ------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| PowerShell               | Canonical Execute at actual cwd; session/plan/review modes enforced | Existing one-operation bridge; arbitrary script effects remain a trusted process       |
| Native grep/find         | Complete canonical descendant preflight, then live tree recheck     | One original-operation approval for Ask paths; conservative scope, bounded to 20,000   |
| Native ls/read-directory | Canonical root and immediate entry metadata targets                 | One original-operation approval; blocked children deny listing, grandchildren not read |

## Validation

Focused tests exercise canonical link escapes, new files versus overwrites,
policy changes and link retargeting during approval, explicit Ask despite global
approval suppression, final edited write targets, plugin facilities, recursive
blocks, patch preflight, blocked artifact excerpts and archive targets. The real
server/browser test additionally checks HTTP previews/downloads, absent-client
policy enforcement, a denied upload and preservation of existing data. No test
requires model credentials or external services.

Native coverage adds real SDK definitions, live descendants/links/tree changes,
final edited risk targets, directory read aliases and PowerShell mode/Execute
gates. `tests/native-tool-policy-test.mjs` uses a real server and selected fork
with deterministic local SSE to verify native registration and actual SDK tool
results, allowed ls/rg, recursive denial, repeated Ask and PowerShell denial.
Unit tests exercise SDK find/PowerShell using injected operations. They do not
claim actual fd or Windows PowerShell execution on the deployment machine.
