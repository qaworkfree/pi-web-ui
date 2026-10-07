# Local-model deployment checklist

Model configuration and the inference readiness check belong to
[pipipiPopopo](https://github.com/qaworkfree/pipipiPopopo). Follow its
[Workfree local-model guide](https://github.com/qaworkfree/pipipiPopopo/blob/main/packages/coding-agent/docs/workfree-local-models.md)
and [compatible-provider example](https://github.com/qaworkfree/pipipiPopopo/blob/main/packages/coding-agent/examples/models/workfree-local.json).
The UI reuses these providers; it does not implement a second model runtime.
For local PowerShell testing, use the runtime's
[Windows validation guide](https://github.com/qaworkfree/pipipiPopopo/blob/main/packages/coding-agent/docs/workfree-local-models-windows.md).

## Windows model directory

Your existing llama.cpp GGUF files are in **`D:\IA\modelos-llamacpp`**. List them
in PowerShell and select the full path of the model you want llama.cpp to load:

```powershell
Get-ChildItem -LiteralPath 'D:\IA\modelos-llamacpp' -Recurse -File -Filter '*.gguf' |
    Select-Object -ExpandProperty FullName
```

The [Windows guide](https://github.com/qaworkfree/pipipiPopopo/blob/main/packages/coding-agent/docs/workfree-local-models-windows.md)
uses this directory for existing models and optional downloads. Pass the selected
GGUF file to llama.cpp's `--model` argument. pi-web-ui reads the configured
server's `/v1/models` endpoint; it does not scan the disk directory itself.

For llama.cpp catalogs, discovery also checks the same server's `/props` to
display the loaded GGUF filename, including quantization, instead of a generic
label or `--alias`. Only the filename is sent to the browser. The server's model
ID remains unchanged for inference. If `/props` is unavailable, the server's
reported name or ID is used; the UI does not guess a model identity.

In **Manage models**, refresh the saved local provider (or use **Fetch and select
models** when configuring it). A provider refresh replaces stale display names
with names reported by the server, while retaining routing, credentials and
manually configured capabilities. The selected-model control and default banner
use the refreshed catalog name, even in an existing conversation.

The user confirmed moving the existing 2B GGUF from `pipipiPopopo` into this
directory on 2026-10-07. The model was preserved. This cloud session cannot
inspect the Windows drives; select that file's new full path when starting
llama.cpp on the PC.

## Before starting the UI

1. Build the selected runtime checkout, hydrate its generated model catalogs (or
   restore its validated exact-version published catalogs using the runtime guide) and
   record its Git commit. Build the UI and record its commit separately. Keep
   existing agent `models.json`/`auth.json` and the UI data directory intact.
2. Start the chosen llama.cpp server on loopback with an instruction-tuned GGUF.
   Record the upstream server revision, model source/checksum, quantization and
   context size. Configure providers in the private agent directory. Authentication
   secrets come from the service environment or existing credential store.
3. Set `PI_RUNTIME_REPO` to the runtime checkout path **outside Git**, then require
   the existing runtime check to pass:

   ```sh
   LLAMA_BASE_URL=http://127.0.0.1:8080 LLAMA_MODEL=workfree-local \
     node "$PI_RUNTIME_REPO/scripts/check-local-model.mjs"
   ```

   Use the real model ID. With an authenticated server, inherit `LLAMA_API_KEY`.
   This check performs readiness, catalog selection and a bounded streaming
   inference. It never loads/unloads models. A failure stops the deployment step.

4. From the UI checkout, select the fork with the existing SDK resolver:

   ```sh
   PI_WEB_SDK=global \
   PI_WEB_SDK_DIR="$PI_RUNTIME_REPO/packages/coding-agent" npm start
   ```

   Preserve the authentication/proxy variables in your service environment.
   Confirm the startup SDK path, actual version and `piSdkCopies` at `/api/health`.
   `PI_WEB_SDK=bundled` selects the installed npm SDK instead. An unbuilt fork does
   not satisfy this check; a successful UI test with the npm SDK is not proof that
   the fork works.

5. In Settings → Models, refresh/select the existing local provider and send a
   harmless prompt. Verify streaming and a read-only tool call in a disposable
   project. Apply the explicit project policy in Settings → Filesystem access;
   missing policy blocks project operations. Approve individual requests and
   confirm they appear in the owning conversation's activity.
6. Complete [private HTTPS/Tailscale validation](deployment.md) on the target
   host and an authorized second device. Use the
   [portable deployment check](workfree-deployment-validation.md) for actual
   HTTP/WebSocket login/CSRF/logout evidence, then perform the browser/model and
   cross-device revocation checks. Confirm logout/revocation closes access.

Repeat steps 3–5 after changes to model, server, runtime or provider configuration.
A service supervisor can invoke the same runtime script as a pre-start check,
using its protected environment and absolute checkout path; the committed units
contain no local paths, model secrets or automatic external deployment.

## Recorded validation and remaining access

The readiness script has ten offline HTTP fixture tests for SSE/UTF-8 streaming,
missing models, unavailable servers, malformed/incomplete responses, redirects
and deadlines. UI SDK-selection tests cover the existing resolver separately.
These tests require no model keys or downloads. The real-server project-policy
test also accepts `PI_WEB_SDK_DIR`: it asserts the selected runtime's package
path/version, then exercises HTTP/WebSocket and browser policy controls.

In this cloud session, live catalog hydration received HTTP 403 for models.dev.
The exact-version official npm artifact supplied valid catalogs instead; the
runtime's strict validator, full check and offline build passed. The UI actually
loaded the built `pipipiPopopo` fork (v1.0.2) and passed the real-server policy
test. Both repositories retain their own code and dependencies.

After the user published the environment on the 2026-10-06 follow-up, an actual
SmolLM2-135M-Instruct Q3_K_S GGUF downloaded successfully with normal TLS and
checksum verification. It is about 88 MB; its immutable source, SHA-256 and server
options are recorded in the runtime guide linked above. The CPU llama-server
target built from upstream v0.5.0, commit
`7fe450e19305b828c199d602c23a8337aaa1f03b`, with CMake 4.1.3/GCC 14.2.

The readiness/catalog/real-SSE check and a CLI text prompt passed. The authenticated
UI loaded the actual fork, received real WebSocket deltas and displayed the model
answer in Chromium at a mobile viewport. Logout closed the connection and made
the expired session cookie unusable. Existing agent/UI configuration was preserved
using a disposable project and separate configuration; other tools were explicitly
disabled for this inference test.

The tiny model's CLI read-tool request did **not** pass: it produced text without
calling `read`. In the later user-authorized Qwen3-Coder-30B-A3B-Instruct Q4_K_M
run, both the CLI and authenticated UI successfully executed `read`, received a
random probe-file marker in the actual tool result and returned it in the final
answer; mobile Chromium displayed it. The verified 18.6 GB artifact ran on CPU
with `--no-repack`, reducing observed memory consumption to about 19 GiB. Its
immutable source/checksum and exact options are in the runtime guide.

Qwen3.8-27B Q8_0 was researched (about 29 GB; the official template supports
tool-call blocks), but not downloaded or tested. Model support requests operations;
the agent executes them and UI adapters enforce project policy. A successful
read check does not establish broader coding quality. The plan also
records the now-completed filesystem/execute audit for the SDK's native
`powershell`, `grep`, `find` and `ls` tools in
[the application audit](permission-entrypoint-audit.md). Separate SDK/real-server
tests validate those adapters; the model inference check does not establish it.
The deployment model/hardware, GPU behavior, Windows execution and second-device
Tailscale access remain unverified. The Windows guide is available, but this
session has no execution access to the user's PC.

Reusable CMake/llama.cpp/model setup and startup instructions were corrected in
the environment configuration draft after observing that the earlier `/tmp`
prerequisites did not survive publication. The correction is saved separately
from publication; restoration of the new shared files in a fresh task is untested.
