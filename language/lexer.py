from .tokens import SymbolType, SimpleToken, IdentifierToken, StringToken, NumberToken, BoolToken, NullToken, Token

class Tokenizer:
	def __init__(self, program: str) -> None:
		self.program: list[str] = [char for char in program]

	def _peek(self, position: int = 0) -> str | None:
		if len(self.program) < 1:
			return None
		return self.program[position]

	def _advance(self) -> str | None:
		if len(self.program ) < 1:
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

		match (self._advance(), self._peek(0), self._peek(1)):
			case ("{", _, _):
				return SimpleToken(type=SymbolType.OPEN_BRACE)
			case ("}", _, _):
				return SimpleToken(type=SymbolType.CLOSE_BRACE)
			case ("(", _, _):
				return SimpleToken(type=SymbolType.OPEN_PAREN)
			case (")", _, _):
				return SimpleToken(type=SymbolType.CLOSE_PAREN)
			case ("[", _, _):
				return SimpleToken(type=SymbolType.OPEN_BRACKET)
			case ("]", _, _):
				return SimpleToken(type=SymbolType.CLOSE_BRACKET)

			case ("+", "+", _):
				self._advance()
				return SimpleToken(type=SymbolType.INCREMENT)
			case ("+", "=", _):
				self._advance()
				return SimpleToken(type=SymbolType.ADDITION_ASSIGN)
			case ("+", _, _):
				return SimpleToken(type=SymbolType.ADD)

			case ("-", "-", _):
				self._advance()
				return SimpleToken(type=SymbolType.DECREMENT)
			case ("-", "=", _):
				self._advance()
				return SimpleToken(type=SymbolType.SUBTRACTION_ASSIGN)
			case ("-", _, _):
				return SimpleToken(type=SymbolType.SUBTRACT)

			case ("!", "=", _):
				self._advance()
				return SimpleToken(type=SymbolType.NOT_EQUAL)
			case ("!", _, _):
				return SimpleToken(type=SymbolType.LOGICAL_NOT)

			case ("~", _, _):
				return SimpleToken(type=SymbolType.BITWISE_NOT)

			case ("*", "*", "="):
				self._advance()
				self._advance()
				return SimpleToken(type=SymbolType.EXPONENTIATION_ASSIGN)
			case ("*", "*", _):
				self._advance()
				return SimpleToken(type=SymbolType.EXPONENT)
			case ("*", "=", _):
				self._advance()
				return SimpleToken(type=SymbolType.MULTIPLICATION_ASSIGN)
			case ("*", _, _):
				return SimpleToken(type=SymbolType.MULTIPLY)

			case ("/", "/", "="):
				self._advance()
				self._advance()
				return SimpleToken(type=SymbolType.FLOOR_DIVISION_ASSIGN)
			case ("/", "/", _):
				self._advance()
				return SimpleToken(type=SymbolType.FLOOR_DIVIDE)
			case ("/", "=", _):
				self._advance()
				return SimpleToken(type=SymbolType.DIVISION_ASSIGN)
			case ("/", _, _):
				return SimpleToken(type=SymbolType.DIVIDE)

			case ("%", "=", _):
				self._advance()
				return SimpleToken(type=SymbolType.MODULUS_ASSIGN)
			case ("%", _, _):
				return SimpleToken(type=SymbolType.MODULO)

			case ("<", "<", "="):
				self._advance()
				self._advance()
				return SimpleToken(type=SymbolType.LSHIFT_ASSIGN)
			case ("<", "<", _):
				self._advance()
				return SimpleToken(type=SymbolType.LSHIFT)
			case ("<", "=", _):
				self._advance()
				return SimpleToken(type=SymbolType.LESS_THAN_EQUAL)
			case ("<", _):
				return SimpleToken(type=SymbolType.LESS_THAN)

			case (">", ">", "="):
				self._advance()
				self._advance()
				return SimpleToken(type=SymbolType.RSHIFT_ASSIGN)
			case (">", ">", _):
				self._advance()
				return SimpleToken(type=SymbolType.RSHIFT)
			case (">", "=", _):
				self._advance()
				return SimpleToken(type=SymbolType.GREATER_THAN_EQUAL)
			case (">", _):
				return SimpleToken(type=SymbolType.GREATER_THAN)

			case ("=", "=", _):
				self._advance()
				return SimpleToken(type=SymbolType.EQUAL)
			case ("=", _, _):
				return SimpleToken(type=SymbolType.ASSIGNMENT)

			case ("&", "&", _):
				self._advance()
				return SimpleToken(type=SymbolType.LOGICAL_AND)
			case ("&", "=", _):
				self._advance()
				return SimpleToken(type=SymbolType.BITWISE_AND_ASSIGN)
			case ("&", _, _):
				return SimpleToken(type=SymbolType.BITWISE_AND)

			case ("^", "=", _):
				self._advance()
				return SimpleToken(type=SymbolType.BITWISE_XOR_ASSIGN)
			case ("^", _, _):
				self._advance()
				return SimpleToken(type=SymbolType.BITWISE_XOR)

			case ("|", "|", _):
				self._advance()
				return SimpleToken(type=SymbolType.LOGICAL_OR)
			case ("|", "=", _):
				self._advance()
				return SimpleToken(type=SymbolType.BITWISE_OR_ASSIGN)
			case ("|", _, _):
				return SimpleToken(type=SymbolType.BITWISE_OR)

			case (":", "=", _):
				return SimpleToken(type=SymbolType.DECLARATION)

			case (",", _, _):
				return SimpleToken(type=SymbolType.COMMA)

			case (None, _, _):
				return SimpleToken(type=SymbolType.EOF)
			case (a, _, _) if a is not None and a in "\"'":	# TODO: this None check is redundant
				return self._tokenize_string(a)
			case (a, _, _) if a is not None and a.isdecimal() or a == ".":
				return self._tokenize_number(a)
			case (a, _, _) if a is not None and a.isalpha() or a == "_":
				return self._tokenize_complex(a)
			case _:
				raise SyntaxError	# TODO: better error handling

	def _tokenize_string(self, delimeter: str) -> StringToken:
		literal = ""
		escaped = False

		peeked = self._peek()
		while peeked != delimeter or escaped:
			if peeked is None:
				raise SyntaxError	# TODO: better error handling

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
				return SimpleToken(type=SymbolType.FN)
			case "if":
				return SimpleToken(type=SymbolType.IF)
			case "else":
				return SimpleToken(type=SymbolType.ELSE)
			case "elif":
				return SimpleToken(type=SymbolType.ELIF)
			case "for":
				return SimpleToken(type=SymbolType.FOR)
			case "while":
				return SimpleToken(type=SymbolType.WHILE)
			case "break":
				return SimpleToken(type=SymbolType.BREAK)
			case "continue":
				return SimpleToken(type=SymbolType.CONTINUE)
			case "return":
				return SimpleToken(type=SymbolType.RETURN)
			case "d":
				return SimpleToken(type=SymbolType.DIE_ROLL)
			case "b" | "below":
				return SimpleToken(type=SymbolType.REROLL_BELOW)
			case "a" | "above":
				return SimpleToken(type=SymbolType.REROLL_ABOVE)
			case "m" | "min":
				return SimpleToken(type=SymbolType.MINIMUM)
			case "x" | "max":
				return SimpleToken(type=SymbolType.MAXIMUM)
			case "TRUE" | "FALSE":
				return BoolToken(literal=symbol == "TRUE")
			case "NULL":
				return NullToken()
			case _:
				return IdentifierToken(label=symbol)
