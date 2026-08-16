import random
import unittest
from unittest.mock import patch

from agathos.rolls import (
	MAX_SOURCE_LENGTH,
	MAX_SAFE_INTEGER,
	SerializationError,
	error_code,
	evaluate_source,
	serialize_value,
)
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
from language.lexer import Tokenizer
from language.parser import Parser


def require_die_detail(value: object) -> DieRollDetail:
	if not isinstance(value, DieRollDetail):
		raise AssertionError(f"expected DieRollDetail, got {type(value).__name__}")
	return value


def require_roll_result(value: object) -> RollResult:
	if not isinstance(value, RollResult):
		raise AssertionError(f"expected RollResult, got {type(value).__name__}")
	return value


class FakeClock:
	def __init__(self, *values: float):
		self.values = iter(values)

	def __call__(self) -> float:
		return next(self.values)


class InterpreterBudgetTests(unittest.TestCase):
	def test_duration_must_not_be_negative(self):
		with self.assertRaises(ValueError):
			Interpreter(max_duration_ms=-1)

	def test_duration_must_be_finite(self):
		for duration in (float("nan"), float("inf"), float("-inf")):
			with self.subTest(duration=duration):
				with self.assertRaisesRegex(
					ValueError, "max_duration_ms must not be negative"
				):
					Interpreter(max_duration_ms=duration)

	def test_clock_accepts_callable(self):
		def clock() -> float:
			return 0.0

		interpreter = Interpreter(max_duration_ms=10, clock=clock)

		self.assertIs(interpreter._clock, clock)

	def test_direct_execute_is_time_bounded(self):
		expressions = Parser(Tokenizer("1 + 2").tokenize()).parse_program()
		interpreter = Interpreter(
			max_duration_ms=10,
			clock=FakeClock(0.000, 0.011),
		)

		with self.assertRaises(ExecutionLimitError):
			interpreter.execute(expressions)

	def test_direct_execute_persistent_is_time_bounded(self):
		expressions = Parser(Tokenizer("value := 1").tokenize()).parse_program()
		interpreter = Interpreter(
			max_duration_ms=10,
			clock=FakeClock(0.000, 0.011),
		)

		with self.assertRaises(ExecutionLimitError):
			interpreter.execute_persistent(expressions)

	def test_parsing_phase_timeout_is_checked_after_parsing(self):
		interpreter = Interpreter(
			max_duration_ms=10,
			clock=FakeClock(0.000, 0.000, 0.011),
		)

		with self.assertRaises(ExecutionLimitError):
			interpreter.execute_source("")

	def test_deadline_is_cleared_after_timed_execution(self):
		expressions = Parser(Tokenizer("1").tokenize()).parse_program()
		interpreter = Interpreter(
			max_duration_ms=10,
			clock=FakeClock(0.000, 0.011, 0.000, 0.000),
		)

		with self.assertRaises(ExecutionLimitError):
			interpreter.execute(expressions)
		self.assertIsNone(interpreter._deadline)
		self.assertEqual(interpreter.execute(expressions), 1)

	def test_execution_timeout_is_raised_before_work_starts(self):
		interpreter = Interpreter(
			max_duration_ms=10,
			clock=FakeClock(0.000, 0.011),
		)

		with self.assertRaises(ExecutionLimitError):
			interpreter.execute_source("1 + 2")

	def test_execution_timeout_interrupts_iteration(self):
		interpreter = Interpreter(
			max_duration_ms=10,
			clock=FakeClock(0.000, *([0.001] * 20), 0.011),
			max_steps=100_000,
		)

		with self.assertRaises(ExecutionLimitError):
			interpreter.execute_source("[d20 for i in 0:100000]")

	def test_huge_integer_operations_are_rejected_before_evaluation(self):
		for source in (
			"2**10000000",
			"2 << 10000000",
			"(2**500000) * (2**500000)",
		):
			with self.subTest(source=source):
				with self.assertRaises(ExecutionLimitError):
					Interpreter().execute_source(source)

	def test_deadline_is_checked_after_binary_operation(self):
		expressions = Parser(Tokenizer("2 * 3").tokenize()).parse_program()
		interpreter = Interpreter(
			max_duration_ms=10,
			clock=FakeClock(0.000, 0.000, 0.011),
		)

		with self.assertRaises(ExecutionLimitError):
			interpreter.execute(expressions)


class RollSemanticTests(unittest.TestCase):
	def test_blank_source_defaults_to_d20(self):
		result = require_roll_result(evaluate_source(" \n\t"))

		self.assertEqual(require_die_detail(result.details[0]).sides, 20)

	def test_d20_roll(self):
		result = require_roll_result(
			Interpreter(rng=random.Random(0)).execute_source("d20")
		)

		self.assertEqual(result.total, 13)

	def test_multiple_dice_roll(self):
		result = require_roll_result(
			Interpreter(rng=random.Random(0)).execute_source("3d6")
		)

		self.assertEqual(result.total, 9)
		self.assertEqual(require_die_detail(result.details[0]).values, (4, 4, 1))

	def test_advantage_roll(self):
		result = require_roll_result(
			Interpreter(rng=random.Random(0)).execute_source("+d20")
		)

		self.assertEqual(result.total, 14)
		self.assertEqual(require_die_detail(result.details[0]).dropped, (13,))

	def test_dropped_and_modified_dice(self):
		result = require_roll_result(
			Interpreter(rng=random.Random(0)).execute_source("3d6b3m4")
		)

		self.assertEqual(result.total, 12)
		self.assertEqual(require_die_detail(result.details[0]).values, (4, 4, 4))

	def test_comprehension_rolls(self):
		result = Interpreter(rng=random.Random(0)).execute_source("[d20 for i in 0:5]")

		self.assertIsInstance(result, list)
		assert isinstance(result, list)
		self.assertEqual(
			[require_roll_result(item).total for item in result],
			[13, 14, 2, 9, 17],
		)


