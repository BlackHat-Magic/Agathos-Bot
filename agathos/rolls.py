"""Bounded, JSON-safe evaluation of Agathos roll expressions."""

from __future__ import annotations

from math import isfinite
from typing import TypeAlias

from language.interpreter import (
	CallDepthError,
	DieRollDetail,
	DivisionByZeroError,
	ExecutionLimitError,
	Interpreter,
	InvalidDiceError,
	RollCompositionDetail,
	RollResult,
	RuntimeErrorBase,
	UndefinedNameError,
)


MAX_SOURCE_LENGTH = 4096
MAX_SAFE_INTEGER = 2**53 - 1

JSONValue: TypeAlias = (
	None | bool | int | float | str | list["JSONValue"] | dict[str, "JSONValue"]
)


class SerializationError(TypeError):
	"""Raised when an interpreter value cannot be represented as JSON."""


def serialize_value(value: object) -> JSONValue:
	"""Convert a supported interpreter value into a JSON-safe value."""
	if value is None or isinstance(value, (bool, str)):
		return value
	if isinstance(value, int):
		if abs(value) > MAX_SAFE_INTEGER:
			raise SerializationError(
				"integer exceeds JavaScript Number.MAX_SAFE_INTEGER"
			)
		return value
	if isinstance(value, float):
		if not isfinite(value):
			raise SerializationError("non-finite floats are not JSON-safe")
		return value
	if isinstance(value, list):
		return [serialize_value(item) for item in value]
	if isinstance(value, RollResult):
		return {
			"kind": "roll_result",
			"total": serialize_value(value.total),
			"details": [serialize_value(detail) for detail in value.details],
		}
	if isinstance(value, DieRollDetail):
		return {
			"kind": "die_roll_detail",
			"sides": serialize_value(value.sides),
			"rolls": [serialize_value(roll) for roll in value.rolls],
			"rerolls": [
				[serialize_value(roll) for roll in reroll] for reroll in value.rerolls
			],
			"dropped": [serialize_value(roll) for roll in value.dropped],
			"clamped": [
				[[serialize_value(item) for item in pair] for pair in clamp]
				for clamp in value.clamped
			],
			"values": [serialize_value(item) for item in value.values],
			"nested": [serialize_value(item) for item in value.nested],
		}
	if isinstance(value, RollCompositionDetail):
		return {
			"kind": "roll_composition_detail",
			"operation": value.operation,
			"left": serialize_value(value.left),
			"right": serialize_value(value.right),
			"result": serialize_value(value.result),
		}
	raise SerializationError(f"unsupported value type: {type(value).__name__}")


def evaluate_source(
	source: str,
	*,
	max_duration_ms: float = 10,
	max_steps: int = 10_000,
	max_call_depth: int = 100,
) -> object:
	"""Evaluate one bounded source string with a fresh interpreter."""
	if not isinstance(source, str):
		raise TypeError("source must be a string")
	if len(source) > MAX_SOURCE_LENGTH:
		raise ValueError("source exceeds maximum length")
	interpreter = Interpreter(
		max_duration_ms=max_duration_ms,
		max_steps=max_steps,
		max_call_depth=max_call_depth,
	)
	return interpreter.execute_source(source.strip() or "d20")


def error_code(error: BaseException) -> str:
	"""Return the stable public code for an evaluation error."""
	if isinstance(error, SerializationError):
		return "serialization_error"
	if isinstance(error, ExecutionLimitError):
		return "execution_timeout"
	if isinstance(error, (CallDepthError, RecursionError)):
		return "recursion_error"
	if isinstance(error, SyntaxError):
		return "syntax_error"
	if isinstance(error, TypeError):
		return "type_error"
	if isinstance(error, (NameError, UndefinedNameError)):
		return "name_error"
	if isinstance(error, (ValueError, InvalidDiceError, DivisionByZeroError)):
		return "value_error"
	if isinstance(error, RuntimeErrorBase):
		return "runtime_error"
	return "runtime_error"
