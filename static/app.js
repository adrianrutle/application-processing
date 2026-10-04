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
  jobTitle: document.querySelector("#job-title"),
  saveJob: document.querySelector("#save-job"),
  newJob: document.querySelector("#new-job"),
  savedJobs: document.querySelector("#saved-jobs"),
  loadJob: document.querySelector("#load-job"),
  jobStatus: document.querySelector("#job-status"),
  pdfBatchConfig: document.querySelector("#pdf-batch-config"),
  pdfCandidateRanges: document.querySelector("#pdf-candidate-ranges"),
  xmlBatchConfig: document.querySelector("#xml-batch-config"),
  xmlCandidateGroup: document.querySelector("#xml-candidate-group"),
  xmlRecordStart: document.querySelector("#xml-record-start"),
  xmlRecordEnd: document.querySelector("#xml-record-end"),
  batchProgress: document.querySelector("#batch-progress"),
  exportReviews: document.querySelector("#export-reviews"),
  exportDemographics: document.querySelector("#export-demographics"),
};

let modelReady = false;
let selectedFile = null;
let selectedDocumentType = null;
let pdfPageCount = 0;
let xmlCandidateGroups = [];
let currentJobId = "";
let currentCriteriaSetId = "";
let criteriaDirty = false;
let batchInProgress = false;
let toastTimer;

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { elements.toast.hidden = true; }, 6500);
}

async function responseJson(response) {
  const body = await response.json();
  const requestId = response.headers.get("X-Request-ID");
  if (!response.ok) {
    const detail = body.detail || "The request could not be completed.";
    throw new Error(requestId ? `${detail} (request ${requestId})` : detail);
  }
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
      elements.modelStatusText.textContent = status.error || (status.provider === "lmstudio" ? "LM Studio server not reachable" : "Local Ollama not reachable");
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
  const hasCandidateUnits = selectedDocumentType === "pdf"
    ? pdfPageCount > 0
    : selectedDocumentType === "xml" && xmlCandidateGroups.length > 0;
  elements.reviewCandidate.disabled = !modelReady
    || !selectedFile
    || !hasCandidateUnits
    || !currentJobId
    || !currentCriteriaSetId
    || criteriaDirty
    || batchInProgress;
  updateSaveButton();
  elements.exportReviews.disabled = !currentJobId;
  elements.exportDemographics.disabled = !currentJobId;
  elements.reviewCandidate.textContent = selectedDocumentType === "xml" && xmlCandidateGroups.length
    ? "Review selected candidates"
    : "Start review batch";
}

function updateSaveButton() {
  elements.saveJob.disabled = !elements.jobTitle.value.trim() || !criteriaValues().length || batchInProgress;
}

async function refreshSavedJobs(selectedId = "") {
  const result = await responseJson(await fetch("/api/jobs", { cache: "no-store" }));
  elements.savedJobs.replaceChildren(new Option("Choose a saved role", ""));
  for (const job of result.jobs) {
    const option = new Option(`${job.title} · v${job.version} · ${job.criteria_count} criteria`, job.id);
    elements.savedJobs.append(option);
  }
  elements.savedJobs.value = selectedId;
  elements.loadJob.disabled = !elements.savedJobs.value;
}

