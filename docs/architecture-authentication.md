# Application authentication

Phase 2 adds an optional application login layer without removing the existing
`PI_WEB_TOKEN` mechanism.

Set both environment variables on the first launch to bootstrap the initial account:

```text
PI_WEB_AUTH_USERNAME=workfree
PI_WEB_AUTH_PASSWORD=<secret>
```

The browser loads a minimal public shell, then authenticates through
`POST /api/auth/login`. Successful login receives an HttpOnly,
SameSite=Lax session cookie valid for seven days. The session is required for
HTTP APIs and WebSocket upgrades. `POST /api/auth/logout` revokes the session.

`PI_WEB_TOKEN` remains supported for service integrations and token-based local
access. Login failures are limited to five attempts per client address within
15 minutes; a successful login clears that counter. The initial account is
persisted as a salted `scrypt` hash in `<dataDir>/auth-users.json`; the plaintext
password is not written to disk and changing the environment password does not
overwrite an existing credential file. An administrator can manage users through
the authenticated `/api/auth/users` endpoints. Browser state-changing requests
are restricted to the UI's own origin, protecting cookie-authenticated sessions
from cross-site request forgery, including the login endpoint. Cookie-authenticated
writes must carry a matching `Origin` or `Referer`; header-authenticated service
clients may omit them. `PI_WEB_ALLOW_ORIGINS` extends the exact-origin list for
both HTTP writes and WebSocket upgrades. Origins include scheme and port.

Settings → Account and devices offers explicit sign out and device revocation.
All users can manage their own sessions; only administrators can manage users.
Revocation, deletion of a user, logout, and session expiry close the affected
existing WebSocket connections, including plugin proxy tunnels. Running agent
tasks are not cancelled by signing out; the revoked browser loses access to them.
Sessions are in memory and all expire on server restart.

Password sessions never issue the shared `PI_WEB_TOKEN` cookie. The shared token
is a service credential: someone who knows it can authenticate until the server
token is rotated. Sign out clears this browser's shared-token cookie and stored
token, but cannot revoke copies held by another client. Token-only deployments
must reopen the UI with a valid token after signing out.

The login shell waits for a verified authentication status before mounting the
application; failures show a retry action. Corrupt or unreadable persisted
credentials stop startup instead of disabling authentication. Back up the data
directory and restrict its access; hashed credentials are saved with mode `0600`.

For the first deployment, password login is the implemented baseline. Passkeys
remain an optional future enhancement, not a deployment prerequisite. Device
names continue to use the browser agent, address and creation date, with a
current-device marker; user-editable labels are optional future work.

Reverse proxy trust and the Tailscale deployment procedure are documented in
[deployment.md](deployment.md#private-access-with-tailscale-and-https).
