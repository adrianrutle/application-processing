// Demo mode for static hosting (GitHub Pages) or `?demo` locally: answers /api/ calls in the browser
// with fictional data, so no file or text leaves the page and no server or model is needed.
(() => {
  const params = new URLSearchParams(window.location.search);
  if (!window.location.hostname.endsWith(".github.io") && !params.has("demo")) return;

  const DEMO_NOTICE = "Fictional demo answers; no model was used.";
  const SAMPLE_CRITERIA = [
    { name: "Master's degree", description: "Master's degree in robotics, computer science or a related field.", category: "required" },
    { name: "Programming", description: "Documented experience with Python or C++ in research or industry.", category: "required" },
    { name: "Robot software", description: "Experience with ROS or comparable robot middleware.", category: "preferred" },
    { name: "Scientific writing", description: "Publications or a thesis written in English.", category: "preferred" },
  ];
  const ASSESSMENTS = ["evidenced", "unclear", "not_evidenced"];
  const NOTES = {
    evidenced: "The demo text contains a passage that matches this criterion.",
    unclear: "The demo text mentions related work, but not clearly enough to confirm it.",
    not_evidenced: "No passage about this criterion was found in the demo text. Missing text is not proof of a missing qualification.",
  };

  const realFetch = window.fetch.bind(window);
  const jobs = new Map();
  const batches = new Map();
  const criteriaTasks = new Map();
  let idCounter = 0;

  class DemoError extends Error {
    constructor(status, detail) {
      super(detail);
      this.status = status;
    }
  }

  function newId(prefix) {
    idCounter += 1;
    return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
  }

  function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "X-Request-ID": newId("demo").slice(-12) },
    });
  }

  function csvResponse(rows, filename) {
    const escape = (value) => {
      let text = value == null ? "" : String(value);
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    const lines = rows.length ? [Object.keys(rows[0]).map(escape).join(",")] : [];
    for (const row of rows) lines.push(Object.values(row).map(escape).join(","));
    return new Response(`﻿${lines.join("\r\n")}`, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  function validCriteria(criteria) {
    if (!Array.isArray(criteria) || !criteria.length) throw new DemoError(422, "Add at least one criterion.");
    return criteria.map(({ name, description, category }) => ({ name, description, category }));
  }

  function createJob(title, criteria) {
    const job = {
      id: newId("job"),
      title,
      updated_at: new Date().toISOString(),
      sets: [{ id: newId("criteria"), version: 1, criteria: validCriteria(criteria) }],
      reviews: [],
    };
    jobs.set(job.id, job);
    return job;
  }

  function requireJob(jobId) {
    const job = jobs.get(jobId);
    if (!job) throw new DemoError(404, "Saved job not found.");
    return job;
  }

  function latestSet(job) {
    return job.sets[job.sets.length - 1];
  }

  function demoReview(criteria, candidateIndex, evidenceReference) {
    const items = criteria.map((criterion, index) => {
      const assessment = ASSESSMENTS[(candidateIndex + index) % ASSESSMENTS.length];
      return {
        criterion: criterion.name,
        assessment,
        notes: NOTES[assessment],
        evidence: assessment === "evidenced"
          ? [{ reference: evidenceReference, quote: `Fictional demo excerpt about ${criterion.name.toLowerCase()}.` }]
          : [],
      };
    });
    const evidenced = items.filter((item) => item.assessment === "evidenced").length;
    return {
      criteria: items,
      summary: `${evidenced} of ${items.length} criteria have supporting text. ${DEMO_NOTICE}`,
    };
  }

  function batchCandidates(form) {
    const pdfRanges = form.get("pdf_ranges_json");
    if (pdfRanges) {
      return JSON.parse(pdfRanges).map((range) => ({
        label: range.label,
        source_type: "pdf",
        source_reference: `Pages ${range.page_start}-${range.page_end}`,
        evidence_reference: `Page ${range.page_start}`,
      }));
    }
    const recordPath = form.get("xml_record_path");
    const start = Number(form.get("xml_start"));
    const end = Number(form.get("xml_end"));
    if (!recordPath || !start || !end || start > end) throw new DemoError(422, "Choose a valid XML candidate record range.");
    return Array.from({ length: end - start + 1 }, (_, offset) => {
      const index = start + offset;
      return {
        label: `Candidate ${String(index).padStart(3, "0")}`,
        source_type: "xml",
        source_reference: `${recordPath}[${index}]`,
        evidence_reference: `${recordPath}[${index}]/ApplicationLetterText[1]`,
      };
    });
  }

  function saveReview(job, item) {
    job.reviews.unshift({
      application_id: newId("application"),
      local_reference: `demo:${item.label}`,
      display_label: item.label,
      source_type: item.source_type,
      source_reference: item.source_reference,
      summary: item.result.summary,
      provider: "demo",
      model: "fictional",
      created_at: new Date().toISOString(),
      criteria_count: item.result.criteria.length,
      criteria: item.result.criteria,
    });
    job.updated_at = new Date().toISOString();
  }

  // Each poll finishes one more candidate, so the progress bar moves as in a real batch.
  function advanceBatch(batch) {
    const next = batch.items.find((item) => item.status !== "complete");
    if (next) {
      next.result = demoReview(batch.criteria, next.ordinal, next.evidence_reference);
      next.status = "complete";
      saveReview(requireJob(batch.job_id), next);
    }
    const completed = batch.items.filter((item) => item.status === "complete").length;
    return {
      id: batch.id,
      job_id: batch.job_id,
      status: completed === batch.items.length ? "complete" : "processing",
      total_items: batch.items.length,
      completed_items: completed,
      failed_items: 0,
      items: batch.items.map(({ id, ordinal, label, source_reference, status, result }) => ({
        id, ordinal, label, source_reference, status, error: null, result: result ? { label, ...result } : null,
      })),
    };
  }

  function queueCriteria() {
    const taskId = newId("task");
    criteriaTasks.set(taskId, SAMPLE_CRITERIA);
    return jsonResponse({ task_id: taskId, status: "queued" }, 202);
  }

  async function route(method, path, body) {
    let match;
    if (method === "GET" && path === "/status") {
      return jsonResponse({
        connected: true,
        model_available: true,
        model: "fictional answers",
        provider: "demo",
        endpoint: "none, demo runs in this browser",
        endpoint_is_local: true,
        cloud_model_blocked: false,
        running_in_codespaces: false,
      });
    }
    if (method === "GET" && path === "/jobs") {
      const list = [...jobs.values()]
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map((job) => ({
          id: job.id,
          title: job.title,
          updated_at: job.updated_at,
          criteria_set_id: latestSet(job).id,
          version: latestSet(job).version,
          criteria_count: latestSet(job).criteria.length,
        }));
      return jsonResponse({ jobs: list });
    }
    if (method === "POST" && path === "/jobs") {
      const { title, criteria } = JSON.parse(body);
      if (!title?.trim()) throw new DemoError(422, "Enter a role name.");
      const job = createJob(title.trim(), criteria);
      return jsonResponse({ id: job.id, title: job.title, criteria_set_id: latestSet(job).id, version: 1 });
    }
    if ((match = path.match(/^\/jobs\/([^/]+)$/)) && method === "GET") {
      const job = requireJob(decodeURIComponent(match[1]));
      const set = latestSet(job);
      return jsonResponse({ id: job.id, title: job.title, criteria_set_id: set.id, criteria_version: set.version, criteria: set.criteria });
    }
    if ((match = path.match(/^\/jobs\/([^/]+)\/criteria$/)) && method === "POST") {
      const job = requireJob(decodeURIComponent(match[1]));
      const set = { id: newId("criteria"), version: latestSet(job).version + 1, criteria: validCriteria(JSON.parse(body).criteria) };
      job.sets.push(set);
      job.updated_at = new Date().toISOString();
      return jsonResponse({ id: set.id, job_id: job.id, version: set.version });
    }
    if ((match = path.match(/^\/jobs\/([^/]+)\/reviews$/)) && method === "GET") {
      const job = requireJob(decodeURIComponent(match[1]));
      return jsonResponse({ reviews: job.reviews.map(({ criteria, ...review }) => review) });
    }
    if ((match = path.match(/^\/jobs\/([^/]+)\/export\.csv$/)) && method === "GET") {
      const job = requireJob(decodeURIComponent(match[1]));
      const rows = job.reviews.flatMap((review) => review.criteria.map((item) => ({
        job_title: job.title,
        local_reference: review.local_reference,
        display_label: review.display_label,
        source_type: review.source_type,
        source_reference: review.source_reference,
        reviewed_at: review.created_at,
        provider: review.provider,
        model: review.model,
        criterion_name: item.criterion,
        assessment: item.assessment,
        notes: item.notes,
        evidence: item.evidence.map((evidence) => `${evidence.reference}: ${evidence.quote}`).join(" | "),
      })));
      return csvResponse(rows, `job-${job.id}-reviews.csv`);
    }
    if ((match = path.match(/^\/jobs\/([^/]+)\/demographics\.csv$/)) && method === "GET") {
      const job = requireJob(decodeURIComponent(match[1]));
      const rows = job.reviews.map((review) => ({
        local_reference: review.local_reference,
        display_label: review.display_label,
        field_name: "Demo",
        field_value: "No real demographics in demo mode",
      }));
      return csvResponse(rows, `job-${job.id}-demographics.csv`);
    }
    if (method === "POST" && path === "/document-info") {
      // The chosen file is never read: demo mode describes a fictional document instead.
      const file = body.get("document");
      if ((file?.name || "").toLowerCase().endsWith(".xml")) {
        return jsonResponse({
          document_type: "xml",
          source_count: 24,
          text_chars: 9600,
          candidate_groups: [{ path: "/Jobbnorge_Export/Candidates/Candidate", count: 3 }],
        });
      }
      return jsonResponse({ document_type: "pdf", page_count: 6 });
    }
    if (method === "POST" && ["/criteria", "/criteria-pdf", "/criteria-url"].includes(path)) {
      return queueCriteria();
    }
    if ((match = path.match(/^\/criteria-tasks\/([^/]+)$/)) && method === "GET") {
      const taskId = decodeURIComponent(match[1]);
      const criteria = criteriaTasks.get(taskId);
      if (!criteria) throw new DemoError(404, "Criteria extraction task not found or expired.");
      return jsonResponse({ task_id: taskId, status: "complete", criteria });
    }
    if (method === "POST" && path === "/review-batches") {
      const job = requireJob(body.get("job_id"));
      const set = job.sets.find((item) => item.id === body.get("criteria_set_id"));
      if (!set) throw new DemoError(404, "Saved job or criteria version not found.");
      const candidates = batchCandidates(body);
      const batch = {
        id: newId("batch"),
        job_id: job.id,
        criteria: set.criteria,
        items: candidates.map((candidate, ordinal) => ({ ...candidate, id: newId("item"), ordinal, status: "queued", result: null })),
      };
      batches.set(batch.id, batch);
      return jsonResponse({ batch_id: batch.id, status: "queued", candidate_count: batch.items.length }, 202);
    }
    if ((match = path.match(/^\/review-batches\/([^/]+)$/)) && method === "GET") {
      const batch = batches.get(decodeURIComponent(match[1]));
      if (!batch) throw new DemoError(404, "Review batch not found.");
      return jsonResponse(advanceBatch(batch));
    }
    throw new DemoError(404, "This action is not available in demo mode.");
  }

  const sampleJob = createJob("Research Engineer, Robotics (demo)", SAMPLE_CRITERIA);
  for (const [ordinal, label] of ["Candidate 001", "Candidate 002"].entries()) {
    const item = { label, source_type: "pdf", source_reference: `Pages ${ordinal * 3 + 1}-${ordinal * 3 + 3}` };
    item.result = demoReview(SAMPLE_CRITERIA, ordinal, `Page ${ordinal * 3 + 1}`);
    saveReview(sampleJob, item);
  }

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, window.location.href);
    const apiIndex = url.pathname.indexOf("/api/");
    if (url.origin !== window.location.origin || apiIndex === -1) return realFetch(input, init);
    try {
      return await route((init.method || "GET").toUpperCase(), url.pathname.slice(apiIndex + 4), init.body);
    } catch (error) {
      return jsonResponse({ detail: error.message }, error.status || 422);
    }
  };
})();
