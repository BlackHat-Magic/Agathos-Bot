import signal
import unittest
from typing import cast

from language.expressions import (
	Binary,
	BinaryOp,
	Block,
	For,
	If,
	Identifier,
	Int,
	Return,
	Unary,
	UnaryOp,
	While,
	Yield,
)
from language.lexer import Tokenizer
from language.parser import Parser
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
		expressions = Parser(tokenize("x := 1; x = 2")).parse_program()

		self.assertEqual(len(expressions), 2)
		self.assertEqual(cast(Binary, expressions[0]).right.dtype, int)
		self.assertEqual(cast(Binary, expressions[1]).right.dtype, int)

	def test_parser_does_not_mutate_input_tokens(self):
		tokens = tokenize("x := 1; x = 2")
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
		expression = Parser(tokenize("x := 1"))._parse_expression(int)

		self.assertEqual(cast(Binary, expression).dtype, int)
		with self.assertRaises(TypeError):
			Parser(tokenize("x := true"))._parse_expression(int)

	def test_program_allows_missing_final_semicolon(self):
		expressions = Parser(tokenize("x := 1")).parse_program()

		self.assertEqual(len(expressions), 1)

	def test_program_allows_final_semicolon(self):
		self.assertEqual(len(Parser(tokenize("x := 1;")).parse_program()), 1)
		self.assertEqual(len(Parser(tokenize("x := 1; x = 2;")).parse_program()), 2)

	def test_program_rejects_missing_separator(self):
		with self.assertRaises(SyntaxError):
			Parser(tokenize("1 2")).parse_program()

	def test_null_bindings_only_accept_null_assignments(self):
		for source in (
			"x := null; x = 1",
			"x: null = null; x = 1",
		):
			with self.subTest(source=source), self.assertRaises(TypeError):
				Parser(tokenize(source)).parse_program()

		self.assertEqual(
			len(Parser(tokenize("x := null; x = null")).parse_program()), 2
		)
		self.assertIsNone(Parser(tokenize("null"))._parse_expression(None).dtype)

	def test_unresolved_identifier_reads_are_rejected(self):
		for source in (
			"unknown",
			"x := unknown",
			"1 + unknown",
			"if unknown == unknown {}",
			"x: bool = unknown == unknown",
		):
			with self.subTest(source=source), self.assertRaises(NameError):
				Parser(tokenize(source)).parse_program()

	def test_nested_declaration_rolls_back_on_initializer_failure(self):
		parser = Parser(tokenize("x: int = (y := true)"))

		with self.assertRaises(TypeError):
			parser.parse_program()
		self.assertEqual(parser.scopes, [{}])

	def test_nested_declaration_is_kept_on_successful_initializer(self):
		parser = Parser(tokenize("x := (y := true)"))

		parser.parse_program()
		self.assertEqual(parser._lookup_type("x"), bool)
		self.assertEqual(parser._lookup_type("y"), bool)

	def test_missing_delimiters_raise_syntax_error(self):
		for source in ("[1", "(1", "x: int 1"):
			with self.subTest(source=source), self.assertRaises(SyntaxError):
				Parser(tokenize(source)).parse_program()

	def test_failed_declaration_initializer_does_not_update_scope(self):
		parser = Parser(tokenize("x: int = true"))

		with self.assertRaises(TypeError):
			parser.parse_program()
		self.assertEqual(parser.scopes, [{}])

	def test_block_allows_final_semicolon(self):
		expressions = Parser(tokenize("{ x := 1; }")).parse_program()

		self.assertEqual(len(expressions), 1)
		self.assertIsInstance(expressions[0], Block)

	def test_block_shadowing_does_not_change_outer_assignment(self):
		expressions = Parser(
			tokenize("x := 1; { x := 2.0; x = 3.0 }; x = 4")
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
		parser = Parser(tokenize("{ x := 1"))

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
		block = cast(Block, Parser(tokenize("{ return 1; }")).parse_program()[0])

		self.assertIsNone(block.dtype)
		self.assertFalse(block.has_value)

	def test_return_rejects_statement_only_operands(self):
		for source in ("return if true {}", "return while true {}"):
			with self.subTest(source=source), self.assertRaises(TypeError):
				Parser(tokenize("{" + source + ";}")).parse_program()

		block = cast(Block, Parser(tokenize("{ return null; }")).parse_program()[0])
		self.assertIsInstance(block.body[0], Return)

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

	def test_parenthesized_yield_is_rejected(self):
		with self.assertRaises(SyntaxError):
			Parser(tokenize("{ (yield 1); }")).parse_program()

	def test_if_expression_has_matching_yield_type(self):
		expressions = Parser(
			tokenize("ready := true; x := if ready { yield 1; } else { yield 2; }")
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
		with self.assertRaises(SyntaxError):
			Parser(
				tokenize("{ if yield true { yield 1; } else { yield 1; } }")
			).parse_program()

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
			"x := if true {}",
			"x := for item in [1] {}",
			"x := while true {}",
		):
			with self.subTest(source=source), self.assertRaises(TypeError):
				Parser(tokenize(source)).parse_program()

	def test_array_initializer_failure_rolls_back_nested_declarations(self):
		parser = Parser(tokenize("x := [y := 1, true]"))

		with self.assertRaises(TypeError):
			parser.parse_program()
		self.assertEqual(parser.scopes, [{}])

	def test_failed_array_expression_rolls_back_nested_declarations(self):
		parser = Parser(tokenize("[y := 1, true]"))

		with self.assertRaises(TypeError):
			parser._parse_expression()
		self.assertEqual(parser.scopes, [{}])

	def test_postfix_indexing_chains_across_expression_types(self):
		expressions = Parser(tokenize("x := [[1, 2], [3, 4]]; x[0][1]")).parse_program()
		self.assertEqual(expressions[-1].dtype, int)

		expressions = Parser(tokenize("[1][0]")).parse_program()
		self.assertEqual(expressions[0].dtype, int)

		expressions = Parser(tokenize("x := [1, 2]; (x)[0]")).parse_program()
		self.assertEqual(expressions[-1].dtype, int)

		with self.assertRaises(TypeError):
			Parser(tokenize("x: int = if true {} ")).parse_program()

		with self.assertRaises(TypeError):
			Parser(tokenize("x := 1; x = while true {} ")).parse_program()

		for source in (
			"[while true {}]",
			"[for item in [1] {}]",
			"[return 1]",
			"[[while true {}]]",
		):
			with self.subTest(source=source), self.assertRaises(TypeError):
				Parser(tokenize(source)).parse_program()

	def test_array_accepts_value_producing_elements(self):
		for source in (
			"[1 + 2]",
			"[if true { yield 1; } else { yield 1; }]",
			"[{ yield 1; }]",
		):
			with self.subTest(source=source):
				self.assertEqual(len(Parser(tokenize(source)).parse_program()), 1)

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

	def test_yield_is_rejected_in_loops(self):
		with self.assertRaises(SyntaxError):
			Parser(tokenize("for item in [1] { yield item; }")).parse_program()
		with self.assertRaises(SyntaxError):
			Parser(tokenize("while true { yield 1; }")).parse_program()
		with self.assertRaises(SyntaxError):
			Parser(
				tokenize("while true { if true { yield 1; } else { yield 1; } }")
			).parse_program()

	def test_same_scope_redeclaration_fails(self):
		with self.assertRaises(SyntaxError):
			Parser(tokenize("x := 1; x := 2")).parse_program()

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
		expressions = Parser(tokenize("x := 1; x++; x--")).parse_program()

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
		for source in ("1++", "x := 1.0; x++"):
			with self.subTest(source=source), self.assertRaises(TypeError):
				Parser(tokenize(source)).parse_program()

	def test_prefix_mutation_requires_integer_identifier(self):
		for source in ("++1", "--1", "x := 1; ++x++"):
			with self.subTest(source=source), self.assertRaises(TypeError):
				Parser(tokenize(source)).parse_program()

		prefix = Parser(tokenize("x := 1; ++x")).parse_program()[1]
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

	def test_floor_division_preserves_numeric_operand_type(self):
		expression = cast(Binary, Parser(tokenize("1 // 2")).parse_program()[0])

		self.assertEqual(expression.operation, BinaryOp.FLOOR_DIVIDE)
		self.assertEqual(expression.dtype, int)

	def test_ordinary_division_rejects_explicit_integer_expected_type(self):
		with self.assertRaises(TypeError):
			Parser(tokenize("x: int = 1 / 2")).parse_program()

	def test_compound_assignment_validates_result_type(self):
		with self.assertRaises(TypeError):
			Parser(tokenize("x := 1; x /= 2")).parse_program()

		expressions = Parser(tokenize("x := 1; x += 2")).parse_program()
		self.assertEqual(cast(Binary, expressions[1]).dtype, int)

	def test_float_compound_assignments_allow_numeric_promotion(self):
		for source, operation in (
			("x := 1.0; x /= 2", BinaryOp.DIVISION_ASSIGN),
			("x := 1.0; x **= 2", BinaryOp.EXPONENTIATION_ASSIGN),
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
					tokenize(f"x := 1; x {operator} 2")
				).parse_program()
				assignment = cast(Binary, expressions[1])
				self.assertEqual(assignment.operation, operation)
				self.assertEqual(assignment.dtype, int)


if __name__ == "__main__":
	unittest.main()
