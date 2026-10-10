# Selective upstream fixes

Backported from xing-shuyin/pi-web-ui while preserving the local document pipeline, filesystem policies, authentication, offline layers, English-only interface and blank startup.

| Upstream commits | Backport |
| --- | --- |
| `69b295d`, `39a28c2`, `4ac67bb`, `842ebb8` | Terminal nonce, group/comment parsing, rejection of incomplete commands and Windows ConPTY output preservation. |
| `d1b50ad` | Limit workspace snapshots and rollback to the conversation cwd subtree. |
| `4a28376` | Attribute dangling tool results to known restarts and warn that commands may already have run. Adapted to English-only output; automatic resume remains disabled by the local launcher. |
| `2e7ef98` | Render a stopped turn neutrally without offering immediate retry. Genuine upstream errors remain errors. |
| `ea5aff6` | Configure the chat rendering window between 5 and 100 messages, default 15. Adapted to this fork's dispatch code and DSH settings. Model presets preserve the current UI preference. This does not delete history or change model context. |
| `7cff6f6` | Use file URLs for Windows Node import hooks, record extension startup logs and report startup failures. Notifications are English. Logs use the configured UI data directory. |

Windows permission-test fixtures use directory junctions to exercise path escape and retargeting checks without requiring privileged file symlinks. Production filesystem checks remain unchanged.

The Windows deployment helper also migrates legacy installation temp files into `Personal/Temp/legacy-install-temp` and publication checkouts into `Personal/Backups/github-publish`, preserving their old paths as junctions. It refuses conflicting destinations instead of overwriting data.

The browser regression run exposed an existing SettingsModal hook-order crash when opening Settings before its first snapshot arrived. All hooks now run before the loading return. The authentication browser test delays the initial settings messages to cover that race and asserts no browser errors.

Validation: all configured TypeScript checks, targeted unit tests and a real terminal PTY regression run. Tests use disposable data; document fixtures cover extraction/OCR and actual password errors. The configurable rendering window has not been performance-benchmarked on a physical iPhone.

The large upstream UI refactor, cross-client session rewrite, shared approval-rule refactor, automatic global SDK selection and background runtime retention changes are not included. They conflict with this fork or need broader compatibility work. Existing offline enforcement, SDK selection, iPhone font/viewport fixes, marker removal and response statistics remain in place.
