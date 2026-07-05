from __future__ import annotations
from dataclasses import dataclass
from enum import auto, Enum, StrEnum
from typing import Literal


class SymbolType(StrEnum):
	# control flow
	FN = "fn"  # TODO: do we want this?
	IF = "if"
	ELSE = "else"
	ELIF = "elif"
	FOR = "for"  # TODO: do we want this? (loop?)
	WHILE = "while"  # TODO: do we want this? (loop?)
	BREAK = "break"
	CONTINUE = "continue"
	RETURN = "return"  # TODO: do we want this? (coupled to fn)
	OPEN_BRACE = "{"  # TODO: do we want this? What would we even use it for?
	CLOSE_BRACE = "}"  # TODO: same as above

	# identifiers

	# literals

	# postfixes
	OPEN_PAREN = "("
	CLOSE_PAREN = ")"
	OPEN_BRACKET = "["
	CLOSE_BRACKET = "]"

	# unary operations
	INCREMENT = "++"
	DECREMENT = "--"
	LOGICAL_NOT = "!"
	BITWISE_NOT = "~"

	# die ops
	DIE_ROLL = "d"
	REROLL_BELOW = "b"  # or "below" to reroll the di(c)e below some amount
	REROLL_ABOVE = "a"  # or "above" to reroll the di(c)e above some amount
	MINIMUM = "m"  # or "min" to replace rolls below some amount with a minimum
	MAXIMUM = "x"  # or "max" to replace rolls above some amount with a maximum

	# arithmetic ops
	EXPONENT = "**"
	MULTIPLY = "*"
	DIVIDE = "/"
	FLOOR_DIVIDE = "//"
	MODULO = "%"
	ADD = "+"
	SUBTRACT = "-"

	# bitshift
	LSHIFT = "<<"
	RSHIFT = ">>"

	# comparison
	LESS_THAN = "<"
	LESS_THAN_EQUAL = "<="
	GREATER_THAN = ">"
	GREATER_THAN_EQUAL = ">="
	EQUAL = "=="  # equality notably lower than relational
	NOT_EQUAL = "!="

	# bitwise logic
	BITWISE_AND = "&"
	BITWISE_XOR = "^"
	BITWISE_OR = "|"

	# logic
	LOGICAL_AND = "&&"
	LOGICAL_OR = "||"

	# assignment
	DECLARATION = ":="
	ASSIGNMENT = "="
	ADDITION_ASSIGN = "+="
	SUBTRACTION_ASSIGN = "-="
	MULTIPLICATION_ASSIGN = "*="
	DIVISION_ASSIGN = "/="
	MODULUS_ASSIGN = "%="
	FLOOR_DIVISION_ASSIGN = "//="
	EXPONENTIATION_ASSIGN = "**="
	BITWISE_AND_ASSIGN = "&="
	BITWISE_OR_ASSIGN = "|="
	BITWISE_XOR_ASSIGN = "^="
	LSHIFT_ASSIGN = "<<="
	RSHIFT_ASSIGN = ">>="

	COMMA = ","

	EOF = "EOF"


class PayloadType(Enum):
	# identifiers
	IDENTIFIER = auto()

	# literals
	LITERAL_STRING = auto()
	LITERAL_NUMBER = auto()
	LITERAL_BOOL = auto()
	LITERAL_NULL = auto()


TokenType = SymbolType | PayloadType


@dataclass(frozen=True)
class SimpleToken:
	type: SymbolType


@dataclass(frozen=True)
class IdentifierToken:
	type: Literal[PayloadType.IDENTIFIER] = Payload.IDENTIFIER
	label: str


@dataclass(frozen=True)
class StringToken:
	type: Literal[PayloadType.LITERAL_STRING] = PayloadType.LITERAL_STRING
	literal: str


@dataclass(frozen=True)
class NumberToken:
	type: Literal[PayloadType.LITERAL_NUMBER] = PayloadType.LITERAL_NUMBER
	literal: str


@dataclass(frozen=True)
class BoolToken:
	type: Literal[PayloadType.LITERAL_BOOL] = PayloadType.LITERAL_BOOL
	literal: bool

@dataclass(frozen=True)
class NullToken:
	type: Literal[PayloadType.LITERAL_NULL] = PayloadType.LITERAL_NULL

Token = SimpleToken | IdentifierToken | StringToken | NumberToken | BoolToken | NullToken
