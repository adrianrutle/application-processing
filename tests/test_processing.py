import asyncio
import io
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from pypdf import PdfWriter
from types import SimpleNamespace

from app import (
    app,
    CriteriaResponse,
    decode_model_json,
    extract_pdf_pages,
    extract_xml_candidate_sources,
    extract_xml_sources,
    fetch_public_announcement,
    find_xml_candidate_groups,
    is_allowed_model_endpoint,
    is_loopback_endpoint,
    is_ollama_cloud_model,
    lm_studio_model_ids,
    local_model_json,
    normalize_text,
    redact_candidate_sources,
)
import app as app_module
from observability import trace_http_request


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self.payload


class FakeLMStudioClient:
    instance = None

    def __init__(self, *args, **kwargs):
        self.instance = self
        self.request_url = ""
        self.request_body = {}
        self.get_headers = {}
        FakeLMStudioClient.instance = self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def get(self, url, **kwargs):
        self.get_headers = kwargs.get("headers", {})
        return FakeResponse({"data": [{"id": "qwen-local"}]})

    async def post(self, url, headers=None, json=None):
        self.request_url = url
        self.request_body = json
        return FakeResponse({"choices": [{"message": {"content": '{"ok": true}'}}]})


class PdfProcessingTests(unittest.TestCase):
    def make_pdf(self):
        writer = PdfWriter()
        for _ in range(2):
            writer.add_blank_page(width=612, height=792)
        stream = io.BytesIO()
        writer.write(stream)
        stream.seek(0)
        return stream

    def test_reads_requested_page_range(self):
        page_count, pages = extract_pdf_pages(self.make_pdf(), 2, 2)
        self.assertEqual(page_count, 2)
        self.assertEqual(list(pages), [2])

    def test_rejects_out_of_bounds_page_range(self):
        with self.assertRaises(HTTPException) as error:
            extract_pdf_pages(self.make_pdf(), 1, 3)
        self.assertEqual(error.exception.status_code, 422)

    def test_loopback_endpoint_policy(self):
        self.assertTrue(is_loopback_endpoint("http://127.0.0.1:11434"))
        self.assertTrue(is_loopback_endpoint("http://localhost:11434"))
        self.assertFalse(is_loopback_endpoint("https://example.com"))

    def test_docker_host_gateway_only_allowed_for_lm_studio(self):
        endpoint = "http://host.docker.internal:1234/v1"
        self.assertTrue(is_allowed_model_endpoint(endpoint, "lmstudio"))
        self.assertFalse(is_allowed_model_endpoint(endpoint, "ollama"))
        self.assertFalse(is_allowed_model_endpoint("https://example.com/v1", "lmstudio"))

    def test_blocks_ollama_cloud_models(self):
        self.assertTrue(is_ollama_cloud_model("example:cloud"))
        self.assertFalse(is_ollama_cloud_model("llama3.2:3b"))

    def test_reads_lm_studio_model_ids(self):
        self.assertEqual(
            lm_studio_model_ids({"data": [{"id": "qwen-local"}, {"name": "ignored"}]}),
            ["qwen-local"],
        )

    def test_model_json_decoder_reports_malformed_content_without_echoing_it(self):
        with self.assertRaises(HTTPException) as error:
            decode_model_json("not json", "LM Studio")
        self.assertEqual(error.exception.status_code, 502)
        self.assertIn("invalid JSON", error.exception.detail)
        self.assertNotIn("not json", error.exception.detail)

    def test_model_json_decoder_requires_object(self):
        with self.assertRaises(HTTPException) as error:
            decode_model_json("[]", "LM Studio")
        self.assertIn("not an object", error.exception.detail)

    def test_lm_studio_uses_openai_compatible_text_mode(self):
        with (
            patch.object(app_module, "LLM_PROVIDER", "lmstudio"),
            patch.object(app_module, "LM_STUDIO_BASE_URL", "http://127.0.0.1:1234/v1"),
            patch.object(app_module, "LM_STUDIO_MODEL", ""),
            patch.dict("os.environ", {"LM_STUDIO_API_KEY": "test-local-key"}),
            patch.object(app_module.httpx, "AsyncClient", FakeLMStudioClient),
        ):
            result = asyncio.run(
                local_model_json([{"role": "user", "content": "test"}], CriteriaResponse)
            )

        self.assertEqual(result, {"ok": True})
        self.assertEqual(FakeLMStudioClient.instance.request_url, "http://127.0.0.1:1234/v1/chat/completions")
        self.assertEqual(FakeLMStudioClient.instance.request_body["model"], "qwen-local")
        self.assertEqual(FakeLMStudioClient.instance.request_body["response_format"], {"type": "text"})
        self.assertEqual(FakeLMStudioClient.instance.get_headers["Authorization"], "Bearer test-local-key")

    def test_lm_studio_status_reports_discovered_model_ready(self):
        with (
            patch.object(app_module, "LLM_PROVIDER", "lmstudio"),
            patch.object(app_module, "LM_STUDIO_BASE_URL", "http://127.0.0.1:1234/v1"),
            patch.object(app_module, "LM_STUDIO_MODEL", ""),
            patch.dict("os.environ", {"LM_STUDIO_API_KEY": "test-local-key"}),
            patch.object(app_module.httpx, "AsyncClient", FakeLMStudioClient),
        ):
            result = asyncio.run(app_module.status())

        self.assertTrue(result["connected"])
        self.assertTrue(result["model_available"])
        self.assertEqual(result["model"], "qwen-local")
        self.assertTrue(result["endpoint_is_local"])

    def test_normalizes_whitespace_for_quote_check(self):
        self.assertEqual(normalize_text("  Python\n experience "), "python experience")

    def test_extracts_xml_text_with_stable_element_paths(self):
        xml = io.BytesIO(
            b"<Candidate id='C-1'><Experience>Python &amp; XML</Experience>"
            b"<Experience>Data analysis</Experience></Candidate>"
        )
        sources = extract_xml_sources(xml)
        self.assertEqual(len(sources), 2)
        self.assertNotIn("/Candidate[1]/@id", sources)
        self.assertEqual(sources["/Candidate[1]/Experience[1]"], "Python & XML")
        self.assertEqual(sources["/Candidate[1]/Experience[2]"], "Data analysis")

    def test_discovers_jobbnorge_candidate_records(self):
        xml = io.BytesIO(
            b"<Jobbnorge_Export><PositionOpening><PositionTitle>Role metadata</PositionTitle></PositionOpening>"
            b"<Candidates><Candidate><ID>1</ID><FirstName>Ada</FirstName><GenderName>Female</GenderName>"
            b"<ApplicationLetterText>Computational modelling experience.</ApplicationLetterText></Candidate>"
            b"<Candidate><ID>2</ID><FirstName>Grace</FirstName><GenderName>Female</GenderName>"
            b"<ApplicationLetterText>Thermal simulation research.</ApplicationLetterText></Candidate>"
            b"</Candidates></Jobbnorge_Export>"
        )
        groups = find_xml_candidate_groups(xml)
        self.assertEqual(groups, [{"path": "/Jobbnorge_Export/Candidates/Candidate", "count": 2}])

    def test_extracts_one_xml_candidate_without_direct_identifiers(self):
        xml = io.BytesIO(
            b"<Jobbnorge_Export><Candidates><Candidate><ID>1</ID><FirstName>Ada</FirstName>"
            b"<BirthDate>1990-01-01</BirthDate><GenderName>Female</GenderName>"
            b"<ApplicationLetterText>Computational modelling experience.</ApplicationLetterText>"
            b"</Candidate><Candidate><ID>2</ID><FirstName>Grace</FirstName>"
            b"<ApplicationLetterText>Thermal simulation research.</ApplicationLetterText>"
            b"</Candidate></Candidates></Jobbnorge_Export>"
        )
        sources = extract_xml_candidate_sources(
            xml,
            "/Jobbnorge_Export/Candidates/Candidate",
            2,
        )
        joined_text = " ".join(sources.values())
        self.assertIn("Thermal simulation research.", joined_text)
        self.assertNotIn("Grace", joined_text)
        self.assertNotIn("1990-01-01", joined_text)
        self.assertNotIn("Female", joined_text)

    def test_rejects_xml_entity_declarations(self):
        xml = io.BytesIO(b'<!DOCTYPE x [<!ENTITY secret "hidden">]><Candidate>&secret;</Candidate>')
        with self.assertRaises(HTTPException) as error:
            extract_xml_sources(xml)
        self.assertEqual(error.exception.status_code, 422)

    def test_redacts_private_xml_values_and_common_contact_data(self):
        sources = {
            "/Candidate[1]/ApplicationLetterText[1]":
                "Ada Example wrote ada@example.test and called +47 123 45 678."
        }
        redacted = redact_candidate_sources(
            sources,
            {"FirstName": "Ada", "SurName": "Example", "Email": "ada@example.test"},
        )
        text = next(iter(redacted.values()))
        self.assertNotIn("Ada", text)
        self.assertNotIn("Example", text)
        self.assertNotIn("ada@example.test", text)
        self.assertNotIn("+47 123 45 678", text)

    def test_document_info_accepts_xml_upload(self):
        client = TestClient(app)
        response = client.post(
            "/api/document-info",
            files={"document": ("candidate.xml", b"<Candidate><Name>Sample</Name></Candidate>", "application/xml")},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["document_type"], "xml")
        self.assertEqual(response.json()["source_count"], 1)
        self.assertEqual(response.json()["text_chars"], 6)
        self.assertTrue(response.headers["x-request-id"])

    def test_announcement_url_rejects_http_and_loopback_hosts(self):
        for url in ("http://example.org/job", "https://127.0.0.1/job"):
            with self.subTest(url=url), self.assertRaises(HTTPException):
                asyncio.run(fetch_public_announcement(url))

    def test_http_trace_logs_client_cancellation(self):
        request = SimpleNamespace(
            method="POST",
            url=SimpleNamespace(path="/api/review"),
        )

        async def cancel_request(_request):
            raise asyncio.CancelledError

        with self.assertLogs("application_processing", level="INFO") as captured:
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(trace_http_request(request, cancel_request))

        self.assertTrue(any("event=http.cancelled" in message for message in captured.output))


if __name__ == "__main__":
    unittest.main()