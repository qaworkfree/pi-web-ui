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
from cross-site request forgery. Device management and passkeys remain follow-up
work. Authenticated users can now review active sessions and revoke an individual
browser device; revocation invalidates the server-side session immediately.
