from .expressions import (
	BinaryOp,
	UnaryOp,
	Type,
	PrimitiveType,
	ArrayType,
	DataType,
	Primitive,
	Array,
	Identifier,
	Index,
	Call,
	For,
	Unary,
	Binary,
	Ternary,
	Expression,
)
from .tokens import Token, TokenType


class Parser:
	def __init__(self, tokens: list[Token]) -> None:
		self.tokens = tokens

	def _peek(self) -> Token | None:
		if len(self.tokens) < 1:
			return None
		return self.tokens[0]

	def _advance(self) -> Token | None:
		if len(self.tokens) < 1:
			return None
		return self.tokens.pop(0)

	def _expect(self, expected: TokenType | str) -> Token:
		next_token = self._advance()
		match next_token.type:
			case token if token == expected:
				return next_token
			case None:
				raise Exception(
					f"Expected '{expected}', but got EOF"
				)  # TODO: better error handling
			case x:
				raise Exception(
					f"Expected '{expected}', but got '{x}'"
				)  # TODO: better error handling

	def _parse_number_literal(self, token: Token, dtype: DataType | None) -> Primitive:
		cleaned = token.literal.replace("_", "")
		if dtype is None:
			dtype = Type.FLOAT if "." in token.literal else Type.INT

		if dtype == Type.FLOAT:
			try:
				return Primitive(
					type="primitive",
					dtype=PrimitiveType(
						type="primitive_type", dtype=Type.DTYPE, payload=Type.FLOAT
					),
					value=float(cleaned),
				)
			except ValueError:
				raise SyntaxError  # TODO: better error handling

		if "." in token.literal:
			raise SyntaxError  # TODO: better error handling
		try:
			return Primitive(
				type="primitive",
				dtype=PrimitiveType(
					type="primitive_type", dtype=Type.DTYPE, payload=Type.INT
				),
				value=int(cleaned),
			)
		except ValueError:
			raise SyntaxError  # TODO: better error handling

	def _parse_call(self, callee: Expression) -> Call:
		self._expect(TokenType.OPEN_PAREN)
		if callee.dtype.type != "function_type":  # Can only call functions
			raise TypeError  # TODO: better error handling

		parameters: list[Expression] = []
		for parameter in callee.dtype.parameters:
			if len(parameters) > 0:
				self._expect(TokenType.COMMA)
			parsed = self._parse_expression(Identifier.dtype)
			if parsed.dtype != parameter.dtype:  # match function parameter types
				raise TypeError  # TODO: better error handling
		self._expect(TokenType.CLOSE_PAREN)

		return Call(type="call", dtype=callee.returns, callee=callee, args=parameters)

	def _parse_array_literal(self, member_type: ArrayType | None = None) -> Array | For:
		self._expect(TokenType.OPEN_BRACKET)
		first_item = self._parse_expression(member_type)
		dtype = first_item.dtype
		if member_type is not None and dtype != member_type:
			# we parsed something that doesn't work as target member type
			raise TypeError  # TODO: better error handling
		peeked = self._peek()
		if peeked is None:  # must match brackets; EOF is bad
			raise SyntaxError  # TODO: better error handling
		items = [first_item]

		# comprehensions
		if peeked.type == TokenType.FOR:
			self._advance()
			target_identifier = self._expect("identifier")
			self._expect(TokenType.IN)
			iterable = self._parse_expression()
			if iterable.dtype.type != "array_type":  # can only iterate over array types
				raise TypeError  # TODO: better error handling
			if member_type is not None and iterable.dtype.member_type != dtype:
				raise TypeError  # TODO: better error handling
			return For(
				type="for",
				dtype=ArrayType(
					type="array_type",
					dtype=Type.DTYPE,
					member_type=iterable.dtype.member_type,
				),
				target=Identifier(
					type="identifier",
					dtype=iterable.dtype.member_type,
					identifier=target_identifier.label,
				),
				iterable=iterable,
				body=items,
			)

		# TODO: literal slices

		while peeked is not None and peeked.type != TokenType.CLOSE_BRACKET:
			self._expect(TokenType.COMMA)
			next_item = self._parse_expression(dtype)
			if next_item.dtype != dtype:
				raise TypeError  # TODO: better error handling
			items.append(next_item)
			peeked = self._peek()
		self._expect(TokenType.CLOSE_BRACKET)

		return Array(
			type="array",
			dtype=ArrayType(
				type="array_type",
				dtype=Type.DTYPE,
				member_type=dtype,
			),
			value=items,
		)

	def _parse_index(self, operand: Expression) -> Index:
		if operand.dtype.type != "array_type":
			raise TypeError  # TODO: better error handling
		dtype = operand.dtype.member_type
		index = self._parse_expression()
		if index.dtype.type != "primitive" or index.dtype.payload != Type.INT:
			raise TypeError
		self._expect(TokenType.CLOSE_BRACKET)

		return Index(type="index", dtype=dtype, array=operand, index=index)

	def _parse_primary(self, dtype: DataType | None) -> Expression:
		token = self._advance()
		peeked = self._peek()
		match token.type:
			case "literal_string":
				return Primitive(
					type="primitive",
					dtype=PrimitiveType(
						type="primitive_type",
						dtype=Type(token.type),
						payload=Type.STRING,
					),
					payload=token.literal,
				)
			case "literal_number":
				return self._parse_number_literal(token, dtype)
			case "literal_bool":
				return Primitive(
					type="primitive",
					dtype=PrimitiveType(
						type="primitive_type", dtype=Type(token.type), payload=Type.BOOL
					),
					payload=token.literal,
				)
			case "literal_null":
				return Primitive(
					type="primitive",
					dtype=PrimitiveType(
						type="primitive_type", dtype=Type(token.type), payload=Type.NULL
					),
					value=None,
				)
			case (
				TokenType.DTYPE_STRING
				| TokenType.DTYPE_FLOAT
				| TokenType.DTYPE_INT
				| TokenType.DTYPE_BOOL
			):
				return PrimitiveType(
					type="primitive_type", dtype=Type.DTYPE, payload=Type.DTYPE
				)
			case "identifier":
				identifier = Identifier(
					type="identifier",
					dtype=dtype,  # TODO: what if this is None?
					identifier=token.label,
				)
				if peeked is not None:
					if peeked.type == TokenType.OPEN_PAREN:
						return self._parse_call(self, identifier, dtype)
					if peeked.type == TokenType.OPEN_BRACKET:
						return self._parse_index(self, identifier, dtype)
				return identifier
			case TokenType.OPEN_PAREN:
				expression = self._parse_expression(dtype)
				self._expect(TokenType.CLOSE_PAREN)
				return expression
			case TokenType.OPEN_BRACKET:
				return self._parse_array_literal(dtype)
			case _:
				raise SyntaxError  # TODO: better error handling

	def _parse_unary(self, dtype: DataType | None) -> Expression:
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
			operand = self._parse_unary(dtype)
			expression = Unary(
				type="unary",
				dtype=dtype,
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
				expression = Unary(
					type="unaru",
					dtype=dtype,
					operation=op,
					operand=expression,
					operator_loc="after",
				)
			return expression
		return self._parse_primary(dtype)

	def _parse_die_roll(self, dtype: DataType | None = None) -> Expression:
		peeked = self._peek()
		if peeked is None:
			raise SyntaxError  # TODO: is this ok?
		if peeked.type == TokenType.DIE_ROLL:
			left = Primitive(
				type="primitive",
				dtype=PrimitiveType(
					type="primitive_type", dtype=Type.DTYPE, payload=Type.INT
				),
				value=1,
			)
		else:
			left = self._parse_unary(dtype)
			self._advance()
			peeked = self._peek()
		while peeked is not None and peeked.type == TokenType.DIE_ROLL:
			self._advance()
			right = self._parse_unary(dtype)
			peeked = self._peek()
			left = Binary(
				type="binary",
				dtype=PrimitiveType(
					type="primitive_type", dtype=Type.DTYPE, payload=Type.INT
				),
				operation=BinaryOp.DIE_ROLL,
				left=left,
				right=right,
			)
		return left

	def _parse_die_mod(self, dtype: DataType | None = None) -> Expression:
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
			right = self._parse_die_roll(dtype)
			peeked = self._peek()
			left = Binary(
				type="binary",
				dtype=PrimitiveType(
					type="primitive_type", dtype=Type.DTYPE, payload=Type.INT
				),
				operation=op,
				left=left,
				right=right,
			)
		return left

	def _parse_exponent(self, dtype: DataType | None = None) -> Expression:
		left = self._parse_die_mod(self, dtype)
		peeked = self._peek()
		while peeked is not None and peeked.type == TokenType.EXPONENT:
			self._advance()
			right = self._parse_die_mod(dtype)
			peeked = self._peek()
			left = Binary(
				type="binary",
				dtype=PrimitiveType(
					type="primitive_type", dtype=Type.DTYPE, payload=Type.INT
				),
				operation=BinaryOp.EXPONENT,
				left=left,
				right=right,
			)
		return left

	def _parse_multiplicative(self, dtype: DataType | None = None) -> Expression:
		left = self._parse_die_roll(dtype)
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
			right = self._parse_die_roll(dtype)
			peeked = self._peek()
			left = Binary(
				type="binary", dtype=dtype, operation=op, left=left, right=right
			)
		return left

	def _parse_additive(self, dtype: DataType | None = None) -> Expression:
		left = self._parse_multiplicative(dtype=dtype)
		peeked = self._peek()
		while peeked is not None:
			if peeked.type in [TokenType.ADD, TokenType.SUBTRACT]:
				op = BinaryOp(peeked.type)
			else:
				break
			self._advance()
			right = self._parse_multiplicative(dtype)
			peeked = self._peek()
			left = Binary(
				type="binary", dtype=dtype, operation=op, left=left, right=right
			)
		return left

	def _parse_bitshift(self, dtype: DataType | None = None) -> Expression:
		left = self._parse_additive(dtype=dtype)
		peeked = self._peek()
		while peeked is not None:
			if peeked.type in [TokenType.LSHIFT, TokenType.RSHIFT]:
				op = BinaryOp(peeked.type)
			else:
				break
			self._advance()
			right = self._parse_additive(dtype)
			peeked = self._peek()
			left = Binary(
				type="binary", dtype=dtype, operation=op, left=left, right=right
			)
		return left

	def _parse_relational(self, dtype: DataType | None = None) -> Expression:
		left = self._parse_bitshift(dtype)
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
			right = self._parse_bitshift(dtype)
			peeked = self._peek()
			left = Binary(
				type="binary", dtype=dtype, operation=op, left=left, right=right
			)
		return left

	def _parse_equality(self, dtype: DataType | None = None) -> Expression:
		left = self._parse_relational(dtype)
		peeked = self._peek()
		while peeked is not None:
			if peeked.type in [TokenType.EQUAL, TokenType.NOT_EQUAL]:
				op = BinaryOp(peeked.type)
			else:
				break
			self._advance()
			right = self._parse_relational(dtype)
			peeked = self._peek()
			left = Binary(
				type="binary", dtype=dtype, operation=op, left=left, right=right
			)
		return left

	def _parse_bitwise_and(self, dtype: DataType | None = None) -> Expression:
		left = self._parse_equality(dtype)
		peeked = self._peek()
		while peeked is not None and peeked.type == TokenType.BITWISE_AND:
			self._advance()
			right = self._parse_equality(dtype)
			peeked = self._peek()
			left = Binary(
				type="binary",
				dtype=dtype,
				operation=BinaryOp.BITWISE_AND,
				left=left,
				right=right,
			)
		return left

	def _parse_bitwise_xor(self, dtype: DataType | None = None) -> Expression:
		left = self._parse_bitwise_and(dtype)
		peeked = self._peek()
		while peeked is not None and peeked.type == TokenType.BITWISE_XOR:
			self._advance()
			right = self._parse_bitwise_and(dtype)
			peeked = self._peek()
			left = Binary(
				type="binary",
				dtype=dtype,
				operation=BinaryOp.BITWISE_XOR,
				left=left,
				right=right,
			)
		return left

	def _parse_bitwise_or(self, dtype: DataType | None = None) -> Expression:
		left = self._parse_bitwise_xor(dtype)
		peeked = self._peek()
		while peeked is not None and peeked.type == TokenType.BITWISE_OR:
			self._advance()
			right = self._parse_bitwise_xor(dtype)
			peeked = self._peek()
			left = Binary(
				type="binary",
				dtype=dtype,
				operation=BinaryOp.BITWISE_OR,
				left=left,
				right=right,
			)
		return left

	def _parse_logical_and(self, dtype: DataType | None = None) -> Expression:
		left = self._parse_bitwise_or(dtype)
		peeked = self._peek()
		while peeked is not None and peeked.type == TokenType.LOGICAL_AND:
			self._advance()
			right = self._parse_bitwise_or(dtype)
			peeked = self._peek()
			left = Binary(
				type="binary",
				dtype=dtype,
				operation=BinaryOp.LOGICAL_AND,
				left=left,
				right=right,
			)
		return left

	def _parse_logical_or(self, dtype: DataType | None = None) -> Expression:
		left = self._parse_logical_and(dtype)
		peeked = self._peek()
		while peeked is not None and peeked.type == TokenType.LOGICAL_OR:
			self._advance()
			right = self._parse_logical_and(dtype)
			peeked = self._peek()
			left = Binary(
				type="binary",
				dtype=dtype,
				operation=BinaryOp.LOGICAL_OR,
				left=left,
				right=right,
			)
		return left

	def _parse_ternary(self, dtype: DataType | None = None) -> Expression:
		if_true = self._parse_logical_or(dtype)
		peeked = self._peek()
		while peeked is not None and peeked.type == TokenType.IF:
			self._advance()
			condition = self._parse_expression(dtype)
			self._expect(TokenType.ELSE)
			if_false = self._parse_expression(dtype)
			peeked = self._peek()
			if_true = Ternary(
				type="ternary",
				dtype=dtype,
				if_true=if_true,
				condition=condition,
				if_false=if_false,
			)
		return if_true

	def _parse_assignment(self, dtype: DataType | None = None) -> Expression:
		left = self._parse_ternary(dtype)
		peeked = self._peek()

		# explicit type declaration
		if (
			left.type == "identifier"
			and peeked is not None
			and peeked.type == TokenType.COLON
		):
			self._advance()
			peeked = self._peek()
			if peeked not in [
				TokenType.DTYPE_STRING,
				TokenType.DTYPE_FLOAT,
				TokenType.DTYPE_INT,
				TokenType.DTYPE_BOOL,
				TokenType.LITERAL_NULL,
			]:
				# data types must follow `identifier: `
				raise SyntaxError  # TODO: better error handling
			dtype = PrimitiveType(
				type="primitive_type", dtype=Type.DTYPE, payload=Type(peeked.type)
			)
			self._advance()
			self._expect(TokenType.ASSIGNMENT)
			right = self._parse_expression(dtype)
			left = Binary(
				type="binary",
				dtype=dtype,
				operation=BinaryOp.DECLARATION,
				left=left,
				right=right,
			)
			self._expect(TokenType.SEMICOLON)
			return left

		assignment_ops = [
			TokenType.DECLARATION,
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
			right = self._parse_expression(dtype)
			peeked = self._peek()
			left = Binary(
				type="binary", dtype=dtype, operation=op, left=left, right=right
			)
		return left

	def _parse_expression(self, dtype: DataType | None = None) -> Expression:
		raise NotImplementedError
