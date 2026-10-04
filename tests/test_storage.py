import tempfile
import unittest
from pathlib import Path

from storage import (
    create_batch,
    create_job,
    export_rows,
    get_batch,
    get_job,
    list_job_demographics,
    list_jobs,
    save_criteria_set,
    save_review,
    set_batch_item_status,
    set_batch_status,
)


class SQLiteStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database = Path(self.temp_dir.name) / "application-review.sqlite3"

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_persists_jobs_and_versions_criteria(self):
        job = create_job(
            "Thermal Modelling PhD",
            [{"name": "CFD", "description": "CFD experience", "category": "required"}],
            self.database,
        )
        second_set = save_criteria_set(
            job["id"],
            [{"name": "Heat transfer", "description": "Bioheat transfer", "category": "preferred"}],
            self.database,
        )

        saved_job = get_job(job["id"], self.database)
        self.assertEqual(saved_job["criteria_version"], 2)
        self.assertEqual(saved_job["criteria_set_id"], second_set["id"])
        self.assertEqual(saved_job["criteria"][0]["name"], "Heat transfer")
        self.assertEqual(list_jobs(self.database)[0]["criteria_count"], 1)

    def test_persists_demographics_and_review_export_separately(self):
        job = create_job(
            "Thermal Modelling PhD",
            [{"name": "CFD", "description": "CFD experience", "category": "required"}],
            self.database,
        )
        candidates = [
            {
                "local_reference": "candidate-001",
                "display_label": "Candidate 001",
                "source_type": "xml",
                "source_reference": "/Jobbnorge_Export/Candidates/Candidate[1]",
                "demographics": {"GenderName": "Example value", "BirthDate": "2000-01-01"},
            },
            {
                "local_reference": "candidate-002",
                "display_label": "Candidate 002",
                "source_type": "xml",
                "source_reference": "/Jobbnorge_Export/Candidates/Candidate[2]",
            },
        ]
        batch_id = create_batch(job["id"], job["criteria_set_id"], candidates, self.database)
        set_batch_status(batch_id, "processing", self.database)
        batch = get_batch(batch_id, self.database)
        save_review(
            batch["items"][0]["id"],
            "lmstudio",
            "qwen-local",
            {
                "summary": "Evidence found for one criterion.",
                "criteria": [
                    {
                        "criterion": "CFD",
                        "assessment": "evidenced",
                        "notes": "The application mentions CFD.",
                        "evidence": [{"reference": "Page 1", "quote": "CFD simulation"}],
                    }
                ],
            },
            self.database,
        )
        set_batch_item_status(batch["items"][1]["id"], "failed", "Model unavailable", self.database)

        saved_batch = get_batch(batch_id, self.database)
        self.assertEqual(saved_batch["status"], "complete_with_errors")
        self.assertEqual(saved_batch["completed_items"], 1)
        self.assertEqual(saved_batch["failed_items"], 1)
        self.assertEqual(
            saved_batch["items"][0]["result"]["criteria"][0]["evidence"][0]["quote"],
            "CFD simulation",
        )
        rows = export_rows(job["id"], self.database)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["local_reference"], "candidate-001")
        self.assertIn("CFD simulation", rows[0]["evidence"])
        demographics = list_job_demographics(job["id"], self.database)
        self.assertEqual({row["field_name"] for row in demographics}, {"GenderName", "BirthDate"})
        self.assertNotIn("GenderName", rows[0])


if __name__ == "__main__":
    unittest.main()