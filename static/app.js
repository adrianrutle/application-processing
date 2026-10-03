const elements = {
  modelStatus: document.querySelector("#model-status"),
  modelStatusText: document.querySelector("#model-status-text"),
  endpointLabel: document.querySelector("#endpoint-label"),
  privacyNote: document.querySelector("#privacy-note"),
  announcement: document.querySelector("#announcement"),
  announcementUrl: document.querySelector("#announcement-url"),
  announcementPdf: document.querySelector("#announcement-pdf"),
  announcementPdfName: document.querySelector("#announcement-pdf-name"),
  announcementTextPanel: document.querySelector("#announcement-text-panel"),
  announcementPdfPanel: document.querySelector("#announcement-pdf-panel"),
  announcementUrlPanel: document.querySelector("#announcement-url-panel"),
  extractCriteria: document.querySelector("#extract-criteria"),
  criteriaStatus: document.querySelector("#criteria-status"),
  criteriaList: document.querySelector("#criteria-list"),
  addCriterion: document.querySelector("#add-criterion"),
  candidateLabel: document.querySelector("#candidate-label"),
  candidateDocument: document.querySelector("#candidate-document"),
  fileName: document.querySelector("#file-name"),
  fileDetails: document.querySelector("#file-details"),
  pageRange: document.querySelector("#page-range"),
  pageCountLabel: document.querySelector("#page-count-label"),
  pageStart: document.querySelector("#page-start"),
  pageEnd: document.querySelector("#page-end"),
  reviewCandidate: document.querySelector("#review-candidate"),
  reviewStatus: document.querySelector("#review-status"),
  resultsList: document.querySelector("#results-list"),
  clearReviews: document.querySelector("#clear-reviews"),
  toast: document.querySelector("#toast"),
};

let modelReady = false;
let selectedFile = null;
let selectedDocumentType = null;
let pdfPageCount = 0;
let toastTimer;

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { elements.toast.hidden = true; }, 6500);
}

async function responseJson(response) {
  const body = await response.json();
  if (!response.ok) throw new Error(body.detail || "The request could not be completed.");
  return body;
}

async function checkModel() {
  try {
    const status = await responseJson(await fetch("/api/status", { cache: "no-store" }));
    elements.endpointLabel.textContent = `Model endpoint: ${status.endpoint}`;
    if (status.running_in_codespaces) {
      elements.privacyNote.classList.add("is-warning");
      elements.privacyNote.querySelector("p").textContent = "This app is running in a remote Codespace. Uploading a candidate PDF or XML sends it from your device to that remote machine. Do not use real applications here; run the app on your own machine for private reviews.";
    }
    if (!status.endpoint_is_local) {
      elements.modelStatus.className = "model-status is-error";
      elements.modelStatusText.textContent = "Non-local model endpoint blocked";
      elements.privacyNote.classList.add("is-warning");
      const setting = status.provider === "lmstudio" ? "LM_STUDIO_BASE_URL" : "OLLAMA_BASE_URL";
      elements.privacyNote.querySelector("p").textContent = `The model endpoint is not loopback. Candidate data processing is disabled until ${setting} points to this machine.`;
      return;
    }
    if (status.cloud_model_blocked) {
      elements.modelStatus.className = "model-status is-error";
      elements.modelStatusText.textContent = "Ollama cloud model blocked";
      elements.endpointLabel.textContent += " · choose a local model";
      return;
    }
    if (!status.connected) {
      elements.modelStatus.className = "model-status is-error";
      elements.modelStatusText.textContent = status.provider === "lmstudio" ? "LM Studio server not reachable" : "Local Ollama not reachable";
      return;
    }
    if (!status.model_available) {
      elements.modelStatus.className = "model-status is-error";
      if (status.provider === "lmstudio") {
        elements.modelStatusText.textContent = status.model ? `LM Studio model not found: ${status.model}` : "Load a model in LM Studio";
        elements.endpointLabel.textContent += " · start the local server and load Qwen";
      } else {
        elements.modelStatusText.textContent = `Model missing: ${status.model}`;
        elements.endpointLabel.textContent += ` · pull ${status.model}`;
      }
      return;
    }
    modelReady = true;
    elements.modelStatus.className = "model-status is-ready";
    elements.modelStatusText.textContent = `${status.provider === "lmstudio" ? "LM Studio ready" : "Ollama ready"} · ${status.model}`;
    elements.extractCriteria.disabled = false;
    updateReviewButton();
  } catch {
    elements.modelStatus.className = "model-status is-error";
    elements.modelStatusText.textContent = "Local model status unavailable";
  }
}

function criteriaValues() {
  return [...elements.criteriaList.querySelectorAll(".criterion-row")].map((row) => ({
    name: row.querySelector(".criterion-name").value.trim(),
    description: row.querySelector(".criterion-description").value.trim(),
    category: row.querySelector(".criterion-category").value,
  })).filter((criterion) => criterion.name && criterion.description);
}

