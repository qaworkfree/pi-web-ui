# Takkle

Takkle boards and a monthly calendar inside pi-web-ui, with agent tools backed by
the original application's Supabase records. No additional dependencies or
Takkle database migrations are required.

## Install and connect

1. Update this fork and build it with `npm run build`. The server and web build
   contain the conversation write gate and Takkle styles.
2. Install **Takkle** from Settings → Interface plugins, or run this from the
   repository root, replacing the data directory with the one your UI uses:

   ```powershell
   node .\bin\pi-web-ui.mjs install .\plugins\takkle --data-dir "C:\path\to\your\existing\.pi-web" --no-build
   ```

   The plugin already contains runnable `index.mjs` and `client/entry.mjs` files.
   Restart the UI server after upgrading the core, then refresh the browser.

3. In the plugin settings, keep **Takkle account email** as
   `account@example.com`. This must be an approved Takkle account with calendar
   membership in the original application.
4. Enter the Supabase server secret in the secret setting, or inject
   `TAKKLE_SUPABASE_SECRET_KEY` securely into the **server** environment. The
   plugin secret setting uses the host's encrypted storage; the key is never
   returned to the browser. Do not put it in a script or tracked file.
5. Open the Takkle tab and verify the calendars and boards. Optionally restrict
   **Allowed calendar IDs** to a comma-separated subset of these calendars.
6. Enable **Allow Takkle changes** when you want manual and agent writes.
   It defaults to disabled. Calendar viewers remain read-only.

The Supabase destination is fixed to
`https://exampleproject.supabase.co`. Network permission must allow this
domain. Credential-bearing requests reject redirects.

## Use

Choose a calendar and optionally a project. Calendar displays cards with start
and/or due dates; Board groups cards by column. Open a card to see its details,
change its title, description, dates, priority or column. New project creates a
board with To Do, In Progress and Completed columns; New card adds a card to a
board. Use Refresh after changes made by an agent or the original Takkle app.

Example agent requests:

- “Show my Takkle projects and cards due this week.”
- “Create a project called Website launch in my Takkle calendar.”
- “Add a card to that project called Review homepage, due October 9, 2026.”
- “Move that card to Completed.”

`takkle_read` reads calendars, projects, board records, cards, card detail and
agenda. `takkle_write` creates projects, columns and cards, and updates projects
or cards. The agent reads IDs and revisions before editing. Stale edits fail
instead of overwriting newer changes. Unconfirmed creations need a refresh
before retrying, since automatic retries could duplicate records.

Read [access boundaries and validation](../../docs/takkle-integration.md) before
sharing this UI server with other people. The configured Takkle account is
shared by all authenticated users of this UI instance.
