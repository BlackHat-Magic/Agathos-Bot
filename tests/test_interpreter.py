import unittest
import random
from typing import Any, cast

from language.expressions import (
	ArrayType,
	Binary,
	BinaryOp,
	Break,
	Block,
	Call,
	Continue,
	Function,
	FunctionType,
	Identifier,
	Index,
	Int,
	Return,
	Unary,
	Yield,
)
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
	RuntimeFunction,
	RuntimeErrorBase,
	UndefinedNameError,
	_BreakSignal,
	_ContinueSignal,
	_ReturnSignal,
	_YieldSignal,
)
from language.lexer import Tokenizer
from language.parser import Parser


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
	def _evaluate_manual_return(self, returns, value):
		environment = RuntimeEnv()
		environment.declare("returned", value)
		function = Function(
			type="function",
			dtype=FunctionType(parameters=[], returns=returns),
			name="manual",
			body=Block(
				type="block",
				dtype=None,
				body=[
					Return(
						type="return",
						dtype=returns,
						expression=Identifier(
							type="identifier", dtype=returns, label="returned"
						),
					)
				],
			),
		)
		environment.declare("manual", RuntimeFunction(function, environment))
		call = Call(
			type="call",
			dtype=returns,
			callee=Identifier(type="identifier", dtype=function.dtype, label="manual"),
			args=[],
		)
		return Interpreter()._evaluate(call, environment)

	def test_function_binds_parameters_and_returns_value(self):
		self.assertEqual(
			Interpreter().execute_source(
				"identity :: int (value: int) { return value; }; identity(7)"
			),
			7,
		)

	def test_function_captures_lexical_environment(self):
		self.assertEqual(
			Interpreter().execute_source(
				"offset := 5; add :: int (value: int) { return value + offset; }; "
				"add(3)"
			),
			8,
		)

	def test_recursive_function_uses_captured_binding(self):
		interpreter = Interpreter(max_call_depth=3)

		with self.assertRaises(CallDepthError):
			interpreter.execute_source(
				"recurse :: int (value: int) { return recurse(value); }; recurse(1)"
			)
		self.assertEqual(interpreter._call_depth, 0)

	def test_nested_function_captures_lexical_locals(self):
		self.assertEqual(
			Interpreter().execute_source(
				"outer :: int (base: int) { inner :: int (value: int) { "
				"return base + value; }; return inner(2); }; outer(3)"
			),
			5,
		)

	def test_no_value_function_returns_none(self):
		self.assertIsNone(
			Interpreter().execute_source("notify :: () { return; }; notify()")
		)

	def test_no_value_function_rejects_explicit_non_none_return(self):
		with self.assertRaises(InvalidOperationError):
			self._evaluate_manual_return(None, 1)

	def test_failed_persistent_submission_rolls_back_declarations(self):
		interpreter = Interpreter()

		with self.assertRaises(DivisionByZeroError):
			interpreter.execute_persistent_source("value := 1; 1 / 0")
		with self.assertRaises(UndefinedNameError):
			interpreter._persistent_environment.lookup("value")

		self.assertEqual(interpreter.execute_persistent_source("later := 2"), 2)

	def test_value_function_rejects_explicit_none_return(self):
		with self.assertRaises(InvalidOperationError):
			self._evaluate_manual_return(int, None)

	def test_scalar_return_types_are_exact_and_roll_results_use_total_type(self):
		self.assertEqual(
			self._evaluate_manual_return(int, RollResult(total=4, details=())),
			RollResult(total=4, details=()),
		)
		self.assertEqual(
			self._evaluate_manual_return(float, RollResult(total=4.5, details=())),
			RollResult(total=4.5, details=()),
		)

		for returns, value in ((int, 1.5), (int, True), (float, 1)):
			with self.subTest(returns=returns, value=value):
				with self.assertRaises(InvalidOperationError):
					self._evaluate_manual_return(returns, value)
		with self.assertRaises(InvalidOperationError):
			self._evaluate_manual_return(int, RollResult(total=4.5, details=()))
		with self.assertRaises(InvalidOperationError):
			self._evaluate_manual_return(float, RollResult(total=4, details=()))

	def test_array_returns_match_element_types_recursively(self):
		array_type = ArrayType(ArrayType(int))
		self.assertEqual(
			self._evaluate_manual_return(array_type, [[1, 2], [3]]),
			[[1, 2], [3]],
		)

		for value in ([[1, "wrong"]], [1, [2]]):
			with self.subTest(value=value):
				with self.assertRaises(InvalidOperationError):
					self._evaluate_manual_return(array_type, value)

	def test_function_returns_require_runtime_functions(self):
		returned_function = Function(
			type="function",
			dtype=FunctionType(parameters=[], returns=None),
			name="returned",
			body=Block(type="block", dtype=None, body=[]),
		)
		returned_environment = RuntimeEnv()
		runtime_function = RuntimeFunction(returned_function, returned_environment)
		function_type = FunctionType(parameters=[], returns=None)

		self.assertIs(
			self._evaluate_manual_return(function_type, runtime_function),
			runtime_function,
		)
		with self.assertRaises(InvalidOperationError):
			self._evaluate_manual_return(function_type, returned_function)

	def test_malformed_return_type_mode_is_rejected(self):
		with self.assertRaises(InvalidOperationError):
			self._evaluate_manual_return(object(), 1)

	def test_value_function_falling_through_is_rejected_defensively(self):
		function = Function(
			type="function",
			dtype=FunctionType(parameters=[], returns=int),
			name="missing",
			body=Block(type="block", dtype=None, body=[]),
		)
		environment = RuntimeEnv()
		environment.declare("missing", RuntimeFunction(function, environment))
		call = Call(
			type="call",
			dtype=int,
			callee=Identifier(type="identifier", dtype=function.dtype, label="missing"),
			args=[],
		)

		with self.assertRaises(InvalidOperationError):
			Interpreter()._evaluate(call, environment)

	def test_function_locals_do_not_leak(self):
		interpreter = Interpreter()

		self.assertEqual(
			interpreter.execute_source(
				"local := 2; make :: () { local := 1; }; make(); local"
			),
			2,
		)

	def test_return_signal_outside_function_is_a_runtime_error(self):
		return_expression = Return(type="return", dtype=None)

		with self.assertRaises(InvalidOperationError):
			Interpreter().execute([return_expression])

	def test_function_converts_malformed_control_signals_to_runtime_errors(self):
		for expression_type, expression in (
			("break", Break(type="break")),
			("continue", Continue(type="continue")),
			("yield", Yield(type="yield", dtype=int, expression=Int(1))),
		):
			with self.subTest(expression_type=expression_type):
				function = Function(
					type="function",
					dtype=FunctionType(parameters=[], returns=None),
					name="malformed",
					body=Block(type="block", dtype=None, body=[expression]),
				)
				environment = RuntimeEnv()
				environment.declare("malformed", RuntimeFunction(function, environment))
				call = Call(
					type="call",
					dtype=None,
					callee=Identifier(
						type="identifier", dtype=function.dtype, label="malformed"
					),
					args=[],
				)

				with self.assertRaises(InvalidOperationError):
					Interpreter()._evaluate(call, environment)

	def test_undefined_and_non_callable_calls_raise_runtime_errors(self):
		undefined_call = Call(
			type="call",
			dtype=int,
			callee=Identifier(
				type="identifier", dtype=FunctionType([], int), label="missing"
			),
			args=[],
		)
		with self.assertRaises(UndefinedNameError):
			Interpreter()._evaluate(undefined_call, RuntimeEnv())

		non_callable_call = Call(type="call", dtype=int, callee=Int(1), args=[])
		with self.assertRaises(InvalidOperationError):
			Interpreter()._evaluate(non_callable_call, RuntimeEnv())

	def test_call_depth_exhaustion_restores_depth(self):
		interpreter = Interpreter(max_call_depth=2)

		with self.assertRaisesRegex(CallDepthError, "call depth exceeded maximum: 2"):
			interpreter.execute_source("loop :: () { loop(); }; loop()")
		self.assertEqual(interpreter._call_depth, 0)
		self.assertEqual(interpreter.execute_source("1"), 1)

	def test_failed_call_restores_depth_after_runtime_error(self):
		interpreter = Interpreter(max_call_depth=1)

		with self.assertRaises(DivisionByZeroError):
			interpreter.execute_source("fail :: int () { return 1 // 0; }; fail()")
		self.assertEqual(interpreter._call_depth, 0)
		self.assertEqual(interpreter.execute_source("1"), 1)

	def test_zero_call_depth_rejects_call_without_entering_function(self):
		interpreter = Interpreter(max_call_depth=0)

		with self.assertRaises(CallDepthError):
			interpreter.execute_source("noop :: () {}; noop()")
		self.assertEqual(interpreter._call_depth, 0)

	def test_forward_function_declarations_are_unavailable_at_runtime(self):
		declarations = Parser(
			Tokenizer(
				"first :: int () { return 1; }; second :: int () { return 2; }"
			).tokenize()
		).parse_program()
		second = cast(Function, declarations[1])
		call = Call(
			type="call",
			dtype=int,
			callee=Identifier(type="identifier", dtype=second.dtype, label=second.name),
			args=[],
		)

		with self.assertRaises(UndefinedNameError):
			Interpreter().execute([declarations[0], call, declarations[1]])

	def test_function_preserves_roll_result_arguments_and_returns(self):
		result = Interpreter(rng=random.Random(0)).execute_source(
			"identity :: int (value: int) { return value; }; identity(1d6)"
		)

		self.assertEqual(
			result,
			RollResult(
				total=4,
				details=(DieRollDetail(6, (4,), ((),), ()),),
			),
		)

	def test_execute_source_returns_latest_value(self):
		interpreter = Interpreter()

		self.assertEqual(
			interpreter.execute_source("var := 5; result := var; result;"), 5
		)

	def test_execute_returns_latest_seeded_roll_result(self):
		program = Parser(Tokenizer("0; 1d6").tokenize()).parse_program()

		self.assertEqual(
			Interpreter(rng=random.Random(0)).execute(program),
			RollResult(
				total=4,
				details=(DieRollDetail(6, (4,), ((),), ()),),
			),
		)

	def test_repeated_execute_calls_reset_environment_steps_and_depth(self):
		interpreter = Interpreter(max_steps=3, max_call_depth=1)
		program = Parser(Tokenizer("value := 1; value").tokenize()).parse_program()

		self.assertEqual(interpreter.execute(program), 1)
		self.assertEqual(interpreter._steps, 3)
		self.assertEqual(interpreter._call_depth, 0)

		missing = Identifier(type="identifier", dtype=int, label="value")
		with self.assertRaises(UndefinedNameError):
			interpreter.execute([missing])
		self.assertEqual(interpreter._steps, 1)
		self.assertEqual(interpreter._call_depth, 0)

	def test_execute_accepts_canonical_parser_if_ast(self):
		program = Parser(
			Tokenizer("if false { yield 1; } else { yield 2; }").tokenize()
		).parse_program()

		self.assertEqual(Interpreter().execute(program), 2)

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
		self.assertEqual(interpreter._steps, 1)

	def test_max_steps_bounds_infinite_while(self):
		with self.assertRaises(ExecutionLimitError):
			Interpreter(max_steps=8).execute_source("while true {}")

	def test_max_steps_bounds_large_ranges(self):
		with self.assertRaises(ExecutionLimitError):
			Interpreter(max_steps=8).execute_source("0:100000000000000000000")

	def test_max_steps_bounds_comprehension_iterations(self):
		with self.assertRaises(ExecutionLimitError):
			Interpreter(max_steps=8).execute_source(
				"[item * 2 for item in 0:100000000000000000000]"
			)

	def test_max_steps_bounds_loop_iterations(self):
		with self.assertRaises(ExecutionLimitError):
			Interpreter(max_steps=8).execute_source(
				"for item in 0:100000000000000000000 { item; }"
			)

	def test_max_steps_bounds_nested_calls(self):
		with self.assertRaises(ExecutionLimitError):
			Interpreter(max_steps=8).execute_source(
				"recurse :: int (value: int) { return recurse(value); }; recurse(1)"
			)

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

	def test_unary_plus_applies_advantage_to_a_plain_d20(self):
		result = Interpreter(rng=random.Random(0)).execute_source("+d20")
		self.assertIsInstance(result, RollResult)
		assert isinstance(result, RollResult)

		self.assertEqual(result.total, 14)
		self.assertEqual(
			result.details,
			(
				DieRollDetail(
					sides=20,
					rolls=(14,),
					rerolls=((),),
					dropped=(13,),
					values=(14,),
				),
			),
		)

	def test_unary_minus_applies_disadvantage_to_a_plain_d20(self):
		result = Interpreter(rng=random.Random(0)).execute_source("-d20")
		self.assertIsInstance(result, RollResult)
		assert isinstance(result, RollResult)
		detail = result.details[0]
		self.assertIsInstance(detail, DieRollDetail)
		assert isinstance(detail, DieRollDetail)

		self.assertEqual(result.total, 13)
		self.assertEqual(detail.dropped, (14,))

	def test_unary_advantage_accepts_explicit_one_d20_spelling(self):
		result = Interpreter(rng=random.Random(0)).execute_source("+1d20")
		self.assertIsInstance(result, RollResult)
		assert isinstance(result, RollResult)
		detail = result.details[0]
		self.assertIsInstance(detail, DieRollDetail)
		assert isinstance(detail, DieRollDetail)

		self.assertEqual(result.total, 14)
		self.assertEqual(detail.dropped, (13,))

	def test_advantage_is_applied_before_following_arithmetic(self):
		result = Interpreter(rng=random.Random(0)).execute_source("+d20 + 5")
		self.assertIsInstance(result, RollResult)
		assert isinstance(result, RollResult)
		detail = result.details[0]
		self.assertIsInstance(detail, DieRollDetail)
		assert isinstance(detail, DieRollDetail)

		self.assertEqual(result.total, 19)
		self.assertEqual(detail.dropped, (13,))
		self.assertEqual(
			result.details[1],
			RollCompositionDetail(operation="+", left=14, right=5, result=19),
		)

	def test_advantage_detail_works_with_following_dice_modifier(self):
		result = Interpreter(rng=random.Random(0)).execute_source("+d20m20")
		self.assertIsInstance(result, RollResult)
		assert isinstance(result, RollResult)
		detail = result.details[0]
		self.assertIsInstance(detail, DieRollDetail)
		assert isinstance(detail, DieRollDetail)

		self.assertEqual(result.total, 20)
		self.assertEqual(detail.dropped, (13,))
		self.assertEqual(detail.clamped, (((14, 20),),))

	def test_advantage_is_not_reapplied_to_a_second_unary_operator(self):
		result = Interpreter(rng=random.Random(0)).execute_source("++d20")
		self.assertIsInstance(result, RollResult)
		assert isinstance(result, RollResult)
		detail = result.details[0]
		self.assertIsInstance(detail, DieRollDetail)
		assert isinstance(detail, DieRollDetail)

		self.assertEqual(result.total, 14)
		self.assertEqual(detail.dropped, (13,))
		self.assertEqual(
			result.details[-1],
			RollCompositionDetail(operation="+", left=14, right=0, result=14),
		)

	def test_unary_signs_remain_ordinary_outside_plain_single_d20(self):
		for source, expected in (
			("+d6", 4),
			("-d6", -4),
			("+2d20", 27),
			("-2d20", -27),
		):
			with self.subTest(source=source):
				result = Interpreter(rng=random.Random(0)).execute_source(source)
				self.assertIsInstance(result, RollResult)
				assert isinstance(result, RollResult)
				self.assertEqual(result.total, expected)

		for source, expected in (("+5", 5), ("-5", -5)):
			with self.subTest(source=source):
				self.assertEqual(Interpreter().execute_source(source), expected)

	def test_grouped_composed_roll_is_not_advantaged(self):
		result = Interpreter(rng=random.Random(0)).execute_source("+(d20 + 5)")
		self.assertIsInstance(result, RollResult)
		assert isinstance(result, RollResult)
		detail = result.details[0]
		self.assertIsInstance(detail, DieRollDetail)
		assert isinstance(detail, DieRollDetail)

		self.assertEqual(result.total, 18)
		self.assertEqual(detail.rolls, (13,))
		self.assertEqual(
			result.details[-1],
			RollCompositionDetail(operation="+", left=18, right=0, result=18),
		)

	def test_arithmetic_shift_bitwise_and_logical_operations(self):
		for source, expected in (
			("1 + 2", 3),
			("1 + 2.0", 3.0),
			("5 - 2", 3),
			("2.0 - 1", 1.0),
			("2 * 3", 6),
			("2 * 3.0", 6.0),
			("5 / 2", 2.5),
			("5 // 2", 2),
			("5 // 2.0", 2.0),
			("5 % 2", 1),
			("5.0 % 2", 1.0),
			("2 ** 3", 8),
			("2 ** 3.0", 8.0),
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

	def test_mixed_numeric_comparisons_and_compound_assignments(self):
		for source, expected in (
			("1 < 2.0", True),
			("1.0 <= 1", True),
			("2 > 1.0", True),
			("2.0 >= 2", True),
			("1 == 1.0", True),
			("1.0 != 2", True),
			("value := 1.0; value += 2; value", 3.0),
			("value := 5.0; value //= 2; value", 2.0),
		):
			with self.subTest(source=source):
				self.assertEqual(Interpreter().execute_source(source), expected)

	def test_mixed_numeric_roll_arithmetic_preserves_float_total_and_details(self):
		result = Interpreter(rng=random.Random(0)).execute_source("1d6 + 0.5")

		self.assertIsInstance(result, RollResult)
		assert isinstance(result, RollResult)
		self.assertEqual(result.total, 4.5)
		self.assertEqual(
			result.details[1],
			RollCompositionDetail(operation="+", left=4, right=0.5, result=4.5),
		)

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

	def test_numeric_rejects_boolean(self):
		interpreter = Interpreter()
		with self.assertRaises(InvalidOperationError):
			interpreter._apply_binary(BinaryOp.ADD, True, 1)

	def test_malformed_operators_are_normalized_to_runtime_errors(self):
		interpreter = Interpreter()
		with self.assertRaises(InvalidOperationError):
			interpreter._apply_binary(cast(BinaryOp, object()), 1, 1)

		unary = Unary(
			type="unary",
			dtype=int,
			operation=cast(Any, object()),
			operand=Int(1),
			operator_loc="before",
		)
		with self.assertRaises(InvalidOperationError):
			interpreter._evaluate(unary, RuntimeEnv())

	def test_dice_rolls_are_seeded_and_record_each_die(self):
		result = Interpreter(rng=random.Random(0)).execute_source("3d6")

		self.assertEqual(
			result,
			RollResult(
				total=9,
				details=(DieRollDetail(6, (4, 4, 1), ((), (), ()), ()),),
			),
		)

	def test_zero_dice_returns_an_empty_roll_result(self):
		result = Interpreter(rng=random.Random(0)).execute_source("0d6")

		self.assertEqual(result, RollResult(total=0, details=()))

	def test_invalid_dice_parameters_raise_invalid_dice_error(self):
		interpreter = Interpreter(rng=random.Random(0))
		for count, sides in (
			(-1, 6),
			(1.5, 6),
			(True, 6),
			(1, 0),
			(1, 6.5),
			(1, False),
		):
			with self.subTest(count=count, sides=sides):
				with self.assertRaises(InvalidDiceError):
					interpreter._apply_binary(BinaryOp.DIE_ROLL, count, sides)

	def test_nested_dice_modifiers_only_apply_to_outer_values(self):
		result = Interpreter(rng=random.Random(0)).execute_source("1d6d20m10")

		self.assertIsInstance(result, RollResult)
		assert isinstance(result, RollResult)
		self.assertEqual(result.total, 51)
		self.assertEqual(len(result.details), 1)
		outer_detail = result.details[0]
		self.assertIsInstance(outer_detail, DieRollDetail)
		assert isinstance(outer_detail, DieRollDetail)
		self.assertEqual(outer_detail.values, (14, 10, 10, 17))
		self.assertEqual(result.total, sum(outer_detail.values))
		self.assertEqual(
			outer_detail.nested,
			(DieRollDetail(6, (4,), ((),), ()),),
		)

	def test_zero_count_outer_dice_isolated_from_nested_modifiers(self):
		result = Interpreter(rng=random.Random(0)).execute_source("(1d1 - 1d1)d20m10")

		self.assertIsInstance(result, RollResult)
		assert isinstance(result, RollResult)
		self.assertEqual(result.total, 0)
		self.assertEqual(len(result.details), 1)
		outer_detail = result.details[0]
		self.assertIsInstance(outer_detail, DieRollDetail)
		assert isinstance(outer_detail, DieRollDetail)
		self.assertEqual(outer_detail.sides, 20)
		self.assertEqual(outer_detail.rolls, ())
		self.assertEqual(outer_detail.values, ())
		self.assertEqual(outer_detail.clamped, ())
		self.assertEqual(
			outer_detail.nested,
			(
				DieRollDetail(1, (1,), ((),), ()),
				DieRollDetail(1, (1,), ((),), ()),
				RollCompositionDetail(operation="-", left=1, right=1, result=0),
			),
		)

	def test_reroll_below_records_each_reroll_sequence(self):
		result = Interpreter(rng=random.Random(0)).execute_source("3d6b3")

		self.assertIsInstance(result, RollResult)
		assert isinstance(result, RollResult)
		self.assertEqual(result.total, 11)
		self.assertEqual(
			result.details[0],
			DieRollDetail(6, (4, 4, 1), ((), (), (3,)), ()),
		)

	def test_reroll_above_records_each_reroll_sequence(self):
		result = Interpreter(rng=random.Random(1)).execute_source("3d6a3")

		self.assertIsInstance(result, RollResult)
		assert isinstance(result, RollResult)
		self.assertEqual(result.total, 6)
		self.assertEqual(
			result.details[0],
			DieRollDetail(6, (2, 5, 1), ((), (3,), ()), ()),
		)

	def test_minimum_and_maximum_retain_clamp_details(self):
		minimum = Interpreter(rng=random.Random(0)).execute_source("3d6m3")
		maximum = Interpreter(rng=random.Random(0)).execute_source("3d6x3")

		self.assertIsInstance(minimum, RollResult)
		self.assertIsInstance(maximum, RollResult)
		assert isinstance(minimum, RollResult)
		assert isinstance(maximum, RollResult)
		self.assertEqual(minimum.total, 11)
		self.assertEqual(maximum.total, 7)
		minimum_detail = minimum.details[0]
		maximum_detail = maximum.details[0]
		self.assertIsInstance(minimum_detail, DieRollDetail)
		self.assertIsInstance(maximum_detail, DieRollDetail)
		assert isinstance(minimum_detail, DieRollDetail)
		assert isinstance(maximum_detail, DieRollDetail)
		self.assertEqual(
			minimum_detail.clamped,
			((), (), ((1, 3),)),
		)
		self.assertEqual(
			maximum_detail.clamped,
			(((4, 3),), ((4, 3),), ()),
		)

	def test_dice_modifiers_chain_and_arithmetic_preserves_details(self):
		chained = Interpreter(rng=random.Random(0)).execute_source("3d6b3m4")
		combined = Interpreter(rng=random.Random(0)).execute_source("1d6 + 5")

		self.assertIsInstance(chained, RollResult)
		self.assertIsInstance(combined, RollResult)
		assert isinstance(chained, RollResult)
		assert isinstance(combined, RollResult)
		chained_detail = chained.details[0]
		self.assertIsInstance(chained_detail, DieRollDetail)
		assert isinstance(chained_detail, DieRollDetail)
		self.assertEqual(chained.total, 12)
		self.assertEqual(
			chained_detail.rerolls,
			((), (), (3,)),
		)
		self.assertEqual(chained_detail.clamped, ((), (), ((3, 4),)))
		self.assertEqual(combined.total, 9)
		self.assertIsInstance(combined.details[0], DieRollDetail)
		self.assertIsInstance(combined.details[1], RollCompositionDetail)

	def test_modifier_chain_accumulates_clamp_history(self):
		result = Interpreter(rng=random.Random(0)).execute_source("3d6m3m4")

		self.assertIsInstance(result, RollResult)
		assert isinstance(result, RollResult)
		detail = result.details[0]
		self.assertIsInstance(detail, DieRollDetail)
		assert isinstance(detail, DieRollDetail)
		self.assertEqual(detail.values, (4, 4, 4))
		self.assertEqual(detail.clamped, ((), (), ((1, 3), (3, 4))))
		self.assertEqual(result.total, sum(detail.values))

	def test_modifier_orderings_keep_canonical_final_die_values(self):
		minimum_then_reroll = Interpreter(rng=random.Random(0)).execute_source(
			"3d6m3b4"
		)
		maximum_then_reroll = Interpreter(rng=random.Random(0)).execute_source(
			"3d6x3a2"
		)

		for result, expected_values, expected_total in (
			(minimum_then_reroll, (4, 4, 5), 13),
			(maximum_then_reroll, (2, 2, 1), 5),
		):
			with self.subTest(expected_total=expected_total):
				self.assertIsInstance(result, RollResult)
				assert isinstance(result, RollResult)
				detail = result.details[0]
				self.assertIsInstance(detail, DieRollDetail)
				assert isinstance(detail, DieRollDetail)
				self.assertEqual(detail.values, expected_values)
				self.assertEqual(result.total, expected_total)
				self.assertEqual(sum(detail.values), result.total)

	def test_reroll_after_clamp_preserves_both_detail_fields(self):
		result = Interpreter(rng=random.Random(0)).execute_source("3d6m3b3")

		self.assertIsInstance(result, RollResult)
		assert isinstance(result, RollResult)
		detail = result.details[0]
		self.assertIsInstance(detail, DieRollDetail)
		assert isinstance(detail, DieRollDetail)
		self.assertEqual(detail.rerolls, ((), (), ()))
		self.assertEqual(detail.clamped, ((), (), ((1, 3),)))

	def test_roll_detail_snapshots_nested_clamp_pairs(self):
		clamp_pair = [1, 3]
		clamped = [clamp_pair, None]
		detail = DieRollDetail(
			sides=6,
			rolls=(1, 4),
			rerolls=((), ()),
			dropped=(),
			clamped=clamped,
		)

		clamp_pair[1] = 99
		clamped.clear()

		self.assertEqual(detail.clamped, (((1, 3),), ()))

	def test_roll_detail_format_includes_rolls_rerolls_and_clamps(self):
		result = Interpreter(rng=random.Random(0)).execute_source("3d6b3m4 + 2")

		self.assertIsInstance(result, RollResult)
		assert isinstance(result, RollResult)
		self.assertEqual(
			result.format(),
			"total=14 details=[d6 rolls=(4, 4, 1) rerolls=((), (), (3,)) "
			"values=(4, 4, 4) dropped=() clamped=((), (), ((3, 4),)); "
			"(12 + 2 = 14)]",
		)

	def test_reroll_execution_limit_stops_an_infinite_reroll(self):
		with self.assertRaises(ExecutionLimitError):
			Interpreter(rng=random.Random(0), max_steps=7).execute_source("1d6b7")

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
			"total=15 details=[d20 rolls=(7, 13) rerolls=((2, 8), ()) "
			"values=(8, 13) dropped=(13,)]",
		)
		with self.assertRaises(AttributeError):
			setattr(result, "total", 16)

	def test_roll_detail_constructors_snapshot_mutable_iterables(self):
		rolls = [7, 13]
		rerolls = [[2, 8], []]
		dropped = [13]
		values = [7, 13]
		details = []
		detail = DieRollDetail(
			sides=20,
			rolls=rolls,
			rerolls=rerolls,
			dropped=dropped,
			values=values,
		)
		details.append(detail)
		result = RollResult(total=15, details=details)

		rolls.append(1)
		rerolls[0].append(19)
		rerolls.append([4])
		dropped.clear()
		values.append(1)
		details.clear()

		self.assertEqual(detail.rolls, (7, 13))
		self.assertEqual(detail.rerolls, ((2, 8), ()))
		self.assertEqual(detail.dropped, (13,))
		self.assertEqual(detail.values, (7, 13))
		self.assertEqual(result.details, (detail,))

	def test_roll_detail_rejects_inconsistent_explicit_values(self):
		with self.assertRaisesRegex(ValueError, "one value per tracked die"):
			DieRollDetail(
				sides=20,
				rolls=(7, 13),
				rerolls=((), ()),
				dropped=(),
				values=(7,),
			)

		with self.assertRaisesRegex(TypeError, "values must contain integers"):
			DieRollDetail(
				sides=20,
				rolls=(7,),
				rerolls=((),),
				dropped=(),
				values=(7.5,),
			)

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
			"total=12 details=[d20 rolls=(7,) rerolls=() values=(7,) dropped=(); "
			"(7 + 5 = 12)]",
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

	def test_if_and_ternary_evaluate_only_the_selected_branch(self):
		self.assertEqual(
			Interpreter().execute_source(
				"if true { yield 1; } else { yield 1 << -1; }"
			),
			1,
		)
		self.assertEqual(
			Interpreter().execute_source("1 if true else 1 << -1"),
			1,
		)

	def test_value_blocks_capture_direct_yield_and_keep_child_scope(self):
		self.assertEqual(
			Interpreter().execute_source(
				"outer := 1; { outer := 2; yield outer; }; outer"
			),
			1,
		)
		self.assertEqual(Interpreter().execute_source("{ yield 7; }"), 7)

	def test_ranges_are_half_open_and_support_integer_and_float_steps(self):
		interpreter = Interpreter()
		self.assertEqual(interpreter.execute_source("1:5"), [1, 2, 3, 4])
		self.assertEqual(interpreter.execute_source("5:0:-2"), [5, 3, 1])
		self.assertEqual(
			interpreter.execute_source("0.0:1.0:0.1"),
			[0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
		)
		self.assertEqual(
			interpreter.execute_source("0.0:-1.0:-0.1"),
			[0.0, -0.1, -0.2, -0.3, -0.4, -0.5, -0.6, -0.7, -0.8, -0.9],
		)
		self.assertEqual(
			interpreter.execute_source("0.1:0.3:0.09999999999999999"),
			[0.1, 0.19999999999999998],
		)

	def test_mixed_huge_integer_float_range_errors_are_normalized(self):
		with self.assertRaises(InvalidOperationError):
			Interpreter().execute_source(
				"start := 10 ** 400; stop := start + 1; start:stop:0.1"
			)

	def test_range_zero_step_is_checked_at_runtime_and_ticks_items(self):
		with self.assertRaises(InvalidOperationError):
			Interpreter().execute_source("step := 0; 0:3:step")
		with self.assertRaises(ExecutionLimitError):
			Interpreter(max_steps=4).execute_source("0:10")

	def test_index_and_omitted_slices_use_runtime_list_semantics(self):
		interpreter = Interpreter()
		self.assertEqual(
			interpreter.execute_source("values := [0, 1, 2, 3, 4]; values[2];"),
			2,
		)
		self.assertEqual(
			interpreter.execute_source("values := [0, 1, 2, 3, 4]; values[1:];"),
			[1, 2, 3, 4],
		)
		self.assertEqual(
			interpreter.execute_source("values := [0, 1, 2, 3, 4]; values[:4:2];"),
			[0, 2],
		)
		with self.assertRaises(InvalidOperationError):
			interpreter.execute_source("values := [1]; values[2]")
		with self.assertRaises(InvalidOperationError):
			interpreter.execute_source("step := 0; [1][::step]")

		invalid_array = Index(
			type="index",
			dtype=int,
			array=Int(1),
			index=Int(0),
		)
		with self.assertRaises(InvalidOperationError):
			interpreter.execute([invalid_array])

	def test_comprehensions_scope_targets_and_tick_each_iteration(self):
		self.assertEqual(
			Interpreter().execute_source("[item * 2 for item in 1:4]"), [2, 4, 6]
		)
		with self.assertRaises(ExecutionLimitError):
			Interpreter(max_steps=4).execute_source("[item for item in 0:10]")
		with self.assertRaises(NameError):
			Parser(Tokenizer("[item for item in [1]]; item").tokenize()).parse_program()

	def test_ordinary_and_collecting_for_and_while_loops(self):
		self.assertEqual(
			Interpreter().execute_source(
				"total := 0; for item in [1, 2, 3] { total += item; }; total"
			),
			6,
		)
		self.assertEqual(
			Interpreter().execute_source("for item in 1:4 { yield item * 2; }"),
			[2, 4, 6],
		)
		self.assertEqual(
			Interpreter().execute_source(
				"index := 0; while index < 3 { index += 1; yield index; }"
			),
			[1, 2, 3],
		)

	def test_nested_collections_have_independent_buffers(self):
		self.assertEqual(
			Interpreter().execute_source(
				"for outer in [1, 2] { yield for inner in [3, 4] { yield inner; }; }"
			),
			[[3, 4], [3, 4]],
		)

	def test_break_and_continue_conditions_fall_through_or_signal(self):
		self.assertEqual(
			Interpreter().execute_source(
				"for item in [1, 2, 3] { continue if item == 2; yield item; }"
			),
			[1, 3],
		)
		self.assertEqual(
			Interpreter().execute_source(
				"for item in [1, 2, 3] { break if item == 2; yield item; }"
			),
			[1],
		)

	def test_control_signals_escaping_their_context_are_runtime_errors(self):
		for expression in (
			Break(type="break"),
			Continue(type="continue"),
			Yield(type="yield", dtype=int, expression=Int(1)),
		):
			with (
				self.subTest(expression=type(expression).__name__),
				self.assertRaises(InvalidOperationError),
			):
				Interpreter().execute([expression])

	def test_loop_targets_are_scoped_to_each_iteration(self):
		self.assertEqual(
			Interpreter().execute_source(
				"item := 9; for item in [1, 2] { item; }; item"
			),
			9,
		)

	def test_runtime_index_type_and_condition_validation(self):
		interpreter = Interpreter()
		environment = RuntimeEnv()
		environment.declare("values", [1])
		environment.declare("index", 1.5)
		index = Index(
			type="index",
			dtype=int,
			array=Identifier(type="identifier", dtype=ArrayType(int), label="values"),
			index=Identifier(type="identifier", dtype=int, label="index"),
		)
		with self.assertRaises(InvalidOperationError):
			interpreter._evaluate(index, environment)


if __name__ == "__main__":
	unittest.main()