async function loadSavedJob(jobId) {
  if (!jobId) return;
  try {
    const job = await responseJson(await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" }));
    currentJobId = job.id;
    currentCriteriaSetId = job.criteria_set_id;
    criteriaDirty = false;
    elements.jobTitle.value = job.title;
    elements.jobTitle.disabled = true;
    elements.criteriaList.replaceChildren();
    for (const criterion of job.criteria) addCriterion(criterion, false);
    elements.jobStatus.textContent = `Loaded criteria version ${job.criteria_version}.`;
    await refreshSavedJobs(job.id);
    const reviews = await responseJson(await fetch(`/api/jobs/${encodeURIComponent(job.id)}/reviews`, { cache: "no-store" }));
    renderSavedReviews(reviews.reviews);
  } catch (error) {
    showToast(error.message);
  }
  updateReviewButton();
}

async function saveCurrentJob() {
  const title = elements.jobTitle.value.trim();
  const criteria = criteriaValues();
  if (!title || !criteria.length) return;
  elements.saveJob.disabled = true;
  try {
    let saved;
    if (currentJobId) {
      saved = await responseJson(await fetch(`/api/jobs/${encodeURIComponent(currentJobId)}/criteria`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ criteria }),
      }));
      currentCriteriaSetId = saved.id;
      elements.jobStatus.textContent = `Saved criteria version ${saved.version}.`;
    } else {
      saved = await responseJson(await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, criteria }),
      }));
      currentJobId = saved.id;
      currentCriteriaSetId = saved.criteria_set_id;
      elements.jobTitle.disabled = true;
      elements.jobStatus.textContent = "Role and criteria saved locally.";
    }
    criteriaDirty = false;
    await refreshSavedJobs(currentJobId);
  } catch (error) {
    showToast(error.message);
  }
  updateReviewButton();
}

function renderSavedReviews(reviews) {
  elements.resultsList.replaceChildren();
  if (!reviews.length) {
    const empty = document.createElement("p");
    empty.className = "empty-results";
    empty.textContent = "No saved reviews for this role yet.";
    elements.resultsList.append(empty);
    elements.clearReviews.disabled = true;
    return;
  }
  for (const item of reviews) {
    const row = document.createElement("article");
    row.className = "candidate-result";
    const heading = document.createElement("div");
    heading.className = "candidate-result-heading";
    const title = document.createElement("h3");
    title.textContent = item.display_label;
    const timestamp = document.createElement("span");
    timestamp.textContent = `${item.criteria_count} criteria · ${new Date(item.created_at).toLocaleString()}`;
    heading.append(title, timestamp);
    const summary = document.createElement("p");
    summary.className = "result-summary";
    summary.textContent = item.summary;
    row.append(heading, summary);
    elements.resultsList.append(row);
  }
  elements.clearReviews.disabled = false;
}

function addCriterion(criterion = { name: "", description: "", category: "required" }, focus = true) {
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
    criteriaDirty = true;
    elements.jobStatus.textContent = "Unsaved criteria changes";
    if (!elements.criteriaList.querySelector(".criterion-row")) {
      const empty = document.createElement("div");
      empty.className = "empty-criteria";
      empty.textContent = "No criteria added yet.";
      elements.criteriaList.append(empty);
    }
    updateReviewButton();
  });

  for (const input of [name, description, category]) {
    input.addEventListener("input", () => {
      criteriaDirty = true;
      elements.jobStatus.textContent = "Unsaved criteria changes";
      updateReviewButton();
    });
  }
  category.addEventListener("change", () => {
    criteriaDirty = true;
    elements.jobStatus.textContent = "Unsaved criteria changes";
    updateReviewButton();
  });
  row.append(fields, category, remove);
  elements.criteriaList.append(row);
  updateReviewButton();
  if (focus) name.focus();
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

function parsePdfCandidateRanges() {
  // Page splits must be explicit; guessing equal-sized candidates can mix two applicants.
  const lines = elements.pdfCandidateRanges.value.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) {
    const pageStart = Number(elements.pageStart.value);
    const pageEnd = Number(elements.pageEnd.value);
    if (!pageStart || !pageEnd || pageStart > pageEnd || pageEnd > pdfPageCount) {
      throw new Error(`Enter a PDF page range from 1 to ${pdfPageCount}.`);
    }
    return [{
      label: elements.candidateLabel.value.trim() || "Candidate 001",
      local_reference: "",
      page_start: pageStart,
      page_end: pageEnd,
    }];
  }

  return lines.map((line, index) => {
    const [label, startText, endText, localReference = ""] = line.split(",").map((part) => part.trim());
    const pageStart = Number(startText);
    const pageEnd = Number(endText);
    if (!label || !pageStart || !pageEnd || pageStart > pageEnd || pageEnd > pdfPageCount) {
      throw new Error(`Invalid PDF range on line ${index + 1}. Use: label, first page, last page.`);
    }
    return { label, local_reference: localReference, page_start: pageStart, page_end: pageEnd };
  });
}

