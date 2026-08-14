from dataclasses import dataclass, field
from typing import cast

from .expressions import (
	BinaryOp,
	UnaryOp,
	PrimitiveType,
	ArrayType,
	FunctionType,
	DataType,
	String,
	Float,
	Int,
	Bool,
	Null,
	Array,
	Range,
	Slice,
	Comprehension,
	Function,
	Identifier,
	Index,
	Call,
	If,
	For,
	While,
	Block,
	Unary,
	Binary,
	Ternary,
	Return,
	Break,
	Continue,
	Yield,  # noqa: F401 - parser wiring for the yield AST node
	FlowSummary,
	Expression,
)
from .lexer import _validate_number_literal
from .tokens import TokenType, NumberToken, IdentifierToken, Token


_COMPOUND_TO_BASE = {
	BinaryOp.ADDITION_ASSIGN: BinaryOp.ADD,
	BinaryOp.SUBTRACTION_ASSIGN: BinaryOp.SUBTRACT,
	BinaryOp.MULTIPLICATION_ASSIGN: BinaryOp.MULTIPLY,
	BinaryOp.DIVISION_ASSIGN: BinaryOp.DIVIDE,
	BinaryOp.MODULUS_ASSIGN: BinaryOp.MODULO,
	BinaryOp.FLOOR_DIVISION_ASSIGN: BinaryOp.FLOOR_DIVIDE,
	BinaryOp.EXPONENTIATION_ASSIGN: BinaryOp.EXPONENT,
	BinaryOp.BITWISE_AND_ASSIGN: BinaryOp.BITWISE_AND,
	BinaryOp.BITWISE_XOR_ASSIGN: BinaryOp.BITWISE_XOR,
	BinaryOp.BITWISE_OR_ASSIGN: BinaryOp.BITWISE_OR,
	BinaryOp.LSHIFT_ASSIGN: BinaryOp.LSHIFT,
	BinaryOp.RSHIFT_ASSIGN: BinaryOp.RSHIFT,
}

_DTYPE_TOKEN_TO_VALUE = {
	TokenType.DTYPE_STRING: str,
	TokenType.DTYPE_FLOAT: float,
	TokenType.DTYPE_INT: int,
	TokenType.DTYPE_BOOL: bool,
	TokenType.LITERAL_NULL: None,
}


class _NoExpectedType:
	pass


_NO_EXPECTED_TYPE = _NoExpectedType()
ExpectedType = DataType | _NoExpectedType


@dataclass
class _LoopContext:
	yield_types: list[DataType] = field(default_factory=list)
	has_break: bool = False
	has_continue: bool = False


