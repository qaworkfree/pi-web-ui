# Validate the running Workfree deployment

Run this check from the Windows host first, then from an authorized second
Tailscale device. It uses the already running UI and creates/revokes only its
own login session. It does not install/start services, change project settings,
run agent tools or send model prompts. Keep the existing repositories and data.

## Prerequisites

- Node >=22.19 and the existing `pi-web-ui` checkout with its dependencies.
- A running UI with password authentication and the selected built agent fork.
- For a second device: Tailscale access and the actual HTTPS URL printed by
  `tailscale serve status` on the host. Remote HTTP is rejected.
- Your existing application username/password, entered locally. Never put them
  in the Git repository, command arguments, shared reports or chat.

Follow [the private HTTPS deployment instructions](deployment.md#private-access-with-tailscale-and-https)
for host/proxy settings. Do not enable Funnel or expose the backend publicly.

## PowerShell

From your existing `pi-web-ui` checkout:

```powershell
$ErrorActionPreference = 'Stop'
$env:WORKFREE_UI_URL = Read-Host 'UI address (loopback on host; HTTPS on second device)'
$env:WORKFREE_UI_USERNAME = Read-Host 'Your existing application username'
$env:WORKFREE_EXPECT_PI_VERSION = Read-Host 'Expected agent version from the runtime package.json'
$Secret = Read-Host 'Application password (local only)' -AsSecureString
$Report = Join-Path $env:TEMP ('Workfree-deployment-' + [guid]::NewGuid().ToString('N') + '.json')
try {
    $env:WORKFREE_UI_PASSWORD = [System.Net.NetworkCredential]::new('', $Secret).Password
    $Result = & node scripts/check-workfree-deployment.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Deployment validation failed; inspect the reported check' }
    $Result | Set-Content -LiteralPath $Report -Encoding UTF8
    Get-Content -LiteralPath $Report
    Write-Host "Report: $Report"
} finally {
    Remove-Item Env:WORKFREE_UI_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:WORKFREE_UI_USERNAME -ErrorAction SilentlyContinue
    $Secret = $null
}
```

Use the service's actual local port on the host. On the second device enter the
Tailscale HTTPS address; do not use localhost there. A proxy URL prefix such as
`https://host.tailnet.ts.net/pi/` is supported. TLS verification and redirects
remain strict; fix certificate/routing errors before retrying.

`WORKFREE_EXPECT_PI_VERSION` is optional to the script but required for this
deployment workflow: take it from
`pipipiPopopo/packages/coding-agent/package.json`, not an assumed npm version.
A mismatch fails before sending login credentials. Also compare `/api/health`
and the host's startup SDK path with your actual fork, as described in the
[local-model checklist](local-model-deployment.md). Version equality alone does
not prove which Git commit is deployed.

The command has a 30-second overall deadline and exits nonzero on failure.
Success prints a JSON report with the client platform, time, target origin,
loaded agent version and these observed checks:

1. The UI identifies the loaded agent version.
2. Anonymous HTTP and WebSocket requests receive 401.
3. Password login issues an HttpOnly, SameSite=Lax session cookie, with Secure
   required over HTTPS, and does not mint a service-token cookie.
4. Authenticated HTTP works and WebSocket delivers an actual state snapshot.
5. A cross-origin logout receives 403 and leaves that session usable.
6. Logout invalidates the cookie and closes its open WebSocket with code 4001.

Reports omit passwords, usernames, cookies, session tokens and response bodies.
Review a report before sharing it; the target hostname identifies your deployment.
On a failed check the command attempts to revoke its own login session. If
connectivity prevents cleanup, remove the validation session in Account and devices.

## What still needs direct evidence

A passing local/cloud report is not proof of Windows, GPU, Tailscale ACLs or a
second physical device. Keep the report from each actual device and record the
tested UI/runtime Git commits separately. After the remote automated check:

- Open the UI in the second device's browser. Verify streaming and a real
  read-only tool call in a disposable project with an explicit Read only grant.
- Use Account and devices on the host to revoke that second browser session;
  confirm its WebSocket and HTTP access stop. The automated command checks its
  own logout, not revocation of a different browser/device.
- Follow the runtime's
  [Windows model procedure](https://github.com/qaworkfree/pipipiPopopo/blob/main/packages/coding-agent/docs/workfree-local-models-windows.md)
  for actual GGUF/SSE/CLI/UI tool validation. Record the model checksum,
  llama.cpp commit, hardware/backend and actual tool result. GPU behavior is
  unverified unless the server actually runs on the selected GPU.

Only mark the deployment plan items complete once these host/browser/model and
second-device observations are available. Current cloud tests validate the
checker and the application locally; they do not establish external deployment.
