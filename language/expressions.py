from __future__ import annotations
from dataclasses import dataclass
from enum import StrEnum
from typing import Literal


class UnaryOp(StrEnum):
	INCREMENT = "++"
	DECREMENT = "--"
	LOGICAL_NOT = "!"
	BITWISE_NOT = "~"
	POSITIVE = "+"
	NEGATIVE = "-"


class BinaryOp(StrEnum):
	DIE_ROLL = "d"
	REROLL_BELOW = "b"
	REROLL_ABOVE = "a"
	MINIMUM = "m"
	MAXIMUM = "x"

	EXPONENT = "**"

	MULTIPLY = "*"
	DIVIDE = "/"
	FLOOR_DIVIDE = "/"
	MODULO = "%"

	ADD = "+"
	SUBTRACT = "-"

	LSHIFT = "<<"
	RSHIFT = ">>"

	LESS_THAN = "<"
	LESSTHAN_EQUAL = "<="
	GREATER_THAN = ">"
	GREATER_THAN_EQUAL = ">="

	EQUAL = "=="
	NOT_EQUAL = "!="

	BITWISE_AND = "&"
	BITWISE_XOR = "^"
	BITWISE_OR = "|"

	LOGICAL_AND = "&&"
	LOGICAL_OR = "||"

	DECLARATION = ":="
	ASSIGNMENT = "="
	ADDITION_ASSIGN = "+="
	SUBTRACTION_ASSIGN = "-="
	MULTIPLICATION_ASSIGN = "*="
	DIVISION_ASSIGN = "/="
	MODULUS_ASSIGN = "//="
	FLOOR_DIVISION_ASSIGN = "%="
	EXPONENTIATION_ASSIGN = "**="
	BITWISE_AND_ASSIGN = "&="
	BITWISE_XOR_ASSIGN = "^="
	BITWISE_OR_ASSIGN = "|="
	LSHIFT_ASSIGN = "<<="
	RSHIFT_ASSIGN = ">>="


class Type(StrEnum):
	DTYPE = "dtype"
	STRING = "str"
	FLOAT = "float"
	INT = "int"
	BOOL = "bool"
	NULL = "null"


@dataclass(frozen=True)
class PrimitiveType:
	type: Literal["primitive_type"]
	dtype: Literal[Type.DTYPE]


@dataclass(frozen=True)
class ArrayType:
	type: Literal["array_type"]
	dtype: Literal[Type.DTYPE]
	member_type: DataType


@dataclass(frozen=True)
class FunctionType:
	type: Literal["function_type"]
	dtype: Literal[Type.DTYPE]
	parameters: list[Identifier]
	returns: DataType | list[DataType]


DataType = PrimitiveType | ArrayType | FunctionType


@dataclass(frozen=True)
class Primitive:
	type: Literal["primitive"]
	dtype: PrimitiveType
	value: str | float | int | bool | None


@dataclass(frozen=True)
class Array:
	type: Literal["array"]
	dtype: ArrayType
	value: list


@dataclass(frozen=True)
class Function:
	type: Literal["function"]
	dtype: FunctionType
	body: list[Expression]


@dataclass(frozen=True)
class Identifier:
	type: Literal["identifier"]
	dtype: DataType
	identifier: str


@dataclass(frozen=True)
class Index:
	type: Literal["index"]
	dtype: ArrayType  # array type
	array: Expression
	index: Expression


@dataclass(frozen=True)
class Call:
	type: Literal["call"]
	dtype: DataType  # return type
	identifier: str
	args: list[Expression]


@dataclass(frozen=True)
class If:  # TODO: ternary
	type: Literal["if"]
	then_branch: list[Expression]
	elif_branches: list[tuple[Expression, list[Expression]]]
	else_branch: list[Expression]


@dataclass(frozen=True)
class For:
	type: Literal["for"]
	dtype: DataType  # TODO: yield keyword
	target: Identifier
	iterable: Expression
	body: list[Expression]


@dataclass(frozen=True)
class While:
	type: Literal["while"]
	dtype: DataType  # TODO: yield keyword
	test: Expression
	body: list[Expression]


@dataclass(frozen=True)
class Unary:
	type: Literal["unary"]
	dtype: DataType
	operation: UnaryOp
	operand: Expression
	operand_loc: Literal["before", "after"]


@dataclass(frozen=True)
class Binary:  # includes assignment and declaration
	type: Literal["binary"]
	dtype: DataType
	operation: BinaryOp
	left: Expression
	right: Expression


@dataclass(frozen=True)
class Return:
	type: Literal["return"]
	dtype: DataType
	expression: Expression


Expression = (
	Primitive
	| Array
	| Function
	| Identifier
	| Index
	| Call
	| Unary
	| If
	| For
	| While
	| Binary
	| Return
)