function renderFailedCandidate(item) {
  const row = document.createElement("article");
  row.className = "candidate-result";
  const heading = document.createElement("div");
  heading.className = "candidate-result-heading";
  const title = document.createElement("h3");
  title.textContent = item.label;
  const status = document.createElement("span");
  status.className = "assessment-status not_evidenced";
  status.textContent = "Review failed";
  heading.append(title, status);
  const note = document.createElement("p");
  note.className = "assessment-note";
  note.textContent = item.error || "No review result was saved.";
  row.append(heading, note);
  elements.resultsList.prepend(row);
}

function renderBatch(batch) {
  elements.resultsList.replaceChildren();
  for (const item of [...batch.items].reverse()) {
    if (item.result) renderResult(item.label, item.result);
    else if (item.status === "failed") renderFailedCandidate(item);
  }
  if (!batch.items.some((item) => item.result || item.status === "failed")) {
    const empty = document.createElement("p");
    empty.className = "empty-results";
    empty.textContent = "The batch completed without saved reviews.";
    elements.resultsList.append(empty);
  }
  elements.clearReviews.disabled = !currentJobId;
}

async function pollReviewBatch(batchId) {
  elements.batchProgress.hidden = false;
  for (;;) {
    const batch = await responseJson(await fetch(`/api/review-batches/${encodeURIComponent(batchId)}`, { cache: "no-store" }));
    const done = batch.completed_items + batch.failed_items;
    elements.batchProgress.max = Math.max(1, batch.total_items);
    elements.batchProgress.value = done;
    elements.reviewStatus.textContent = `Reviewing ${done} of ${batch.total_items} candidates · ${batch.completed_items} complete · ${batch.failed_items} failed`;
    if (["complete", "complete_with_errors"].includes(batch.status)) {
      renderBatch(batch);
      elements.reviewStatus.textContent = `Batch finished: ${batch.completed_items} reviewed, ${batch.failed_items} failed. Results saved locally.`;
      return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
  }
}

elements.addCriterion.addEventListener("click", () => addCriterion());
elements.saveJob.addEventListener("click", saveCurrentJob);
elements.newJob.addEventListener("click", () => {
  currentJobId = "";
  currentCriteriaSetId = "";
  criteriaDirty = false;
  elements.jobTitle.value = "";
  elements.jobTitle.disabled = false;
  elements.savedJobs.value = "";
  elements.criteriaList.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "empty-criteria";
  empty.textContent = "No criteria added yet.";
  elements.criteriaList.append(empty);
  elements.jobStatus.textContent = "New role";
  renderSavedReviews([]);
  updateReviewButton();
});
elements.jobTitle.addEventListener("input", updateSaveButton);
elements.savedJobs.addEventListener("change", () => {
  elements.loadJob.disabled = !elements.savedJobs.value;
});
elements.loadJob.addEventListener("click", () => loadSavedJob(elements.savedJobs.value));

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
    const response = await fetch(endpoint, requestOptions);
    const requestId = response.headers.get("X-Request-ID");
    const result = await responseJson(response);
    elements.criteriaList.replaceChildren();
    for (const criterion of result.criteria) addCriterion(criterion);
    criteriaDirty = true;
    elements.jobStatus.textContent = "Extracted criteria need to be saved before review.";
    elements.criteriaStatus.textContent = `${result.criteria.length} criteria extracted; review and edit them.${requestId ? ` Request ${requestId}.` : ""}`;
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
  xmlCandidateGroups = [];
  pdfPageCount = 0;
  elements.pageRange.hidden = true;
  elements.pdfBatchConfig.hidden = true;
  elements.xmlBatchConfig.hidden = true;
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
      elements.pdfBatchConfig.hidden = false;
      elements.pdfCandidateRanges.placeholder = `One candidate per line: label, first page, last page\nCandidate 001, 1, 2\nCandidate 002, 3, 4-5\n\n${pdfPageCount} pages detected`;
    } else {
      xmlCandidateGroups = info.candidate_groups || [];
      elements.fileDetails.textContent = `XML · ${xmlCandidateGroups.reduce((total, group) => total + group.count, 0)} candidate records · ${info.text_chars.toLocaleString()} reviewable characters`;
      elements.xmlBatchConfig.hidden = xmlCandidateGroups.length === 0;
      elements.xmlCandidateGroup.replaceChildren();
      for (const group of xmlCandidateGroups) {
        const option = new Option(`${group.path} · ${group.count} candidates`, group.path);
        elements.xmlCandidateGroup.append(option);
      }
      if (xmlCandidateGroups.length) {
        elements.xmlRecordStart.value = "1";
        elements.xmlRecordEnd.value = String(xmlCandidateGroups[0].count);
        elements.xmlRecordEnd.max = String(xmlCandidateGroups[0].count);
      } else {
        elements.fileDetails.textContent = `XML · ${info.source_count} text paths · no repeated candidate records detected`;
      }
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

elements.xmlCandidateGroup.addEventListener("change", () => {
  const group = xmlCandidateGroups.find((item) => item.path === elements.xmlCandidateGroup.value);
  if (group) {
    elements.xmlRecordStart.max = String(group.count);
    elements.xmlRecordEnd.max = String(group.count);
    elements.xmlRecordStart.value = "1";
    elements.xmlRecordEnd.value = String(group.count);
  }
});

elements.reviewCandidate.addEventListener("click", async () => {
  if (!selectedFile || !currentJobId || !currentCriteriaSetId || criteriaDirty) return;
  const form = new FormData();
  form.append("document", selectedFile);
  form.append("job_id", currentJobId);
  form.append("criteria_set_id", currentCriteriaSetId);
  if (selectedDocumentType === "pdf") {
    try {
      form.append("pdf_ranges_json", JSON.stringify(parsePdfCandidateRanges()));
    } catch (error) {
      showToast(error.message);
      return;
    }
  } else {
    const recordGroup = xmlCandidateGroups.find((group) => group.path === elements.xmlCandidateGroup.value);
    const start = Number(elements.xmlRecordStart.value);
    const end = Number(elements.xmlRecordEnd.value);
    if (!recordGroup || !start || !end || start > end || end > recordGroup.count) {
      showToast("Choose a valid XML candidate record range.");
      return;
    }
    form.append("xml_record_path", recordGroup.path);
    form.append("xml_start", String(start));
    form.append("xml_end", String(end));
  }
  batchInProgress = true;
  elements.reviewCandidate.disabled = true;
  elements.reviewStatus.textContent = "Uploading document to the local app and queuing reviews…";
  try {
    const startResponse = await fetch("/api/review-batches", { method: "POST", body: form });
    const batch = await responseJson(startResponse);
    elements.reviewStatus.textContent = `Queued ${batch.candidate_count} candidates · batch ${batch.batch_id.slice(0, 8)}`;
    await pollReviewBatch(batch.batch_id);
  } catch (error) {
    elements.reviewStatus.textContent = "Review failed.";
    showToast(error.message);
  } finally {
    batchInProgress = false;
    updateReviewButton();
  }
});

elements.exportReviews.addEventListener("click", () => {
  if (currentJobId) window.location.assign(`/api/jobs/${encodeURIComponent(currentJobId)}/export.csv`);
});

elements.exportDemographics.addEventListener("click", () => {
  if (currentJobId) window.location.assign(`/api/jobs/${encodeURIComponent(currentJobId)}/demographics.csv`);
});

elements.clearReviews.addEventListener("click", () => {
  elements.resultsList.replaceChildren();
  const empty = document.createElement("p");
  empty.className = "empty-results";
  empty.textContent = "Candidate reviews will appear here.";
  elements.resultsList.append(empty);
  elements.clearReviews.disabled = !currentJobId;
});

refreshSavedJobs().catch((error) => showToast(error.message));
updateReviewButton();
checkModel();