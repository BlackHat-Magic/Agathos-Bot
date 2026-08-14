import signal
import unittest
from typing import cast


from language.expressions import (
	Array,
	Binary,
	BinaryOp,
	Block,
	Break,
	Comprehension,
	Continue,
	ArrayType,
	For,
	Function,
	FlowSummary,
	If,
	Identifier,
	Int,
	Float,
	Index,
	Call,
	Range,
	Return,
	Slice,
	Unary,
	UnaryOp,
	While,
	Yield,
)
from language.lexer import Tokenizer
from language.parser import Parser, _LoopContext
from language.tokens import (
	BoolToken,
	IdentifierToken,
	NumberToken,
	SimpleToken,
	StringToken,
	Token,
	TokenType,
)


def tokenize(source: str) -> list[Token]:
	def timeout_handler(_signum, _frame):
		raise AssertionError("tokenization timed out")

	tokenizer = Tokenizer(source)
	previous_handler = signal.getsignal(signal.SIGALRM)
	previous_timer = signal.getitimer(signal.ITIMER_REAL)
	signal.signal(signal.SIGALRM, timeout_handler)
	signal.setitimer(signal.ITIMER_REAL, 1)
	try:
		tokens = tokenizer.tokenize()
		if len(tokens) > 1000:
			raise AssertionError("tokenization exceeded 1000 tokens")
		return tokens
	finally:
		signal.setitimer(signal.ITIMER_REAL, *previous_timer)
		signal.signal(signal.SIGALRM, previous_handler)


