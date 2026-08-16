"""Private Worker entrypoint for bounded Agathos expression evaluation."""

from __future__ import annotations

import logging
from typing import Any, cast

from workers import Response, WorkerEntrypoint

from agathos.rolls import (
	MAX_SOURCE_LENGTH,
	SerializationError,
	error_code,
	evaluate_source,
	serialize_value,
)
from language.interpreter import RuntimeErrorBase


logger = logging.getLogger(__name__)


def _json_response(payload: dict[str, Any], status: int = 200) -> Response:
	"""Create a JSON response using the Workers SDK response API."""
	return cast(Any, Response.json)(payload, status=status)


def _error_response(code: str, message: str, status: int) -> Response:
	"""Create the stable error envelope used by the evaluator API."""
	return _json_response(
		{"ok": False, "error": {"code": code, "message": message}},
		status,
	)


def _content_type(request: Any) -> str | None:
	"""Return the request media type without optional parameters."""
	value = request.headers.get("content-type")
	if not isinstance(value, str):
		return None
	return value.split(";", 1)[0].strip().lower()


class Default(WorkerEntrypoint):
	"""Evaluate one Agathos source string per private Worker request."""

	async def fetch(self, request: Any) -> Response:
		"""Validate, evaluate, and serialize a JSON evaluator request."""
		method = getattr(request.method, "value", request.method)
		if method != "POST":
			return _error_response(
				"method_not_allowed", "only POST requests are supported", 405
			)

		if _content_type(request) != "application/json":
			return _error_response(
				"unsupported_media_type",
				"content type must be application/json",
				400,
			)

		try:
			payload = await request.json()
		except ValueError:
			return _error_response(
				"invalid_json", "request body must be valid JSON", 400
			)

		if not isinstance(payload, dict):
			return _error_response(
				"invalid_request", "request body must be an object", 400
			)

		source = payload.get("source")
		if not isinstance(source, str):
			return _error_response("invalid_source", "source must be a string", 400)
		if len(source) > MAX_SOURCE_LENGTH:
			return _error_response(
				"source_too_long",
				f"source must not exceed {MAX_SOURCE_LENGTH} characters",
				400,
			)

		try:
			result = evaluate_source(
				source,
				max_duration_ms=10,
				max_steps=10_000,
				max_call_depth=100,
			)
			return _json_response({"ok": True, "value": serialize_value(result)})
		except (
			RuntimeErrorBase,
			SerializationError,
			SyntaxError,
			TypeError,
			NameError,
			ValueError,
			RecursionError,
		) as error:
			return _error_response(
				error_code(error), str(error) or "evaluation failed", 200
			)
		except Exception:
			logger.error("evaluator_unexpected_exception")
			return _error_response("internal_error", "internal evaluator error", 500)
