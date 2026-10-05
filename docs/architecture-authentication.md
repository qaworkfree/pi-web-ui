# Application authentication

Phase 2 adds an optional application login layer without removing the existing
`PI_WEB_TOKEN` mechanism.

Set both environment variables to enable it:

```text
PI_WEB_AUTH_USERNAME=workfree
PI_WEB_AUTH_PASSWORD=<secret>
```

The browser loads a minimal public shell, then authenticates through
`POST /api/auth/login`. Successful login receives an HttpOnly,
SameSite=Lax session cookie valid for seven days. The session is required for
HTTP APIs and WebSocket upgrades. `POST /api/auth/logout` revokes the session.

`PI_WEB_TOKEN` remains supported for service integrations and token-based local
access. Credentials are currently supplied through the process environment;
hashed credential storage, multiple users, device management, CSRF defenses,
and passkeys remain follow-up work.
