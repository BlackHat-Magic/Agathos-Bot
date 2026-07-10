from .tokens import (
	TokenType,
	SimpleToken,
	IdentifierToken,
	StringToken,
	NumberToken,
	BoolToken,
	Token,
)


class Tokenizer:
	def __init__(self, program: str) -> None:
		self.program: list[str] = [char for char in program]

	def _peek(self) -> str | None:
		if len(self.program) < 1:
			return None
		return self.program[0]

	def _advance(self) -> str | None:
		if len(self.program) < 1:
			return None
		return self.program.pop(0)

	def _skip_whitespace(self) -> str | None:
		while True:
			if len(self.program) < 1:
				return None
			popped = self.program.pop(0)
			if not popped.isspace():
				return popped

	def next_token(self) -> Token:
		self._skip_whitespace()

		symbol = self._advance()
		if symbol is None:
			return SimpleToken(type=TokenType.EOF)

		match symbol:
			# catches postfixes, bitwise NOT, and comma
			case "{" | "}" | "(" | ")" | "[" | "]" | "~" | ",":
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
				return NumberToken(type="literal_number", literal=symbol)
			case c if c.isalpha() or c == "_":
				symbol = c
				peeked = self._peek()
				while peeked is not None and (peeked.isalpha() or peeked == "_"):
					symbol += peeked
					self._advance()
				try:
					type_ = TokenType(symbol)
					return SimpleToken(type=type_)
				except ValueError:
					if symbol == "TRUE" or symbol == "FALSE":
						return BoolToken(type="literal_bool", literal=symbol == "TRUE")
					return IdentifierToken(type="identifier", label=symbol)
			case _:
				raise SyntaxError  # TODO: better error handling

	def _tokenize_string(self, delimeter: str) -> StringToken:
		literal = ""
		escaped = False

		peeked = self._peek()
		while peeked != delimeter or escaped:
			if peeked is None:
				raise SyntaxError  # TODO: better error handling

			if escaped:
				# not formatted: \r, \b, \f, \v, \a
				if peeked == "t":
					peeked = "\t"
				elif peeked == "n":
					peeked = "\n"
				escaped = False
			elif peeked == "\\":
				escaped = True
				self._advance()
				continue

			literal += peeked
			self._advance()
			escaped = False
		return StringToken(type="literal_string", literal=literal)
