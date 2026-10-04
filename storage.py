import json
import os
import sqlite3
import sys
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def database_path() -> Path:
    configured_path = os.getenv("APPLICATION_DB_PATH")
    if configured_path:
        return Path(configured_path).expanduser()
    if sys.platform == "darwin":
        data_dir = Path.home() / "Library" / "Application Support" / "Application Review"
    elif os.getenv("XDG_DATA_HOME"):
        data_dir = Path(os.environ["XDG_DATA_HOME"]) / "application-review"
    else:
        data_dir = Path.home() / ".local" / "share" / "application-review"
    return data_dir / "applications.sqlite3"


SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS criteria_sets (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(job_id, version)
);
CREATE TABLE IF NOT EXISTS criteria (
    id TEXT PRIMARY KEY,
    criteria_set_id TEXT NOT NULL REFERENCES criteria_sets(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('required', 'preferred')),
    UNIQUE(criteria_set_id, position)
);
CREATE TABLE IF NOT EXISTS applicants (
    id TEXT PRIMARY KEY,
    local_reference TEXT NOT NULL UNIQUE,
    display_label TEXT NOT NULL,
    created_at TEXT NOT NULL
);
-- Store sensitive profile fields separately from the review evidence tables.
CREATE TABLE IF NOT EXISTS applicant_demographics (
    applicant_id TEXT NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
    field_name TEXT NOT NULL,
    field_value TEXT NOT NULL,
    PRIMARY KEY(applicant_id, field_name)
);
CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    applicant_id TEXT NOT NULL REFERENCES applicants(id),
    job_id TEXT NOT NULL REFERENCES jobs(id),
    criteria_set_id TEXT NOT NULL REFERENCES criteria_sets(id),
    source_type TEXT NOT NULL CHECK(source_type IN ('pdf', 'xml')),
    source_reference TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(applicant_id, job_id)
);
CREATE TABLE IF NOT EXISTS batches (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    criteria_set_id TEXT NOT NULL REFERENCES criteria_sets(id),
    status TEXT NOT NULL CHECK(status IN ('queued', 'processing', 'complete', 'complete_with_errors')),
    total_items INTEGER NOT NULL,
    completed_items INTEGER NOT NULL DEFAULT 0,
    failed_items INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS batch_items (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    local_reference TEXT NOT NULL,
    display_label TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK(source_type IN ('pdf', 'xml')),
    source_reference TEXT NOT NULL,
    chunk_spec_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL CHECK(status IN ('queued', 'processing', 'complete', 'failed')),
    error TEXT,
    application_id TEXT REFERENCES applications(id),
    UNIQUE(batch_id, ordinal)
);
CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    batch_item_id TEXT NOT NULL REFERENCES batch_items(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(batch_item_id)
);
CREATE TABLE IF NOT EXISTS review_items (
    id TEXT PRIMARY KEY,
    review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    criterion_name TEXT NOT NULL,
    assessment TEXT NOT NULL CHECK(assessment IN ('evidenced', 'not_evidenced', 'unclear')),
    notes TEXT NOT NULL,
    UNIQUE(review_id, position)
);
CREATE TABLE IF NOT EXISTS review_evidence (
    id TEXT PRIMARY KEY,
    review_item_id TEXT NOT NULL REFERENCES review_items(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    source_reference TEXT NOT NULL,
    quote TEXT NOT NULL,
    UNIQUE(review_item_id, position)
);
CREATE INDEX IF NOT EXISTS idx_applications_job ON applications(job_id);
CREATE INDEX IF NOT EXISTS idx_batch_items_batch ON batch_items(batch_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_reviews_application ON reviews(application_id);
"""


@contextmanager
def connect(path: str | Path | None = None):
    db_path = Path(path) if path else database_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    connection.executescript(SCHEMA)
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def _criteria_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "category": row["category"],
    }


def _save_criteria(connection: sqlite3.Connection, criteria_set_id: str, criteria: list[dict]):
    for position, item in enumerate(criteria):
        connection.execute(
            "INSERT INTO criteria(id, criteria_set_id, position, name, description, category) VALUES (?, ?, ?, ?, ?, ?)",
            (
                str(uuid.uuid4()),
                criteria_set_id,
                position,
                item["name"].strip(),
                item["description"].strip(),
                item["category"],
            ),
        )


def create_job(title: str, criteria: list[dict], path: str | Path | None = None) -> dict:
    job_id = str(uuid.uuid4())
    criteria_set_id = str(uuid.uuid4())
    now = utc_now()
    with connect(path) as connection:
        connection.execute(
            "INSERT INTO jobs(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (job_id, title.strip(), now, now),
        )
        connection.execute(
            "INSERT INTO criteria_sets(id, job_id, version, created_at) VALUES (?, ?, ?, ?)",
            (criteria_set_id, job_id, 1, now),
        )
        _save_criteria(connection, criteria_set_id, criteria)
    return {"id": job_id, "title": title.strip(), "criteria_set_id": criteria_set_id, "version": 1}


def save_criteria_set(job_id: str, criteria: list[dict], path: str | Path | None = None) -> dict:
    criteria_set_id = str(uuid.uuid4())
    now = utc_now()
    with connect(path) as connection:
        job = connection.execute("SELECT id FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if not job:
            raise KeyError("Job not found")
        version = connection.execute(
            "SELECT COALESCE(MAX(version), 0) + 1 FROM criteria_sets WHERE job_id = ?",
            (job_id,),
        ).fetchone()[0]
        connection.execute(
            "INSERT INTO criteria_sets(id, job_id, version, created_at) VALUES (?, ?, ?, ?)",
            (criteria_set_id, job_id, version, now),
        )
        _save_criteria(connection, criteria_set_id, criteria)
        connection.execute("UPDATE jobs SET updated_at = ? WHERE id = ?", (now, job_id))
    return {"id": criteria_set_id, "job_id": job_id, "version": version}


def list_jobs(path: str | Path | None = None) -> list[dict]:
    with connect(path) as connection:
        rows = connection.execute(
            """
            SELECT j.id, j.title, j.updated_at, cs.id AS criteria_set_id, cs.version,
                   (SELECT COUNT(*) FROM criteria c WHERE c.criteria_set_id = cs.id) AS criteria_count
            FROM jobs j
            LEFT JOIN criteria_sets cs ON cs.job_id = j.id
              AND cs.version = (SELECT MAX(version) FROM criteria_sets WHERE job_id = j.id)
            ORDER BY j.updated_at DESC
            """
        ).fetchall()
    return [dict(row) for row in rows]


def get_job(job_id: str, path: str | Path | None = None) -> dict | None:
    with connect(path) as connection:
        job = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if not job:
            return None
        criteria_set = connection.execute(
            "SELECT * FROM criteria_sets WHERE job_id = ? ORDER BY version DESC LIMIT 1",
            (job_id,),
        ).fetchone()
        criteria = connection.execute(
            "SELECT * FROM criteria WHERE criteria_set_id = ? ORDER BY position",
            (criteria_set["id"],),
        ).fetchall()
    return {
        "id": job["id"],
        "title": job["title"],
        "criteria_set_id": criteria_set["id"],
        "criteria_version": criteria_set["version"],
        "criteria": [_criteria_dict(row) for row in criteria],
    }


def get_criteria_set(job_id: str, criteria_set_id: str, path: str | Path | None = None) -> dict | None:
    with connect(path) as connection:
        criteria_set = connection.execute(
            "SELECT * FROM criteria_sets WHERE id = ? AND job_id = ?",
            (criteria_set_id, job_id),
        ).fetchone()
        if not criteria_set:
            return None
        criteria = connection.execute(
            "SELECT * FROM criteria WHERE criteria_set_id = ? ORDER BY position",
            (criteria_set_id,),
        ).fetchall()
    return {
        "id": criteria_set["id"],
        "job_id": job_id,
        "version": criteria_set["version"],
        "criteria": [_criteria_dict(row) for row in criteria],
    }


def create_batch(job_id: str, criteria_set_id: str, candidates: list[dict], path: str | Path | None = None) -> str:
    batch_id = str(uuid.uuid4())
    now = utc_now()
    with connect(path) as connection:
        criteria_set = connection.execute(
            "SELECT id FROM criteria_sets WHERE id = ? AND job_id = ?",
            (criteria_set_id, job_id),
        ).fetchone()
        if not criteria_set:
            raise KeyError("Criteria set not found for this job")
        connection.execute(
            "INSERT INTO batches(id, job_id, criteria_set_id, status, total_items, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (batch_id, job_id, criteria_set_id, "queued", len(candidates), now, now),
        )
        for ordinal, candidate in enumerate(candidates):
            applicant = connection.execute(
                "SELECT id FROM applicants WHERE local_reference = ?",
                (candidate["local_reference"],),
            ).fetchone()
            if applicant:
                applicant_id = applicant["id"]
                connection.execute(
                    "UPDATE applicants SET display_label = ? WHERE id = ?",
                    (candidate["display_label"], applicant_id),
                )
            else:
                applicant_id = str(uuid.uuid4())
                connection.execute(
                    "INSERT INTO applicants(id, local_reference, display_label, created_at) VALUES (?, ?, ?, ?)",
                    (applicant_id, candidate["local_reference"], candidate["display_label"], now),
                )
            # Demographics are persisted separately from review text and are never added to model prompts.
            # Demographics live only in the separate applicant table, never in review or batch text.
            for field_name, field_value in candidate.get("demographics", {}).items():
                connection.execute(
                    "INSERT INTO applicant_demographics(applicant_id, field_name, field_value) VALUES (?, ?, ?) "
                    "ON CONFLICT(applicant_id, field_name) DO UPDATE SET field_value = excluded.field_value",
                    (applicant_id, field_name, str(field_value)),
                )
            application = connection.execute(
                "SELECT id FROM applications WHERE applicant_id = ? AND job_id = ?",
                (applicant_id, job_id),
            ).fetchone()
            if application:
                application_id = application["id"]
                connection.execute(
                    "UPDATE applications SET criteria_set_id = ?, source_type = ?, source_reference = ? WHERE id = ?",
                    (criteria_set_id, candidate["source_type"], candidate["source_reference"], application_id),
                )
            else:
                application_id = str(uuid.uuid4())
                connection.execute(
                    "INSERT INTO applications(id, applicant_id, job_id, criteria_set_id, source_type, source_reference, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        application_id,
                        applicant_id,
                        job_id,
                        criteria_set_id,
                        candidate["source_type"],
                        candidate["source_reference"],
                        now,
                    ),
                )
            connection.execute(
                "INSERT INTO batch_items(id, batch_id, ordinal, local_reference, display_label, source_type, source_reference, chunk_spec_json, status, application_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    str(uuid.uuid4()),
                    batch_id,
                    ordinal,
                    candidate["local_reference"],
                    candidate["display_label"],
                    candidate["source_type"],
                    candidate["source_reference"],
                    json.dumps(candidate.get("chunk_spec", {}), ensure_ascii=True),
                    "queued",
                    application_id,
                ),
            )
    return batch_id


def set_batch_status(batch_id: str, status: str, path: str | Path | None = None):
    with connect(path) as connection:
        connection.execute("UPDATE batches SET status = ?, updated_at = ? WHERE id = ?", (status, utc_now(), batch_id))


def set_batch_item_status(item_id: str, status: str, error: str | None = None, path: str | Path | None = None):
    with connect(path) as connection:
        connection.execute("UPDATE batch_items SET status = ?, error = ? WHERE id = ?", (status, error, item_id))
        batch_id = connection.execute("SELECT batch_id FROM batch_items WHERE id = ?", (item_id,)).fetchone()[0]
        _refresh_batch_counts(connection, batch_id, utc_now())


def save_review(
    batch_item_id: str,
    provider: str,
    model: str,
    review: dict,
    path: str | Path | None = None,
):
    now = utc_now()
    with connect(path) as connection:
        item = connection.execute(
            "SELECT * FROM batch_items WHERE id = ?",
            (batch_item_id,),
        ).fetchone()
        if not item:
            raise KeyError("Batch item not found")
        applicant = connection.execute(
            "SELECT id FROM applicants WHERE local_reference = ?",
            (item["local_reference"],),
        ).fetchone()
        if applicant:
            applicant_id = applicant["id"]
            connection.execute(
                "UPDATE applicants SET display_label = ? WHERE id = ?",
                (item["display_label"], applicant_id),
            )
        else:
            applicant_id = str(uuid.uuid4())
            connection.execute(
                "INSERT INTO applicants(id, local_reference, display_label, created_at) VALUES (?, ?, ?, ?)",
                (applicant_id, item["local_reference"], item["display_label"], now),
            )
        application_id = item["application_id"]
        if application_id is None:
            application_id = str(uuid.uuid4())
            connection.execute(
                "INSERT INTO applications(id, applicant_id, job_id, criteria_set_id, source_type, source_reference, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    application_id,
                    applicant_id,
                    connection.execute("SELECT job_id FROM batches WHERE id = ?", (item["batch_id"],)).fetchone()[0],
                    connection.execute("SELECT criteria_set_id FROM batches WHERE id = ?", (item["batch_id"],)).fetchone()[0],
                    item["source_type"],
                    item["source_reference"],
                    now,
                ),
            )
        review_id = str(uuid.uuid4())
        connection.execute(
            "INSERT INTO reviews(id, application_id, batch_item_id, provider, model, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (review_id, application_id, batch_item_id, provider, model, review["summary"], now),
        )
        for position, criterion in enumerate(review["criteria"]):
            review_item_id = str(uuid.uuid4())
            connection.execute(
                "INSERT INTO review_items(id, review_id, position, criterion_name, assessment, notes) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    review_item_id,
                    review_id,
                    position,
                    criterion["criterion"],
                    criterion["assessment"],
                    criterion.get("notes", ""),
                ),
            )
            for evidence_position, evidence in enumerate(criterion.get("evidence", [])):
                connection.execute(
                    "INSERT INTO review_evidence(id, review_item_id, position, source_reference, quote) VALUES (?, ?, ?, ?, ?)",
                    (
                        str(uuid.uuid4()),
                        review_item_id,
                        evidence_position,
                        evidence["reference"],
                        evidence["quote"],
                    ),
                )
        connection.execute(
            "UPDATE batch_items SET status = 'complete', application_id = ?, error = NULL WHERE id = ?",
            (application_id, batch_item_id),
        )
        batch = connection.execute("SELECT batch_id FROM batch_items WHERE id = ?", (batch_item_id,)).fetchone()
        _refresh_batch_counts(connection, batch["batch_id"], now)


def _refresh_batch_counts(connection: sqlite3.Connection, batch_id: str, now: str):
    row = connection.execute(
        "SELECT COUNT(*) AS total, SUM(status = 'complete') AS complete, SUM(status = 'failed') AS failed, SUM(status IN ('queued', 'processing')) AS pending FROM batch_items WHERE batch_id = ?",
        (batch_id,),
    ).fetchone()
    if row["pending"] == 0:
        status = "complete_with_errors" if row["failed"] else "complete"
    else:
        status = "processing"
    connection.execute(
        "UPDATE batches SET status = ?, completed_items = ?, failed_items = ?, updated_at = ? WHERE id = ?",
        (status, row["complete"] or 0, row["failed"] or 0, now, batch_id),
    )


def get_batch(batch_id: str, path: str | Path | None = None) -> dict | None:
    with connect(path) as connection:
        batch = connection.execute("SELECT * FROM batches WHERE id = ?", (batch_id,)).fetchone()
        if not batch:
            return None
        items = connection.execute(
            "SELECT * FROM batch_items WHERE batch_id = ? ORDER BY ordinal",
            (batch_id,),
        ).fetchall()
        results = connection.execute(
            """
            SELECT bi.id AS batch_item_id, a.display_label, r.summary, r.provider, r.model, r.created_at,
                   ri.id AS review_item_id, ri.criterion_name, ri.assessment, ri.notes,
                   ev.source_reference, ev.quote
            FROM batch_items bi
            JOIN applications app ON app.id = bi.application_id
            JOIN applicants a ON a.id = app.applicant_id
            JOIN reviews r ON r.application_id = app.id
            JOIN review_items ri ON ri.review_id = r.id
            LEFT JOIN review_evidence ev ON ev.review_item_id = ri.id
            WHERE bi.batch_id = ?
            ORDER BY bi.ordinal, ri.position, ev.position
            """,
            (batch_id,),
        ).fetchall()
    grouped: dict[str, dict] = {}
    criteria_by_id: dict[str, dict] = {}
    for row in results:
        item = grouped.setdefault(
            row["batch_item_id"],
            {
                "label": row["display_label"],
                "summary": row["summary"],
                "provider": row["provider"],
                "model": row["model"],
                "created_at": row["created_at"],
                "criteria": [],
            },
        )
        criterion_item = criteria_by_id.get(row["review_item_id"])
        if criterion_item is None:
            criterion_item = {
                "criterion": row["criterion_name"],
                "assessment": row["assessment"],
                "notes": row["notes"],
                "evidence": [],
            }
            criteria_by_id[row["review_item_id"]] = criterion_item
            item["criteria"].append(criterion_item)
        if row["source_reference"] is not None:
            criterion_item["evidence"].append(
                {"reference": row["source_reference"], "quote": row["quote"]}
            )
    batch_data = dict(batch)
    batch_data["items"] = [
        {
            "id": row["id"],
            "ordinal": row["ordinal"],
            "label": row["display_label"],
            "source_reference": row["source_reference"],
            "status": row["status"],
            "error": row["error"],
            "result": grouped.get(row["id"]),
        }
        for row in items
    ]
    return batch_data


def get_batch_work_items(batch_id: str, path: str | Path | None = None) -> list[dict]:
    with connect(path) as connection:
        rows = connection.execute(
            """
            SELECT bi.*, a.id AS applicant_id
            FROM batch_items bi
            JOIN applicants a ON a.local_reference = bi.local_reference
            WHERE bi.batch_id = ?
            ORDER BY bi.ordinal
            """,
            (batch_id,),
        ).fetchall()
        work_items = []
        for row in rows:
            demographics = connection.execute(
                "SELECT field_name, field_value FROM applicant_demographics WHERE applicant_id = ?",
                (row["applicant_id"],),
            ).fetchall()
            work_items.append(
                {
                    "id": row["id"],
                    "ordinal": row["ordinal"],
                    "local_reference": row["local_reference"],
                    "source_reference": row["source_reference"],
                    "source_type": row["source_type"],
                    "chunk_spec": json.loads(row["chunk_spec_json"]),
                    "demographics": {item["field_name"]: item["field_value"] for item in demographics},
                }
            )
    return work_items


def export_rows(job_id: str, path: str | Path | None = None) -> list[dict]:
    with connect(path) as connection:
        rows = connection.execute(
            """
            SELECT j.title AS job_title, a.local_reference, a.display_label, app.source_type,
                   app.source_reference, r.created_at AS reviewed_at, r.provider, r.model,
                   ri.criterion_name, ri.assessment, ri.notes,
                   GROUP_CONCAT(ev.source_reference || ': ' || ev.quote, ' | ') AS evidence
            FROM applications app
            JOIN jobs j ON j.id = app.job_id
            JOIN applicants a ON a.id = app.applicant_id
            JOIN reviews r ON r.application_id = app.id
            JOIN review_items ri ON ri.review_id = r.id
            LEFT JOIN review_evidence ev ON ev.review_item_id = ri.id
            WHERE j.id = ?
            GROUP BY ri.id
            ORDER BY r.created_at, a.display_label, ri.position
            """,
            (job_id,),
        ).fetchall()
    return [dict(row) for row in rows]


def list_job_reviews(job_id: str, path: str | Path | None = None) -> list[dict]:
    with connect(path) as connection:
        rows = connection.execute(
            """
            SELECT app.id AS application_id, a.local_reference, a.display_label, app.source_type,
                   app.source_reference, r.summary, r.provider, r.model, r.created_at,
                   COUNT(ri.id) AS criteria_count
            FROM applications app
            JOIN applicants a ON a.id = app.applicant_id
            JOIN reviews r ON r.application_id = app.id
            JOIN review_items ri ON ri.review_id = r.id
            WHERE app.job_id = ?
            GROUP BY app.id, r.id
            ORDER BY r.created_at DESC
            """,
            (job_id,),
        ).fetchall()
    return [dict(row) for row in rows]


def list_job_demographics(job_id: str, path: str | Path | None = None) -> list[dict]:
    with connect(path) as connection:
        rows = connection.execute(
            """
            SELECT a.local_reference, a.display_label, d.field_name, d.field_value
            FROM applications app
            JOIN applicants a ON a.id = app.applicant_id
            JOIN applicant_demographics d ON d.applicant_id = a.id
            WHERE app.job_id = ?
            ORDER BY a.display_label, d.field_name
            """,
            (job_id,),
        ).fetchall()
    return [dict(row) for row in rows]