function updateReviewButton() {
  elements.reviewCandidate.disabled = !modelReady || !selectedDocumentType || criteriaValues().length === 0;
}

function addCriterion(criterion = { name: "", description: "", category: "required" }) {
  elements.criteriaList.querySelector(".empty-criteria")?.remove();
  const row = document.createElement("div");
  row.className = "criterion-row";

  const fields = document.createElement("div");
  fields.className = "criterion-fields";
  const name = document.createElement("input");
  name.className = "criterion-name";
  name.type = "text";
  name.maxLength = 120;
  name.placeholder = "Criterion name";
  name.setAttribute("aria-label", "Criterion name");
  name.value = criterion.name;
  const description = document.createElement("textarea");
  description.className = "criterion-description";
  description.maxLength = 600;
  description.rows = 2;
  description.placeholder = "What evidence meets this criterion?";
  description.setAttribute("aria-label", "Criterion description");
  description.value = criterion.description;
  const category = document.createElement("select");
  category.className = "criterion-category";
  category.setAttribute("aria-label", "Criterion category");
  for (const [value, label] of [["required", "Required"], ["preferred", "Preferred"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    category.append(option);
  }
  category.value = criterion.category;
  fields.append(name, description);

  const remove = document.createElement("button");
  remove.className = "remove-criterion";
  remove.type = "button";
  remove.textContent = "Remove";
  remove.setAttribute("aria-label", "Remove criterion");
  remove.addEventListener("click", () => {
    row.remove();
    if (!elements.criteriaList.querySelector(".criterion-row")) {
      const empty = document.createElement("div");
      empty.className = "empty-criteria";
      empty.textContent = "No criteria added yet.";
      elements.criteriaList.append(empty);
    }
    updateReviewButton();
  });

  for (const input of [name, description, category]) input.addEventListener("input", updateReviewButton);
  category.addEventListener("change", updateReviewButton);
  row.append(fields, category, remove);
  elements.criteriaList.append(row);
  updateReviewButton();
  name.focus();
}

function renderResult(label, result) {
  const container = document.createElement("article");
  container.className = "candidate-result";
  const heading = document.createElement("div");
  heading.className = "candidate-result-heading";
  const title = document.createElement("h3");
  title.textContent = label;
  const time = document.createElement("span");
  time.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date());
  heading.append(title, time);

  const summary = document.createElement("p");
  summary.className = "result-summary";
  summary.textContent = result.summary;
  const assessments = document.createElement("div");
  assessments.className = "assessment-list";

  for (const item of result.criteria) {
    const assessment = document.createElement("section");
    assessment.className = "assessment";
    const top = document.createElement("div");
    top.className = "assessment-top";
    const criterion = document.createElement("h4");
    criterion.textContent = item.criterion;
    const state = document.createElement("span");
    state.className = `assessment-status ${item.assessment}`;
    state.textContent = ({ evidenced: "Evidence found", not_evidenced: "Not found in source", unclear: "Unclear" })[item.assessment];
    top.append(criterion, state);
    assessment.append(top);

    if (item.notes) {
      const note = document.createElement("p");
      note.className = "assessment-note";
      note.textContent = item.notes;
      assessment.append(note);
    }
    if (item.evidence.length) {
      const evidenceList = document.createElement("ul");
      evidenceList.className = "evidence-list";
      for (const evidence of item.evidence) {
        const entry = document.createElement("li");
        const page = document.createElement("span");
        page.className = "evidence-page";
        page.textContent = evidence.reference;
        const quote = document.createElement("q");
        quote.textContent = evidence.quote;
        entry.append(page, quote);
        evidenceList.append(entry);
      }
      assessment.append(evidenceList);
    }
    assessments.append(assessment);
  }

  container.append(heading, summary, assessments);
  if (elements.resultsList.querySelector(".empty-results")) elements.resultsList.replaceChildren();
  elements.resultsList.prepend(container);
  elements.clearReviews.disabled = false;
}

elements.addCriterion.addEventListener("click", () => addCriterion());

elements.extractCriteria.addEventListener("click", async () => {
  const mode = document.querySelector('input[name="announcement-mode"]:checked').value;
  let endpoint = "/api/criteria";
  let requestOptions;
  if (mode === "text") {
    const announcement = elements.announcement.value.trim();
    if (announcement.length < 30) {
      showToast("Paste at least 30 characters of announcement text.");
      return;
    }
    requestOptions = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ announcement }),
    };
  } else if (mode === "pdf") {
    const file = elements.announcementPdf.files?.[0];
    if (!file) {
      showToast("Choose a job announcement PDF first.");
      return;
    }
    endpoint = "/api/criteria-pdf";
    const form = new FormData();
    form.append("announcement_pdf", file);
    requestOptions = { method: "POST", body: form };
  } else {
    const url = elements.announcementUrl.value.trim();
    if (!url) {
      showToast("Enter the public HTTPS announcement URL first.");
      return;
    }
    endpoint = "/api/criteria-url";
    requestOptions = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    };
  }
  elements.extractCriteria.disabled = true;
  elements.criteriaStatus.textContent = "Extracting with local model…";
  try {
    const result = await responseJson(await fetch(endpoint, requestOptions));
    elements.criteriaList.replaceChildren();
    for (const criterion of result.criteria) addCriterion(criterion);
    elements.criteriaStatus.textContent = `${result.criteria.length} criteria extracted; review and edit them.`;
  } catch (error) {
    elements.criteriaStatus.textContent = "Extraction failed.";
    showToast(error.message);
  } finally {
    elements.extractCriteria.disabled = !modelReady;
    updateReviewButton();
  }
});

