# Workfree Windows deployment files

This directory contains the source of the automatic launcher and document/data toolkit used by the local installation. It contains no account data, uploaded documents, sessions, model weights, Python environment or installed llama.cpp binaries.

For an existing installation in `D:\pipipiPopopo`, copy the launcher `.ps1`/`.cmd` files and the `tools`, `tests` and `agent-config/skills/local-documents` source directories into that installation. Back up changed files first. Preserve the installation's `service-config.json`, `deployment.json`, `ui-data`, other agent configuration and existing model files. For a new configuration, copy `service-config.example.json` to `service-config.json` and adjust the paths; do not overwrite an existing configuration with the example.

The installation expects the `pipipiPopopo` and `pi-web-ui` Git checkouts under its root. Their origins must be `https://github.com/qaworkfree/pipipiPopopo` and `https://github.com/qaworkfree/pi-web-ui`. Git and Python 3.11+ must be installed. The configured llama-server must already support router presets; the launcher never updates or builds llama.cpp and never downloads model weights. The supplied skill's helper paths target `D:\pipipiPopopo`; adjust those paths if installing elsewhere.

Run **Launch pipipiPopopo.cmd**. The root `Start-Workfree.cmd` and `start-ui.cmd` are aliases. The UI repository's `Start-Workfree.cmd` forwards to the root automatic launcher when installed in this layout. The automatic launcher fetches GitHub main, preserves local source edits, installs lockfile dependencies, builds a separate candidate and promotes verified directory junctions so the main repository folders expose the live files. Conflicting edits or failed preparation leave the prior source available. `-GitHubOnly` explicitly discards local source customizations; use it only when that is intended. This updater updates the two application repositories; changing the root launcher files themselves requires copying the reviewed files from this directory again.

Before replacing services, preparation scans standalone GGUFs recursively, reads their context limits and preserves each model's selected context/output in `ui-data/local-launcher/profiles.json`. Projector companions are excluded from standalone selection; encoder models are labeled for embeddings. The router loads at most one model on demand. No model is prompted or benchmarked during startup.

The launcher prepares English/Portuguese OCR assets and an isolated Python environment in `tools/python`. PDF/Office extraction and OCR then work offline; Python supports document creation, spreadsheets, analysis and charts. `tools/local-web.py` supplies public web search and source-page text. Public queries leave the machine; document extraction does not. Private connectors, full browser control and hosted image generation require their respective integrations. See [local document tools](../../docs/local-document-tools.md).

After preparation, the launcher stops listener process trees on the configured ports (defaults 8080 and 8788), including unrelated listeners on those ports, then starts fresh services. System and ancestor processes are protected. Authentication and history are retained; existing user-managed filesystem policies are preserved. Initial filesystem permissions allow working inside `test-project` and reading uploads/attachments, with other paths blocked and execution/deletion requiring approval. Startup opens a blank chat and never automatically continues an old task.

The local interface is at `http://127.0.0.1:8788/`. First setup asks for a password; later launches reuse the existing account. No passwords are embedded in the scripts. The launcher does not configure Tailscale or change firewall rules. Allow the managed Python executable through your normal firewall controls if public web searches are blocked.

Useful commands from the installed root:

- `powershell.exe -NoProfile -File launch.ps1 -NoBrowser`: prepare/update/restart without opening a browser.
- `powershell.exe -NoProfile -File check-services.ps1`: inspect local health.
- `powershell.exe -NoProfile -File validate-model.ps1`: inspect model metadata/catalog without inference.
- `powershell.exe -NoProfile -File tests/launcher-tests.ps1`: isolated updater/folder fixtures.
- `powershell.exe -NoProfile -File tests/port-listeners-tests.ps1`: isolated listener replacement fixtures.

`tests/document-toolkit-smoke.py` creates synthetic files to verify Python libraries. `tests/document-ui-integration.mjs` runs isolated UI/model-stub services; drive its URL through a browser with synthetic PDF uploads and stop it through the printed stop endpoint. It never invokes a GGUF.

## Private storage

`prepare-personal-storage.ps1` stores UI conversations/uploads/authentication under `Personal/UI`, agent settings/sessions under `Personal/Agent`, generated work under `Personal/Workspace`, logs under `Personal/Logs` and backups under `Personal/Backups`. Directory junctions retain the old paths. On an existing installation, stop services with `stop-services.ps1` before the first migration. Existing destination conflicts fail without merging data. Filesystem permission rules retain their decisions at the corresponding physical paths.

The launcher prepares this layout automatically. Keep documents, prompts and other personal files in `Personal`; choose `Personal/Workspace` (or the compatible `test-project` alias) as your project. These folders and the legacy aliases are excluded by Git ignore rules. Ignore rules do not remove files already tracked by Git: inspect the exact staged filenames before every publication. Publish code through an explicit file list; never copy personal data or credentials into a source checkout.

Run `powershell.exe -NoProfile -File tests/personal-storage-tests.ps1` to verify preservation, aliases, policy equivalence, repeat runs and conflicting/external destination rejection with synthetic fixtures.
