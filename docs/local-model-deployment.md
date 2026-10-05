# Local-model deployment checklist

Model configuration and the inference readiness check belong to
[pipipiPopopo](https://github.com/qaworkfree/pipipiPopopo). Follow its
[Workfree local-model guide](https://github.com/qaworkfree/pipipiPopopo/blob/main/packages/coding-agent/docs/workfree-local-models.md)
and [compatible-provider example](https://github.com/qaworkfree/pipipiPopopo/blob/main/packages/coding-agent/examples/models/workfree-local.json).
The UI reuses these providers; it does not implement a second model runtime.

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
   host and an authorized second device. Confirm logout/revocation closes access.

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

Hugging Face GGUF downloads still receive HTTP 403. Real GGUF inference, model
tool-call compatibility, GPU behavior and second-device Tailscale access remain
**unverified**. Supply permitted model-download access (or a local GGUF with its
source/checksum), the intended host and access to its tailnet before recording
those checks as passed. The deployment model and hardware must be chosen for that
host; simulated SSE is not evidence of model quality.
