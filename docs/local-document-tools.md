# Local document and data tools

The local pi engine can read PDF, DOCX, PPTX and XLSX attachments using its core `read` tool. PDFs with selectable text are extracted directly. Scanned pages, and image attachments for text-only models, use local Tesseract OCR with English and Portuguese language data. This works with Qwen3-Next 80B without switching to a vision model.

Uploaded, restored and path-referenced documents include a small first-page preview. Preview text shares a budget across attachments based on the selected model's context. The agent reads remaining pages on demand with `read({path, pages:"2-4"})`; ranges contain at most ten pages. `ocr:"force"` retries pages with an unreliable text layer. `text_offset` resumes truncated tool results without losing part of a long line. Ordinary text-file attachment behavior is unchanged.

OCR runs in a separate Node process with a two-minute timeout, cancellation, bounded rendering dimensions, input/output limits and a small cache. PDF.js renders scanned pages and Tesseract.js extracts text. DOCX is grouped into text chunks, PPTX into slides and XLSX into sheets. Office macros, formulas and external links are never executed; spreadsheet formula results are cached values from the file. OCR confidence and source page numbers are included. OCR extracts text; charts, arbitrary images and handwriting may need a vision-capable model and review.

`launch.ps1` installs locked npm dependencies and primes the English/Portuguese OCR cache before replacing running services. A successful preparation makes PDF extraction and OCR available offline. Uploaded documents are processed locally; language-data preparation downloads only public OCR assets. The installed llama.cpp binary is untouched. Startup stays blank and never runs model capability tests.

The launcher also prepares an isolated Python environment with ReportLab, python-docx, python-pptx, openpyxl, pandas and matplotlib. The existing `eval`, `powershell` and `bash` tools can create documents, analyze data and plot charts; `present_files` exposes requested outputs. The `local-documents` skill in the local agent configuration explains these capabilities. Tool use still follows normal filesystem and execution approval rules.

The complete Windows launcher and toolkit source is in [deploy/workfree-windows](../deploy/workfree-windows/README.md), including locked Python requirements, the agent skill and public web helper. Copy those reviewed files into an existing stack as described there; keep account data and installed models private. The application updater updates the repositories; root launcher file updates require copying the reviewed bundle.

Initial local filesystem rules allow work inside `D:/pipipiPopopo/test-project` and read-only access to user uploads/attachment storage, with execution/deletion requiring approval. Other paths stay blocked. Existing user-managed policies are preserved.

Public web search and page retrieval are available through the managed `tools/local-web.py` helper (DDGS search and HTTP page text). The agent can invoke it using its existing shell tools; results contain source URLs and pagination. Search sends queries to public services, while document extraction stays local. Browser control uses the existing page-picker extension and needs a granted page. Image generation, private cloud connectors and account-specific ChatGPT/Claude tools are separate integrations and require configuration.

Validation: `tests/unit/document-reader.test.ts` covers actual digital/scanned PDFs, offline OCR, Office extraction, corrupt documents, cancellation, page validation, small-context pagination, restored uploads and third-party read composition. Set `PI_WEB_TEST_OCR_CACHE` to the prepared cache directory to include real OCR tests.

Private storage: the Windows launcher keeps documents, conversations, credentials, outputs, logs and backups under the installation's `Personal` folder. Legacy paths remain compatible directory aliases. Git ignore rules exclude private data; publication must stage only explicitly reviewed source files.