for (const input of document.querySelectorAll('input[name="announcement-mode"]')) {
  input.addEventListener("change", () => {
    const mode = document.querySelector('input[name="announcement-mode"]:checked').value;
    elements.announcementTextPanel.hidden = mode !== "text";
    elements.announcementPdfPanel.hidden = mode !== "pdf";
    elements.announcementUrlPanel.hidden = mode !== "url";
  });
}

elements.announcementPdf.addEventListener("change", () => {
  elements.announcementPdfName.textContent = elements.announcementPdf.files?.[0]?.name || "Choose announcement PDF";
});

elements.candidateDocument.addEventListener("change", async () => {
  selectedFile = elements.candidateDocument.files?.[0] || null;
  selectedDocumentType = null;
  pdfPageCount = 0;
  elements.pageRange.hidden = true;
  if (!selectedFile) {
    elements.fileName.textContent = "Choose a PDF or XML";
    elements.fileDetails.textContent = "PDF page ranges are supported; XML citations use element paths";
    updateReviewButton();
    return;
  }
  elements.fileName.textContent = selectedFile.name;
  elements.fileDetails.textContent = "Reading document locally…";
  const form = new FormData();
  form.append("document", selectedFile);
  try {
    const info = await responseJson(await fetch("/api/document-info", { method: "POST", body: form }));
    selectedDocumentType = info.document_type;
    if (info.document_type === "pdf") {
      pdfPageCount = info.page_count;
      elements.fileDetails.textContent = `PDF · ${pdfPageCount} pages`;
      elements.pageCountLabel.textContent = `${pdfPageCount} pages in this file`;
      elements.pageStart.max = String(pdfPageCount);
      elements.pageEnd.max = String(pdfPageCount);
      elements.pageStart.value = "1";
      elements.pageEnd.value = String(pdfPageCount);
      elements.pageRange.hidden = false;
    } else {
      elements.fileDetails.textContent = `XML · ${info.source_count} text sections`;
    }
  } catch (error) {
    selectedFile = null;
    selectedDocumentType = null;
    elements.fileName.textContent = "Could not read document";
    elements.fileDetails.textContent = "Choose a valid PDF or XML file";
    showToast(error.message);
  }
  updateReviewButton();
});

elements.reviewCandidate.addEventListener("click", async () => {
  if (!selectedFile || !criteriaValues().length) return;
  const start = selectedDocumentType === "pdf" ? Number(elements.pageStart.value) : null;
  const end = selectedDocumentType === "pdf" ? Number(elements.pageEnd.value) : null;
  if (selectedDocumentType === "pdf" && (!start || !end || start > end || end > pdfPageCount)) {
    showToast(`Enter a page range from 1 to ${pdfPageCount}.`);
    return;
  }

  const form = new FormData();
  form.append("document", selectedFile);
  form.append("criteria_json", JSON.stringify({ criteria: criteriaValues() }));
  if (selectedDocumentType === "pdf") {
    form.append("page_start", String(start));
    form.append("page_end", String(end));
  }
  const label = elements.candidateLabel.value.trim() || selectedFile.name.replace(/\.(pdf|xml)$/i, "") || "Candidate";
  elements.reviewCandidate.disabled = true;
  elements.reviewStatus.textContent = "Reviewing with local model…";
  try {
    const result = await responseJson(await fetch("/api/review", { method: "POST", body: form }));
    renderResult(label, result);
    elements.reviewStatus.textContent = "Review complete. Verify each note against the original application.";
  } catch (error) {
    elements.reviewStatus.textContent = "Review failed.";
    showToast(error.message);
  } finally {
    updateReviewButton();
  }
});

elements.clearReviews.addEventListener("click", () => {
  elements.resultsList.replaceChildren();
  const empty = document.createElement("p");
  empty.className = "empty-results";
  empty.textContent = "Candidate reviews will appear here.";
  elements.resultsList.append(empty);
  elements.clearReviews.disabled = true;
});

checkModel();