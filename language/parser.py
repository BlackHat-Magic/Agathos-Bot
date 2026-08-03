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
	Yield,  # noqa: F401 - parser wiring for the yield AST node
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


class Parser:
	def __init__(self, tokens: list[Token]) -> None:
		self.tokens = tokens
		self._position = 0
		self.scopes: list[dict[str, DataType]] = [{}]
		self._value_capable_blocks: list[bool] = []
		self._loop_body_depth = 0

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
		if isinstance(expression, (Block, If, For, While)):
			return expression.has_value, expression.dtype
		return False, None

	def _require_value(self, expression: Expression) -> None:
		if isinstance(expression, (For, While, Return)):
			raise TypeError  # statement-only expression used as a value
		if isinstance(expression, (Block, If)) and not expression.has_value:
			raise TypeError  # statement-only expression used as a value

		children: list[Expression] = []
		if isinstance(expression, Array):
			children = expression.value
		elif isinstance(expression, Function):
			children = [expression.body]
		elif isinstance(expression, Index):
			children = [expression.array, expression.index]
		elif isinstance(expression, Call):
			children = [expression.callee, *expression.args]
		elif isinstance(expression, If):
			children = [expression.then_branch]
			children.extend(condition for condition, _ in expression.elif_branches)
			children.extend(branch for _, branch in expression.elif_branches)
			if expression.else_branch is not None:
				children.append(expression.else_branch)
		elif isinstance(expression, Block):
			children = expression.body
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
		elif isinstance(expression, Function):
			children = [expression.body]
		elif isinstance(expression, Index):
			children = [expression.array, expression.index]
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
			children = [expression.expression]

		return any(self._contains_yield(child) for child in children)

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

	# Validate operand types for a non-assignment binary op and return the
	# result type (a raw python type for primitives, bool for comparisons, the
	# array/function type for those -- though no ops currently apply to those).
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
				if (
					(left is not int and left is not float)
					or (right is not int and right is not float)
					or (left is not right)
				):
					raise TypeError  # TODO: better error handling
				return left
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
				if left != right or not isinstance(left, type):
					raise TypeError  # TODO: better error handling
				return bool
			case BinaryOp.EQUAL | BinaryOp.NOT_EQUAL:
				if left != right:
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
		for i, parameter in enumerate(callee.dtype.parameters):
			if i > 0:
				self._expect(TokenType.COMMA)
			parsed = self._parse_expression(parameter.dtype)
			if parsed.dtype != parameter.dtype:  # match function parameter types
				raise TypeError  # TODO: better error handling
			parameters.append(parsed)
		self._expect(TokenType.CLOSE_PAREN)

		return Call(type="call", dtype=final_type, callee=callee, args=parameters)

	def _parse_array_literal(self, dtype: ExpectedType = _NO_EXPECTED_TYPE) -> Array:
		scope_snapshot = self._snapshot_scopes()
		try:
			return self._parse_array_literal_contents(dtype)
		except Exception:
			self._restore_scopes(scope_snapshot)
			raise

	def _parse_array_literal_contents(
		self, dtype: ExpectedType = _NO_EXPECTED_TYPE
	) -> Array:
		# NOTE: the opening `[` was already consumed by _parse_primary before
		# delegating here, so do not expect it again.
		final_type: ArrayType
		if dtype is _NO_EXPECTED_TYPE:
			member_type = _NO_EXPECTED_TYPE
		elif isinstance(dtype, ArrayType):
			member_type = dtype.member_type
		else:
			raise TypeError  # TODO: better error handling
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

		# comprehensions
		if peeked.type == TokenType.FOR:
			raise NotImplementedError  # TODO: see return statement

			# (unreachable placeholder; comprehension parsing not yet done)
			self._advance()
			target_identifier = self._expect("identifier")  # noqa: F841
			self._expect(TokenType.IN)
			iterable = self._parse_expression()
			if not isinstance(iterable.dtype, ArrayType):
				# can only iterate over array types
				raise TypeError  # TODO: better error handling
			if iterable.dtype.member_type != final_type.member_type:
				raise TypeError  # TODO: better error handling

			# I think the way to do this is to walk the branch of the AST that has the identifier as its
			# root and find the leaf that has an identifier with an unresolved type, then construct a
			# new one like that for each member of the iterable
			return Array(
				type="array",
				dtype=iterable.dtype,
				value=[
					first_expression for _ in iterable.value
				],  # TODO: this is incorrect
			)

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
	) -> Index:
		self._expect(TokenType.OPEN_BRACKET)
		if not isinstance(operand.dtype, ArrayType):
			raise TypeError  # TODO: better error handling
		final_type: DataType
		if dtype is _NO_EXPECTED_TYPE:
			final_type = operand.dtype.member_type
		else:
			assert dtype is not _NO_EXPECTED_TYPE
			if dtype != operand.dtype.member_type:
				raise TypeError  # TODO: better error handling
			final_type = cast(DataType, dtype)
		index = self._parse_expression(int)
		if index.dtype is not int:
			raise TypeError  # TODO: better error handling
		self._expect(TokenType.CLOSE_BRACKET)

		return Index(type="index", dtype=final_type, array=operand, index=index)

	def _parse_primary(self, dtype: ExpectedType) -> Expression:
		token = self._advance()
		peeked = self._peek()
		if token is None:
			raise SyntaxError  # TODO: what should actually happen here?
		if token.type == TokenType.MAXIMUM:
			token = IdentifierToken(type="identifier", label="x")
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
				expression = self._parse_expression()
				self._expect(TokenType.CLOSE_PAREN)
				if self._contains_yield(expression):
					raise SyntaxError  # yield must be a direct statement
				if dtype is not _NO_EXPECTED_TYPE and expression.dtype != dtype:
					raise TypeError  # TODO: better error handling
				return expression
			case (TokenType.OPEN_BRACKET, _):
				return self._parse_array_literal(dtype)
			case _:
				raise SyntaxError  # TODO: better error handling

	def _parse_postfix(self, dtype: ExpectedType) -> Expression:
		expression = self._parse_primary(_NO_EXPECTED_TYPE)
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
		return self._parse_postfix(dtype)

	def _parse_die_roll(self, dtype: ExpectedType = _NO_EXPECTED_TYPE) -> Expression:
		peeked = self._peek()
		if peeked is None:
			raise SyntaxError  # TODO: is this ok?
		if peeked.type == TokenType.DIE_ROLL:
			left = Int(1)
		else:
			left = self._parse_unary(dtype)
			peeked = self._peek()
		while peeked is not None and peeked.type == TokenType.DIE_ROLL:
			self._advance()
			right = self._parse_unary(int)
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
		left = self._parse_die_mod(_NO_EXPECTED_TYPE)
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

	def _parse_bitshift(self, dtype: ExpectedType = _NO_EXPECTED_TYPE) -> Expression:
		left = self._parse_additive(dtype)
		peeked = self._peek()
		while peeked is not None:
			if peeked.type in [TokenType.LSHIFT, TokenType.RSHIFT]:
				op = BinaryOp(peeked.type)
			else:
				break
			self._advance()
			right = self._parse_additive(dtype)
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
			]:
				op = BinaryOp(peeked.type)
			else:
				break
			self._advance()
			right = self._parse_bitshift(_NO_EXPECTED_TYPE)
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

	def _parse_assignment(self, dtype: ExpectedType = _NO_EXPECTED_TYPE) -> Expression:
		left = self._parse_ternary(_NO_EXPECTED_TYPE)
		peeked = self._peek()

		# explicit type declaration: `identifier: type = value` (or `:= value`)
		if (
			left.type == "identifier"
			and peeked is not None
			and peeked.type == TokenType.COLON
		):
			self._advance()
			peeked = self._peek()
			if peeked is None or peeked.type not in _DTYPE_TOKEN_TO_VALUE:
				# data types must follow `identifier: `
				raise SyntaxError  # TODO: better error handling
			declared_type = _DTYPE_TOKEN_TO_VALUE[peeked.type]
			if dtype is not _NO_EXPECTED_TYPE and dtype != declared_type:
				raise TypeError  # TODO: better error handling
			scope_snapshot = self._snapshot_scopes()
			self._advance()
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

		if dtype is not _NO_EXPECTED_TYPE and left.dtype != dtype:
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
			expressions.append(self._parse_expression())
			peeked = self._peek()
			if peeked is not None and peeked.type == TokenType.SEMICOLON:
				self._advance()
				peeked = self._peek()
			elif peeked is None or peeked.type != TokenType.EOF:
				raise SyntaxError  # expressions require separators

		self._expect(TokenType.EOF)
		return expressions

	def _parse_block(self, value_capable: bool = False) -> Block:
		self._expect(TokenType.OPEN_BRACE)
		self._push_scope()
		self._value_capable_blocks.append(value_capable)
		try:
			return self._parse_block_contents()
		finally:
			self._value_capable_blocks.pop()
			self._pop_scope()

	def _parse_block_contents(self) -> Block:
		peeked = self._peek()
		expressions: list[Expression] = []
		value_types: list[DataType] = []

		while peeked is not None and peeked.type != TokenType.CLOSE_BRACE:
			next_expression = self._parse_expression()
			if self._contains_yield(next_expression) and not isinstance(
				next_expression, (Yield, If, Block)
			):
				raise SyntaxError  # yield must be a direct statement
			has_value, value_type = self._value_production(next_expression)
			if has_value:
				value_types.append(value_type)
			expressions.append(next_expression)
			peeked = self._peek()
			if peeked is not None and peeked.type == TokenType.SEMICOLON:
				self._advance()
				peeked = self._peek()
			elif peeked is not None and peeked.type != TokenType.CLOSE_BRACE:
				raise SyntaxError  # expressions require separators

		self._expect(TokenType.CLOSE_BRACE)
		if value_types and any(
			value_type != value_types[0] for value_type in value_types[1:]
		):
			raise TypeError  # TODO: better error handling
		return Block(
			type="block",
			dtype=value_types[0] if value_types else None,
			body=expressions,
			has_value=bool(value_types),
		)

	def _parse_if_statement(self, dtype: ExpectedType = _NO_EXPECTED_TYPE) -> If:
		self._expect(TokenType.IF)
		condition = self._parse_expression(bool)
		if condition.dtype is not bool:
			raise TypeError  # TODO: better error handling
		if self._contains_yield(condition):
			raise SyntaxError  # yield must not appear in an if condition
		then_branch = self._parse_block(value_capable=True)

		elif_branches: list[tuple[Expression, Block]] = []
		peeked = self._peek()
		while peeked is not None and peeked.type == TokenType.ELIF:
			self._advance()
			elif_condition = self._parse_expression(bool)
			if elif_condition.dtype is not bool:
				raise TypeError  # TODO: better error handling
			if self._contains_yield(elif_condition):
				raise SyntaxError  # yield must not appear in an if condition
			block = self._parse_block(value_capable=True)
			elif_branches.append((elif_condition, block))
			peeked = self._peek()

		if peeked is not None and peeked.type == TokenType.ELSE:
			self._advance()
			else_branch = self._parse_block(value_capable=True)
		else:
			else_branch = None

		branches = [then_branch] + [block for _, block in elif_branches]
		if else_branch is None:
			if any(branch.has_value for branch in branches):
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

		if dtype is not _NO_EXPECTED_TYPE and (not has_value or final_type != dtype):
			raise TypeError  # TODO: better error handling

		return If(
			type="if",
			dtype=final_type,
			then_branch=then_branch,
			elif_branches=elif_branches,
			else_branch=else_branch,
			has_value=has_value,
		)

	def _parse_for_statement(self, dtype: ExpectedType = _NO_EXPECTED_TYPE) -> For:
		if dtype is not _NO_EXPECTED_TYPE:
			raise TypeError  # loops are statement-only
		self._expect(TokenType.FOR)

		identifier = self._expect("identifier")
		if not isinstance(identifier, IdentifierToken):
			raise SyntaxError
		self._expect(TokenType.IN)

		iterable = self._parse_expression()
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
		try:
			self._declare_type(identifier.label, iterable.dtype.member_type)
			body = self._parse_block_contents()
		finally:
			self._loop_body_depth -= 1
			self._value_capable_blocks.pop()
			self._pop_scope()

		return For(
			type="for",
			dtype=None,
			target=target,
			iterable=iterable,
			body=body,
			has_value=False,
		)

	def _parse_while_statement(self, dtype: ExpectedType = _NO_EXPECTED_TYPE) -> While:
		if dtype is not _NO_EXPECTED_TYPE:
			raise TypeError  # while loops are statement-only
		self._expect(TokenType.WHILE)
		condition = self._parse_expression(bool)
		if condition.dtype is not bool:
			raise TypeError  # TODO: better error handling

		self._loop_body_depth += 1
		try:
			body = self._parse_block()
		finally:
			self._loop_body_depth -= 1

		return While(  # TODO: while loops returning stuff
			type="while",
			dtype=None,
			test=condition,
			body=body,
			has_value=False,
		)

	def _parse_return_statement(self) -> Return:
		self._expect(TokenType.RETURN)
		expression = self._parse_expression()
		self._require_value(expression)
		return Return(type="return", dtype=expression.dtype, expression=expression)

	def _parse_expression(self, dtype: ExpectedType = _NO_EXPECTED_TYPE) -> Expression:
		peeked = self._peek()
		if peeked is None:
			raise SyntaxError

		match peeked.type:
			case TokenType.IF:
				return self._parse_if_statement(dtype)
			case TokenType.FOR:
				return self._parse_for_statement(dtype)
			case TokenType.WHILE:
				return self._parse_while_statement(dtype)
			case TokenType.RETURN:
				return self._parse_return_statement()
			case TokenType.YIELD:
				if (
					not self._value_capable_blocks
					or not self._value_capable_blocks[-1]
					or self._loop_body_depth > 0
				):
					raise SyntaxError  # yield requires a value-capable block
				self._advance()
				expression = self._parse_expression()
				if self._contains_yield(expression) and not isinstance(expression, If):
					raise SyntaxError  # yield must not be nested in its operand
				self._require_value(expression)
				if dtype is not _NO_EXPECTED_TYPE and expression.dtype != dtype:
					raise TypeError  # TODO: better error handling
				return Yield(
					type="yield", dtype=expression.dtype, expression=expression
				)
			case TokenType.OPEN_BRACE:
				block = self._parse_block(value_capable=True)
				if dtype is not _NO_EXPECTED_TYPE and (
					not block.has_value or block.dtype != dtype
				):
					raise TypeError  # TODO: better error handling
				return block
			case (
				TokenType.FUNCTION
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
