import contextvars
import json
import logging
import time
import uuid


request_id_context = contextvars.ContextVar("application_review_request_id", default="-")
pipeline_logger = logging.getLogger("application_processing")
pipeline_logger.setLevel(logging.INFO)
pipeline_logger.propagate = False

if not pipeline_logger.handlers:
    console_handler = logging.StreamHandler()
    console_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    pipeline_logger.addHandler(console_handler)


def log_pipeline_event(event: str, **metadata):
    safe_metadata = json.dumps(metadata, sort_keys=True, ensure_ascii=True, default=str)
    pipeline_logger.info("request_id=%s event=%s %s", request_id_context.get(), event, safe_metadata)


async def trace_http_request(request, call_next):
    request_id = uuid.uuid4().hex[:12]
    token = request_id_context.set(request_id)
    started = time.perf_counter()
    response = None
    try:
        response = await call_next(request)
        return response
    except Exception as exc:
        if request.url.path.startswith("/api/"):
            log_pipeline_event(
                "http.exception",
                method=request.method,
                path=request.url.path,
                error_type=type(exc).__name__,
            )
        raise
    finally:
        if response is not None:
            response.headers["X-Request-ID"] = request_id
            if request.url.path.startswith("/api/"):
                log_pipeline_event(
                    "http.complete",
                    method=request.method,
                    path=request.url.path,
                    status=response.status_code,
                    duration_ms=round((time.perf_counter() - started) * 1000),
                )
        request_id_context.reset(token)