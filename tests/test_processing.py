import asyncio
import io
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from pypdf import PdfWriter

from app import (
    app,
    extract_pdf_pages,
    extract_xml_sources,
    fetch_public_announcement,
    is_allowed_model_endpoint,
    is_loopback_endpoint,
    is_ollama_cloud_model,
    lm_studio_model_ids,
    local_model_json,
    normalize_text,
)
import app as app_module


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
        FakeLMStudioClient.instance = self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def get(self, url, **kwargs):
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

    def test_lm_studio_uses_openai_compatible_json_api(self):
        with (
            patch.object(app_module, "LLM_PROVIDER", "lmstudio"),
            patch.object(app_module, "LM_STUDIO_BASE_URL", "http://127.0.0.1:1234/v1"),
            patch.object(app_module, "LM_STUDIO_MODEL", ""),
            patch.object(app_module.httpx, "AsyncClient", FakeLMStudioClient),
        ):
            result = asyncio.run(local_model_json([{"role": "user", "content": "test"}]))

        self.assertEqual(result, {"ok": True})
        self.assertEqual(FakeLMStudioClient.instance.request_url, "http://127.0.0.1:1234/v1/chat/completions")
        self.assertEqual(FakeLMStudioClient.instance.request_body["model"], "qwen-local")
        self.assertEqual(FakeLMStudioClient.instance.request_body["response_format"], {"type": "json_object"})

    def test_lm_studio_status_reports_discovered_model_ready(self):
        with (
            patch.object(app_module, "LLM_PROVIDER", "lmstudio"),
            patch.object(app_module, "LM_STUDIO_BASE_URL", "http://127.0.0.1:1234/v1"),
            patch.object(app_module, "LM_STUDIO_MODEL", ""),
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
        self.assertEqual(sources["/Candidate[1]/@id"], "C-1")
        self.assertEqual(sources["/Candidate[1]/Experience[1]"], "Python & XML")
        self.assertEqual(sources["/Candidate[1]/Experience[2]"], "Data analysis")

    def test_rejects_xml_entity_declarations(self):
        xml = io.BytesIO(b'<!DOCTYPE x [<!ENTITY secret "hidden">]><Candidate>&secret;</Candidate>')
        with self.assertRaises(HTTPException) as error:
            extract_xml_sources(xml)
        self.assertEqual(error.exception.status_code, 422)

    def test_document_info_accepts_xml_upload(self):
        client = TestClient(app)
        response = client.post(
            "/api/document-info",
            files={"document": ("candidate.xml", b"<Candidate><Name>Sample</Name></Candidate>", "application/xml")},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["document_type"], "xml")

    def test_announcement_url_rejects_http_and_loopback_hosts(self):
        for url in ("http://example.org/job", "https://127.0.0.1/job"):
            with self.subTest(url=url), self.assertRaises(HTTPException):
                asyncio.run(fetch_public_announcement(url))


if __name__ == "__main__":
    unittest.main()