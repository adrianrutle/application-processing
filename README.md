# Application Review

A local-first tool for comparing candidate application PDFs or XML with job-related criteria. Candidate documents are processed only by a loopback Ollama or LM Studio endpoint. The app does not save applications, CVs, criteria, or review results between browser sessions.

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

The app discovers the model ID from LM Studio. If more than one model is available, set `LM_STUDIO_MODEL` to the ID shown by `curl http://127.0.0.1:1234/v1/models`. The app uses LM Studio's OpenAI-compatible chat-completions API with JSON response mode and blocks non-loopback model URLs.

### Docker on macOS

Docker Desktop can run the app while LM Studio stays installed on the Mac. In LM Studio, load Qwen and start the local server on port `1234`. From this project directory on the Mac, run:

```sh
docker compose up --build
```

Open <http://127.0.0.1:8000>. Docker Desktop routes `host.docker.internal` from the app container to the Mac's LM Studio server. The app accepts that host gateway only for LM Studio; the web UI port is published on the Mac's loopback interface only. Stop it with `Ctrl+C`.

If your LM Studio server requires an API key, export `LM_STUDIO_API_KEY` in the same terminal before starting Compose. To select a specific loaded model, export `LM_STUDIO_MODEL` to its ID first. Do not enable LM Studio's network-wide access unless required; `host.docker.internal` is intended to connect the container to the Mac host.

## Review flow

1. Paste an announcement, upload its PDF, or enter its public HTTPS URL; extract criteria with the local model.
2. Edit the criteria; add or remove items as needed.
3. Select a candidate PDF or XML. For a combined PDF, enter the candidate's page range; XML evidence cites element paths.
4. Review the evidence notes and check each citation against the original document.

The app handles text-based PDFs and XML up to 50 MB. Image-only scans need OCR before use. Large PDFs can be reviewed in smaller page ranges. Announcement URLs must use HTTPS, resolve to public IP addresses, and not redirect. Application documents are parsed for the request and are not added to a database; multipart uploads may be temporarily spooled by the web framework to the machine's system temporary directory. Review results stay in browser memory until the page is closed or cleared.

## Scope and safeguards

- The model extracts explicit job-related criteria and compares application text with those criteria; it does not rank candidates or recommend hiring decisions.
- Candidate labels are not sent to the model. Evidence quotes are checked against extracted PDF text or XML element content before they are displayed.
- Missing information is not treated as proof that a candidate lacks a qualification. Review labels are prompts for human verification, not findings of fact.
- This MVP sends candidate text only to a loopback Ollama or LM Studio service and blocks Ollama models tagged `:cloud`. It has no cloud LLM mode, anonymization service, OCR, or persistent storage.
- A local model can still produce inaccurate or biased output. Use consistent job-related criteria, review the source pages, and make decisions yourself.

## Tests

```sh
python -m unittest discover -s tests
```