from .tokens import (
	TokenType,
	SimpleToken,
	IdentifierToken,
	StringToken,
	NumberToken,
	BoolToken,
	Token,
)


def _validate_number_literal(literal: str) -> None:
	if literal.count(".") > 1 or not any(char.isdecimal() for char in literal):
		raise SyntaxError  # TODO: better error handling
	for index, char in enumerate(literal):
		if char == "_" and (
			index == 0
			or index == len(literal) - 1
			or not literal[index - 1].isdecimal()
			or not literal[index + 1].isdecimal()
		):
			raise SyntaxError  # TODO: better error handling


class Tokenizer:
	def __init__(self, program: str) -> None:
		self.program = program
		self.position = 0

	def _peek(self, offset: int = 0) -> str | None:
		position = self.position + offset
		if position < 0 or position >= len(self.program):
			return None
		return self.program[position]

	def _advance(self) -> str | None:
		peeked = self._peek()
		if peeked is None:
			return None
		self.position += 1
		return peeked

	def _skip_whitespace(self) -> None:
		while (peeked := self._peek()) is not None and peeked.isspace():
			self._advance()

	def next_token(self) -> Token:
		self._skip_whitespace()
		while self._peek() == "#":
			while (peeked := self._peek()) is not None and peeked not in "\r\n":
				self._advance()
			self._skip_whitespace()

		symbol = self._advance()
		if symbol is None:
			return SimpleToken(type=TokenType.EOF)

		match symbol:
			# catches postfixes, bitwise NOT, and comma
			case "{" | "}" | "(" | ")" | "[" | "]" | "~" | "," | ";":
				return SimpleToken(type=TokenType(symbol))

			# catches add, subtract, increment, decrement, addition assign, and subtraction assign
			case "+" | "-":
				peeked = self._peek()
				if peeked == symbol or peeked == "=":
					symbol += peeked  # ty: ignore[unsupported-operator]
					self._advance()
				return SimpleToken(type=TokenType(symbol))

			# catches logical not, modulus, assignment, bitwise XOR, not equal, modulus assign,
			# equality, and bitwise XOR assign
			case "!" | "%" | "=" | "^":
				peeked = self._peek()
				if peeked == "=":
					symbol += peeked
					self._advance()
				return SimpleToken(type=TokenType(symbol))

			# catches multiply, divide, less than, greater than, exponent, floor divide, left shift
			# right shift, multiply assign, divide assign, less than or equal, greater than or equal,
			# exponentiation assign, floor divide assign, left shift assign, and right shift assign
			case "*" | "/" | "<" | ">":
				peeked = self._peek()
				if peeked == symbol:
					symbol += peeked  # ty: ignore[unsupported-operator]
					self._advance()
					peeked = self._peek()
				if peeked == "=":
					symbol += peeked
					self._advance()
				return SimpleToken(type=TokenType(symbol))

			# catches bitwise and, bitwise or, colon, logical and, logical or, function declaration,
			# bitwise and assign, bitwise or assign, and implicit declaration
			case "&" | "|" | ":":
				peeked = self._peek()
				if peeked == symbol or peeked == "=":
					symbol += peeked  # ty: ignore[unsupported-operator]
					self._advance()
				return SimpleToken(type=TokenType(symbol))

			# literals and identifiers
			case c if c == '"' or c == "'":
				return self._tokenize_string(c)
			case c if c.isdecimal() or c == ".":
				symbol = c
				peeked = self._peek()
				while peeked is not None and (peeked.isdecimal() or peeked in "._"):
					symbol += peeked
					self._advance()
					peeked = self._peek()
				_validate_number_literal(symbol)
				return NumberToken(type="literal_number", literal=symbol)
			case c if c.isalpha() or c == "_":
				symbol = c
				peeked = self._peek()
				while peeked is not None and (peeked.isalpha() or peeked == "_"):
					symbol += peeked
					self._advance()
					peeked = self._peek()
				if symbol != TokenType.EOF.value:
					try:
						type_ = TokenType(symbol)
						return SimpleToken(type=type_)
					except ValueError:
						pass
				if symbol == "true" or symbol == "false":
					return BoolToken(type="literal_bool", literal=symbol == "true")
				return IdentifierToken(type="identifier", label=symbol)
			case _:
				raise SyntaxError  # TODO: better error handling

	def tokenize(self) -> list[Token]:
		tokens = []
		while True:
			token = self.next_token()
			tokens.append(token)
			if token.type == TokenType.EOF:
				return tokens

	def _tokenize_string(self, delimeter: str) -> StringToken:
		literal = ""
		escaped = False

		peeked = self._peek()
		while peeked != delimeter or escaped:
			if peeked is None:
				raise SyntaxError  # TODO: better error handling

			if escaped:
				if peeked == "t":
					literal += "\t"
				elif peeked == "n":
					literal += "\n"
				elif peeked == "\\":
					literal += "\\"
				elif peeked == delimeter:
					literal += delimeter
				else:
					raise SyntaxError  # TODO: better error handling
				escaped = False
				self._advance()
				peeked = self._peek()
				continue
			elif peeked == "\\":
				escaped = True
				self._advance()
				peeked = self._peek()
				continue

			literal += peeked
			self._advance()
			escaped = False
			peeked = self._peek()
		self._advance()
		return StringToken(type="literal_string", literal=literal)
