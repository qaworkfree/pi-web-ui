# Takkle integration

The first integration connects pi-web-ui to the existing Takkle cloud data,
using the schema from the supplied `Takkle-main.zip`. The original app remains
independent. Changes appear in its normal cloud sync; data that exists only in
its offline IndexedDB must sync to Supabase before this integration can see it.

## Components

- `plugins/takkle/service.mjs`: server-configured Supabase destination, account resolution,
  access checks, paginated records and validated writes.
- `plugins/takkle/index.mjs`: authenticated plugin routes and the two agent
  tools, `takkle_read` and `takkle_write`.
- `plugins/takkle/client/`: themed board, card forms and Monday-first monthly
  calendar. Date-only values are kept as dates without UTC conversion. Cards
  with only a start date also appear. Refresh fetches current cloud records.
- `server/plugin-mutation.ts`: conversation gates for plugin tools explicitly
  marked `readOnly: false`, applied at initial registration and after reload.

Takkle's `workspaces` table stores calendars. Projects, columns, tasks, labels,
members, checklist, comments, activities, attachments and views are JSON records
in the `records` table. Queries always filter calendar, collection and soft
deletion. Card details include related record metadata; attachment binaries are
not downloaded. Read results indicate truncation where they are bounded.

## Account and permission boundaries

Configure your account email in the private plugin settings. Every operation resolves
that email through Supabase Auth, requires an approved `access_requests` row,
and reads its current `workspace_members` memberships. An optional calendar-ID
allowlist narrows that scope. IDs supplied by a browser or agent cannot expand
it. Writes require **Allow Takkle changes** and an owner/editor membership;
membership and settings are rechecked before the mutation.

The Supabase secret bypasses database RLS. These server checks therefore matter:
this is a connection for one trusted Takkle account, shared by every authenticated
user of this UI instance. pi-web-ui login identities are not mapped to separate
Takkle users. Do not give UI access to someone who should not access this
configured account's calendars. A future multi-account connection would need
per-user identity and credential storage.

Plugin routes use the existing UI authentication and origin protection. Secrets
stay server-side, through encrypted plugin settings or a secure environment
binding. Requests only target the server-configured HTTPS Supabase project and reject
redirects. Provider error bodies and credentials are not returned as errors.

Agent writes are denied in conversation read-only, planning, delegate-review
and goal-review modes, including when tools are dynamically reloaded. Existing
tools without the new metadata retain their existing behavior. Manual Takkle
forms use the plugin's write setting and calendar role; conversation modes only
apply to the agent. These external-app permissions are separate from filesystem
path rules. There is no new OS sandbox or process isolation.

## Writes and compatibility

Supported operations are project creation/rename/description, column creation,
and card creation or updates to title, plain-text description, dates, priority
and column. Cards can be completed or reopened by moving columns. Existing
unknown JSON fields are preserved, timestamps use native ISO strings, and new
card numbers are left to Takkle's database trigger. A new project and its three
columns are inserted together. The existing Completed column is preserved when
adding a column.

Updates require `expectedRevision`, matching the record's current `updated_at`,
and include it in the conditional database update. If another writer wins,
refresh and reassess. Creations have no automatic retry or idempotency key;
refresh after an uncertain response before retrying.

This stage does not create/delete calendars, change sharing or user access,
delete records, edit checklist items/comments, upload attachments, manage
recurrences, or generate Takkle activity entries for mutations. Existing related
records can be read. Descriptions are rendered as plain text in this UI;
unchanged existing rich descriptions are preserved. It does not embed the full
Takkle application or claim every feature of that application is supported.

## Setup and validation

Follow [the plugin installation instructions](../plugins/takkle/README.md).
Use the same data directory as the running UI. Installing into another data
directory does not activate a plugin in your current instance.

Automated checks:

```bash
npx vitest run tests/unit/takkle.test.ts
npm run typecheck
npm run build:web
npm run build:server
PI_WEB_SDK=global PI_WEB_SDK_DIR=/workspace/pipipiPopopo/packages/coding-agent \
  node tests/takkle-ui-test.mjs
```

The browser test requires Chromium and the built UI/server. It runs an actual
fork-backed SDK session with local HTTP/SSE model and Supabase fixtures: tool
registration, reads, card creation, read-only/plan denials, login and origin
protection, manual project/card updates and completion, and mobile layout.
It uses temporary data directories and fictitious credentials, cleans up its
own processes and records, and never accesses the live Supabase project.

Configure the project URL, account email and server credentials privately.
Fixture validation does not verify access to a live account.
