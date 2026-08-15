from __future__ import annotations
from dataclasses import dataclass
from enum import StrEnum
from typing import Literal


class TokenType(StrEnum):
	# control flow
	FUNCTION = "::"  # TODO: do we want this?
	IF = "if"
	ELSE = "else"
	ELIF = "elif"
	FOR = "for"  # TODO: do we want this? (loop?)
	IN = "in"
	WHILE = "while"  # TODO: do we want this? (loop?)
	BREAK = "break"
	CONTINUE = "continue"
	RETURN = "return"  # TODO: do we want this? (coupled to fn)
	YIELD = "yield"
	OPEN_BRACE = "{"  # TODO: do we want this? What would we even use it for?
	CLOSE_BRACE = "}"  # TODO: same as above

	# identifiers
	DTYPE_STRING = "str"
	DTYPE_FLOAT = "float"
	DTYPE_INT = "int"
	DTYPE_BOOL = "bool"

	# literals
	LITERAL_NULL = "null"

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
	DROP_LOWEST = "l"
	DROP_HIGHEST = "h"

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
	COLON = ":"
	SEMICOLON = ";"
	EOF = "EOF"


@dataclass(frozen=True)
class SimpleToken:
	type: TokenType


@dataclass(frozen=True)
class IdentifierToken:
	type: Literal["identifier"]
	label: str


@dataclass(frozen=True)
class StringToken:
	type: Literal["literal_string"]
	literal: str


@dataclass(frozen=True)
class NumberToken:
	type: Literal["literal_number"]
	literal: str


@dataclass(frozen=True)
class BoolToken:
	type: Literal["literal_bool"]
	literal: bool


Token = SimpleToken | IdentifierToken | StringToken | NumberToken | BoolToken
