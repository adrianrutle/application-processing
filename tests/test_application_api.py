import json
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from pypdf import PdfWriter

import app as app_module
from app import app
from storage import list_job_demographics


class ApplicationPersistenceApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database = Path(self.temp_dir.name) / "local-review.sqlite3"
        self.env_patch = patch.dict(os.environ, {"APPLICATION_DB_PATH": str(self.database)})
        self.env_patch.start()
        self.client = TestClient(app)
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.env_patch.stop()
        self.temp_dir.cleanup()

    def create_job(self):
        response = self.client.post(
            "/api/jobs",
            json={
                "title": "Thermal Modelling PhD",
                "criteria": [
                    {"name": "CFD", "description": "Computational fluid dynamics", "category": "required"}
                ],
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_job_criteria_save_and_load(self):
        job = self.create_job()
        loaded = self.client.get(f"/api/jobs/{job['id']}").json()
        self.assertEqual(loaded["criteria"][0]["name"], "CFD")

        update = self.client.post(
            f"/api/jobs/{job['id']}/criteria",
            json={"criteria": [{"name": "Thermal", "description": "Heat transfer", "category": "preferred"}]},
        )
        self.assertEqual(update.status_code, 200, update.text)
        self.assertEqual(update.json()["version"], 2)
        self.assertEqual(self.client.get(f"/api/jobs/{job['id']}").json()["criteria_version"], 2)

    def test_xml_batch_reviews_each_candidate_and_keeps_demographics_out_of_model_text(self):
        job = self.create_job()
        xml = b"""<Jobbnorge_Export><PositionOpening><PositionTitle>PhD</PositionTitle></PositionOpening>
        <Candidates>
          <Candidate><ID>91</ID><FirstName>PrivateNameA</FirstName><Email>private-a@example.test</Email><GenderName>ExampleGender</GenderName><BirthDate>2000-01-01</BirthDate><ApplicationLetterText>Unique applicant phrase alpha</ApplicationLetterText></Candidate>
          <Candidate><ID>92</ID><FirstName>PrivateNameB</FirstName><Email>private-b@example.test</Email><GenderName>ExampleGender</GenderName><BirthDate>2001-02-02</BirthDate><ApplicationLetterText>Unique applicant phrase beta</ApplicationLetterText></Candidate>
        </Candidates></Jobbnorge_Export>"""
        document_info = self.client.post(
            "/api/document-info",
            files={"document": ("applications.xml", xml, "application/xml")},
        )
        self.assertEqual(document_info.status_code, 200, document_info.text)
        self.assertEqual(document_info.json()["candidate_groups"], [
            {"path": "/Jobbnorge_Export/Candidates/Candidate", "count": 2}
        ])

        seen_model_text = []

        async def fake_review(sources, document_type, criteria):
            seen_model_text.append(" ".join(sources.values()))
            return app_module.ReviewResponse(
                summary="Synthetic review complete.",
                criteria=[
                    app_module.CriterionReview(
                        criterion="CFD",
                        assessment="evidenced",
                        notes="Synthetic test result.",
                        evidence=[],
                    )
                ],
            )

        with patch.object(app_module, "evaluate_candidate_sources", fake_review):
            started = self.client.post(
                "/api/review-batches",
                data={
                    "job_id": job["id"],
                    "criteria_set_id": job["criteria_set_id"],
                    "xml_record_path": "/Jobbnorge_Export/Candidates/Candidate",
                    "xml_start": "1",
                    "xml_end": "2",
                },
                files={"document": ("applications.xml", xml, "application/xml")},
            )
            self.assertEqual(started.status_code, 202, started.text)
            batch_id = started.json()["batch_id"]
            batch = self.client.get(f"/api/review-batches/{batch_id}").json()

        self.assertEqual(batch["status"], "complete")
        self.assertEqual(batch["completed_items"], 2)
        self.assertEqual(len(seen_model_text), 2)
        model_text = " ".join(seen_model_text)
        for private_value in ("PrivateNameA", "PrivateNameB", "private-a@example.test", "ExampleGender", "2000-01-01"):
            self.assertNotIn(private_value, model_text)
        self.assertIn("Unique applicant phrase alpha", model_text)

        demographics = list_job_demographics(job["id"], self.database)
        self.assertEqual(len(demographics), 10)
        review_csv = self.client.get(f"/api/jobs/{job['id']}/export.csv").text
        demographics_csv = self.client.get(f"/api/jobs/{job['id']}/demographics.csv").text
        self.assertNotIn("ExampleGender", review_csv)
        self.assertIn("ExampleGender", demographics_csv)
        self.assertNotIn("Unique applicant phrase alpha", self.database.read_bytes().decode("latin1"))

    def test_single_review_rejects_multi_candidate_xml(self):
        criteria_json = json.dumps({
            "criteria": [{"name": "CFD", "description": "CFD experience", "category": "required"}]
        })
        xml = b"<Jobbnorge_Export><Candidates><Candidate><ApplicationLetterText>One candidate.</ApplicationLetterText></Candidate><Candidate><ApplicationLetterText>Another candidate.</ApplicationLetterText></Candidate></Candidates></Jobbnorge_Export>"
        response = self.client.post(
            "/api/review",
            data={"criteria_json": criteria_json},
            files={"document": ("applications.xml", xml, "application/xml")},
        )
        self.assertEqual(response.status_code, 422)
        self.assertIn("multiple candidates", response.json()["detail"])

    def test_single_xml_review_redacts_demographics_from_model_input(self):
        seen_text = []

        async def fake_review(sources, document_type, criteria):
            seen_text.append(" ".join(sources.values()))
            return app_module.ReviewResponse(summary="Done", criteria=[])

        criteria_json = json.dumps({
            "criteria": [{"name": "CFD", "description": "CFD experience", "category": "required"}]
        })
        xml = b"<Candidate><ID>8</ID><FirstName>PrivatePerson</FirstName><Email>private@example.test</Email><GenderName>ExampleGender</GenderName><ApplicationLetterText>PrivatePerson has CFD experience; email private@example.test.</ApplicationLetterText></Candidate>"
        with patch.object(app_module, "evaluate_candidate_sources", fake_review):
            response = self.client.post(
                "/api/review",
                data={"criteria_json": criteria_json},
                files={"document": ("candidate.xml", xml, "application/xml")},
            )
        self.assertEqual(response.status_code, 200, response.text)
        model_text = " ".join(seen_text)
        for value in ("PrivatePerson", "private@example.test", "ExampleGender"):
            self.assertNotIn(value, model_text)

    def test_pdf_batch_uses_explicit_non_overlapping_page_ranges(self):
        job = self.create_job()
        writer = PdfWriter()
        for _ in range(4):
            writer.add_blank_page(width=612, height=792)
        pdf = io.BytesIO()
        writer.write(pdf)
        pdf_bytes = pdf.getvalue()
        reviewed_sources = []

        async def fake_review(sources, document_type, criteria):
            reviewed_sources.append(sorted(sources))
            return app_module.ReviewResponse(summary="Synthetic PDF review.", criteria=[])

        with patch.object(app_module, "evaluate_candidate_sources", fake_review):
            started = self.client.post(
                "/api/review-batches",
                data={
                    "job_id": job["id"],
                    "criteria_set_id": job["criteria_set_id"],
                    "pdf_ranges_json": json.dumps([
                        {"label": "Candidate 001", "page_start": 1, "page_end": 2},
                        {"label": "Candidate 002", "page_start": 3, "page_end": 4},
                    ]),
                },
                files={"document": ("applications.pdf", pdf_bytes, "application/pdf")},
            )
            self.assertEqual(started.status_code, 202, started.text)
            batch_id = started.json()["batch_id"]
            batch = self.client.get(f"/api/review-batches/{batch_id}").json()

        self.assertEqual(batch["status"], "complete")
        self.assertEqual(reviewed_sources, [["Page 1", "Page 2"], ["Page 3", "Page 4"]])


if __name__ == "__main__":
    unittest.main()
