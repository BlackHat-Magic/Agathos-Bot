import unittest
from typing import cast

from language.expressions import Binary, BinaryOp, Identifier, Int
from language.interpreter import (
	CallDepthError,
	DieRollDetail,
	DivisionByZeroError,
	ExecutionLimitError,
	InvalidDiceError,
	InvalidOperationError,
	Interpreter,
	RollCompositionDetail,
	RollResult,
	RuntimeEnv,
	RuntimeErrorBase,
	UndefinedNameError,
	_BreakSignal,
	_ContinueSignal,
	_ReturnSignal,
	_YieldSignal,
)


class RuntimeEnvTests(unittest.TestCase):
	def test_declaration_stores_value_in_current_environment(self):
		env = RuntimeEnv()

		env.declare("answer", 42)

		self.assertEqual(env.lookup("answer"), 42)

	def test_child_environment_shadows_parent(self):
		parent = RuntimeEnv()
		parent.declare("value", "outer")
		child = parent.child()

		child.declare("value", "inner")

		self.assertEqual(parent.lookup("value"), "outer")
		self.assertEqual(child.lookup("value"), "inner")

	def test_assignment_updates_nearest_same_name_binding_only(self):
		parent = RuntimeEnv()
		parent.declare("value", "outer")
		child = parent.child()
		child.declare("value", "inner")

		child.assign("value", "updated")

		self.assertEqual(child.lookup("value"), "updated")
		self.assertEqual(parent.lookup("value"), "outer")

	def test_assignment_updates_ancestor_when_child_has_no_binding(self):
		parent = RuntimeEnv()
		parent.declare("value", "outer")
		child = parent.child()

		child.assign("value", "updated")

		self.assertEqual(parent.lookup("value"), "updated")

	def test_lookup_rejects_undefined_name(self):
		with self.assertRaises(UndefinedNameError):
			RuntimeEnv().lookup("missing")

	def test_assignment_rejects_undefined_name(self):
		with self.assertRaises(UndefinedNameError):
			RuntimeEnv().assign("missing", 1)

	def test_declaration_rejects_duplicate_current_binding(self):
		env = RuntimeEnv()
		env.declare("value", 1)

		with self.assertRaises(InvalidOperationError):
			env.declare("value", 2)

	def test_child_declaration_can_shadow_without_duplicate_error(self):
		parent = RuntimeEnv()
		parent.declare("value", 1)
		child = parent.child()

		child.declare("value", 2)

		self.assertEqual(child.lookup("value"), 2)

	def test_parent_must_be_runtime_environment(self):
		with self.assertRaises(TypeError):
			RuntimeEnv(parent=cast(RuntimeEnv, object()))

	def test_parent_link_is_read_only(self):
		parent = RuntimeEnv()
		child = parent.child()

		with self.assertRaises(AttributeError):
			setattr(child, "parent", child)

		self.assertIs(child.parent, parent)


class RuntimeErrorHierarchyTests(unittest.TestCase):
	def test_runtime_errors_share_common_base(self):
		error_types = (
			UndefinedNameError,
			InvalidOperationError,
			DivisionByZeroError,
			InvalidDiceError,
			ExecutionLimitError,
			CallDepthError,
		)

		for error_type in error_types:
			with self.subTest(error_type=error_type):
				self.assertTrue(issubclass(error_type, RuntimeErrorBase))
				self.assertTrue(issubclass(error_type, Exception))


class RuntimeControlSignalTests(unittest.TestCase):
	def test_value_signals_preserve_value_and_exception_args(self):
		for signal_type in (_ReturnSignal, _YieldSignal):
			with self.subTest(signal_type=signal_type):
				signal = signal_type("value")
				self.assertEqual(signal.value, "value")
				self.assertEqual(signal.args, ("value",))
				self.assertNotEqual(signal, signal_type("value"))

	def test_empty_signals_have_no_value_or_exception_args(self):
		for signal_type in (_BreakSignal, _ContinueSignal):
			with self.subTest(signal_type=signal_type):
				signal = signal_type()
				self.assertEqual(signal.args, ())
				self.assertNotEqual(signal, signal_type())