class Parser:
	def __init__(self, tokens: list[Token]) -> None:
		self.tokens = tokens
		self._position = 0
		self.scopes: list[dict[str, DataType]] = [{}]
		self._value_capable_blocks: list[bool] = []
		self._loop_body_depth = 0
		self._function_returns: list[DataType] = []
		self._loop_contexts: list[_LoopContext] = []
		self._comprehension_depth = 0
		self._range_suppression_depth = 0
		self._path_reachable = True
		self._loop_header_depth = 0
		self._yield_operand_depth = 0
		self._primary_expected_type: ExpectedType = _NO_EXPECTED_TYPE

	def _nearest_loop_context(self) -> _LoopContext | None:
		return self._loop_contexts[-1] if self._loop_contexts else None

	def _record_loop_yield_type(self, dtype: DataType) -> None:
		loop_context = self._nearest_loop_context()
		if (
			loop_context is not None
			and self._path_reachable
			and self._loop_header_depth == 0
		):
			loop_context.yield_types.append(dtype)

	def _make_flow_summary(
		self,
		*,
		can_fall_through: bool = True,
		return_types: tuple[DataType, ...] = (),
		yield_types: tuple[DataType, ...] = (),
		breaks: bool = False,
		continues: bool = False,
	) -> FlowSummary:
		return FlowSummary(
			can_fall_through=can_fall_through,
			return_types=return_types,
			yield_types=yield_types,
			breaks=breaks,
			continues=continues,
		)

	def _combine_flow_summaries(self, *summaries: FlowSummary) -> FlowSummary:
		return self._make_flow_summary(
			can_fall_through=all(summary.can_fall_through for summary in summaries),
			return_types=tuple(
				dtype for summary in summaries for dtype in summary.return_types
			),
			yield_types=tuple(
				dtype for summary in summaries for dtype in summary.yield_types
			),
			breaks=any(summary.breaks for summary in summaries),
			continues=any(summary.continues for summary in summaries),
		)

	def _flow_for_expression(self, expression: Expression) -> FlowSummary:
		if isinstance(expression, Return):
			return self._make_flow_summary(
				can_fall_through=False,
				return_types=(expression.dtype,),
			)
		if isinstance(expression, Yield):
			return self._make_flow_summary(
				can_fall_through=self._nearest_loop_context() is None,
				yield_types=(expression.dtype,),
			)
		if isinstance(expression, Break):
			return self._make_flow_summary(
				can_fall_through=expression.condition is not None,
				breaks=True,
			)
		if isinstance(expression, Continue):
			return self._make_flow_summary(
				can_fall_through=expression.condition is not None,
				continues=True,
			)
		if (
			isinstance(expression, (Block, If, For, While))
			and expression.flow is not None
		):
			return expression.flow
		return self._make_flow_summary()

	def _loop_result(
		self, loop_context: _LoopContext, dtype: ExpectedType
	) -> tuple[DataType, bool]:
		if not loop_context.yield_types:
			return None, False
		member_type = loop_context.yield_types[0]
		if any(
			yield_type != member_type for yield_type in loop_context.yield_types[1:]
		):
			raise TypeError
		result_type = ArrayType(member_type=member_type)
		if dtype is not _NO_EXPECTED_TYPE and dtype != result_type:
			raise TypeError
		return result_type, True

	def _push_scope(self) -> None:
		self.scopes.append({})

	def _pop_scope(self) -> None:
		self.scopes.pop()

	def _lookup_type(self, label: str) -> DataType | None:
		for scope in reversed(self.scopes):
			if label in scope:
				return scope[label]
		return None

	def _is_declared(self, label: str) -> bool:
		return any(label in scope for scope in reversed(self.scopes))

	def _declare_type(self, label: str, dtype: DataType) -> None:
		if label in self.scopes[-1]:
			raise SyntaxError  # TODO: better error handling: redeclaration
		self.scopes[-1][label] = dtype

	def _snapshot_scopes(self) -> list[dict[str, DataType]]:
		return [scope.copy() for scope in self.scopes]

	def _restore_scopes(self, snapshot: list[dict[str, DataType]]) -> None:
		self.scopes[:] = [scope.copy() for scope in snapshot]

	def _assignable_type(self, label: str) -> DataType:
		for scope in reversed(self.scopes):
			if label in scope:
				return scope[label]
		raise NameError  # TODO: better error handling: assignment to undeclared

	def _value_production(self, expression: Expression) -> tuple[bool, DataType]:
		if isinstance(expression, Yield):
			return True, expression.dtype
		if isinstance(expression, (Block, If)):
			return expression.has_value, expression.dtype
		return False, None

	def _require_value(self, expression: Expression) -> None:
		if isinstance(expression, (Break, Continue, Return)):
			raise TypeError  # statement-only expression used as a value
		if isinstance(expression, (For, While)):
			if not expression.has_value:
				raise TypeError  # statement-only loop used as a value
			return
		if isinstance(expression, Call) and expression.dtype is None:
			raise TypeError  # no-value function calls are statement-only
		if isinstance(expression, (Block, If)) and not expression.has_value:
			raise TypeError  # statement-only expression used as a value
		if isinstance(expression, Block):
			for child in expression.body:
				if self._value_production(child)[0]:
					self._require_value(child)
			return
		if isinstance(expression, If):
			self._require_value(expression.then_branch)
			for condition, branch in expression.elif_branches:
				self._require_value(condition)
				self._require_value(branch)
			if expression.else_branch is not None:
				self._require_value(expression.else_branch)
			return

		children: list[Expression] = []
		if isinstance(expression, Array):
			children = expression.value
		elif isinstance(expression, Range):
			children = [expression.start, expression.stop, expression.step]
		elif isinstance(expression, Function):
			children = [expression.body]
		elif isinstance(expression, Index):
			children = [expression.array, expression.index]
		elif isinstance(expression, Slice):
			children = [expression.array]
			children.extend(
				part
				for part in (expression.start, expression.stop, expression.step)
				if part is not None
			)
		elif isinstance(expression, Comprehension):
			children = [expression.expression, expression.iterable]
		elif isinstance(expression, Call):
			children = [expression.callee, *expression.args]
		elif isinstance(expression, Unary):
			children = [expression.operand]
		elif isinstance(expression, Binary):
			children = [expression.left, expression.right]
		elif isinstance(expression, Ternary):
			children = [expression.if_true, expression.condition, expression.if_false]
		elif isinstance(expression, Yield):
			children = [expression.expression]

		for child in children:
			self._require_value(child)

	def _contains_yield(self, expression: Expression) -> bool:
		if isinstance(expression, Yield):
			return True

		children: list[Expression] = []
		if isinstance(expression, Array):
			children = expression.value
		elif isinstance(expression, Range):
			children = [expression.start, expression.stop, expression.step]
		elif isinstance(expression, Function):
			children = [expression.body]
		elif isinstance(expression, Index):
			children = [expression.array, expression.index]
		elif isinstance(expression, Slice):
			children = [expression.array]
			children.extend(
				part
				for part in (expression.start, expression.stop, expression.step)
				if part is not None
			)
		elif isinstance(expression, Comprehension):
			children = [expression.expression, expression.iterable]
		elif isinstance(expression, Call):
			children = [expression.callee, *expression.args]
		elif isinstance(expression, If):
			children = [expression.then_branch]
			children.extend(condition for condition, _ in expression.elif_branches)
			children.extend(branch for _, branch in expression.elif_branches)
			if expression.else_branch is not None:
				children.append(expression.else_branch)
		elif isinstance(expression, (For, While)):
			children = [expression.body]
			if isinstance(expression, For):
				children.append(expression.iterable)
			else:
				children.append(expression.test)
		elif isinstance(expression, Block):
			children = expression.body
		elif isinstance(expression, Unary):
			children = [expression.operand]
		elif isinstance(expression, Binary):
			children = [expression.left, expression.right]
		elif isinstance(expression, Ternary):
			children = [expression.if_true, expression.condition, expression.if_false]
		elif isinstance(expression, Return):
			if expression.expression is not None:
				children = [expression.expression]

		return any(self._contains_yield(child) for child in children)

	def _has_invalid_nested_yield(self, expression: Expression) -> bool:
		if isinstance(expression, (Block, If, For, While)):
			return False
		return self._contains_yield(expression)

	def _is_valid_yield_container(self, expression: Expression) -> bool:
		if isinstance(expression, (Yield, Block, If, For, While)):
			return True
		if isinstance(expression, Return) and expression.expression is not None:
			return not self._has_invalid_nested_yield(expression.expression)
		return False

	def _defers_expected_control_type(self, expression: Expression) -> bool:
		return (
			bool(self._loop_contexts)
			and self._yield_operand_depth == 0
			and isinstance(expression, (Block, If, For, While))
			and not expression.has_value
		)

	def _peek(self) -> Token | None:
		if self._position >= len(self.tokens):
			return None
		return self.tokens[self._position]

	def _advance(self) -> Token | None:
		if self._position >= len(self.tokens):
			return None
		token = self.tokens[self._position]
		self._position += 1
		return token

	def _expect(self, expected: TokenType | str) -> Token:
		next_token = self._advance()
		if next_token is None:
			raise SyntaxError(
				f"Expected '{expected}', but got EOF"
			)  # TODO: better error handling
		match next_token.type:
			case token if token == expected:
				if expected == TokenType.EOF and self._position != len(self.tokens):
					raise SyntaxError  # tokens after EOF are malformed
				return next_token
			case None:
				raise SyntaxError(
					f"Expected '{expected}', but got EOF"
				)  # TODO: better error handling
			case x:
				raise SyntaxError(
					f"Expected '{expected}', but got '{x}'"
				)  # TODO: better error handling

	def _expect_identifier(self) -> IdentifierToken:
		token = self._advance()
		if isinstance(token, IdentifierToken):
			return token
		raise SyntaxError

	def _parse_type(self) -> DataType:
		token = self._advance()
		if token is None:
			raise SyntaxError  # TODO: better error handling

		if token.type in _DTYPE_TOKEN_TO_VALUE:
			return _DTYPE_TOKEN_TO_VALUE[token.type]

		if isinstance(token, IdentifierToken) and token.label == "array":
			self._expect(TokenType.OPEN_BRACKET)
			peeked = self._peek()
			if peeked is None or peeked.type == TokenType.CLOSE_BRACKET:
				raise SyntaxError  # TODO: better error handling
			member_type = self._parse_type()
			self._expect(TokenType.CLOSE_BRACKET)
			return ArrayType(member_type=member_type)

		raise SyntaxError  # TODO: better error handling

	# Validate operand types for a non-assignment binary op and return the
	# result type (a raw python type for primitives, bool for comparisons, the
	# array/function type for those -- though no ops currently apply to those).
	@staticmethod
	def _is_numeric_type(dtype: DataType) -> bool:
		return dtype is int or dtype is float

	def _binary_result_type(
		self, op: BinaryOp, left: DataType, right: DataType
	) -> DataType:
		match op:
			case (
				BinaryOp.DIE_ROLL
				| BinaryOp.REROLL_BELOW
				| BinaryOp.REROLL_ABOVE
				| BinaryOp.MINIMUM
				| BinaryOp.MAXIMUM
			):
				if left is not int or right is not int:
					raise TypeError  # TODO: better error handling
				return int
			case BinaryOp.EXPONENT:
				if (left is not int and left is not float) or (
					right is not int and right is not float
				):
					raise TypeError  # TODO: better error handling
				return float if left is float or right is float else int
			case (
				BinaryOp.MULTIPLY
				| BinaryOp.FLOOR_DIVIDE
				| BinaryOp.MODULO
				| BinaryOp.ADD
				| BinaryOp.SUBTRACT
			):
				if not self._is_numeric_type(left) or not self._is_numeric_type(right):
					raise TypeError  # TODO: better error handling
				return float if left is float or right is float else int
			case BinaryOp.DIVIDE:
				if (left is not int and left is not float) or (
					right is not int and right is not float
				):
					raise TypeError  # TODO: better error handling
				return float
			case BinaryOp.LSHIFT | BinaryOp.RSHIFT:
				if left is not int or right is not int:
					raise TypeError  # TODO: better error handling
				return int
			case (
				BinaryOp.LESS_THAN
				| BinaryOp.LESS_THAN_EQUAL
				| BinaryOp.GREATER_THAN
				| BinaryOp.GREATER_THAN_EQUAL
			):
				if not (
					self._is_numeric_type(left) and self._is_numeric_type(right)
				) and (left != right or not isinstance(left, type)):
					raise TypeError  # TODO: better error handling
				return bool
			case BinaryOp.IN:
				if not isinstance(right, ArrayType) or right.member_type != left:
					raise TypeError  # TODO: better error handling
				return bool
			case BinaryOp.EQUAL | BinaryOp.NOT_EQUAL:
				if left != right and not (
					self._is_numeric_type(left) and self._is_numeric_type(right)
				):
					raise TypeError  # TODO: better error handling
				return bool
			case BinaryOp.BITWISE_AND | BinaryOp.BITWISE_XOR | BinaryOp.BITWISE_OR:
				if left is not int or right is not int:
					raise TypeError  # TODO: better error handling
				return int
			case BinaryOp.LOGICAL_AND | BinaryOp.LOGICAL_OR:
				if left is not bool or right is not bool:
					raise TypeError  # TODO: better error handling
				return bool
			case _:
				raise TypeError  # TODO: better error handling

	def _parse_number_literal(
		self, token: NumberToken, dtype: ExpectedType
	) -> Float | Int:
		literal = token.literal
		_validate_number_literal(literal)

		cleaned = token.literal.replace("_", "")
		if dtype is _NO_EXPECTED_TYPE:
			dtype = float if "." in token.literal else int
		if dtype is int:
			if "." in token.literal:
				raise SyntaxError  # TODO: better error handling
			try:
				return Int(cleaned)
			except ValueError:
				raise SyntaxError  # TODO: better error handling
		if dtype is float:
			try:
				return Float(cleaned)
			except ValueError:
				raise SyntaxError  # TODO: better error handling
		raise TypeError  # TODO: better error handling

	def _parse_call(
		self, callee: Expression, dtype: ExpectedType = _NO_EXPECTED_TYPE
	) -> Call:
		scope_snapshot = self._snapshot_scopes()
		try:
			self._expect(TokenType.OPEN_PAREN)
			if not isinstance(callee.dtype, FunctionType):  # Can only call functions
				raise TypeError  # TODO: better error handling
			final_type: DataType
			if dtype is _NO_EXPECTED_TYPE:
				final_type = callee.dtype.returns
			else:
				assert dtype is not _NO_EXPECTED_TYPE
				if dtype != callee.dtype.returns:
					raise TypeError  # TODO: better error handling
				final_type = cast(DataType, dtype)

			parameters: list[Expression] = []
			peeked = self._peek()
			if peeked is not None and peeked.type != TokenType.CLOSE_PAREN:
				while True:
					if len(parameters) >= len(callee.dtype.parameters):
						raise TypeError  # wrong argument count
					parameter = callee.dtype.parameters[len(parameters)]
					parsed = self._parse_expression(parameter.dtype)
					self._require_value(parsed)
					if (
						parsed.dtype != parameter.dtype
					):  # match function parameter types
						raise TypeError  # TODO: better error handling
					parameters.append(parsed)
					peeked = self._peek()
					if peeked is None or peeked.type == TokenType.CLOSE_PAREN:
						break
					self._expect(TokenType.COMMA)
					peeked = self._peek()
					if peeked is None or peeked.type == TokenType.CLOSE_PAREN:
						raise SyntaxError  # trailing comma is not an argument
			self._expect(TokenType.CLOSE_PAREN)
			if len(parameters) != len(callee.dtype.parameters):
				raise TypeError  # wrong argument count

			return Call(type="call", dtype=final_type, callee=callee, args=parameters)
		except Exception:
			self._restore_scopes(scope_snapshot)
			raise

	def _parse_array_literal(
		self, dtype: ExpectedType = _NO_EXPECTED_TYPE
	) -> Array | Comprehension:
		scope_snapshot = self._snapshot_scopes()
		try:
			return self._parse_array_literal_contents(dtype)
		except Exception:
			self._restore_scopes(scope_snapshot)
			raise

	def _find_top_level_token(self, expected: TokenType) -> int | None:
		depth = 0
		for position in range(self._position, len(self.tokens)):
			token_type = self.tokens[position].type
			if token_type in (
				TokenType.OPEN_BRACKET,
				TokenType.OPEN_PAREN,
				TokenType.OPEN_BRACE,
			):
				depth += 1
			elif token_type in (
				TokenType.CLOSE_BRACKET,
				TokenType.CLOSE_PAREN,
				TokenType.CLOSE_BRACE,
			):
				if depth == 0:
					return None
				depth -= 1
			elif token_type == expected and depth == 0:
				return position
		return None

	def _parse_comprehension(
		self,
		dtype: ExpectedType,
		for_position: int,
	) -> Comprehension:
		element_position = self._position
		self._position = for_position
		self._expect(TokenType.FOR)
		target_token = self._advance()
		if not isinstance(target_token, IdentifierToken):
			raise SyntaxError
		self._expect(TokenType.IN)
		iterable_position = self._position
		if_position = self._find_top_level_token(TokenType.IF)
		if if_position is not None and if_position != iterable_position:
			self._position = if_position
			else_position = self._find_top_level_token(TokenType.ELSE)
			self._position = iterable_position
			if else_position is None:
				raise SyntaxError  # filter clauses are not supported

		iterable = self._parse_expression()
		self._require_value(iterable)
		if not isinstance(iterable.dtype, ArrayType):
			raise TypeError  # TODO: better error handling: can only iterate over arrays
		self._expect(TokenType.CLOSE_BRACKET)
		comprehension_end = self._position

		target = Identifier(
			type="identifier",
			dtype=iterable.dtype.member_type,
			label=target_token.label,
		)
		self._position = element_position
		self._push_scope()
		try:
			self._declare_type(target.label, target.dtype)
			element = self._parse_expression(
				dtype.member_type if isinstance(dtype, ArrayType) else _NO_EXPECTED_TYPE
			)
			self._require_value(element)
			if self._position != for_position:
				raise SyntaxError
		finally:
			self._pop_scope()
		self._position = comprehension_end

		if dtype is not _NO_EXPECTED_TYPE and not isinstance(dtype, ArrayType):
			raise TypeError
		result_type = ArrayType(member_type=element.dtype)
		if isinstance(dtype, ArrayType) and dtype.member_type != element.dtype:
			raise TypeError
		return Comprehension(
			type="comprehension",
			dtype=dtype if isinstance(dtype, ArrayType) else result_type,
			expression=element,
			target=target,
			iterable=iterable,
		)

	def _parse_array_literal_contents(
		self, dtype: ExpectedType = _NO_EXPECTED_TYPE
	) -> Array | Comprehension:
		# NOTE: the opening `[` was already consumed by _parse_primary before
		# delegating here, so do not expect it again.
		final_type: ArrayType
		if dtype is _NO_EXPECTED_TYPE:
			member_type = _NO_EXPECTED_TYPE
		elif isinstance(dtype, ArrayType):
			member_type = dtype.member_type
		else:
			raise TypeError  # TODO: better error handling
		peeked = self._peek()
		if peeked is None:
			raise SyntaxError  # TODO: better error handling
		if peeked.type == TokenType.CLOSE_BRACKET:
			if not isinstance(dtype, ArrayType):
				raise TypeError  # TODO: better error handling
			self._advance()
			return Array(type="array", dtype=dtype, value=[])

		comprehension_for = self._find_top_level_token(TokenType.FOR)
		if comprehension_for is not None and comprehension_for != self._position:
			return self._parse_comprehension(dtype, comprehension_for)

		first_expression = self._parse_expression(member_type)
		self._require_value(first_expression)
		if dtype is _NO_EXPECTED_TYPE:
			final_type = ArrayType(member_type=first_expression.dtype)
		else:
			if (
				not isinstance(dtype, ArrayType)
				or dtype.member_type != first_expression.dtype
			):
				raise TypeError  # TODO: better error handling
			assert isinstance(dtype, ArrayType)
			final_type = dtype
		peeked = self._peek()
		if peeked is None:  # must match brackets; EOF is bad
			raise SyntaxError  # TODO: better error handling

		# TODO: literal slices

		expressions = [first_expression]
		while peeked is not None and peeked.type != TokenType.CLOSE_BRACKET:
			self._expect(TokenType.COMMA)
			next_expression = self._parse_expression(final_type.member_type)
			self._require_value(next_expression)
			if next_expression.dtype != final_type.member_type:
				raise TypeError  # TODO: better error handling
			expressions.append(next_expression)
			peeked = self._peek()
		self._expect(TokenType.CLOSE_BRACKET)

		return Array(
			type="array",
			dtype=final_type,
			value=expressions,
		)

	def _parse_index(
		self, operand: Expression, dtype: ExpectedType = _NO_EXPECTED_TYPE
	) -> Index | Slice:
		self._expect(TokenType.OPEN_BRACKET)
		if not isinstance(operand.dtype, ArrayType):
			raise TypeError  # TODO: better error handling

		peeked = self._peek()
		start: Expression | None
		if peeked is not None and peeked.type in (
			TokenType.COLON,
			TokenType.FUNCTION,
		):
			start = None
		else:
			self._range_suppression_depth += 1
			try:
				start = self._parse_expression(int)
			finally:
				self._range_suppression_depth -= 1
			if start.dtype is not int:
				raise TypeError  # TODO: better error handling

		peeked = self._peek()
		if peeked is not None and peeked.type == TokenType.FUNCTION:
			# The lexer combines adjacent colons into the function token. Within
			# brackets, that spelling is the compact `::` slice form.
			self._advance()
			stop = None
			peeked = self._peek()
			if peeked is not None and peeked.type != TokenType.CLOSE_BRACKET:
				self._range_suppression_depth += 1
				try:
					step = self._parse_expression(int)
				finally:
					self._range_suppression_depth -= 1
				if step.dtype is not int:
					raise TypeError  # TODO: better error handling
			else:
				step = None
			self._expect(TokenType.CLOSE_BRACKET)
			if dtype is not _NO_EXPECTED_TYPE and dtype != operand.dtype:
				raise TypeError  # TODO: better error handling
			return Slice(
				type="slice",
				dtype=operand.dtype,
				array=operand,
				start=start,
				stop=stop,
				step=step,
			)

		if peeked is None or peeked.type != TokenType.COLON:
			if start is None:
				raise SyntaxError  # TODO: better error handling
			self._expect(TokenType.CLOSE_BRACKET)
			final_type: DataType = operand.dtype.member_type
			if dtype is not _NO_EXPECTED_TYPE and dtype != final_type:
				raise TypeError  # TODO: better error handling
			return Index(type="index", dtype=final_type, array=operand, index=start)

		self._advance()
		peeked = self._peek()
		if peeked is None or peeked.type in (
			TokenType.COLON,
			TokenType.CLOSE_BRACKET,
		):
			stop = None
		else:
			self._range_suppression_depth += 1
			try:
				stop = self._parse_expression(int)
			finally:
				self._range_suppression_depth -= 1
			if stop.dtype is not int:
				raise TypeError  # TODO: better error handling

		peeked = self._peek()
		if peeked is not None and peeked.type == TokenType.COLON:
			self._advance()
			peeked = self._peek()
			if peeked is None or peeked.type == TokenType.CLOSE_BRACKET:
				step = None
			else:
				self._range_suppression_depth += 1
				try:
					step = self._parse_expression(int)
				finally:
					self._range_suppression_depth -= 1
				if step.dtype is not int:
					raise TypeError  # TODO: better error handling
		else:
			step = None

		self._expect(TokenType.CLOSE_BRACKET)
		if dtype is not _NO_EXPECTED_TYPE and dtype != operand.dtype:
			raise TypeError  # TODO: better error handling
		return Slice(
			type="slice",
			dtype=operand.dtype,
			array=operand,
			start=start,
			stop=stop,
			step=step,
		)

	def _parse_primary(self, dtype: ExpectedType) -> Expression:
		token = self._advance()
		peeked = self._peek()
		if token is None:
			raise SyntaxError  # TODO: what should actually happen here?
		match (token.type, dtype):
			case ("literal_string", x) if x is _NO_EXPECTED_TYPE or x is str:
				return String(token.literal)  # ty: ignore[unresolved-attribute]
			case ("literal_string", _):
				raise TypeError  # TODO: better error handling

			case ("literal_number", x) if x is _NO_EXPECTED_TYPE:
				return self._parse_number_literal(token, _NO_EXPECTED_TYPE)  # ty: ignore[invalid-argument-type]
			case ("literal_number", x) if x is int or x is float:
				return self._parse_number_literal(token, x)  # ty: ignore[invalid-argument-type]
			case ("literal_number", _):
				raise TypeError  # TODO: better error handling

			case ("literal_bool", x) if x is _NO_EXPECTED_TYPE or x is bool:
				return Bool(token.literal)  # ty: ignore[unresolved-attribute]
			case ("literal_bool", _):
				raise TypeError  # TODO: better error handling

			case (TokenType.LITERAL_NULL, x) if x is _NO_EXPECTED_TYPE or x is None:
				return Null()
			case (TokenType.LITERAL_NULL, _):
				raise TypeError  # TODO: better error handling

			case (TokenType.DTYPE_STRING, x) if x is _NO_EXPECTED_TYPE or x is str:
				return PrimitiveType(value=str)
			case (TokenType.DTYPE_STRING, _):
				raise TypeError  # TODO: better error handling

			case (TokenType.DTYPE_FLOAT, x) if x is _NO_EXPECTED_TYPE or x is float:
				return PrimitiveType(value=float)
			case (TokenType.DTYPE_FLOAT, _):
				raise TypeError  # TODO: better error handling

			case (TokenType.DTYPE_INT, x) if x is _NO_EXPECTED_TYPE or x is int:
				return PrimitiveType(value=int)
			case (TokenType.DTYPE_INT, _):
				raise TypeError  # TODO: better error handling

			case (TokenType.DTYPE_BOOL, x) if x is _NO_EXPECTED_TYPE or x is bool:
				return PrimitiveType(value=bool)
			case (TokenType.DTYPE_BOOL, _):
				raise TypeError  # TODO: better error handling

			case ("identifier", _):
				declared = self._lookup_type(token.label)  # ty: ignore[unresolved-attribute]
				is_declared = self._is_declared(token.label)  # ty: ignore[unresolved-attribute]
				is_declaration_target = peeked is not None and peeked.type in (
					TokenType.COLON,
					TokenType.DECLARATION,
				)
				if not is_declared:
					if not is_declaration_target:
						raise NameError  # TODO: better error handling: unresolved read
					identifier = Identifier(
						type="identifier",
						dtype=None,
						label=token.label,  # ty: ignore[unresolved-attribute]
					)
				elif dtype is not _NO_EXPECTED_TYPE and dtype != declared:
					raise TypeError  # TODO: better error handling
				else:
					identifier = Identifier(
						type="identifier",
						dtype=declared,  # may be None for declaration context
						label=token.label,  # ty: ignore[unresolved-attribute]
					)
				return identifier
			case (TokenType.OPEN_PAREN, _):
				inner_peeked = self._peek()
				inner_dtype = (
					dtype
					if dtype is not _NO_EXPECTED_TYPE
					and inner_peeked is not None
					and inner_peeked.type
					in (
						TokenType.OPEN_PAREN,
						TokenType.OPEN_BRACKET,
						TokenType.OPEN_BRACE,
						TokenType.IF,
						TokenType.FOR,
						TokenType.WHILE,
					)
					else _NO_EXPECTED_TYPE
				)
				expression = self._parse_expression(inner_dtype)
				self._expect(TokenType.CLOSE_PAREN)
				if self._has_invalid_nested_yield(expression):
					raise SyntaxError  # yield must be a direct statement
				if (
					dtype is not _NO_EXPECTED_TYPE
					and expression.dtype != dtype
					and not self._defers_expected_control_type(expression)
				):
					raise TypeError  # TODO: better error handling
				return expression
			case (token_type, _) if token_type in (
				TokenType.OPEN_BRACE,
				TokenType.IF,
				TokenType.FOR,
				TokenType.WHILE,
			):
				self._position -= 1
				match token_type:
					case TokenType.OPEN_BRACE:
						return self._parse_block(value_capable=True, dtype=dtype)
					case TokenType.IF:
						return self._parse_if_statement(dtype)
					case TokenType.FOR:
						return self._parse_for_statement(dtype)
					case TokenType.WHILE:
						return self._parse_while_statement(dtype)
			case (TokenType.OPEN_BRACKET, _):
				return self._parse_array_literal(dtype)
			case _:
				raise SyntaxError  # TODO: better error handling

	def _parse_postfix_suffix(
		self, expression: Expression, dtype: ExpectedType
	) -> Expression:
		while (peeked := self._peek()) is not None:
			if peeked.type == TokenType.OPEN_PAREN:
				expression = self._parse_call(expression)
			elif peeked.type == TokenType.OPEN_BRACKET:
				expression = self._parse_index(expression)
			elif peeked.type in (TokenType.INCREMENT, TokenType.DECREMENT):
				if (
					not isinstance(expression, Identifier)
					or expression.dtype is not int
				):
					raise TypeError  # TODO: better error handling
				self._advance()
				expression = Unary(
					type="unary",
					dtype=int,
					operation=UnaryOp(peeked.type),
					operand=expression,
					operator_loc="after",
				)
			else:
				break
		if dtype is not _NO_EXPECTED_TYPE and expression.dtype != dtype:
			raise TypeError  # TODO: better error handling
		return expression

	def _parse_postfix(
		self,
		dtype: ExpectedType,
		primary_dtype: ExpectedType = _NO_EXPECTED_TYPE,
	) -> Expression:
		scope_snapshot = self._snapshot_scopes()
		position_snapshot = self._position
		try:
			if (
				primary_dtype is _NO_EXPECTED_TYPE
				and self._primary_expected_type is not _NO_EXPECTED_TYPE
			):
				primary_dtype = self._primary_expected_type
				self._primary_expected_type = _NO_EXPECTED_TYPE
			if primary_dtype is _NO_EXPECTED_TYPE:
				primary_dtype = (
					dtype
					if isinstance(dtype, ArrayType)
					and (peeked := self._peek()) is not None
					and peeked.type == TokenType.OPEN_BRACKET
					else _NO_EXPECTED_TYPE
				)
			try:
				expression = self._parse_primary(primary_dtype)
			except TypeError:
				if primary_dtype is _NO_EXPECTED_TYPE:
					raise
				self._restore_scopes(scope_snapshot)
				self._position = position_snapshot
				expression = self._parse_primary(_NO_EXPECTED_TYPE)
			return self._parse_postfix_suffix(expression, dtype)
		except Exception:
			self._restore_scopes(scope_snapshot)
			raise

	def _parse_unary(self, dtype: ExpectedType) -> Expression:
		peeked = self._peek()

		unary_ops = [
			TokenType.INCREMENT,
			TokenType.DECREMENT,
			TokenType.LOGICAL_NOT,
			TokenType.BITWISE_NOT,
			TokenType.ADD,
			TokenType.SUBTRACT,
		]
		if peeked is not None and peeked.type in unary_ops:
			op = UnaryOp(peeked.type)
			self._advance()
			peeked = self._peek()
			if op in (UnaryOp.INCREMENT, UnaryOp.DECREMENT) and (
				peeked is not None and peeked.type == TokenType.DIE_ROLL
			):
				sign = UnaryOp.POSITIVE if op == UnaryOp.INCREMENT else UnaryOp.NEGATIVE
				dice = self._parse_die_mod(dtype)
				inner = Unary(
					type="unary",
					dtype=dice.dtype,
					operation=sign,
					operand=dice,
					operator_loc="before",
				)
				return Unary(
					type="unary",
					dtype=inner.dtype,
					operation=sign,
					operand=inner,
					operator_loc="before",
				)
			if dtype is _NO_EXPECTED_TYPE and op == UnaryOp.LOGICAL_NOT:
				dtype = bool
			operand = self._parse_unary(dtype)
			if dtype is _NO_EXPECTED_TYPE:
				if op == UnaryOp.LOGICAL_NOT:
					if operand.dtype is not bool:
						raise TypeError  # TODO: better error handling
					dtype = bool
				elif op in (UnaryOp.INCREMENT, UnaryOp.DECREMENT):
					if not isinstance(operand, Identifier) or operand.dtype is not int:
						raise TypeError  # TODO: better error handling
					dtype = int
				elif op == UnaryOp.BITWISE_NOT:
					if operand.dtype is not int:
						raise TypeError  # TODO: better error handling
					dtype = int
				elif op in (UnaryOp.POSITIVE, UnaryOp.NEGATIVE):
					if operand.dtype is not int and operand.dtype is not float:
						raise TypeError  # TODO: better error handling
					dtype = operand.dtype
			else:
				# explicit expected dtype: validate operand produces it
				assert dtype is not _NO_EXPECTED_TYPE
				if op == UnaryOp.LOGICAL_NOT and (
					dtype is not bool or operand.dtype is not bool
				):
					raise TypeError  # TODO: better error handling
				elif op in (UnaryOp.INCREMENT, UnaryOp.DECREMENT) and (
					dtype is not int
					or not isinstance(operand, Identifier)
					or operand.dtype is not int
				):
					raise TypeError  # TODO: better error handling
				elif op == UnaryOp.BITWISE_NOT and (
					dtype is not int or operand.dtype is not int
				):
					raise TypeError  # TODO: better error handling
				elif op in (UnaryOp.POSITIVE, UnaryOp.NEGATIVE) and (
					(dtype is not int and dtype is not float) or operand.dtype != dtype
				):
					raise TypeError  # TODO: better error handling
			assert dtype is not _NO_EXPECTED_TYPE
			expression = Unary(
				type="unary",
				dtype=cast(DataType, dtype),
				operation=op,
				operand=operand,
				operator_loc="before",
			)
			while peeked is not None and peeked.type in [
				TokenType.INCREMENT,
				TokenType.DECREMENT,
			]:
				op = UnaryOp(peeked.type)
				self._advance()
				peeked = self._peek()
				if expression.dtype is not int:  # ++/-- require int operand
					raise TypeError  # TODO: better error handling
				expression = Unary(
					type="unary",
					dtype=int,
					operation=op,
					operand=expression,
					operator_loc="after",
				)
			return expression
		return self._parse_die_mod(dtype)

	def _parse_die_roll(self, dtype: ExpectedType = _NO_EXPECTED_TYPE) -> Expression:
		peeked = self._peek()
		if peeked is None:
			raise SyntaxError  # TODO: is this ok?
		if peeked.type == TokenType.DIE_ROLL:
			left = Int(1)
		else:
			left = self._parse_postfix(dtype)
			peeked = self._peek()
		while peeked is not None and peeked.type == TokenType.DIE_ROLL:
			self._advance()
			right = self._parse_postfix(int)
			result = self._binary_result_type(
				BinaryOp.DIE_ROLL, left.dtype, right.dtype
			)
			if dtype is not _NO_EXPECTED_TYPE and result != dtype:
				raise TypeError  # TODO: better error handling
			left = Binary(
				type="binary",
				dtype=result,
				operation=BinaryOp.DIE_ROLL,
				left=left,
				right=right,
			)
			peeked = self._peek()
		if dtype is not _NO_EXPECTED_TYPE and left.dtype != dtype:
			raise TypeError  # TODO: better error handling
		return left

	def _parse_die_mod(self, dtype: ExpectedType = _NO_EXPECTED_TYPE) -> Expression:
		left = self._parse_die_roll(dtype)
		peeked = self._peek()
		while peeked is not None:
			if peeked.type in [
				TokenType.REROLL_BELOW,
				TokenType.REROLL_ABOVE,
				TokenType.MAXIMUM,
				TokenType.MINIMUM,
			]:
				op = BinaryOp(peeked.type)
			else:
				break
			self._advance()
			right = self._parse_die_roll(int)
			result = self._binary_result_type(op, left.dtype, right.dtype)
			if dtype is not _NO_EXPECTED_TYPE and result != dtype:
				raise TypeError  # TODO: better error handling
			left = Binary(
				type="binary",
				dtype=result,
				operation=op,
				left=left,
				right=right,
			)
			peeked = self._peek()
		if dtype is not _NO_EXPECTED_TYPE and left.dtype != dtype:
			raise TypeError  # TODO: better error handling
		return left

	def _parse_exponent(self, dtype: ExpectedType = _NO_EXPECTED_TYPE) -> Expression:
		left = self._parse_unary(_NO_EXPECTED_TYPE)
		peeked = self._peek()
		if peeked is not None and peeked.type == TokenType.EXPONENT:
			self._advance()
			right = self._parse_exponent(_NO_EXPECTED_TYPE)
			result = self._binary_result_type(
				BinaryOp.EXPONENT, left.dtype, right.dtype
			)
			if dtype is not _NO_EXPECTED_TYPE and result != dtype:
				raise TypeError  # TODO: better error handling
			left = Binary(
				type="binary",
				dtype=result,
				operation=BinaryOp.EXPONENT,
				left=left,
				right=right,
			)
		if dtype is not _NO_EXPECTED_TYPE and left.dtype != dtype:
			raise TypeError  # TODO: better error handling
		return left

	def _parse_multiplicative(
		self, dtype: ExpectedType = _NO_EXPECTED_TYPE
	) -> Expression:
		left = self._parse_exponent(dtype)
		peeked = self._peek()
		while peeked is not None:
			if peeked.type in [
				TokenType.MULTIPLY,
				TokenType.DIVIDE,
				TokenType.FLOOR_DIVIDE,
				TokenType.MODULO,
			]:
				op = BinaryOp(peeked.type)
			else:
				break
			self._advance()
			right = self._parse_exponent(dtype)
			result = self._binary_result_type(op, left.dtype, right.dtype)
			if dtype is not _NO_EXPECTED_TYPE and result != dtype:
				raise TypeError  # TODO: better error handling
			left = Binary(
				type="binary", dtype=result, operation=op, left=left, right=right
			)
			peeked = self._peek()
		if dtype is not _NO_EXPECTED_TYPE and left.dtype != dtype:
			raise TypeError  # TODO: better error handling
		return left

	def _parse_additive(self, dtype: ExpectedType = _NO_EXPECTED_TYPE) -> Expression:
		left = self._parse_multiplicative(dtype)
		peeked = self._peek()
		while peeked is not None:
			if peeked.type in [TokenType.ADD, TokenType.SUBTRACT]:
				op = BinaryOp(peeked.type)
			else:
				break
			self._advance()
			right = self._parse_multiplicative(dtype)
			result = self._binary_result_type(op, left.dtype, right.dtype)
			if dtype is not _NO_EXPECTED_TYPE and result != dtype:
				raise TypeError  # TODO: better error handling
			left = Binary(
				type="binary", dtype=result, operation=op, left=left, right=right
			)
			peeked = self._peek()
		if dtype is not _NO_EXPECTED_TYPE and left.dtype != dtype:
			raise TypeError  # TODO: better error handling
		return left

	def _parse_range(self, dtype: ExpectedType = _NO_EXPECTED_TYPE) -> Expression:
		left = self._parse_additive(_NO_EXPECTED_TYPE)
		peeked = self._peek()
		if (
			self._range_suppression_depth > 0
			or peeked is None
			or peeked.type != TokenType.COLON
		):
			if dtype is not _NO_EXPECTED_TYPE and left.dtype != dtype:
				raise TypeError  # TODO: better error handling
			return left

		# An unresolved identifier followed by a colon is the start of a declaration.
		if isinstance(left, Identifier) and left.dtype is None:
			if dtype is not _NO_EXPECTED_TYPE and left.dtype != dtype:
				raise TypeError  # TODO: better error handling
			return left

		if left.dtype is not int and left.dtype is not float:
			raise TypeError  # TODO: better error handling
		self._advance()
		right = self._parse_additive(_NO_EXPECTED_TYPE)
		if right.dtype is not int and right.dtype is not float:
			raise TypeError  # TODO: better error handling

		peeked = self._peek()
		if peeked is not None and peeked.type == TokenType.COLON:
			self._advance()
			step = self._parse_additive(_NO_EXPECTED_TYPE)
			if step.dtype is not int and step.dtype is not float:
				raise TypeError  # TODO: better error handling
		else:
			if left.dtype is not int or right.dtype is not int:
				raise TypeError  # float bounds require an explicit step
			step = Int(1)

		if self._is_zero_numeric_expression(step):
			raise ValueError  # range step cannot be zero
		member_type = float if float in (left.dtype, right.dtype, step.dtype) else int
		range_expression = Range(
			type="range",
			dtype=ArrayType(member_type=member_type),
			start=left,
			stop=right,
			step=step,
		)
		if dtype is not _NO_EXPECTED_TYPE and range_expression.dtype != dtype:
			raise TypeError  # TODO: better error handling
		return range_expression

	def _is_zero_numeric_expression(self, expression: Expression) -> bool:
		value = self._constant_numeric_value(expression)
		return value == 0

	def _constant_numeric_value(self, expression: Expression) -> int | float | None:
		if isinstance(expression, Int):
			return int(expression)
		if isinstance(expression, Float):
			return float(expression)
		if isinstance(expression, Unary) and expression.operation in (
			UnaryOp.POSITIVE,
			UnaryOp.NEGATIVE,
		):
			operand = self._constant_numeric_value(expression.operand)
			if operand is None:
				return None
			return +operand if expression.operation == UnaryOp.POSITIVE else -operand
		if not isinstance(expression, Binary):
			return None
		if expression.operation not in (
			BinaryOp.EXPONENT,
			BinaryOp.MULTIPLY,
			BinaryOp.DIVIDE,
			BinaryOp.FLOOR_DIVIDE,
			BinaryOp.MODULO,
			BinaryOp.ADD,
			BinaryOp.SUBTRACT,
		):
			return None
		left = self._constant_numeric_value(expression.left)
		right = self._constant_numeric_value(expression.right)
		if left is None or right is None:
			return None
		try:
			match expression.operation:
				case BinaryOp.EXPONENT:
					value = left**right
				case BinaryOp.MULTIPLY:
					value = left * right
				case BinaryOp.DIVIDE:
					value = left / right
				case BinaryOp.FLOOR_DIVIDE:
					value = left // right
				case BinaryOp.MODULO:
					value = left % right
				case BinaryOp.ADD:
					value = left + right
				case BinaryOp.SUBTRACT:
					value = left - right
				case _:
					return None
		except ArithmeticError:
			return None
		return value if isinstance(value, (int, float)) else None

	def _parse_bitshift(self, dtype: ExpectedType = _NO_EXPECTED_TYPE) -> Expression:
		left = self._parse_range(dtype)
		peeked = self._peek()
		while peeked is not None:
			if peeked.type in [TokenType.LSHIFT, TokenType.RSHIFT]:
				op = BinaryOp(peeked.type)
			else:
				break
			self._advance()
			right = self._parse_range(dtype)
			result = self._binary_result_type(op, left.dtype, right.dtype)
			if dtype is not _NO_EXPECTED_TYPE and result != dtype:
				raise TypeError  # TODO: better error handling
			left = Binary(
				type="binary", dtype=result, operation=op, left=left, right=right
			)
			peeked = self._peek()
		if dtype is not _NO_EXPECTED_TYPE and left.dtype != dtype:
			raise TypeError  # TODO: better error handling
		return left

	def _parse_relational(self, dtype: ExpectedType = _NO_EXPECTED_TYPE) -> Expression:
		left = self._parse_bitshift(_NO_EXPECTED_TYPE)
		peeked = self._peek()
		while peeked is not None:
			if peeked.type in [
				TokenType.LESS_THAN,
				TokenType.LESS_THAN_EQUAL,
				TokenType.GREATER_THAN,
				TokenType.GREATER_THAN_EQUAL,
				TokenType.IN,
			]:
				op = BinaryOp(peeked.type)
			else:
				break
			self._advance()
			right = self._parse_bitshift(_NO_EXPECTED_TYPE)
			if op == BinaryOp.IN:
				self._require_value(left)
				self._require_value(right)
			result = self._binary_result_type(op, left.dtype, right.dtype)
			left = Binary(
				type="binary", dtype=result, operation=op, left=left, right=right
			)
			peeked = self._peek()
		if dtype is not _NO_EXPECTED_TYPE and left.dtype != dtype:
			raise TypeError  # TODO: better error handling
		return left

	def _parse_equality(self, dtype: ExpectedType = _NO_EXPECTED_TYPE) -> Expression:
		left = self._parse_relational(_NO_EXPECTED_TYPE)
		peeked = self._peek()
		while peeked is not None:
			if peeked.type in [TokenType.EQUAL, TokenType.NOT_EQUAL]:
				op = BinaryOp(peeked.type)
			else:
				break
			self._advance()
			right = self._parse_relational(_NO_EXPECTED_TYPE)
			self._require_value(left)
			self._require_value(right)
			result = self._binary_result_type(op, left.dtype, right.dtype)
			left = Binary(
				type="binary", dtype=result, operation=op, left=left, right=right
			)
			peeked = self._peek()
		if dtype is not _NO_EXPECTED_TYPE and left.dtype != dtype:
			raise TypeError  # TODO: better error handling
		return left

	def _parse_bitwise_and(self, dtype: ExpectedType = _NO_EXPECTED_TYPE) -> Expression:
		left = self._parse_equality(_NO_EXPECTED_TYPE)
		peeked = self._peek()
		while peeked is not None and peeked.type == TokenType.BITWISE_AND:
			self._advance()
			right = self._parse_equality(_NO_EXPECTED_TYPE)
			result = self._binary_result_type(
				BinaryOp.BITWISE_AND, left.dtype, right.dtype
			)
			if dtype is not _NO_EXPECTED_TYPE and result != dtype:
				raise TypeError  # TODO: better error handling
			left = Binary(
				type="binary",
				dtype=result,
				operation=BinaryOp.BITWISE_AND,
				left=left,
				right=right,
			)
			peeked = self._peek()
		if dtype is not _NO_EXPECTED_TYPE and left.dtype != dtype:
			raise TypeError  # TODO: better error handling
		return left

	def _parse_bitwise_xor(self, dtype: ExpectedType = _NO_EXPECTED_TYPE) -> Expression:
		left = self._parse_bitwise_and(_NO_EXPECTED_TYPE)
		peeked = self._peek()
		while peeked is not None and peeked.type == TokenType.BITWISE_XOR:
			self._advance()
			right = self._parse_bitwise_and(_NO_EXPECTED_TYPE)
			result = self._binary_result_type(
				BinaryOp.BITWISE_XOR, left.dtype, right.dtype
			)
			if dtype is not _NO_EXPECTED_TYPE and result != dtype:
				raise TypeError  # TODO: better error handling
			left = Binary(
				type="binary",
				dtype=result,
				operation=BinaryOp.BITWISE_XOR,
				left=left,
				right=right,
			)
			peeked = self._peek()
		if dtype is not _NO_EXPECTED_TYPE and left.dtype != dtype:
			raise TypeError  # TODO: better error handling
		return left

	def _parse_bitwise_or(self, dtype: ExpectedType = _NO_EXPECTED_TYPE) -> Expression:
		left = self._parse_bitwise_xor(_NO_EXPECTED_TYPE)
		peeked = self._peek()
		while peeked is not None and peeked.type == TokenType.BITWISE_OR:
			self._advance()
			right = self._parse_bitwise_xor(_NO_EXPECTED_TYPE)
			result = self._binary_result_type(
				BinaryOp.BITWISE_OR, left.dtype, right.dtype
			)
			if dtype is not _NO_EXPECTED_TYPE and result != dtype:
				raise TypeError  # TODO: better error handling
			left = Binary(
				type="binary",
				dtype=result,
				operation=BinaryOp.BITWISE_OR,
				left=left,
				right=right,
			)
			peeked = self._peek()
		if dtype is not _NO_EXPECTED_TYPE and left.dtype != dtype:
			raise TypeError  # TODO: better error handling
		return left

	def _parse_logical_and(self, dtype: ExpectedType = _NO_EXPECTED_TYPE) -> Expression:
		left = self._parse_bitwise_or(_NO_EXPECTED_TYPE)
		peeked = self._peek()
		while peeked is not None and peeked.type == TokenType.LOGICAL_AND:
			self._advance()
			right = self._parse_bitwise_or(_NO_EXPECTED_TYPE)
			result = self._binary_result_type(
				BinaryOp.LOGICAL_AND, left.dtype, right.dtype
			)
			left = Binary(
				type="binary",
				dtype=result,
				operation=BinaryOp.LOGICAL_AND,
				left=left,
				right=right,
			)
			peeked = self._peek()
		if dtype is not _NO_EXPECTED_TYPE and left.dtype != dtype:
			raise TypeError  # TODO: better error handling
		return left

	def _parse_logical_or(self, dtype: ExpectedType = _NO_EXPECTED_TYPE) -> Expression:
		left = self._parse_logical_and(_NO_EXPECTED_TYPE)
		peeked = self._peek()
		while peeked is not None and peeked.type == TokenType.LOGICAL_OR:
			self._advance()
			right = self._parse_logical_and(_NO_EXPECTED_TYPE)
			result = self._binary_result_type(
				BinaryOp.LOGICAL_OR, left.dtype, right.dtype
			)
			left = Binary(
				type="binary",
				dtype=result,
				operation=BinaryOp.LOGICAL_OR,
				left=left,
				right=right,
			)
			peeked = self._peek()
		if dtype is not _NO_EXPECTED_TYPE and left.dtype != dtype:
			raise TypeError  # TODO: better error handling
		return left

	def _parse_ternary(self, dtype: ExpectedType = _NO_EXPECTED_TYPE) -> Expression:
		if_true = self._parse_logical_or(dtype)
		peeked = self._peek()
		while peeked is not None and peeked.type == TokenType.IF:
			self._advance()
			condition = self._parse_expression(bool)
			if condition.dtype is not bool:
				raise TypeError  # TODO: better error handling
			self._expect(TokenType.ELSE)
			if_false = self._parse_expression(if_true.dtype)
			if if_false.dtype != if_true.dtype:
				raise TypeError  # TODO: better error handling
			if dtype is not _NO_EXPECTED_TYPE and if_true.dtype != dtype:
				raise TypeError  # TODO: better error handling
			peeked = self._peek()
			if_true = Ternary(
				type="ternary",
				dtype=if_true.dtype,
				if_true=if_true,
				condition=condition,
				if_false=if_false,
			)
		return if_true

	def _parse_function_declaration(self) -> Function:
		name_token = self._expect_identifier()
		name = name_token.label
		self._expect(TokenType.FUNCTION)

		peeked = self._peek()
		if peeked is not None and peeked.type == TokenType.OPEN_PAREN:
			return_type = None
		else:
			return_type = self._parse_type()
		self._expect(TokenType.OPEN_PAREN)

		parameters: list[Identifier] = []
		parameter_names: set[str] = set()
		peeked = self._peek()
		if peeked is not None and peeked.type != TokenType.CLOSE_PAREN:
			while True:
				parameter_token = self._expect_identifier()
				if parameter_token.label in parameter_names:
					raise SyntaxError  # duplicate parameter
				parameter_names.add(parameter_token.label)
				self._expect(TokenType.COLON)
				parameter_type = self._parse_type()
				parameters.append(
					Identifier(
						type="identifier",
						dtype=parameter_type,
						label=parameter_token.label,
					)
				)
				peeked = self._peek()
				if peeked is None or peeked.type == TokenType.CLOSE_PAREN:
					break
				self._expect(TokenType.COMMA)
				peeked = self._peek()
				if peeked is None or peeked.type == TokenType.CLOSE_PAREN:
					raise SyntaxError  # trailing comma is not a parameter
		self._expect(TokenType.CLOSE_PAREN)

		function_type = FunctionType(parameters=parameters, returns=return_type)
		scope_snapshot = self._snapshot_scopes()
		loop_contexts_snapshot = self._loop_contexts
		path_reachable_snapshot = self._path_reachable
		try:
			# The provisional signature makes recursive calls visible while parsing.
			self._declare_type(name, function_type)
			self._push_scope()
			try:
				self._loop_contexts = []
				self._path_reachable = True
				for parameter in parameters:
					self._declare_type(parameter.label, parameter.dtype)
				self._function_returns.append(return_type)
				try:
					body = self._parse_block()
				finally:
					self._function_returns.pop()
			finally:
				self._loop_contexts = loop_contexts_snapshot
				self._path_reachable = path_reachable_snapshot
				self._pop_scope()

			flow = body.flow
			if return_type is not None and (flow is None or flow.can_fall_through):
				raise TypeError  # value-returning functions must return on all paths
			return Function(
				type="function",
				dtype=function_type,
				name=name,
				body=body,
				flow=flow,
			)
		except Exception:
			self._restore_scopes(scope_snapshot)
			raise

	def _parse_assignment(self, dtype: ExpectedType = _NO_EXPECTED_TYPE) -> Expression:
		peeked = self._peek()
		primary_dtype = (
			dtype
			if dtype is not _NO_EXPECTED_TYPE
			and peeked is not None
			and peeked.type
			in (
				TokenType.OPEN_PAREN,
				TokenType.OPEN_BRACKET,
				TokenType.OPEN_BRACE,
				TokenType.IF,
				TokenType.FOR,
				TokenType.WHILE,
			)
			else _NO_EXPECTED_TYPE
		)
		if primary_dtype is _NO_EXPECTED_TYPE:
			left = self._parse_ternary(_NO_EXPECTED_TYPE)
		else:
			previous_primary_dtype = self._primary_expected_type
			self._primary_expected_type = primary_dtype
			try:
				left = self._parse_ternary(_NO_EXPECTED_TYPE)
			finally:
				self._primary_expected_type = previous_primary_dtype
		peeked = self._peek()

		# explicit type declaration: `identifier: type = value` (or `:= value`)
		if (
			left.type == "identifier"
			and peeked is not None
			and peeked.type == TokenType.COLON
		):
			self._advance()
			declared_type = self._parse_type()
			if dtype is not _NO_EXPECTED_TYPE and dtype != declared_type:
				raise TypeError  # TODO: better error handling
			scope_snapshot = self._snapshot_scopes()
			try:
				self._expect(TokenType.ASSIGNMENT)
				right = self._parse_expression(declared_type)
				self._require_value(right)
				if right.dtype != declared_type:
					raise TypeError  # TODO: better error handling
				self._declare_type(left.label, declared_type)
			except Exception:
				self._restore_scopes(scope_snapshot)
				raise
			return Binary(
				type="binary",
				dtype=declared_type,
				operation=BinaryOp.DECLARATION,
				left=left,
				right=right,
			)

		# bare inferred declaration: `identifier := value`
		if (
			left.type == "identifier"
			and peeked is not None
			and peeked.type == TokenType.DECLARATION
		):
			scope_snapshot = self._snapshot_scopes()
			self._advance()
			try:
				right = self._parse_expression()
				self._require_value(right)
				inferred = right.dtype
				if dtype is not _NO_EXPECTED_TYPE and inferred != dtype:
					raise TypeError  # TODO: better error handling
				self._declare_type(left.label, inferred)
			except Exception:
				self._restore_scopes(scope_snapshot)
				raise
			return Binary(
				type="binary",
				dtype=inferred,
				operation=BinaryOp.DECLARATION,
				left=left,
				right=right,
			)

		if (
			dtype is not _NO_EXPECTED_TYPE
			and left.dtype != dtype
			and not self._defers_expected_control_type(left)
		):
			raise TypeError  # TODO: better error handling
		assignment_ops = [
			TokenType.ASSIGNMENT,
			TokenType.ADDITION_ASSIGN,
			TokenType.SUBTRACTION_ASSIGN,
			TokenType.MULTIPLICATION_ASSIGN,
			TokenType.DIVISION_ASSIGN,
			TokenType.MODULUS_ASSIGN,
			TokenType.FLOOR_DIVISION_ASSIGN,
			TokenType.EXPONENTIATION_ASSIGN,
			TokenType.BITWISE_AND_ASSIGN,
			TokenType.BITWISE_OR_ASSIGN,
			TokenType.BITWISE_XOR_ASSIGN,
			TokenType.LSHIFT_ASSIGN,
			TokenType.RSHIFT_ASSIGN,
		]
		while peeked is not None and peeked.type in assignment_ops:
			op = BinaryOp(peeked.type)
			if left.type != "identifier":
				raise SyntaxError  # TODO: better error handling: assignment target must be identifier
			declared = self._assignable_type(left.label)
			self._advance()
			if op == BinaryOp.ASSIGNMENT:
				right = self._parse_expression(declared)
				final_type = declared
			else:
				# compound assignment: validate the underlying arithmetic op too
				right = self._parse_expression()
				self._require_value(right)
				result = self._binary_result_type(
					_COMPOUND_TO_BASE[op], declared, right.dtype
				)
				if result != declared:
					raise TypeError  # TODO: better error handling
				final_type = declared
			if op == BinaryOp.ASSIGNMENT:
				self._require_value(right)
			if dtype is not _NO_EXPECTED_TYPE and final_type != dtype:
				raise TypeError  # TODO: better error handling
			left = Binary(
				type="binary", dtype=final_type, operation=op, left=left, right=right
			)
			peeked = self._peek()
		return left

	def parse_program(self) -> list[Expression]:
		expressions: list[Expression] = []
		peeked = self._peek()
		while peeked is not None and peeked.type != TokenType.EOF:
			scope_snapshot = self._snapshot_scopes()
			try:
				expressions.append(self._parse_expression())
				peeked = self._peek()
				if peeked is not None and peeked.type == TokenType.SEMICOLON:
					self._advance()
					peeked = self._peek()
				elif peeked is None or peeked.type != TokenType.EOF:
					raise SyntaxError  # expressions require separators
			except Exception:
				self._restore_scopes(scope_snapshot)
				raise

		self._expect(TokenType.EOF)
		return expressions

	def _parse_block(
		self,
		value_capable: bool = False,
		dtype: ExpectedType = _NO_EXPECTED_TYPE,
	) -> Block:
		self._expect(TokenType.OPEN_BRACE)
		self._push_scope()
		self._value_capable_blocks.append(value_capable)
		try:
			return self._parse_block_contents(dtype)
		finally:
			self._value_capable_blocks.pop()
			self._pop_scope()

	def _parse_block_contents(self, dtype: ExpectedType = _NO_EXPECTED_TYPE) -> Block:
		peeked = self._peek()
		expressions: list[Expression] = []
		value_types: list[DataType] = []
		flow_summaries: list[FlowSummary] = []
		reachable = True
		path_reachable_snapshot = self._path_reachable

		try:
			while peeked is not None and peeked.type != TokenType.CLOSE_BRACE:
				self._path_reachable = path_reachable_snapshot and reachable
				if dtype is not _NO_EXPECTED_TYPE and peeked.type in (
					TokenType.YIELD,
					TokenType.IF,
					TokenType.FOR,
					TokenType.WHILE,
					TokenType.OPEN_BRACE,
					TokenType.OPEN_PAREN,
				):
					next_expression = self._parse_expression(dtype)
				else:
					next_expression = self._parse_expression()
				if self._contains_yield(
					next_expression
				) and not self._is_valid_yield_container(next_expression):
					raise SyntaxError  # yield must be a direct statement
				flow_summary = self._flow_for_expression(next_expression)
				if reachable:
					has_value, value_type = self._value_production(next_expression)
					if has_value:
						value_types.append(value_type)
					flow_summaries.append(flow_summary)
					reachable = flow_summary.can_fall_through
				expressions.append(next_expression)
				peeked = self._peek()
				if peeked is not None and peeked.type == TokenType.SEMICOLON:
					self._advance()
					peeked = self._peek()
				elif (
					peeked is not None
					and peeked.type != TokenType.CLOSE_BRACE
					and not isinstance(next_expression, (Block, If))
				):
					raise SyntaxError  # expressions require separators

			self._expect(TokenType.CLOSE_BRACE)
			if value_types and any(
				value_type != value_types[0] for value_type in value_types[1:]
			):
				raise TypeError  # TODO: better error handling
			flow = self._combine_flow_summaries(*flow_summaries)
			return Block(
				type="block",
				dtype=value_types[0] if value_types else None,
				body=expressions,
				has_value=bool(value_types),
				flow=flow,
			)
		finally:
			self._path_reachable = path_reachable_snapshot

	def _parse_if_statement(self, dtype: ExpectedType = _NO_EXPECTED_TYPE) -> If:
		self._expect(TokenType.IF)
		condition = self._parse_expression()
		if self._contains_yield(condition):
			raise SyntaxError  # yield must not appear in an if condition
		if condition.dtype is not bool:
			raise TypeError  # TODO: better error handling
		then_branch = self._parse_block(value_capable=True, dtype=dtype)

		elif_branches: list[tuple[Expression, Block]] = []
		peeked = self._peek()
		while peeked is not None and peeked.type == TokenType.ELIF:
			self._advance()
			elif_condition = self._parse_expression()
			if self._contains_yield(elif_condition):
				raise SyntaxError  # yield must not appear in an if condition
			if elif_condition.dtype is not bool:
				raise TypeError  # TODO: better error handling
			block = self._parse_block(value_capable=True, dtype=dtype)
			elif_branches.append((elif_condition, block))
			peeked = self._peek()

		if peeked is not None and peeked.type == TokenType.ELSE:
			self._advance()
			else_branch = self._parse_block(value_capable=True, dtype=dtype)
		else:
			else_branch = None

		branch_flows = [
			branch.flow
			for branch in [then_branch, *[block for _, block in elif_branches]]
		]
		if else_branch is not None:
			branch_flows.append(else_branch.flow)
		available_flows = [
			branch_flow for branch_flow in branch_flows if branch_flow is not None
		]
		flow = self._make_flow_summary(
			can_fall_through=any(
				branch_flow.can_fall_through for branch_flow in available_flows
			),
			return_types=tuple(
				dtype
				for branch_flow in available_flows
				for dtype in branch_flow.return_types
			),
			yield_types=tuple(
				dtype
				for branch_flow in available_flows
				for dtype in branch_flow.yield_types
			),
			breaks=any(branch_flow.breaks for branch_flow in available_flows),
			continues=any(branch_flow.continues for branch_flow in available_flows),
		)
		if else_branch is None:
			flow = self._make_flow_summary(
				return_types=flow.return_types,
				yield_types=flow.yield_types,
				breaks=flow.breaks,
				continues=flow.continues,
			)

		branches = [then_branch] + [block for _, block in elif_branches]
		all_branches = branches + ([else_branch] if else_branch is not None else [])
		collects_yields = (
			bool(self._loop_contexts)
			and self._yield_operand_depth == 0
			and any(
				branch.flow is not None and branch.flow.yield_types
				for branch in all_branches
			)
		)
		if collects_yields:
			has_value = False
			final_type = None
		elif else_branch is None:
			if any(branch.has_value for branch in branches):
				if not self._loop_contexts:
					raise SyntaxError  # value-producing if requires an else branch
			has_value = False
			final_type = None
		else:
			branches.append(else_branch)
			branches_have_values = [branch.has_value for branch in branches]
			if any(branches_have_values):
				if not all(branches_have_values):
					raise TypeError  # TODO: better error handling
				has_value = True
				final_type = branches[0].dtype
				if any(branch.dtype != final_type for branch in branches[1:]):
					raise TypeError  # TODO: better error handling
			else:
				has_value = False
				final_type = None

		if dtype is not _NO_EXPECTED_TYPE and has_value and final_type != dtype:
			raise TypeError  # TODO: better error handling

		return If(
			type="if",
			dtype=final_type,
			condition=condition,
			then_branch=then_branch,
			elif_branches=elif_branches,
			else_branch=else_branch,
			has_value=has_value,
			flow=flow,
		)

	def _parse_for_statement(self, dtype: ExpectedType = _NO_EXPECTED_TYPE) -> For:
		if dtype is not _NO_EXPECTED_TYPE and not isinstance(dtype, ArrayType):
			raise TypeError
		scope_snapshot = self._snapshot_scopes()
		try:
			self._expect(TokenType.FOR)

			identifier = self._expect("identifier")
			if not isinstance(identifier, IdentifierToken):
				raise SyntaxError
			self._expect(TokenType.IN)

			iterable = self._parse_loop_header_expression()
			if not isinstance(iterable.dtype, ArrayType):
				raise TypeError  # TODO: better error handling: can only iterate over arrays
			target = Identifier(
				type="identifier",
				dtype=iterable.dtype.member_type,
				label=identifier.label,
			)
			self._expect(TokenType.OPEN_BRACE)
			self._push_scope()
			self._value_capable_blocks.append(False)
			self._loop_body_depth += 1
			loop_context = _LoopContext()
			self._loop_contexts.append(loop_context)
			try:
				self._declare_type(identifier.label, iterable.dtype.member_type)
				body_dtype = (
					dtype.member_type
					if isinstance(dtype, ArrayType)
					else _NO_EXPECTED_TYPE
				)
				body = self._parse_block_contents(body_dtype)
			finally:
				self._loop_contexts.pop()
				self._loop_body_depth -= 1
				self._value_capable_blocks.pop()
				self._pop_scope()
			loop_dtype, has_value = self._loop_result(loop_context, dtype)

			return For(
				type="for",
				dtype=loop_dtype,
				target=target,
				iterable=iterable,
				body=body,
				has_value=has_value,
				flow=self._make_flow_summary(
					can_fall_through=True,
					return_types=body.flow.return_types
					if body.flow is not None
					else (),
				),
			)
		except Exception:
			self._restore_scopes(scope_snapshot)
			raise

	def _parse_while_statement(self, dtype: ExpectedType = _NO_EXPECTED_TYPE) -> While:
		if dtype is not _NO_EXPECTED_TYPE and not isinstance(dtype, ArrayType):
			raise TypeError
		scope_snapshot = self._snapshot_scopes()
		try:
			self._expect(TokenType.WHILE)
			condition = self._parse_loop_header_expression()
			if condition.dtype is not bool:
				raise TypeError  # TODO: better error handling

			loop_context = _LoopContext()
			self._loop_contexts.append(loop_context)
			self._loop_body_depth += 1
			try:
				body_dtype = (
					dtype.member_type
					if isinstance(dtype, ArrayType)
					else _NO_EXPECTED_TYPE
				)
				body = self._parse_block(dtype=body_dtype)
			finally:
				self._loop_contexts.pop()
				self._loop_body_depth -= 1
			loop_dtype, has_value = self._loop_result(loop_context, dtype)

			return While(
				type="while",
				dtype=loop_dtype,
				test=condition,
				body=body,
				has_value=has_value,
				flow=self._make_flow_summary(
					can_fall_through=True,
					return_types=body.flow.return_types
					if body.flow is not None
					else (),
				),
			)
		except Exception:
			self._restore_scopes(scope_snapshot)
			raise

	def _parse_loop_header_expression(self) -> Expression:
		self._loop_header_depth += 1
		try:
			expression = self._parse_expression()
		finally:
			self._loop_header_depth -= 1
		if self._contains_yield(expression):
			raise SyntaxError  # yields are not valid in loop headers
		return expression

	def _parse_loop_control_statement(
		self, control_type: TokenType
	) -> Break | Continue:
		if self._nearest_loop_context() is None:
			raise SyntaxError
		self._expect(control_type)
		condition = None
		peeked = self._peek()
		if peeked is not None and peeked.type == TokenType.IF:
			self._advance()
			condition = self._parse_expression()
			if self._contains_yield(condition):
				raise SyntaxError  # yield must not appear in a loop-control condition
			if condition.dtype is not bool:
				raise TypeError
		if control_type == TokenType.BREAK:
			return Break(type="break", condition=condition)
		return Continue(type="continue", condition=condition)

	def _parse_return_statement(self) -> Return:
		self._expect(TokenType.RETURN)
		if not self._function_returns:
			raise SyntaxError  # return is only valid inside a function
		peeked = self._peek()
		if peeked is None or peeked.type in (
			TokenType.SEMICOLON,
			TokenType.CLOSE_BRACE,
		):
			if self._function_returns[-1] is not None:
				raise TypeError  # value-returning functions require a value
			return Return(type="return", dtype=None)
		if peeked.type == TokenType.LITERAL_NULL:
			self._advance()
			if self._function_returns[-1] is not None:
				raise TypeError  # value-returning functions require a value
			return Return(type="return", dtype=None)

		expression = self._parse_expression(self._function_returns[-1])
		self._require_value(expression)
		if isinstance(expression, Null):
			return Return(type="return", dtype=None)
		if expression.dtype != self._function_returns[-1]:
			raise TypeError  # return type does not match the function
		return Return(type="return", dtype=expression.dtype, expression=expression)

	def _parse_expression(self, dtype: ExpectedType = _NO_EXPECTED_TYPE) -> Expression:
		peeked = self._peek()
		if peeked is None:
			raise SyntaxError
		if (
			isinstance(peeked, IdentifierToken)
			and self._position + 1 < len(self.tokens)
			and self.tokens[self._position + 1].type == TokenType.FUNCTION
		):
			return self._parse_function_declaration()
		match peeked.type:
			case TokenType.BREAK:
				return self._parse_loop_control_statement(TokenType.BREAK)
			case TokenType.CONTINUE:
				return self._parse_loop_control_statement(TokenType.CONTINUE)
			case TokenType.RETURN:
				return self._parse_return_statement()
			case TokenType.YIELD:
				if self._nearest_loop_context() is None and (
					not self._value_capable_blocks or not self._value_capable_blocks[-1]
				):
					raise SyntaxError  # yield requires a value-capable block or loop
				self._advance()
				self._yield_operand_depth += 1
				try:
					expression = self._parse_expression(dtype)
				finally:
					self._yield_operand_depth -= 1
				if self._has_invalid_nested_yield(expression):
					raise SyntaxError  # yield must not be nested in its operand
				self._require_value(expression)
				if dtype is not _NO_EXPECTED_TYPE and expression.dtype != dtype:
					raise TypeError  # TODO: better error handling
				self._record_loop_yield_type(expression.dtype)
				return Yield(
					type="yield", dtype=expression.dtype, expression=expression
				)
			case (
				TokenType.OPEN_BRACE
				| TokenType.IF
				| TokenType.FOR
				| TokenType.WHILE
				| TokenType.FUNCTION
				| TokenType.DTYPE_STRING
				| TokenType.DTYPE_FLOAT
				| TokenType.DTYPE_INT
				| TokenType.DTYPE_BOOL
				| TokenType.LITERAL_NULL
				| TokenType.OPEN_PAREN
				| TokenType.OPEN_BRACKET
				| TokenType.INCREMENT
				| TokenType.DECREMENT
				| TokenType.LOGICAL_NOT
				| TokenType.BITWISE_NOT
				| TokenType.DIE_ROLL
				| TokenType.MAXIMUM
				| TokenType.ADD
				| TokenType.SUBTRACT
				| "literal_string"
				| "literal_number"
				| "literal_bool"
				| "identifier"
			):
				return self._parse_assignment(dtype)
			case _:
				raise SyntaxError
