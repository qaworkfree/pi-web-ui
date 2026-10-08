# Launcher and personal storage

Run **Launch pipipiPopopo.cmd** in the Windows installation. `Start-Workfree.cmd` and `start-ui.cmd` call the same launcher. The launcher checks GitHub main, installs locked dependencies, builds a candidate, prepares local OCR/Python tools and then restarts the services. It never updates an installed llama.cpp, downloads model weights or sends prompts on startup. Every supported standalone GGUF in the configured model folder is available; context and output choices are independent and bounded by each model's metadata.

Open `http://127.0.0.1:8788/` and use your existing account. Configuration and port numbers are stored in `Personal/Config/service-config.json`. Startup opens a blank chat; previous conversations remain in History.

## Personal storage

The installation keeps all user data outside its source repositories:

- `Personal/Uploads`: uploaded documents.
- `Personal/Attachments`: saved attachment content.
- `Personal/UI`: authentication, chat settings, drafts and other UI state.
- `Personal/Agent`: agent settings, sessions and memory configuration.
- `Personal/Workspace`: generated documents, project files and local memories.
- `Personal/Config`: installation preferences and private integration settings.
- `Personal/Logs`, `Personal/Backups`, `Personal/Temp`: private logs, backups and temporary files.
- `Personal/Notes` and `Personal/Prompts`: private notes and prompts.

`PI_WEB_UPLOAD_DIR` and `PI_WEB_ATTACHMENT_DIR` select the dedicated storage locations. Without these overrides, other deployments retain their normal data-directory behavior. The Windows launcher disables automatic upload expiry so saved conversations do not lose their documents. Operators can configure retention separately.

Legacy directory junctions preserve references in old conversations; they point into Personal and contain no second copy. New uploads use the direct Personal path. Restored uploads resolve their physical location and remain restricted to the owning client's upload directory, including when a junction points to another client's files. The storage migration preserves existing filesystem policy decisions without overwriting destination conflicts. Stop existing services before migrating an older installation for the first time.

Keep personal projects inside Personal/Workspace. Never commit uploads, transcripts, authentication, memories, personal configuration, fiscal prompts or private diagnostic reports. Ignore rules do not remove existing tracked files or old commits. Publish an explicit reviewed source list. After a privacy history rewrite, deploy with `-GitHubOnly` to create fresh source clones rather than importing old local history.

## Documents

PDF/Office extraction and English/Portuguese OCR run locally. Long upload names retain their extensions; older extensionless PDF/Office uploads are recognized from their contents. The read tool supports page ranges and text continuation. A continued read preserves the selected extraction mode for the same file version and page range. Forced OCR must not silently turn into a binary or differently formatted read.

OCR language files are prepared once and reused offline. The Python toolkit supports documents, spreadsheets, analysis and charts. Public web searches send queries to the chosen search service.

## Recovery and checks

- `launch.ps1 -NoBrowser`: update and restart without opening the browser.
- `launch.ps1 -Repair`: reinstall dependencies and rebuild.
- `launch.ps1 -GitHubOnly -NoBrowser`: install a fresh GitHub checkout without local source patches. Use after a repository privacy history cleanup.
- `check-services.ps1`: service health.
- `validate-model.ps1`: model catalog/context metadata, without inference.
- `stop-services.ps1`: stop recorded services.

After preparation, the launcher replaces listener process trees on its two configured ports. Run it when you intend to restart current work. Failed preparation retains the previous usable build. `deployment.json` identifies deployed source folders; logs and backups remain private.

Regression checks: `uploads.test.ts`, `attachments.test.ts`, `attachment-store.test.ts`, `document-reader.test.ts` and the Windows `personal-storage-tests.ps1`/`launcher-tests.ps1` fixtures. OCR tests use prepared local language assets and synthetic documents; no model inference is required.
