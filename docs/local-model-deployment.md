# Local-model deployment checklist

Model configuration and the inference readiness check belong to
[pipipiPopopo](https://github.com/qaworkfree/pipipiPopopo). Follow its
[Workfree local-model guide](https://github.com/qaworkfree/pipipiPopopo/blob/main/packages/coding-agent/docs/workfree-local-models.md)
and [compatible-provider example](https://github.com/qaworkfree/pipipiPopopo/blob/main/packages/coding-agent/examples/models/workfree-local.json).
The UI reuses these providers; it does not implement a second model runtime.
For local PowerShell testing, use the runtime's
[Windows validation guide](https://github.com/qaworkfree/pipipiPopopo/blob/main/packages/coding-agent/docs/workfree-local-models-windows.md).

## Windows model directory

### Visible launcher and all local models

Update both existing checkouts from GitHub, preserving local edits, then double-click
[`Start-Workfree.cmd`](../Start-Workfree.cmd) inside `pi-web-ui`. Use this launcher
instead of the old shortcut. Node.js >=22.19, Git and an existing compatible
`llama-server.exe` (v0.5.0 or newer with router/preset support) are required.
The launcher finds the sibling `pipipiPopopo` checkout and common llama.cpp
locations. If it cannot find one, its visible console asks for that existing
path once and saves the nonsecret settings in ignored
`.pi-web/local-launcher/launcher.json`. It never pulls/resets Git or downloads GGUFs.

First launch installs locked dependencies without lifecycle scripts, explicitly
rebuilds the UI's `node-pty`, and builds the fork and complete UI. If runtime
catalogs are absent, it restores the exact-version official npm catalogs with
their original manifest and validates them strictly. Existing catalogs are
preserved. Source/dependency/Node changes invalidate the private build stamp;
unchanged launches reuse outputs. Build failures stop startup with visible logs.
`-Rebuild` forces preparation. `-SetupOnly` prepares and checks prerequisites
without terminating or launching any service.

**Before starting services, the launcher terminates listeners on its configured
ports (defaults 8080 and 8788), including their process trees.** Other listening
ports are untouched; the launcher and ancestor consoles are protected. Known
pi-web-ui PowerShell watchdogs are stopped with their listener so they cannot
restart it. If Windows denies process termination, startup fails with an
actionable error; it does not silently use another port or elevate privileges.

Both required consoles remain visible: llama.cpp with live logs and the UI
with live logs. Closing the model console stops llama.cpp; Ctrl+C stops the UI.
Errors remain visible. Opening the UI, opening/selecting models and readiness
checks send **no chat prompt or capability test**. Model weights load only when
you send a message. Existing private authentication/data settings remain in use.

For explicit path/port overrides, from your UI checkout:

```powershell
.\Start-Workfree.cmd -RuntimeRepo 'C:\path\pipipiPopopo' `
    -LlamaServer 'C:\path\llama-server.exe' `
    -ModelsDir 'D:\IA\modelos-llamacpp' -ProjectDir 'C:\path\project'
```

These nonsecret overrides persist for future double-click launches.
`ExecutionPolicy Bypass` applies to the launcher process, not the machine policy.
Override `-GpuLayers`, `-LlamaPort` or `-UiPort` for your actual setup.

#### Select context separately for each GGUF

Open the composer's model picker and select an actual filename under **llama.cpp**.
Then choose **Manage models → llama.cpp** in the custom-provider section. The
existing **Context** and **Max output** controls remain available for each model:

- **GGUF limit** comes from that file's `general.architecture` and matching
  `*.context_length` metadata, not its filename or a made-up provider alias.
- Initial context is `min(4096, GGUF limit)`; the model's full limit is not
  automatically allocated. Choose a preset or a custom integer within that limit.
  Contexts of 1K, 2K and 4K are available for smaller models.
- Max output must be positive and smaller than the selected context. Reducing
  context adjusts output downward when needed. Invalid custom values disable
  Save and are also rejected by the runtime helper.
- **Save** persists that model's choice and changes its llama.cpp preset. Idle
  conversations adopt the refreshed bounds. Finish active agent turns before
  changing context. The next message uses the new preset; startup remains idle.
- Profiles/presets live under ignored `.pi-web/local-launcher/`; they contain
  model paths and settings, never copied credentials. They survive restarts.
  No global `--ctx-size` overrides them. Inherited `LLAMA_ARG_*` overrides are
  removed only from the llama.cpp child process.

The default models directory remains **`D:\IA\modelos-llamacpp`**. Opening the
picker rescans GGUF metadata and refreshes the router catalog without loading
weights. Subdirectories and first shards are supported; projector/draft sidecars
are not offered as chat models. A sole `mmproj` alongside a model is attached to
its preset. Files with missing/unreadable context metadata stop preparation with
an error rather than being given an invented limit. Fix or move that incompatible
file outside the selected model directory and retry; files are never deleted.
The metadata limit is a model bound, not a promise that your RAM/GPU can allocate
that context. Start small and increase according to your machine's capacity.

Saved custom providers pointing to this router receive the same settings/limits;
other local ports and remote/cloud providers retain their own configuration.
Credentials, manual capabilities and unknown configuration fields are preserved.
The old single-file `--model` launcher can advertise only that model; the new
launcher uses verified per-model presets with autoload and one loaded model at a
time. Updating Git does not rewrite an already installed Windows shortcut.

### Single-model manual validation

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
   By default this checks readiness/catalog using GET only, sending no prompt.
   An explicitly requested inference check adds `--inference`; it sends a bounded
   greeting and can cause router autoload. Never run inference or tool tests
   automatically from launchers or pre-start hooks.

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

5. Only when explicitly validating inference/tools, select the local provider and send a
   harmless prompt. Verify streaming and a read-only tool call in a disposable
   project. Apply the explicit project policy in Settings → Filesystem access;
   missing policy blocks project operations. Approve individual requests and
   confirm they appear in the owning conversation's activity.
6. Complete [private HTTPS/Tailscale validation](deployment.md) on the target
   host and an authorized second device. Use the
   [portable deployment check](workfree-deployment-validation.md) for actual
   HTTP/WebSocket login/CSRF/logout evidence, then perform the browser/model and
   cross-device revocation checks. Confirm logout/revocation closes access.

Repeat the passive readiness check after changing runtime/server configuration.
Inference and tool checks require an explicit validation request.
A service supervisor can invoke the same runtime script as a pre-start check,
using its protected environment and absolute checkout path; the committed units
contain no local paths, model secrets or automatic external deployment.

## Recorded validation and remaining access

The readiness script has eleven offline HTTP fixture tests for passive startup and explicit SSE/UTF-8 streaming,
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
