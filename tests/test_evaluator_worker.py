import importlib
import json
import sys
import types
import unittest
from typing import Any, cast
from unittest.mock import patch

from language.interpreter import ExecutionLimitError


class FakeSDKResponse:
	def __init__(
		self,
		body: str | bytes | None = None,
		status: int = 200,
		headers: dict[str, str] | None = None,
	) -> None:
		self.body = body
		self.status = status
		self.headers = headers or {}

	@staticmethod
	def json(
		data: dict[str, Any],
		*,
		status: int = 200,
		headers: dict[str, str] | None = None,
	) -> "FakeSDKResponse":
		response_headers = {"content-type": "application/json"}
		if headers:
			response_headers.update(headers)
		return FakeSDKResponse(
			json.dumps(data), status=status, headers=response_headers
		)


class FakeSDKWorkerEntrypoint:
	def __init__(self, ctx: object = None, env: object = None) -> None:
		self.ctx = ctx
		self.env = env


fake_workers = types.ModuleType("workers")
setattr(fake_workers, "Response", FakeSDKResponse)
setattr(fake_workers, "WorkerEntrypoint", FakeSDKWorkerEntrypoint)
previous_evaluator_worker = sys.modules.pop("evaluator_worker", None)
try:
	with patch.dict(sys.modules, {"workers": fake_workers}):
		evaluator_worker = importlib.import_module("evaluator_worker")
finally:
	sys.modules.pop("evaluator_worker", None)
	if previous_evaluator_worker is not None:
		sys.modules["evaluator_worker"] = previous_evaluator_worker


class FakeRequest:
	def __init__(
		self,
		body: object,
		*,
		method: str = "POST",
		content_type: str = "application/json",
		json_error: Exception | None = None,
	) -> None:
		self.method = method
		self.headers = {"content-type": content_type}
		self.body = body
		self.json_error = json_error

	async def json(self) -> object:
		if self.json_error is not None:
			raise self.json_error
		return self.body


def response_data(response: object) -> dict[str, Any]:
	body = getattr(response, "body")
	if isinstance(body, bytes):
		body = body.decode()
	if not isinstance(body, str):
		raise AssertionError(f"expected a local JSON body, got {type(body).__name__}")
	data: Any = json.loads(body)
	if not isinstance(data, dict):
		raise AssertionError("expected a JSON object")
	return data


class EvaluatorWorkerTests(unittest.IsolatedAsyncioTestCase):
	def setUp(self) -> None:
		self.worker = evaluator_worker.Default(cast(Any, None), cast(Any, None))

	async def test_successful_roll_has_json_safe_shape(self):
		response = await self.worker.fetch(FakeRequest({"source": "3d6"}))

		self.assertEqual(response.status, 200)
		data = response_data(response)
		self.assertEqual(data["ok"], True)
		value = data["value"]
		self.assertIsInstance(value, dict)
		assert isinstance(value, dict)
		self.assertEqual(value["kind"], "roll_result")
		self.assertIsInstance(value["total"], int)
		self.assertIsInstance(value["details"], list)

	async def test_missing_non_string_and_too_long_sources_are_rejected(self):
		requests = (
			FakeRequest({}),
			FakeRequest({"source": 3}),
			FakeRequest({"source": "x" * 4097}),
		)

		for request in requests:
			with self.subTest(request=request.body):
				response = await self.worker.fetch(request)
				data = response_data(response)
				self.assertEqual(response.status, 400)
				self.assertEqual(data["ok"], False)
				self.assertIsInstance(data["error"], dict)
				assert isinstance(data["error"], dict)
				self.assertIsInstance(data["error"].get("code"), str)
				self.assertIsInstance(data["error"].get("message"), str)

	async def test_malformed_json_is_rejected(self):
		response = await self.worker.fetch(
			FakeRequest(None, json_error=ValueError("malformed"))
		)

		self.assertEqual(response.status, 400)
		self.assertEqual(response_data(response)["error"]["code"], "invalid_json")

	async def test_wrong_method_is_rejected(self):
		response = await self.worker.fetch(FakeRequest({}, method="GET"))

		self.assertEqual(response.status, 405)
		self.assertEqual(response_data(response)["ok"], False)

	async def test_wrong_content_type_is_rejected(self):
		response = await self.worker.fetch(FakeRequest({}, content_type="text/plain"))

		self.assertEqual(response.status, 400)
		self.assertEqual(
			response_data(response)["error"]["code"], "unsupported_media_type"
		)

	async def test_execution_timeout_is_a_user_facing_200_error(self):
		with patch.object(
			evaluator_worker,
			"evaluate_source",
			side_effect=ExecutionLimitError("too slow"),
		):
			response = await self.worker.fetch(FakeRequest({"source": "3d6"}))

		self.assertEqual(response.status, 200)
		self.assertEqual(response_data(response)["error"]["code"], "execution_timeout")

	async def test_evaluation_uses_worker_budgets(self):
		with patch.object(
			evaluator_worker, "evaluate_source", return_value=3
		) as evaluate:
			response = await self.worker.fetch(FakeRequest({"source": "3d6"}))

		self.assertEqual(response.status, 200)
		evaluate.assert_called_once_with(
			"3d6",
			max_duration_ms=10,
			max_steps=10_000,
			max_call_depth=100,
		)

	async def test_malformed_evaluator_result_is_a_stable_error(self):
		with patch.object(evaluator_worker, "evaluate_source", return_value=object()):
			response = await self.worker.fetch(FakeRequest({"source": "3d6"}))

		self.assertEqual(response.status, 200)
		data = response_data(response)
		self.assertEqual(data["ok"], False)
		self.assertEqual(data["error"]["code"], "serialization_error")

	async def test_unexpected_failure_is_not_exposed_to_caller(self):
		with self.assertLogs(evaluator_worker.logger, level="ERROR") as logs:
			with patch.object(
				evaluator_worker,
				"evaluate_source",
				side_effect=RuntimeError("secret-token"),
			):
				response = await self.worker.fetch(
					FakeRequest({"source": "source-secret"})
				)

		self.assertEqual(response.status, 500)
		data = response_data(response)
		self.assertEqual(data["error"]["code"], "internal_error")
		self.assertNotIn("secret-token", json.dumps(data))
		log_output = "\n".join(logs.output)
		self.assertEqual(
			logs.output, ["ERROR:evaluator_worker:evaluator_unexpected_exception"]
		)
		self.assertNotIn("secret-token", log_output)
		self.assertNotIn("source-secret", log_output)