class LanguageTests(unittest.TestCase):
	def test_program_parses_declaration_and_assignment(self):
		expressions = Parser(tokenize("value := 1; value = 2")).parse_program()

		self.assertEqual(len(expressions), 2)
		self.assertEqual(cast(Binary, expressions[0]).right.dtype, int)
		self.assertEqual(cast(Binary, expressions[1]).right.dtype, int)

	def test_parser_does_not_mutate_input_tokens(self):
		tokens = tokenize("value := 1; value = 2")
		original_tokens = tokens.copy()

		Parser(tokens).parse_program()

		self.assertEqual(tokens, original_tokens)

	def test_parser_rejects_tokens_after_eof(self):
		tokens: list[Token] = [
			NumberToken(type="literal_number", literal="1"),
			SimpleToken(type=TokenType.EOF),
			NumberToken(type="literal_number", literal="2"),
		]

		with self.assertRaises(SyntaxError):
			Parser(tokens).parse_program()

	def test_eof_spelling_is_an_identifier(self):
		tokens = tokenize("EOF")

		self.assertIsInstance(tokens[0], IdentifierToken)
		self.assertEqual(cast(IdentifierToken, tokens[0]).label, "EOF")
		self.assertEqual(tokens[1], SimpleToken(type=TokenType.EOF))

	def test_eof_spelling_does_not_hide_following_input(self):
		with self.assertRaises(NameError):
			Parser(tokenize("EOF 1")).parse_program()

	def test_expected_type_entry_allows_declaration_target(self):
		expression = Parser(tokenize("value := 1"))._parse_expression(int)

		self.assertEqual(cast(Binary, expression).dtype, int)
		with self.assertRaises(TypeError):
			Parser(tokenize("value := true"))._parse_expression(int)

	def test_scalar_type_annotations_are_preserved_in_scope(self):
		for source, expected in (
			('value: str = "value"', str),
			("value: float = 1.0", float),
			("value: int = 1", int),
			("value: bool = true", bool),
			("value: null = null", None),
		):
			with self.subTest(source=source):
				parser = Parser(tokenize(source))
				expression = cast(Binary, parser.parse_program()[0])
				self.assertEqual(expression.dtype, expected)
				self.assertEqual(parser._lookup_type("value"), expected)

	def test_nested_array_type_annotations_are_preserved(self):
		parser = Parser(tokenize("values: array[array[int]] = [[1], [2, 3]]"))
		expression = cast(Binary, parser.parse_program()[0])

		expected = ArrayType(member_type=ArrayType(member_type=int))
		self.assertEqual(expression.dtype, expected)
		self.assertEqual(parser._lookup_type("values"), expected)

	def test_invalid_type_annotations_are_rejected(self):
		for source in (
			"value: unknown = 1",
			"value: array[int = []",
			"value: array[] = []",
		):
			with self.subTest(source=source), self.assertRaises(SyntaxError):
				Parser(tokenize(source)).parse_program()

	def test_empty_array_literals_require_typed_array_context(self):
		parser = Parser(tokenize("values: array[array[int]] = []"))
		expression = cast(Binary, parser.parse_program()[0])
		right = cast(Array, expression.right)

		self.assertEqual(right.dtype, ArrayType(member_type=ArrayType(member_type=int)))
		self.assertEqual(right.value, [])

		with self.assertRaises(TypeError):
			Parser(tokenize("[]")).parse_program()

	def test_expected_nested_array_member_types_apply_to_every_element(self):
		expected = ArrayType(member_type=ArrayType(member_type=int))
		for source in (
			"values: array[array[int]] = [[]]",
			"values: array[array[int]] = [[], []]",
		):
			with self.subTest(source=source):
				expression = cast(Binary, Parser(tokenize(source)).parse_program()[0])
				array = cast(Array, expression.right)

				self.assertEqual(array.dtype, expected)
				self.assertTrue(
					all(
						element.dtype == ArrayType(member_type=int)
						for element in array.value
					)
				)

		for source in (
			"values: array[array[int]] = [[1], [true]]",
			"values: array[array[int]] = [[], [true]]",
		):
			with self.subTest(source=source), self.assertRaises(TypeError):
				Parser(tokenize(source)).parse_program()

	def test_expected_array_types_propagate_through_value_blocks_and_parentheses(self):
		array_type = ArrayType(member_type=int)
		nested_type = ArrayType(member_type=array_type)
		for source, expected in (
			(
				"value: array[int] = if true { yield []; } else { yield []; }",
				array_type,
			),
			(
				"value: array[array[int]] = if true { yield [[]]; } "
				"else { yield [[], []]; }",
				nested_type,
			),
			(
				"value: array[int] = if true { ({ yield []; }) } "
				"else { ({ yield []; }) }",
				array_type,
			),
			("value: array[int] = ([])", array_type),
			(
				"value: array[int] = (if true { yield []; } else { yield []; })",
				array_type,
			),
			("value: array[int] = ({ yield []; })", array_type),
			("value: array[int] = (([]))", array_type),
			(
				"value: array[int] = (((if true { yield []; } else { yield []; })))",
				array_type,
			),
			("value: array[int] = (({ yield []; }))", array_type),
		):
			with self.subTest(source=source):
				expression = cast(Binary, Parser(tokenize(source)).parse_program()[0])
				self.assertEqual(expression.dtype, expected)

	def test_parenthesized_expressions_parse_before_expected_type_validation(self):
		expression = cast(
			Binary,
			Parser(tokenize("value: int = (1) + 2")).parse_program()[0],
		)

		self.assertEqual(expression.dtype, int)
		self.assertEqual(cast(Binary, expression.right).dtype, int)

	def test_value_blocks_can_participate_in_binary_expressions(self):
		expression = cast(
			Binary,
			Parser(tokenize("value: int = { yield 1; } + 2")).parse_program()[0],
		)
		composition = cast(Binary, expression.right)

		self.assertEqual(expression.dtype, int)
		self.assertIsInstance(composition.left, Block)

	def test_expected_array_types_propagate_through_direct_blocks(self):
		for source, expected in (
			("value: array[int] = { yield []; }", ArrayType(member_type=int)),
			(
				"value: array[array[int]] = { { yield [[]]; } }",
				ArrayType(member_type=ArrayType(member_type=int)),
			),
		):
			with self.subTest(source=source):
				expression = cast(Binary, Parser(tokenize(source)).parse_program()[0])
				self.assertEqual(expression.dtype, expected)

		with self.assertRaises(TypeError):
			Parser(tokenize("value: array[int] = { 1; }")).parse_program()

	def test_expected_block_types_do_not_constrain_statement_only_ifs(self):
		source = "value: int = if true { if false { 1; } yield 1; } else { yield 1; }"
		expression = cast(Binary, Parser(tokenize(source)).parse_program()[0])

		self.assertEqual(expression.dtype, int)

		nested_block = Parser(
			tokenize("value: int = { { 1.0; } yield 1; }")
		).parse_program()[0]
		self.assertEqual(cast(Binary, nested_block).dtype, int)

	def test_failed_postfix_chains_restore_nested_declarations(self):
		for source, label in (
			(
				"values := [1, 2]; values[index := 0][true]",
				"index",
			),
			(
				"values := [1, 2]; values[1:stop := true]",
				"stop",
			),
		):
			with self.subTest(source=source):
				parser = Parser(tokenize(source))
				with self.assertRaises(TypeError):
					parser.parse_program()
				self.assertFalse(parser._is_declared(label))
				self.assertEqual(
					parser.scopes, [{"values": ArrayType(member_type=int)}]
				)

	def test_array_literals_reject_heterogeneous_values(self):
		for source in ("[1, true]", "values: array[int] = [1, true]"):
			with self.subTest(source=source), self.assertRaises(TypeError):
				Parser(tokenize(source)).parse_program()

	def test_indexing_and_slicing_validate_array_and_integer_types(self):
		with self.assertRaises(TypeError):
			Parser(tokenize("1[0]")).parse_program()
		with self.assertRaises(TypeError):
			Parser(tokenize("1[:]")).parse_program()

		for source in (
			"values := [1, 2]; values[true]",
			"values := [1, 2]; values[1.0]",
			"values := [1, 2]; values[true:]",
			"values := [1, 2]; values[:1.0]",
			"values := [1, 2]; values[::true]",
		):
			with self.subTest(source=source), self.assertRaises(TypeError):
				Parser(tokenize(source)).parse_program()

	def test_chained_indexing_and_slicing_preserve_types(self):
		expressions = Parser(
			tokenize(
				"values := [[1, 2], [3, 4]]; values[0][1]; values[1:][0]; values[0][1:]"
			)
		).parse_program()

		self.assertIsInstance(expressions[1], Index)
		self.assertEqual(expressions[1].dtype, int)
		self.assertIsInstance(expressions[2], Index)
		self.assertEqual(expressions[2].dtype, ArrayType(member_type=int))
		self.assertIsInstance(expressions[3], Slice)
		self.assertEqual(expressions[3].dtype, ArrayType(member_type=int))

	def test_all_slice_forms_have_optional_integer_components(self):
		expressions = Parser(
			tokenize(
				"values := [1, 2, 3, 4, 5]; values[1:]; values[:5]; "
				"values[::2]; values[1:5:2]; values[:]"
			)
		).parse_program()
		slices = [cast(Slice, expression) for expression in expressions[1:]]

		self.assertEqual(
			(slices[0].start, slices[0].stop, slices[0].step), (Int(1), None, None)
		)
		self.assertEqual(
			(slices[1].start, slices[1].stop, slices[1].step), (None, Int(5), None)
		)
		self.assertEqual(
			(slices[2].start, slices[2].stop, slices[2].step), (None, None, Int(2))
		)
		self.assertEqual(
			(slices[3].start, slices[3].stop, slices[3].step),
			(Int(1), Int(5), Int(2)),
		)
		self.assertEqual(
			(slices[4].start, slices[4].stop, slices[4].step), (None, None, None)
		)
		for slice_expression in slices:
			self.assertEqual(slice_expression.dtype, ArrayType(member_type=int))

	def test_array_returning_calls_can_be_indexed(self):
		expressions = Parser(
			tokenize("values :: array[int] () { return [1, 2]; }; values()[0]")
		).parse_program()

		self.assertEqual(cast(Index, expressions[-1]).dtype, int)

	def test_program_allows_missing_final_semicolon(self):
		expressions = Parser(tokenize("value := 1")).parse_program()

		self.assertEqual(len(expressions), 1)

	def test_program_allows_final_semicolon(self):
		self.assertEqual(len(Parser(tokenize("value := 1;")).parse_program()), 1)
		self.assertEqual(
			len(Parser(tokenize("value := 1; value = 2;")).parse_program()), 2
		)

	def test_program_rejects_missing_separator(self):
		with self.assertRaises(SyntaxError):
			Parser(tokenize("1 2")).parse_program()

	def test_null_bindings_only_accept_null_assignments(self):
		for source in (
			"value := null; value = 1",
			"value: null = null; value = 1",
		):
			with self.subTest(source=source), self.assertRaises(TypeError):
				Parser(tokenize(source)).parse_program()

		self.assertEqual(
			len(Parser(tokenize("value := null; value = null")).parse_program()), 2
		)
		self.assertIsNone(Parser(tokenize("null"))._parse_expression(None).dtype)

	def test_unresolved_identifier_reads_are_rejected(self):
		for source in (
			"unknown",
			"value := unknown",
			"1 + unknown",
			"if unknown == unknown {}",
			"value: bool = unknown == unknown",
		):
			with self.subTest(source=source), self.assertRaises(NameError):
				Parser(tokenize(source)).parse_program()

	def test_nested_declaration_rolls_back_on_initializer_failure(self):
		parser = Parser(tokenize("value: int = (y := true)"))

		with self.assertRaises(TypeError):
			parser.parse_program()
		self.assertEqual(parser.scopes, [{}])

	def test_nested_declaration_is_kept_on_successful_initializer(self):
		parser = Parser(tokenize("value := (y := true)"))

		parser.parse_program()
		self.assertEqual(parser._lookup_type("value"), bool)
		self.assertEqual(parser._lookup_type("y"), bool)

	def test_top_level_failure_restores_nested_declarations(self):
		parser = Parser(tokenize("kept := true; if (leaked := true) { unknown; }"))

		with self.assertRaises(NameError):
			parser.parse_program()
		self.assertEqual(parser.scopes, [{"kept": bool}])
		self.assertFalse(parser._is_declared("leaked"))

	def test_missing_delimiters_raise_syntax_error(self):
		for source in ("[1", "(1", "value: int 1"):
			with self.subTest(source=source), self.assertRaises(SyntaxError):
				Parser(tokenize(source)).parse_program()

	def test_failed_declaration_initializer_does_not_update_scope(self):
		parser = Parser(tokenize("value: int = true"))

		with self.assertRaises(TypeError):
			parser.parse_program()
		self.assertEqual(parser.scopes, [{}])

	def test_block_allows_final_semicolon(self):
		expressions = Parser(tokenize("{ value := 1; }")).parse_program()

		self.assertEqual(len(expressions), 1)
		self.assertIsInstance(expressions[0], Block)

	def test_block_shadowing_does_not_change_outer_assignment(self):
		expressions = Parser(
			tokenize("value := 1; { value := 2.0; value = 3.0 }; value = 4")
		).parse_program()

		inner_block = cast(Block, expressions[1])
		self.assertEqual(cast(Binary, inner_block.body[0]).right.dtype, float)
		self.assertEqual(cast(Binary, inner_block.body[1]).right.dtype, float)
		last_expression = cast(Binary, expressions[-1])
		self.assertEqual(last_expression.left.dtype, int)
		self.assertEqual(last_expression.right.dtype, int)

	def test_for_target_redeclaration_in_body_fails(self):
		with self.assertRaises(SyntaxError):
			Parser(tokenize("for item in [1] { item := 2 }")).parse_program()

	def test_block_scope_is_cleaned_up_after_parse_error(self):
		parser = Parser(tokenize("{ value := 1"))

		with self.assertRaises(SyntaxError):
			parser.parse_program()
		self.assertEqual(parser.scopes, [{}])

	def test_for_target_is_visible_in_body_but_does_not_leak(self):
		expressions = Parser(tokenize("for item in [1] { item }")).parse_program()
		loop = cast(For, expressions[0])
		body_identifier = loop.body.body[0]
		self.assertEqual(body_identifier.dtype, int)

		with self.assertRaises(NameError):
			Parser(tokenize("for item in [1] { item }; item = 2")).parse_program()

	def test_yield_token_and_ast_model_wiring_only(self):
		tokens = tokenize("yield")
		self.assertEqual(tokens[0].type, TokenType.YIELD)

		yield_node = Yield(type="yield", dtype=int, expression=Int(1))
		self.assertEqual(yield_node.type, "yield")
		self.assertEqual(yield_node.dtype, int)
		self.assertEqual(yield_node.expression, Int(1))

	def test_new_ast_nodes_are_frozen_and_expose_their_fields(self):
		array_type = ArrayType(member_type=int)
		start = Int(0)
		stop = Int(10)
		step = Int(2)
		array = Identifier(type="identifier", dtype=array_type, label="values")
		target = Identifier(type="identifier", dtype=int, label="item")

		range_node = Range(
			type="range",
			dtype=array_type,
			start=start,
			stop=stop,
			step=step,
		)
		slice_node = Slice(
			type="slice",
			dtype=array_type,
			array=array,
			start=start,
			stop=stop,
			step=step,
		)
		comprehension = Comprehension(
			type="comprehension",
			dtype=array_type,
			expression=target,
			target=target,
			iterable=array,
		)
		break_node = Break(type="break", condition=Int(1))
		continue_node = Continue(type="continue", condition=Int(1))

		self.assertEqual(range_node.stop, stop)
		self.assertEqual(slice_node.array, array)
		self.assertEqual(comprehension.target, target)
		self.assertIsNone(break_node.dtype)
		self.assertIsNone(continue_node.dtype)
		with self.assertRaises(AttributeError):
			setattr(range_node, "start", Int(1))

	def test_slice_and_loop_control_nodes_allow_omitted_parts(self):
		array_type = ArrayType(member_type=int)
		array = Identifier(type="identifier", dtype=array_type, label="values")
		slice_node = Slice(type="slice", dtype=array_type, array=array)
		break_node = Break(type="break")
		continue_node = Continue(type="continue")

		self.assertIsNone(slice_node.start)
		self.assertIsNone(slice_node.stop)
		self.assertIsNone(slice_node.step)
		self.assertIsNone(break_node.condition)
		self.assertIsNone(continue_node.condition)

	def test_flow_summary_and_return_without_expression(self):
		flow = FlowSummary(
			can_fall_through=False,
			return_types=(int, None),
			yield_types=(int,),
			breaks=True,
			continues=False,
		)
		return_node = Return(type="return", dtype=None)

		self.assertFalse(flow.can_fall_through)
		self.assertEqual(flow.return_types, (int, None))
		self.assertEqual(flow.yield_types, (int,))
		self.assertTrue(flow.breaks)
		self.assertFalse(flow.continues)
		self.assertIsNone(return_node.expression)
		with self.assertRaises(AttributeError):
			setattr(flow, "breaks", False)

	def test_parser_flow_scaffolding(self):
		parser = Parser([])
		self.assertEqual(parser._function_returns, [])
		self.assertEqual(parser._loop_contexts, [])
		self.assertEqual(parser._comprehension_depth, 0)
		self.assertIsNone(parser._nearest_loop_context())

		loop_context = _LoopContext()
		parser._loop_contexts.append(loop_context)
		self.assertIs(parser._nearest_loop_context(), loop_context)
		parser._record_loop_yield_type(int)
		self.assertEqual(loop_context.yield_types, [int])

		first = parser._make_flow_summary(return_types=(int,), breaks=True)
		second = parser._make_flow_summary(
			can_fall_through=False, yield_types=(float,), continues=True
		)
		combined = parser._combine_flow_summaries(first, second)
		self.assertFalse(combined.can_fall_through)
		self.assertEqual(combined.return_types, (int,))
		self.assertEqual(combined.yield_types, (float,))
		self.assertTrue(combined.breaks)
		self.assertTrue(combined.continues)

	def test_yielded_block_has_yield_type(self):
		block = cast(Block, Parser(tokenize("{ yield 1; }")).parse_program()[0])

		self.assertEqual(block.dtype, int)
		self.assertTrue(block.has_value)
		self.assertIsInstance(block.body[0], Yield)

	def test_matching_yields_have_block_type(self):
		block = cast(
			Block,
			Parser(tokenize("{ yield 1; yield 2; }")).parse_program()[0],
		)

		self.assertEqual(block.dtype, int)
		self.assertTrue(block.has_value)

	def test_yield_null_is_distinct_from_no_value(self):
		null_block = cast(Block, Parser(tokenize("{ yield null; }")).parse_program()[0])
		statement_block = cast(Block, Parser(tokenize("{ 1; }")).parse_program()[0])

		self.assertIsNone(null_block.dtype)
		self.assertTrue(null_block.has_value)
		self.assertIsNone(statement_block.dtype)
		self.assertFalse(statement_block.has_value)

	def test_return_only_block_has_no_value(self):
		function = cast(
			Function,
			Parser(tokenize("returns :: int () { return 1; }")).parse_program()[0],
		)
		block = function.body

		self.assertIsNone(block.dtype)
		self.assertFalse(block.has_value)

	def test_return_rejects_statement_only_operands(self):
		for source in ("return if true {}", "return while true {}"):
			with self.subTest(source=source), self.assertRaises(TypeError):
				Parser(tokenize("returns :: int () {" + source + ";}")).parse_program()

		function = cast(
			Function,
			Parser(tokenize("returns :: null () { return null; }")).parse_program()[0],
		)
		block = function.body
		self.assertIsInstance(block.body[0], Return)

	def test_return_accepts_value_producing_if_expression(self):
		function = cast(
			Function,
			Parser(
				tokenize(
					"f :: int () { return if true { yield 1; } else { yield 2; }; }"
				)
			).parse_program()[0],
		)
		return_node = cast(Return, function.body.body[0])

		self.assertEqual(return_node.dtype, int)
		self.assertIsInstance(return_node.expression, If)

		parenthesized = cast(
			Function,
			Parser(
				tokenize(
					"g :: int () { return (if true { yield 1; } else { yield 2; }); }"
				)
			).parse_program()[0],
		)
		parenthesized_return = cast(Return, parenthesized.body.body[0])
		self.assertEqual(parenthesized_return.dtype, int)
		self.assertIsInstance(parenthesized_return.expression, If)

		nested_empty = cast(
			Function,
			Parser(tokenize("h :: array[int] () { return (([])); }")).parse_program()[
				0
			],
		)
		nested_return = cast(Return, nested_empty.body.body[0])
		self.assertEqual(nested_return.dtype, ArrayType(member_type=int))

	def test_named_function_declarations_retain_signature_and_name(self):
		for source, expected_return in (
			("value :: int (parameter: int) { return parameter; }", int),
			("implicit :: (parameter: int) { return; }", None),
			("explicit :: null () { return null; }", None),
		):
			with self.subTest(source=source):
				function = cast(Function, Parser(tokenize(source)).parse_program()[0])
				self.assertEqual(function.name, source.split(" ::", 1)[0])
				self.assertEqual(function.dtype.returns, expected_return)
				self.assertEqual(
					[
						(parameter.label, parameter.dtype)
						for parameter in function.dtype.parameters
					],
					[("parameter", int)] if "parameter: int" in source else [],
				)

	def test_recursive_calls_see_provisional_function_signature(self):
		function = cast(
			Function,
			Parser(
				tokenize(
					"factorial :: int (n: int) { "
					"if n == 0 { return 1; } "
					"else { return n * factorial(n - 1); } }"
				)
			).parse_program()[0],
		)
		branch = cast(If, function.body.body[0])
		else_branch = cast(Block, branch.else_branch)
		call_expression = cast(Return, else_branch.body[0]).expression
		self.assertIsInstance(call_expression, Binary)
		call = cast(Call, cast(Binary, call_expression).right)
		self.assertEqual(call.dtype, int)

	def test_function_parameters_are_scoped_to_the_function(self):
		parser = Parser(tokenize("identity :: int (value: int) { return value; }"))
		function = cast(Function, parser.parse_program()[0])
		return_node = cast(Return, function.body.body[0])

		self.assertEqual(cast(Identifier, return_node.expression).dtype, int)
		self.assertFalse(parser._is_declared("value"))
		self.assertIn("identity", parser.scopes[0])
		self.assertNotIn("value", parser.scopes[0])

	def test_duplicate_function_parameters_are_rejected(self):
		with self.assertRaises(SyntaxError):
			Parser(
				tokenize(
					"duplicate :: int (parameter: int, parameter: int) { return parameter; }"
				)
			).parse_program()

	def test_function_calls_check_arity_and_argument_types(self):
		for source, expected_error in (
			(
				"identity :: int (value: int) { return value; }; identity()",
				TypeError,
			),
			(
				"identity :: int (value: int) { return value; }; identity(1, 2)",
				TypeError,
			),
			(
				"identity :: int (value: int) { return value; }; identity(true)",
				TypeError,
			),
		):
			with self.subTest(source=source), self.assertRaises(expected_error):
				Parser(tokenize(source)).parse_program()

		declaration = cast(
			Binary,
			Parser(
				tokenize(
					"identity :: int (value: int) { return value; }; result := identity(1)"
				)
			).parse_program()[1],
		)
		call = cast(Call, declaration.right)
		self.assertEqual(call.dtype, int)

	def test_function_calls_reject_non_function_expressions(self):
		with self.assertRaises(TypeError):
			Parser(tokenize("value := 1; value()")).parse_program()

	def test_function_calls_honor_expected_return_types(self):
		with self.assertRaises(TypeError):
			Parser(
				tokenize("value :: int () { return 1; }; result: float = value()")
			).parse_program()

	def test_no_value_function_calls_are_rejected_as_arguments(self):
		with self.assertRaises(TypeError):
			Parser(
				tokenize(
					"notify :: () {}; consume :: int (value: int) { return value; }; "
					"consume(notify())"
				)
			).parse_program()

	def test_failed_call_arguments_roll_back_nested_declarations(self):
		parser = Parser(
			tokenize(
				"consume :: int (first: int, second: int) { return first; }; "
				"consume(value := 1, true)"
			)
		)

		with self.assertRaises(TypeError):
			parser.parse_program()
		self.assertFalse(parser._is_declared("value"))
		self.assertEqual(len(parser.scopes), 1)

	def test_no_value_calls_are_statement_only(self):
		expressions = Parser(tokenize("notify :: () {}; notify()")).parse_program()
		self.assertIsInstance(expressions[1], Call)
		self.assertIsNone(cast(Call, expressions[1]).dtype)

		with self.assertRaises(TypeError):
			Parser(tokenize("notify :: () {}; result := notify()")).parse_program()

	def test_no_value_calls_cannot_participate_in_equality(self):
		for operator in ("==", "!="):
			with self.subTest(operator=operator), self.assertRaises(TypeError):
				Parser(
					tokenize(f"notify :: () {{}}; notify() {operator} null")
				).parse_program()

		self.assertEqual(
			Parser(tokenize("null == null")).parse_program()[0].dtype,
			bool,
		)

	def test_matching_and_mismatching_function_returns(self):
		Parser(
			tokenize("choose :: int () { if true { return 1; } else { return 2; } }")
		).parse_program()

		for source in (
			"wrong :: int () { return 1.0; }",
			"wrong :: int () { return null; }",
			"wrong :: () { return 1; }",
		):
			with self.subTest(source=source), self.assertRaises(TypeError):
				Parser(tokenize(source)).parse_program()

	def test_return_and_return_null_have_the_same_no_value_representation(self):
		returns = Parser(
			tokenize("first :: null () { return; }; second :: null () { return null; }")
		).parse_program()
		first = cast(Function, returns[0]).body.body[0]
		second = cast(Function, returns[1]).body.body[0]

		self.assertEqual(first, second)
		self.assertIsNone(cast(Return, first).expression)

		parenthesized = cast(
			Function,
			Parser(tokenize("third :: null () { return (null); }")).parse_program()[0],
		).body.body[0]
		self.assertEqual(parenthesized, first)

	def test_return_is_rejected_outside_functions(self):
		for source in ("return;", "return null;"):
			with self.subTest(source=source), self.assertRaises(SyntaxError):
				Parser(tokenize(source)).parse_program()

	def test_value_functions_cannot_fall_through_but_no_value_functions_can(self):
		for source in (
			"missing :: int () {}",
			"partial :: int () { if true { return 1; } }",
			"looped :: int () { while true { return 1; } }",
		):
			with self.subTest(source=source), self.assertRaises(TypeError):
				Parser(tokenize(source)).parse_program()

		for source in ("implicit :: () {}", "explicit :: null () { 1; }"):
			with self.subTest(source=source):
				Parser(tokenize(source)).parse_program()

	def test_failed_function_bodies_roll_back_signatures_and_scopes(self):
		for source, error in (
			("typed :: int () { return true; }", TypeError),
			("falling :: int () {}", TypeError),
		):
			with self.subTest(source=source), self.assertRaises(error):
				parser = Parser(tokenize(source))
				try:
					parser.parse_program()
				finally:
					self.assertEqual(parser.scopes, [{}])

	def test_anonymous_functions_and_forward_references_are_rejected(self):
		with self.assertRaises(SyntaxError):
			Parser(tokenize(":: int () { return 1; }")).parse_program()

		parser = Parser(
			tokenize(
				"first :: int () { second(); return 1; }; "
				"second :: int () { return 2; }"
			)
		)
		with self.assertRaises(NameError):
			parser.parse_program()
		self.assertFalse(parser._is_declared("first"))

	def test_mismatching_yields_fail(self):
		with self.assertRaises(TypeError):
			Parser(tokenize("{ yield 1; yield 2.0; }")).parse_program()

	def test_yield_outside_value_context_fails(self):
		with self.assertRaises(SyntaxError):
			Parser(tokenize("yield 1")).parse_program()

	def test_yield_rejects_statement_only_operand(self):
		with self.assertRaises(TypeError):
			Parser(tokenize("{ yield if true {}; }")).parse_program()

	def test_yield_rejects_statement_only_ternary_operand(self):
		with self.assertRaises(TypeError):
			Parser(tokenize("{ yield {} if true else {}; }")).parse_program()

	def test_yield_accepts_null_operand(self):
		block = cast(Block, Parser(tokenize("{ yield null; }")).parse_program()[0])

		self.assertTrue(block.has_value)
		self.assertIsNone(cast(Yield, block.body[0]).dtype)

	def test_yield_must_be_a_direct_statement(self):
		for source in (
			"{ [yield 1]; }",
			"{ 1 + yield 1; }",
			"{ -yield 1; }",
			"{ [yield 1][0]; }",
			"{ (yield 1) if true else 1; }",
			"{ yield (yield 1); }",
		):
			with self.subTest(source=source), self.assertRaises(SyntaxError):
				Parser(tokenize(source)).parse_program()

	def test_yield_if_operand_remains_valid(self):
		block = cast(
			Block,
			Parser(
				tokenize("{ yield if true { yield 1; } else { yield 1; } }")
			).parse_program()[0],
		)

		self.assertTrue(block.has_value)
		self.assertEqual(block.dtype, int)

	def test_collecting_loop_yield_accepts_value_if_operand(self):
		loop = cast(
			For,
			Parser(
				tokenize(
					"for item in [1] { yield if true { yield 1; } else { yield 2; } }"
				)
			).parse_program()[0],
		)
		yield_node = cast(Yield, loop.body.body[0])
		if_operand = cast(If, yield_node.expression)

		self.assertEqual(loop.dtype, ArrayType(member_type=int))
		self.assertTrue(if_operand.has_value)
		self.assertEqual(if_operand.dtype, int)
		self.assertEqual(yield_node.dtype, int)

		with self.assertRaises(TypeError):
			Parser(
				tokenize(
					"for item in [1] { yield if true { break; } else { continue; } }"
				)
			).parse_program()

	def test_parenthesized_yield_is_rejected(self):
		with self.assertRaises(SyntaxError):
			Parser(tokenize("{ (yield 1); }")).parse_program()

	def test_arbitrary_nested_yields_are_rejected(self):
		for source in ("{ yield [yield 1]; }", "{ yield 1 + yield 1; }"):
			with self.subTest(source=source), self.assertRaises(SyntaxError):
				Parser(tokenize(source)).parse_program()

	def test_if_expression_has_matching_yield_type(self):
		expressions = Parser(
			tokenize("ready := true; result := if ready { yield 1; } else { yield 2; }")
		).parse_program()
		if_expression = cast(Binary, expressions[1]).right

		self.assertIsInstance(if_expression, If)
		self.assertEqual(cast(If, if_expression).dtype, int)
		self.assertTrue(cast(If, if_expression).has_value)

	def test_if_expression_honors_expected_type(self):
		if_expression = Parser(
			tokenize("if true { yield 1; } else { yield 2; }")
		)._parse_expression(int)

		self.assertIsInstance(if_expression, If)
		self.assertEqual(cast(If, if_expression).dtype, int)

		with self.assertRaises(TypeError):
			Parser(
				tokenize("if true { yield 1; } else { yield 2; }")
			)._parse_expression(float)

	def test_if_expression_rejects_mismatching_yield_types(self):
		with self.assertRaises(TypeError):
			Parser(tokenize("if true { yield 1; } else { yield 2.0; }")).parse_program()

	def test_if_expression_accepts_matching_null_yields(self):
		if_expression = Parser(
			tokenize("if true { yield null; } else { yield null; }")
		).parse_program()[0]

		self.assertTrue(cast(If, if_expression).has_value)
		self.assertIsNone(cast(If, if_expression).dtype)

	def test_if_expression_rejects_null_and_non_null_yields(self):
		with self.assertRaises(TypeError):
			Parser(
				tokenize("if true { yield null; } else { yield 1; }")
			).parse_program()

	def test_if_expression_rejects_missing_yield_sibling(self):
		with self.assertRaises(TypeError):
			Parser(tokenize("if true { yield 1; } else { 2; }")).parse_program()

	def test_elif_branches_must_match_yield_type(self):
		expression = Parser(
			tokenize("if true { yield 1; } elif false { yield 1; } else { yield 1; }")
		).parse_program()[0]

		self.assertEqual(cast(If, expression).dtype, int)

		with self.assertRaises(TypeError):
			Parser(
				tokenize(
					"if true { yield 1; } elif false { yield 2.0; } else { yield 1; }"
				)
			).parse_program()

	def test_yield_is_rejected_in_elif_condition(self):
		with self.assertRaises(SyntaxError):
			Parser(
				tokenize(
					"{ yield if true { yield 1; } elif yield true { yield 1; } "
					"else { yield 1; } }"
				)
			).parse_program()

	def test_yield_is_rejected_in_main_if_condition(self):
		for source in (
			"{ if yield true { yield 1; } else { yield 1; } }",
			"{ if yield 1 {} }",
			"if yield 1 {}",
		):
			with self.subTest(source=source), self.assertRaises(SyntaxError):
				Parser(tokenize(source)).parse_program()

	def test_nested_value_production_requires_if_else(self):
		with self.assertRaises(SyntaxError):
			Parser(tokenize("if true { { yield 1; } }")).parse_program()

		expression = Parser(
			tokenize("if true { { yield 1; } } else { yield 1; }")
		).parse_program()[0]
		self.assertEqual(cast(If, expression).dtype, int)

	def test_if_yield_requires_else(self):
		with self.assertRaises(SyntaxError):
			Parser(tokenize("if true { yield 1; }")).parse_program()

	def test_bare_if_is_statement_only(self):
		if_statement = Parser(tokenize("if true { 1; }")).parse_program()[0]

		self.assertIsInstance(if_statement, If)
		self.assertIsNone(cast(If, if_statement).dtype)
		self.assertFalse(cast(If, if_statement).has_value)

	def test_statement_only_rhs_is_rejected(self):
		for source in (
			"result := if true {}",
			"result := for item in [1] {}",
			"result := while true {}",
		):
			with self.subTest(source=source), self.assertRaises(TypeError):
				Parser(tokenize(source)).parse_program()

	def test_array_initializer_failure_rolls_back_nested_declarations(self):
		parser = Parser(tokenize("value := [y := 1, true]"))

		with self.assertRaises(TypeError):
			parser.parse_program()
		self.assertEqual(parser.scopes, [{}])

	def test_failed_array_expression_rolls_back_nested_declarations(self):
		parser = Parser(tokenize("[y := 1, true]"))

		with self.assertRaises(TypeError):
			parser._parse_expression()
		self.assertEqual(parser.scopes, [{}])

	def test_postfix_indexing_chains_across_expression_types(self):
		expressions = Parser(
			tokenize("values := [[1, 2], [3, 4]]; values[0][1]")
		).parse_program()
		self.assertEqual(expressions[-1].dtype, int)

		expressions = Parser(tokenize("[1][0]")).parse_program()
		self.assertEqual(expressions[0].dtype, int)

		expressions = Parser(tokenize("values := [1, 2]; (values)[0]")).parse_program()
		self.assertEqual(expressions[-1].dtype, int)

		with self.assertRaises(TypeError):
			Parser(tokenize("value: int = if true {} ")).parse_program()

		with self.assertRaises(TypeError):
			Parser(tokenize("value := 1; value = while true {} ")).parse_program()

		for source in (
			"[while true {}]",
			"[for item in [1] {}]",
			"[[while true {}]]",
		):
			with self.subTest(source=source), self.assertRaises(TypeError):
				Parser(tokenize(source)).parse_program()
		with self.assertRaises(SyntaxError):
			Parser(tokenize("[return 1]")).parse_program()

	def test_expected_types_apply_after_index_and_slice_postfixes(self):
		for source, expected in (
			("value: array[int] = [[1]][0]", ArrayType(member_type=int)),
			("value: int = ([1])[0]", int),
			(
				"value: array[array[int]] = [[1]][:]",
				ArrayType(member_type=ArrayType(member_type=int)),
			),
			("value: array[int] = ([1])[:]", ArrayType(member_type=int)),
		):
			with self.subTest(source=source):
				expression = cast(Binary, Parser(tokenize(source)).parse_program()[0])
				self.assertEqual(expression.dtype, expected)

	def test_array_accepts_value_producing_elements(self):
		for source in (
			"[1 + 2]",
			"[if true { yield 1; } else { yield 1; }]",
			"[{ yield 1; }]",
		):
			with self.subTest(source=source):
				self.assertEqual(len(Parser(tokenize(source)).parse_program()), 1)

	def test_integer_comprehensions_bind_targets_and_infer_element_types(self):
		parser = Parser(
			tokenize("values := [1, 2]; doubled := [item * 2 for item in values]")
		)
		expressions = parser.parse_program()
		comprehension = cast(Comprehension, cast(Binary, expressions[1]).right)

		self.assertEqual(comprehension.dtype, ArrayType(member_type=int))
		self.assertEqual(comprehension.target.dtype, int)
		self.assertEqual(cast(Identifier, comprehension.expression).dtype, int)
		self.assertFalse(parser._is_declared("item"))

	def test_comprehensions_support_nested_array_and_range_iterables(self):
		expressions = Parser(
			tokenize("[row[0] for row in [[1], [2]]]; [value for value in 1:5]")
		).parse_program()

		first = cast(Comprehension, expressions[0])
		second = cast(Comprehension, expressions[1])
		self.assertEqual(first.target.dtype, ArrayType(member_type=int))
		self.assertEqual(first.dtype, ArrayType(member_type=int))
		self.assertEqual(second.target.dtype, int)
		self.assertEqual(second.dtype, ArrayType(member_type=int))
		self.assertIsInstance(second.iterable, Range)

	def test_comprehensions_support_nested_comprehensions(self):
		expression = cast(
			Comprehension,
			Parser(
				tokenize("[item for item in [value for value in 1:3]]")
			).parse_program()[0],
		)

		self.assertEqual(expression.dtype, ArrayType(member_type=int))
		self.assertIsInstance(expression.iterable, Comprehension)

	def test_comprehensions_accept_array_valued_if_iterables(self):
		expression = cast(
			Comprehension,
			Parser(
				tokenize(
					"[item for item in if true { yield [1]; } else { yield [2]; }]"
				)
			).parse_program()[0],
		)

		self.assertEqual(expression.target.dtype, int)
		self.assertEqual(expression.dtype, ArrayType(member_type=int))
		self.assertIsInstance(expression.iterable, If)

	def test_comprehensions_reject_invalid_iterables_and_element_reads(self):
		for source, error in (
			("[item for item in 1]", TypeError),
			("[unknown for item in [1]]", NameError),
			("[item for unknown in [1]]", NameError),
			("[item for item in [1]]; item", NameError),
		):
			with self.subTest(source=source), self.assertRaises(error):
				Parser(tokenize(source)).parse_program()

	def test_comprehension_targets_are_cleaned_up_after_errors(self):
		parser = Parser(tokenize("outer := 0; [item + true for item in [1]]"))
		with self.assertRaises(TypeError):
			parser.parse_program()
		self.assertEqual(parser.scopes, [{"outer": int}])
		self.assertFalse(parser._is_declared("item"))

	def test_comprehensions_reject_filters(self):
		with self.assertRaises(SyntaxError):
			Parser(tokenize("[item for item in [1] if item]")).parse_program()

	def test_comprehensions_honor_expected_nested_array_types(self):
		for source, expected in (
			(
				"values: array[int] = [item for item in [1, 2]]",
				ArrayType(member_type=int),
			),
			(
				"values: array[array[int]] = [row for row in [[1], [2]]]",
				ArrayType(member_type=ArrayType(member_type=int)),
			),
		):
			with self.subTest(source=source):
				expression = cast(Binary, Parser(tokenize(source)).parse_program()[0])
				self.assertEqual(expression.dtype, expected)
				self.assertEqual(cast(Comprehension, expression.right).dtype, expected)

	def test_comprehensions_require_identifier_targets_and_value_elements(self):
		for source, error in (
			("[item for 1 in [1]]", SyntaxError),
			("[item for true in [1]]", SyntaxError),
			("[x for x in [1]]", SyntaxError),
			("[while true {} for item in [1]]", TypeError),
		):
			with self.subTest(source=source), self.assertRaises(error):
				Parser(tokenize(source)).parse_program()

	def test_if_condition_must_be_boolean(self):
		with self.assertRaises(TypeError):
			Parser(tokenize("if 1 {} ")).parse_program()

	def test_for_target_has_iterable_member_type(self):
		loop = cast(
			For, Parser(tokenize("for item in [1] { item }")).parse_program()[0]
		)

		self.assertEqual(loop.target.dtype, int)
		self.assertEqual(loop.body.body[0].dtype, int)
		self.assertIsNone(loop.dtype)
		self.assertFalse(loop.has_value)

	def test_for_scalar_iterable_fails(self):
		with self.assertRaises(TypeError):
			Parser(tokenize("for item in 1 {} ")).parse_program()

	def test_while_condition_must_be_boolean(self):
		loop = cast(While, Parser(tokenize("while true { 1; }")).parse_program()[0])

		self.assertIsNone(loop.dtype)
		self.assertFalse(loop.has_value)

		with self.assertRaises(TypeError):
			Parser(tokenize("while 1 {} ")).parse_program()

	def test_collecting_loops_propagate_expected_member_types(self):
		expected = ArrayType(member_type=ArrayType(member_type=int))
		for source in (
			"values: array[array[int]] = for item in [[1]] { yield []; }",
			"values: array[array[int]] = while true { yield []; }",
			"values: array[array[int]] = for item in [[1]] { "
			"if true { yield []; } else { yield []; } }",
			"values: array[array[int]] = while true { "
			"if true { yield []; } else { yield []; } }",
			"values: array[array[int]] = for item in [[1]] { "
			"(if true { yield []; } else { yield []; }) }",
			"values: array[array[int]] = while true { "
			"(if true { yield []; } else { yield []; }) }",
		):
			with self.subTest(source=source):
				expression = cast(Binary, Parser(tokenize(source)).parse_program()[0])
				self.assertEqual(expression.dtype, expected)

		with self.assertRaises(TypeError):
			Parser(
				tokenize(
					"value: array[array[int]] = for item in [[1]] { "
					"if true { yield []; } else { yield [true]; } }"
				)
			).parse_program()

	def test_loop_headers_reject_yields_before_enclosing_collection(self):
		for source in (
			"for item in [1] { while yield true {} }",
			"for item in [1] { for inner in yield [1] {} }",
			"for item in [1] { while yield 1 {} }",
			"for item in [1] { for inner in yield 1 {} }",
		):
			with self.subTest(source=source):
				parser = Parser(tokenize(source))
				with self.assertRaises(SyntaxError):
					parser.parse_program()
				self.assertEqual(parser._loop_contexts, [])
				self.assertEqual(parser.scopes, [{}])

	def test_loops_without_yields_are_null_valued(self):
		for source, loop_type in (
			("for item in [1] { item; }", For),
			("while true { 1; }", While),
		):
			with self.subTest(source=source):
				loop = Parser(tokenize(source)).parse_program()[0]
				self.assertIsInstance(loop, loop_type)
				assert isinstance(loop, (For, While))
				self.assertIsNone(loop.dtype)
				self.assertFalse(loop.has_value)

	def test_for_and_while_loops_collect_reachable_yields(self):
		for source in (
			"for item in [1] { yield item; }",
			"while true { yield 1; }",
		):
			with self.subTest(source=source):
				loop = Parser(tokenize(source)).parse_program()[0]
				assert isinstance(loop, (For, While))
				self.assertEqual(loop.dtype, ArrayType(member_type=int))
				self.assertTrue(loop.has_value)

		for source in (
			"values: array[int] = for item in [1] { yield item; }",
			"values: array[int] = while true { yield 1; }",
		):
			with self.subTest(source=source):
				declaration = cast(Binary, Parser(tokenize(source)).parse_program()[0])
				self.assertEqual(declaration.dtype, ArrayType(member_type=int))

	def test_collecting_loops_allow_conditional_yields_without_else(self):
		for source in (
			"for item in [1] { if true { yield item; } }",
			"while true { if true { yield 1; } }",
		):
			with self.subTest(source=source):
				loop = Parser(tokenize(source)).parse_program()[0]
				assert isinstance(loop, (For, While))
				self.assertEqual(loop.dtype, ArrayType(member_type=int))
				self.assertTrue(loop.has_value)

		with self.assertRaises(SyntaxError):
			Parser(tokenize("if true { yield 1; }")).parse_program()

	def test_collecting_loops_reject_mismatching_reachable_yields(self):
		for source in (
			"for item in [1] { if true { yield 1; } else { yield 2.0; } }",
			"while true { if true { yield 1; } else { yield 2.0; } }",
		):
			with self.subTest(source=source), self.assertRaises(TypeError):
				Parser(tokenize(source)).parse_program()

	def test_yield_terminates_iteration_flow_and_excludes_unreachable_yields(self):
		loop = cast(
			For,
			Parser(tokenize("for item in [1] { yield 1; yield 2.0; }")).parse_program()[
				0
			],
		)

		self.assertEqual(loop.dtype, ArrayType(member_type=int))
		assert loop.body.flow is not None
		self.assertFalse(loop.body.flow.can_fall_through)
		self.assertEqual(loop.body.flow.yield_types, (int,))
		self.assertEqual(len(loop.body.body), 2)

	def test_nested_collecting_loops_have_independent_yield_types(self):
		loop = cast(
			For,
			Parser(
				tokenize(
					"for item in [1] { "
					"for inner in [1.0] { yield inner; }; yield item; }"
				)
			).parse_program()[0],
		)
		inner = cast(For, loop.body.body[0])

		self.assertEqual(loop.dtype, ArrayType(member_type=int))
		self.assertEqual(inner.dtype, ArrayType(member_type=float))

	def test_loop_control_requires_a_loop_and_boolean_conditions(self):
		for source in ("break;", "continue;", "{ break; }"):
			with self.subTest(source=source), self.assertRaises(SyntaxError):
				Parser(tokenize(source)).parse_program()

		for source in (
			"for item in [1] { break; continue; }",
			"while true { break if true; continue if false; }",
		):
			with self.subTest(source=source):
				loop = Parser(tokenize(source)).parse_program()[0]
				assert isinstance(loop, (For, While))
				self.assertIsNone(loop.dtype)
				self.assertFalse(loop.has_value)

		for source in (
			"for item in [1] { break if 1; }",
			"while true { continue if 1; }",
		):
			with self.subTest(source=source), self.assertRaises(TypeError):
				Parser(tokenize(source)).parse_program()

		for source in (
			"for item in [1] { break if yield true; }",
			"while true { continue if yield false; }",
		):
			with self.subTest(source=source), self.assertRaises(SyntaxError):
				Parser(tokenize(source)).parse_program()

	def test_loop_control_is_rejected_as_a_yield_value(self):
		for source in (
			"for item in [1] { yield break; }",
			"for item in [1] { yield continue; }",
			"while true { yield break if true; }",
			"while true { yield continue if false; }",
		):
			with self.subTest(source=source), self.assertRaises(TypeError):
				Parser(tokenize(source)).parse_program()

	def test_for_parse_failure_restores_iterable_declarations(self):
		parser = Parser(tokenize("for item in (leaked := [1]) { unknown; }"))

		with self.assertRaises(NameError):
			parser.parse_program()
		self.assertEqual(parser.scopes, [{}])
		self.assertFalse(parser._is_declared("leaked"))
		self.assertFalse(parser._is_declared("item"))

	def test_while_parse_failure_restores_condition_declarations(self):
		for source in (
			"while (leaked := true) { unknown; }",
			"while (leaked := true) && unknown {}",
		):
			with self.subTest(source=source):
				parser = Parser(tokenize(source))
				with self.assertRaises(NameError):
					parser.parse_program()
				self.assertEqual(parser.scopes, [{}])
				self.assertFalse(parser._is_declared("leaked"))

	def test_loop_control_does_not_contribute_a_collection_member_type(self):
		loop = cast(
			For,
			Parser(
				tokenize(
					"for item in [1] { break if false; continue if false; yield item; }"
				)
			).parse_program()[0],
		)

		self.assertEqual(loop.dtype, ArrayType(member_type=int))
		self.assertTrue(loop.has_value)

	def test_collecting_loop_target_scope_is_cleaned_up(self):
		parser = Parser(tokenize("for item in [1] { yield item; }"))
		loop = cast(For, parser.parse_program()[0])

		self.assertEqual(loop.target.dtype, int)
		self.assertFalse(parser._is_declared("item"))
		self.assertEqual(parser.scopes, [{}])

	def test_same_scope_redeclaration_fails(self):
		with self.assertRaises(SyntaxError):
			Parser(tokenize("value := 1; value := 2")).parse_program()

	def test_multi_character_dice_expression(self):
		tokens = tokenize("1d20m10+5")

		self.assertEqual(
			[token.type for token in tokens],
			[
				"literal_number",
				TokenType.DIE_ROLL,
				"literal_number",
				TokenType.MINIMUM,
				"literal_number",
				TokenType.ADD,
				"literal_number",
				TokenType.EOF,
			],
		)
		for index in (0, 2, 4, 6):
			self.assertIsInstance(tokens[index], NumberToken)
		self.assertEqual(
			[cast(NumberToken, tokens[index]).literal for index in (0, 2, 4, 6)],
			["1", "20", "10", "5"],
		)

	def test_dice_operator_names_are_reserved_identifiers(self):
		reserved = {
			"d": TokenType.DIE_ROLL,
			"b": TokenType.REROLL_BELOW,
			"a": TokenType.REROLL_ABOVE,
			"m": TokenType.MINIMUM,
			"x": TokenType.MAXIMUM,
		}
		for spelling, token_type in reserved.items():
			with self.subTest(spelling=spelling):
				self.assertEqual(tokenize(spelling)[0], SimpleToken(type=token_type))
				for source in (
					f"{spelling} := 1",
					spelling,
					f"[item for {spelling} in [1]]",
				):
					with self.subTest(source=source), self.assertRaises(SyntaxError):
						Parser(tokenize(source)).parse_program()

	def test_all_dice_operator_names_remain_expression_operators(self):
		for source in ("1d20", "1b2", "1a2", "1m2", "1x2"):
			with self.subTest(source=source):
				expression = Parser(tokenize(source)).parse_program()[0]
				self.assertIsInstance(expression, Binary)

	def test_strings_consume_closing_delimiters(self):
		tokens = tokenize('"hello" + "world"')

		self.assertEqual(
			[token.type for token in tokens],
			["literal_string", TokenType.ADD, "literal_string", TokenType.EOF],
		)
		self.assertIsInstance(tokens[0], StringToken)
		self.assertEqual(cast(StringToken, tokens[0]).literal, "hello")
		self.assertIsInstance(tokens[2], StringToken)
		self.assertEqual(cast(StringToken, tokens[2]).literal, "world")

	def test_comments_are_ignored_across_a_newline(self):
		tokens = tokenize("1 # ignore this\n + 2")

		self.assertEqual(
			[token.type for token in tokens],
			["literal_number", TokenType.ADD, "literal_number", TokenType.EOF],
		)

	def test_boolean_literals_are_lowercase_only(self):
		tokens = tokenize("true TRUE false FALSE")

		self.assertEqual(
			[token.type for token in tokens],
			[
				"literal_bool",
				"identifier",
				"literal_bool",
				"identifier",
				TokenType.EOF,
			],
		)
		self.assertIsInstance(tokens[0], BoolToken)
		self.assertTrue(cast(BoolToken, tokens[0]).literal)
		self.assertIsInstance(tokens[1], IdentifierToken)
		self.assertEqual(cast(IdentifierToken, tokens[1]).label, "TRUE")
		self.assertIsInstance(tokens[2], BoolToken)
		self.assertFalse(cast(BoolToken, tokens[2]).literal)
		self.assertIsInstance(tokens[3], IdentifierToken)
		self.assertEqual(cast(IdentifierToken, tokens[3]).label, "FALSE")

	def test_uppercase_boolean_is_rejected_in_boolean_context(self):
		with self.assertRaises(NameError):
			Parser(tokenize("if TRUE {}"))._parse_if_statement()

	def test_d20_tokenization_completes(self):
		tokens = tokenize("d20")

		self.assertEqual(
			[token.type for token in tokens],
			[TokenType.DIE_ROLL, "literal_number", TokenType.EOF],
		)

	def test_unterminated_strings_raise_syntax_error(self):
		with self.assertRaises(SyntaxError):
			tokenize('"unterminated')

	def test_string_escapes_are_decoded(self):
		token = cast(StringToken, tokenize(r'"line\n\t\"quote\""')[0])

		self.assertEqual(token.literal, 'line\n\t"quote"')

	def test_string_escapes_support_backslashes_and_quote_delimiters(self):
		token = cast(StringToken, tokenize(r'"line\\path \"quoted\""')[0])

		self.assertEqual(token.literal, 'line\\path "quoted"')

	def test_unsupported_string_escape_raises_syntax_error(self):
		with self.assertRaises(SyntaxError):
			tokenize(r'"unsupported\q"')

	def test_malformed_number_literals_raise_syntax_error(self):
		for source in ("1_", "1__2", "1._2", "1_.2", ".", "1.2.3"):
			with self.subTest(source=source), self.assertRaises(SyntaxError):
				tokenize(source)

	def test_parser_rejects_malformed_number_tokens(self):
		for literal in ("1__2", "1.2.3"):
			with self.subTest(literal=literal), self.assertRaises(SyntaxError):
				Parser(
					[
						NumberToken(type="literal_number", literal=literal),
						SimpleToken(type=TokenType.EOF),
					]
				)._parse_expression()

	def test_valid_number_literals_preserve_underscore_support(self):
		tokens = tokenize("1_000 .5")

		self.assertEqual(
			[cast(NumberToken, token).literal for token in tokens[:-1]],
			["1_000", ".5"],
		)

	def test_double_slash_is_floor_division(self):
		tokens = tokenize("1//2")

		self.assertEqual(
			[token.type for token in tokens],
			["literal_number", TokenType.FLOOR_DIVIDE, "literal_number", TokenType.EOF],
		)

	def test_postfix_increment_and_decrement_consume_program(self):
		expressions = Parser(tokenize("value := 1; value++; value--")).parse_program()

		self.assertEqual(len(expressions), 3)
		for expression, operation in zip(
			expressions[1:], (UnaryOp.INCREMENT, UnaryOp.DECREMENT)
		):
			postfix = cast(Unary, expression)
			self.assertEqual(postfix.operation, operation)
			self.assertEqual(postfix.operator_loc, "after")
			self.assertEqual(postfix.dtype, int)
			self.assertIsInstance(postfix.operand, Identifier)
			self.assertEqual(postfix.operand.dtype, int)

	def test_postfix_mutation_requires_integer_identifier(self):
		for source in ("1++", "value := 1.0; value++"):
			with self.subTest(source=source), self.assertRaises(TypeError):
				Parser(tokenize(source)).parse_program()

	def test_prefix_mutation_requires_integer_identifier(self):
		for source in ("++1", "--1", "value := 1; ++value++"):
			with self.subTest(source=source), self.assertRaises(TypeError):
				Parser(tokenize(source)).parse_program()

		prefix = Parser(tokenize("value := 1; ++value")).parse_program()[1]
		self.assertIsInstance(prefix, Unary)
		self.assertEqual(cast(Unary, prefix).operator_loc, "before")
		self.assertIsInstance(cast(Unary, prefix).operand, Identifier)

	def test_exponentiation_is_right_associative(self):
		expression = cast(Binary, Parser(tokenize("2 ** 3 ** 2")).parse_program()[0])

		self.assertEqual(expression.operation, BinaryOp.EXPONENT)
		self.assertEqual(expression.left, Int(2))
		inner = cast(Binary, expression.right)
		self.assertEqual(inner.operation, BinaryOp.EXPONENT)
		self.assertEqual(inner.left, Int(3))
		self.assertEqual(inner.right, Int(2))
		self.assertEqual(expression.dtype, int)

	def test_ordinary_division_produces_float(self):
		expression = cast(Binary, Parser(tokenize("1 / 2")).parse_program()[0])

		self.assertEqual(expression.operation, BinaryOp.DIVIDE)
		self.assertEqual(expression.dtype, float)

	def test_mixed_numeric_arithmetic_promotes_to_float(self):
		for source, operation in (
			("1 + 2.0", BinaryOp.ADD),
			("2.0 - 1", BinaryOp.SUBTRACT),
			("2 * 3.0", BinaryOp.MULTIPLY),
			("5 // 2.0", BinaryOp.FLOOR_DIVIDE),
			("5.0 % 2", BinaryOp.MODULO),
			("2 ** 3.0", BinaryOp.EXPONENT),
		):
			with self.subTest(source=source):
				expression = cast(Binary, Parser(tokenize(source)).parse_program()[0])
				self.assertEqual(expression.operation, operation)
				self.assertIs(expression.dtype, float)

	def test_mixed_numeric_comparisons_return_boolean(self):
		for source in (
			"1 < 1.0",
			"1.0 <= 1",
			"2 > 1.0",
			"2.0 >= 2",
			"1 == 1.0",
			"1.0 != 2",
		):
			with self.subTest(source=source):
				expression = cast(Binary, Parser(tokenize(source)).parse_program()[0])
				self.assertIs(expression.dtype, bool)

	def test_integer_only_operations_reject_float_operands(self):
		for source in ("1.0 & 1", "1 << 1.0", "1.0d6"):
			with self.subTest(source=source), self.assertRaises(TypeError):
				Parser(tokenize(source)).parse_program()

	def test_mixed_numeric_compound_assignments_follow_result_type(self):
		for operator in ("+=", "-=", "*=", "/=", "//=", "%=", "**="):
			with self.subTest(operator=operator):
				expression = Parser(
					tokenize(f"value := 1.0; value {operator} 2")
				).parse_program()[1]
				self.assertIs(cast(Binary, expression).dtype, float)

		for operator in ("+=", "-=", "*=", "/=", "//=", "%=", "**="):
			with self.subTest(operator=operator):
				with self.assertRaises(TypeError):
					Parser(
						tokenize(f"value := 1; value {operator} 2.0")
					).parse_program()

	def test_floor_division_preserves_numeric_operand_type(self):
		expression = cast(Binary, Parser(tokenize("1 // 2")).parse_program()[0])

		self.assertEqual(expression.operation, BinaryOp.FLOOR_DIVIDE)
		self.assertEqual(expression.dtype, int)

	def test_ordinary_division_rejects_explicit_integer_expected_type(self):
		with self.assertRaises(TypeError):
			Parser(tokenize("value: int = 1 / 2")).parse_program()

	def test_compound_assignment_validates_result_type(self):
		with self.assertRaises(TypeError):
			Parser(tokenize("value := 1; value /= 2")).parse_program()

		expressions = Parser(tokenize("value := 1; value += 2")).parse_program()
		self.assertEqual(cast(Binary, expressions[1]).dtype, int)

	def test_float_compound_assignments_allow_numeric_promotion(self):
		for source, operation in (
			("value := 1.0; value /= 2", BinaryOp.DIVISION_ASSIGN),
			("value := 1.0; value **= 2", BinaryOp.EXPONENTIATION_ASSIGN),
		):
			with self.subTest(source=source):
				assignment = cast(Binary, Parser(tokenize(source)).parse_program()[1])
				self.assertEqual(assignment.operation, operation)
				self.assertEqual(assignment.dtype, float)

	def test_integer_compound_assignments_are_supported(self):
		for operator, operation in (
			("+=", BinaryOp.ADDITION_ASSIGN),
			("-=", BinaryOp.SUBTRACTION_ASSIGN),
			("*=", BinaryOp.MULTIPLICATION_ASSIGN),
			("//=", BinaryOp.FLOOR_DIVISION_ASSIGN),
			("%=", BinaryOp.MODULUS_ASSIGN),
			("**=", BinaryOp.EXPONENTIATION_ASSIGN),
			("&=", BinaryOp.BITWISE_AND_ASSIGN),
			("|=", BinaryOp.BITWISE_OR_ASSIGN),
			("^=", BinaryOp.BITWISE_XOR_ASSIGN),
			("<<=", BinaryOp.LSHIFT_ASSIGN),
			(">>=", BinaryOp.RSHIFT_ASSIGN),
		):
			with self.subTest(operator=operator):
				expressions = Parser(
					tokenize(f"value := 1; value {operator} 2")
				).parse_program()
				assignment = cast(Binary, expressions[1])
				self.assertEqual(assignment.operation, operation)
				self.assertEqual(assignment.dtype, int)

	def test_integer_ranges_have_default_and_explicit_steps(self):
		for source, expected_step in (("1:5", Int(1)), ("1:100:20", Int(20))):
			with self.subTest(source=source):
				range_expression = cast(
					Range, Parser(tokenize(source)).parse_program()[0]
				)
				self.assertEqual(range_expression.dtype, ArrayType(member_type=int))
				self.assertEqual(
					(
						range_expression.start,
						range_expression.stop,
						range_expression.step,
					),
					(Int(1), Int(5) if source == "1:5" else Int(100), expected_step),
				)

	def test_float_ranges_require_steps_and_have_float_member_types(self):
		for source in ("0.0:1.0", "0.0:1.0:0.1"):
			with self.subTest(source=source):
				parser = Parser(tokenize(source))
				if source == "0.0:1.0":
					with self.assertRaises(TypeError):
						parser.parse_program()
					continue
				range_expression = cast(Range, parser.parse_program()[0])
				self.assertEqual(range_expression.dtype, ArrayType(member_type=float))
				self.assertEqual(
					(
						range_expression.start,
						range_expression.stop,
						range_expression.step,
					),
					(Float(0.0), Float(1.0), Float(0.1)),
				)

		integer_bounds_float_step = cast(
			Range, Parser(tokenize("1:5:0.5")).parse_program()[0]
		)
		self.assertEqual(integer_bounds_float_step.dtype, ArrayType(member_type=float))

	def test_ranges_accept_negative_steps_and_reject_zero_steps(self):
		range_expression = cast(Range, Parser(tokenize("5:1:-1")).parse_program()[0])
		self.assertEqual(range_expression.dtype, ArrayType(member_type=int))
		self.assertEqual(range_expression.step.dtype, int)

		for source in ("1:5:0", "1:5:0.0", "1:5:-0"):
			with self.subTest(source=source), self.assertRaises(ValueError):
				Parser(tokenize(source)).parse_program()

	def test_ranges_reject_statically_zero_arithmetic_steps(self):
		for source in ("1:5:0 + 0", "1:5:1 - 1", "1:5:2 * 0"):
			with self.subTest(source=source), self.assertRaises(ValueError):
				Parser(tokenize(source)).parse_program()

		parser = Parser(tokenize("step := 0; values := 1:5:step"))
		expressions = parser.parse_program()
		range_expression = cast(Range, cast(Binary, expressions[1]).right)
		self.assertEqual(range_expression.dtype, ArrayType(member_type=int))

	def test_ranges_work_as_iterables_and_membership_operands(self):
		expressions = Parser(
			tokenize("for item in 1:5 {}; 1 in 1:5; 1 in [1, 2]")
		).parse_program()
		self.assertEqual(cast(For, expressions[0]).target.dtype, int)
		for expression in expressions[1:]:
			self.assertIsInstance(expression, Binary)
			self.assertEqual(cast(Binary, expression).operation, BinaryOp.IN)
			self.assertEqual(cast(Binary, expression).dtype, bool)

		membership = cast(Binary, Parser(tokenize("1 in 1:5")).parse_program()[0])
		self.assertIsInstance(membership.right, Range)
		self.assertEqual(cast(Range, membership.right).step, Int(1))

	def test_declaration_and_slice_colons_keep_their_ast_shapes(self):
		declaration = cast(
			Binary, Parser(tokenize("values: array[int] = 1:5")).parse_program()[0]
		)
		self.assertEqual(declaration.operation, BinaryOp.DECLARATION)
		self.assertIsInstance(declaration.right, Range)

		slice_expression = Parser(
			tokenize("values := [1, 2, 3]; values[1:2]")
		).parse_program()[1]
		self.assertIsInstance(slice_expression, Slice)
		self.assertEqual(
			(cast(Slice, slice_expression).start, cast(Slice, slice_expression).stop),
			(Int(1), Int(2)),
		)

	def test_membership_requires_matching_array_member_type(self):
		for source in ("1 in 1", "1 in [1.0]", "true in [1]", "1.0 in 1:5"):
			with self.subTest(source=source), self.assertRaises(TypeError):
				Parser(tokenize(source)).parse_program()

	def test_membership_rejects_no_value_calls_but_accepts_null_literals(self):
		with self.assertRaises(TypeError):
			Parser(tokenize("notify :: () {}; notify() in [null]")).parse_program()

		expression = cast(Binary, Parser(tokenize("null in [null]")).parse_program()[0])
		self.assertEqual(expression.operation, BinaryOp.IN)
		self.assertEqual(expression.dtype, bool)


if __name__ == "__main__":
	unittest.main()