class SerializationTests(unittest.TestCase):
	def test_primitive_and_nested_array_serialization(self):
		value = [None, True, 3, 2.5, "text", [False, "nested"]]

		self.assertEqual(serialize_value(value), value)

	def test_safe_integers_serialize_losslessly(self):
		value = [-MAX_SAFE_INTEGER, 0, MAX_SAFE_INTEGER]

		self.assertEqual(serialize_value(value), value)

	def test_unsafe_nested_integer_is_rejected(self):
		with self.assertRaisesRegex(
			SerializationError,
			"integer exceeds JavaScript Number.MAX_SAFE_INTEGER",
		):
			serialize_value([9007199254740993])

	def test_unsafe_roll_result_total_is_rejected(self):
		with self.assertRaises(SerializationError):
			serialize_value(RollResult(total=9007199254740993, details=()))

	def test_unsafe_roll_detail_integer_is_rejected(self):
		detail = DieRollDetail(
			sides=6,
			rolls=(9007199254740993,),
			rerolls=(),
			dropped=(),
		)

		with self.assertRaises(SerializationError):
			serialize_value(RollResult(total=1, details=(detail,)))

	def test_roll_result_serializes_as_a_tagged_object(self):
		die = DieRollDetail(
			sides=6,
			rolls=(4, 5),
			rerolls=((2,), ()),
			dropped=(5,),
			clamped=(((2, 4),), ()),
			values=(4, 4),
		)
		composition = RollCompositionDetail(operation="+", left=4, right=2, result=6)
		result = RollResult(total=6, details=(die, composition), d20_eligible=True)

		self.assertEqual(
			serialize_value(result),
			{
				"kind": "roll_result",
				"total": 6,
				"details": [
					{
						"kind": "die_roll_detail",
						"sides": 6,
						"rolls": [4, 5],
						"rerolls": [[2], []],
						"dropped": [5],
						"clamped": [[[2, 4]], []],
						"values": [4, 4],
						"nested": [],
					},
					{
						"kind": "roll_composition_detail",
						"operation": "+",
						"left": 4,
						"right": 2,
						"result": 6,
					},
				],
			},
		)

	def test_nested_roll_details_are_serialized(self):
		nested = DieRollDetail(sides=4, rolls=(2,), rerolls=((),), dropped=())
		die = DieRollDetail(
			sides=6,
			rolls=(3,),
			rerolls=((),),
			dropped=(),
			nested=(nested,),
		)

		serialized = serialize_value(die)
		assert isinstance(serialized, dict)
		nested_values = serialized["nested"]
		assert isinstance(nested_values, list)
		nested_detail = nested_values[0]
		assert isinstance(nested_detail, dict)

		self.assertEqual(nested_detail["kind"], "die_roll_detail")
		self.assertEqual(nested_detail["sides"], 4)

	def test_non_finite_float_is_rejected(self):
		for value in (float("nan"), float("inf"), float("-inf")):
			with self.subTest(value=value):
				with self.assertRaises(SerializationError):
					serialize_value(value)

	def test_unsupported_value_is_rejected_with_dedicated_error(self):
		with self.assertRaises(SerializationError):
			serialize_value(object())

	def test_source_length_is_rejected_before_interpreter_creation(self):
		with patch("agathos.rolls.Interpreter") as interpreter_type:
			with self.assertRaises(ValueError):
				evaluate_source("x" * (MAX_SOURCE_LENGTH + 1))

		interpreter_type.assert_not_called()

	def test_evaluation_constructs_a_fresh_interpreter(self):
		with patch("agathos.rolls.Interpreter") as interpreter_type:
			interpreter_type.return_value.execute_source.return_value = 3

			self.assertEqual(evaluate_source("1 + 2"), 3)

		interpreter_type.assert_called_once_with(
			max_duration_ms=10,
			max_steps=10_000,
			max_call_depth=100,
		)


class ErrorCodeTests(unittest.TestCase):
	def test_error_codes_are_stable(self):
		cases = (
			(SerializationError("unsafe integer"), "serialization_error"),
			(SyntaxError(), "syntax_error"),
			(TypeError(), "type_error"),
			(NameError(), "name_error"),
			(UndefinedNameError("missing"), "name_error"),
			(ValueError(), "value_error"),
			(InvalidDiceError("bad dice"), "value_error"),
			(DivisionByZeroError("zero"), "value_error"),
			(RecursionError(), "recursion_error"),
			(CallDepthError("too deep"), "recursion_error"),
			(ExecutionLimitError("too slow"), "execution_timeout"),
			(RuntimeErrorBase("other"), "runtime_error"),
		)

		for error, expected in cases:
			with self.subTest(error=type(error).__name__):
				self.assertEqual(error_code(error), expected)


if __name__ == "__main__":
	unittest.main()