class InterpreterTests(unittest.TestCase):
	def test_execute_source_returns_latest_value(self):
		interpreter = Interpreter()

		self.assertEqual(
			interpreter.execute_source("var := 5; result := var; result;"), 5
		)

	def test_execute_source_evaluates_scalar_literals(self):
		for source, expected in (
			('"text"', "text"),
			("1.5", 1.5),
			("5", 5),
			("true", True),
			("null", None),
		):
			with self.subTest(source=source):
				self.assertEqual(Interpreter().execute_source(source), expected)

	def test_block_declaration_shadows_outer_binding(self):
		self.assertEqual(
			Interpreter().execute_source("value := 1; { value := 2; value; }; value;"),
			1,
		)

	def test_assignment_updates_nearest_visible_binding(self):
		self.assertEqual(
			Interpreter().execute_source("value := 1; { value = 2; }; value;"),
			2,
		)

	def test_block_has_a_child_scope_and_returns_latest_result(self):
		self.assertEqual(
			Interpreter().execute_source("{ value := 2; value; }"),
			2,
		)

	def test_empty_program_returns_none(self):
		self.assertIsNone(Interpreter().execute_source(""))

	def test_execute_resets_step_state_for_each_program(self):
		interpreter = Interpreter(max_steps=1)

		self.assertEqual(interpreter.execute_source("1"), 1)
		self.assertEqual(interpreter.execute_source("2"), 2)

	def test_step_exhaustion_raises_before_next_dispatch(self):
		with self.assertRaises(ExecutionLimitError):
			Interpreter(max_steps=1).execute_source("1; 2")

	def test_primitive_type_descriptor_is_not_a_runtime_value(self):
		with self.assertRaises(InvalidOperationError):
			Interpreter().execute_source("int")

	def test_unary_operations_and_identifier_mutation(self):
		interpreter = Interpreter()

		self.assertEqual(interpreter.execute_source("value := 1; ++value;"), 2)
		self.assertEqual(
			interpreter.execute_source("value := 1; old := value++; old;"), 1
		)
		self.assertEqual(interpreter.execute_source("value := 1; value--; value;"), 0)
		self.assertEqual(interpreter.execute_source("!false"), True)
		self.assertEqual(interpreter.execute_source("~5"), -6)
		self.assertEqual(interpreter.execute_source("+5"), 5)
		self.assertEqual(interpreter.execute_source("-5"), -5)

	def test_arithmetic_shift_bitwise_and_logical_operations(self):
		for source, expected in (
			("1 + 2", 3),
			("5 - 2", 3),
			("2 * 3", 6),
			("5 / 2", 2.5),
			("5 // 2", 2),
			("5 % 2", 1),
			("2 ** 3", 8),
			("1 << 3", 8),
			("8 >> 2", 2),
			("6 & 3", 2),
			("6 ^ 3", 5),
			("6 | 3", 7),
			("true && false", False),
			("true || false", True),
		):
			with self.subTest(source=source):
				self.assertEqual(Interpreter().execute_source(source), expected)

	def test_comparisons_equality_and_list_membership(self):
		for source, expected in (
			("1 < 2", True),
			("2 <= 2", True),
			("3 > 2", True),
			("3 >= 4", False),
			("2 == 2", True),
			("2 != 2", False),
			("2 in [1, 2, 3]", True),
			("4 in [1, 2, 3]", False),
		):
			with self.subTest(source=source):
				self.assertEqual(Interpreter().execute_source(source), expected)

	def test_compound_assignment_uses_operator_dispatch(self):
		self.assertEqual(
			Interpreter().execute_source("value := 2; value *= 3; value += 1; value;"),
			7,
		)

	def test_zero_division_errors_are_normalized(self):
		for source in ("1 / 0", "1 // 0", "1 % 0"):
			with self.subTest(source=source):
				with self.assertRaises(DivisionByZeroError):
					Interpreter().execute_source(source)

	def test_numeric_rejects_boolean_and_dice_operations_are_deferred(self):
		interpreter = Interpreter()
		with self.assertRaises(InvalidOperationError):
			interpreter._apply_binary(BinaryOp.ADD, True, 1)
		with self.assertRaises(InvalidOperationError):
			interpreter.execute_source("1d6")

	def test_roll_result_is_immutable_and_formats_deterministically(self):
		detail = DieRollDetail(
			sides=20,
			rolls=(7, 13),
			rerolls=((2, 8), ()),
			dropped=(13,),
		)
		result = RollResult(total=15, details=(detail,))

		self.assertEqual(
			result.format(),
			"total=15 details=[d20 rolls=(7, 13) rerolls=((2, 8), ()) dropped=(13,)]",
		)
		with self.assertRaises(AttributeError):
			setattr(result, "total", 16)

	def test_roll_detail_constructors_snapshot_mutable_iterables(self):
		rolls = [7, 13]
		rerolls = [[2, 8], []]
		dropped = [13]
		details = []
		detail = DieRollDetail(
			sides=20,
			rolls=rolls,
			rerolls=rerolls,
			dropped=dropped,
		)
		details.append(detail)
		result = RollResult(total=15, details=details)

		rolls.append(1)
		rerolls[0].append(19)
		rerolls.append([4])
		dropped.clear()
		details.clear()

		self.assertEqual(detail.rolls, (7, 13))
		self.assertEqual(detail.rerolls, ((2, 8), ()))
		self.assertEqual(detail.dropped, (13,))
		self.assertEqual(result.details, (detail,))

	def test_roll_details_survive_manual_arithmetic_and_comparisons(self):
		detail = DieRollDetail(sides=20, rolls=(7,), rerolls=(), dropped=())
		roll = RollResult(total=7, details=(detail,))
		interpreter = Interpreter()

		combined = interpreter._combine_result(roll, 5, 12, "+")
		self.assertIsInstance(combined, RollResult)
		assert isinstance(combined, RollResult)
		self.assertEqual(combined.total, 12)
		self.assertEqual(combined.details[0], detail)
		self.assertEqual(
			combined.details[1],
			RollCompositionDetail(operation="+", left=7, right=5, result=12),
		)
		self.assertEqual(
			combined.format(),
			"total=12 details=[d20 rolls=(7,) rerolls=() dropped=(); (7 + 5 = 12)]",
		)

		environment = RuntimeEnv()
		environment.declare("roll", roll)
		roll_identifier = Identifier(type="identifier", dtype=int, label="roll")
		addition = Binary(
			type="binary",
			dtype=int,
			operation=BinaryOp.ADD,
			left=roll_identifier,
			right=Int(5),
		)
		comparison = Binary(
			type="binary",
			dtype=bool,
			operation=BinaryOp.GREATER_THAN,
			left=roll_identifier,
			right=Int(5),
		)
		self.assertEqual(interpreter._evaluate(addition, environment), combined)
		self.assertTrue(interpreter._evaluate(comparison, environment))


if __name__ == "__main__":
	unittest.main()
