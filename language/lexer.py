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

			# catches bitwise and, bitwise or, logical and, logical or, bitwise and assign, and bitwise
			# or assign
			case "&" | "|":
				peeked = self._peek()
				if peeked == symbol or peeked == "=":
					symbol += peeked  # ty: ignore[unsupported-operator]
					self._advance()
				return SimpleToken(type=TokenType(symbol))

			case ":" if self._peek() == "=":
				self._advance()
				return SimpleToken(type=TokenType.DECLARATION)
			case c if c == '"' or c == "'":
				return self._tokenize_string(c)
			case c if c.isdecimal() or c == ".":
				return self._tokenize_number(c)
			case c if c.isalpha() or c == "_":
				return self._tokenize_complex(c)
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
		return StringToken(literal=literal)

	def _tokenize_number(self, first_digit: str) -> NumberToken:
		literal = first_digit
		peeked = self._peek()
		while peeked is not None and (peeked.isdecimal() or peeked in "._"):
			literal += peeked
			self._advance()
		return NumberToken(literal=literal)

	def _tokenize_complex(self, first_char: str) -> Token:
		symbol = first_char
		peeked = self._peek()
		while peeked is not None and (peeked.isalpha() or peeked == "_"):
			symbol += peeked
			self._advance()
		match symbol:
			case "fn":
				return SimpleToken(type=TokenType.FN)
			case "if":
				return SimpleToken(type=TokenType.IF)
			case "else":
				return SimpleToken(type=TokenType.ELSE)
			case "elif":
				return SimpleToken(type=TokenType.ELIF)
			case "for":
				return SimpleToken(type=TokenType.FOR)
			case "while":
				return SimpleToken(type=TokenType.WHILE)
			case "break":
				return SimpleToken(type=TokenType.BREAK)
			case "continue":
				return SimpleToken(type=TokenType.CONTINUE)
			case "return":
				return SimpleToken(type=TokenType.RETURN)
			case "d":
				return SimpleToken(type=TokenType.DIE_ROLL)
			case "b" | "below":
				return SimpleToken(type=TokenType.REROLL_BELOW)
			case "a" | "above":
				return SimpleToken(type=TokenType.REROLL_ABOVE)
			case "m" | "min":
				return SimpleToken(type=TokenType.MINIMUM)
			case "x" | "max":
				return SimpleToken(type=TokenType.MAXIMUM)
			case "TRUE" | "FALSE":
				return BoolToken(literal=symbol == "TRUE")
			case "NULL":
				return SimpleToken(type=TokenType.LITERAL_NULL)
			case _:
				return IdentifierToken(label=symbol)
