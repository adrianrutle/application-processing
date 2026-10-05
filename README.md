# Application Review

A local-first tool for comparing candidate application PDFs or XML with saved, job-related criteria. Candidate documents are processed only by a loopback Ollama or LM Studio endpoint.

**Run this on your own computer before using real applicant data.** A Codespace or other remote development container is not your device: uploaded PDFs and XML files are transferred to that remote machine even though model inference uses its local model endpoint. The app detects Codespaces and displays a warning.

## Run locally

Run the app on the same computer as its local model server. With [Ollama](https://ollama.com/), pull the default model:

```sh
ollama pull llama3.2:3b
```

Then install and run the app:

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8000
```

Open <http://127.0.0.1:8000>. The default Ollama endpoint is `http://127.0.0.1:11434`; configure a different **loopback** address with `OLLAMA_BASE_URL` or choose another installed model with `OLLAMA_MODEL`. The app blocks model endpoints that are not loopback addresses. Keep the web app bound to `127.0.0.1`.

### LM Studio on macOS

In LM Studio, load your Qwen model and start its local server from the Developer/Local Server view on port `1234`. Then run the app from this project on the Mac:

```sh
LLM_PROVIDER=lmstudio LM_STUDIO_BASE_URL=http://127.0.0.1:1234/v1 uvicorn app:app --host 127.0.0.1 --port 8000
```

The app discovers the model ID from LM Studio. If more than one model is available, set `LM_STUDIO_MODEL` to the ID shown by `curl http://127.0.0.1:1234/v1/models`. The app uses LM Studio's OpenAI-compatible chat-completions API in text mode, then parses and validates the returned JSON locally. It blocks non-loopback model URLs.

### Docker on macOS

Docker Desktop can run the app while LM Studio stays installed on the Mac. In LM Studio, load Qwen and start the local server on port `1234`. From this project directory on the Mac, run:

```sh
docker compose up --build
```

Open <http://127.0.0.1:8000>. Docker Desktop routes `host.docker.internal` from the app container to the Mac's LM Studio server. The app accepts that host gateway only for LM Studio; the web UI port is published on the Mac's loopback interface only. Stop it with `Ctrl+C`.

If your LM Studio server requires an API key, export `LM_STUDIO_API_KEY` in the same terminal before starting Compose. To select a specific loaded model, export `LM_STUDIO_MODEL` to its ID first. Do not enable LM Studio's network-wide access unless required; `host.docker.internal` is intended to connect the container to the Mac host.

## Review flow

1. Paste an announcement, upload its PDF, or enter its public HTTPS URL; extract criteria with the local model.
2. Edit and save the role. Criteria changes are stored as a new version.
3. Select a candidate PDF and enter one page range per applicant, or select an XML candidate element and record range.
4. Start the batch and monitor per-candidate progress. Each candidate is reviewed in a separate model request.
5. Review the evidence notes, then export the review CSV or the separate demographics CSV.

The app handles text-based PDFs and XML up to 50 MB. Image-only scans need OCR before use. PDF candidate ranges must be entered explicitly; the app never guesses boundaries from equal page counts. Jobbnorge-style XML exports are split by repeated `Candidate` elements (for the example structure, `/Jobbnorge_Export/Candidates/Candidate`). Announcement URLs must use HTTPS, resolve to public IP addresses, and not redirect.

Uploaded PDFs/XML are processed from the request and are not saved. The SQLite database stores job titles, criteria versions, applicant references, structured demographics extracted from XML, review results, and evidence excerpts. Demographics are in a separate table and are not included in model input or the standard review CSV; a separate demographics CSV is available explicitly. PDF demographics are not yet extracted into that table. Applicant files and their text are not stored as files in SQLite.

On macOS the default database is `~/Library/Application Support/Application Review/applications.sqlite3`; on Linux it is `$XDG_DATA_HOME/application-review/applications.sqlite3` or `~/.local/share/application-review/applications.sqlite3`. Override it with `APPLICATION_DB_PATH`. Docker Compose stores it in the persistent `application-review-data` volume. SQLite is not encrypted by the app; protect the computer/database with OS disk encryption and restrict access. Back up and delete the database according to your retention policy.

The XML source count is the number of distinct text-bearing element/attribute paths, not the number of candidates. XML direct identifier and demographic elements are excluded from model text; matching literal values, email addresses, and phone-like strings are also redacted locally from extracted text. PDF labels, emails, and phone-like strings receive heuristic redaction, but this is not guaranteed anonymization. Free-form applicant text may still identify someone; verify redaction before relying on it. All model requests remain local regardless.

The console emits request-correlated pipeline diagnostics: document type, page/path counts, text character counts, model/response type, token counts when supplied, JSON parsing/schema outcome, verified citation counts, request status, and duration. The UI shows the same request ID after completion or in an error, so its `request_id` log entries are easy to find. It deliberately does not log document text, prompts, or raw model output because those may contain applicant data. Each API response includes its request ID in the `X-Request-ID` header.

Model calls have a 600-second timeout by default because local reasoning models can take several minutes. Set `LLM_REQUEST_TIMEOUT_SECONDS` to change it. The console distinguishes `model.request.timeout` from `model.request.cancelled` and `http.cancelled` events, so a disconnect is not automatically mistaken for a timeout.

Criteria extraction is queued by the app and the browser polls for its result, so a slow local model does not hold the initial browser request open until an upstream gateway times out. Extraction tasks are kept in memory for up to one hour after completion and are lost if the app process restarts.

## Scope and safeguards

- The model extracts explicit job-related criteria and compares application text with those criteria; it does not rank candidates or recommend hiring decisions.
- Candidate labels and locally stored demographic fields are not sent to the model. Evidence quotes are checked against extracted PDF text or XML element content before they are displayed.
- Missing information is not treated as proof that a candidate lacks a qualification. Review labels are prompts for human verification, not findings of fact.
- This MVP sends candidate text only to a loopback Ollama or LM Studio service and blocks Ollama models tagged `:cloud`. It has no cloud LLM mode, guaranteed anonymization, or OCR.
- A local model can still produce inaccurate or biased output. Use consistent job-related criteria, review the source pages, and make decisions yourself.

## Tests

```sh
python -m unittest discover -s tests
```