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
	FLOOR_DIVIDE = "//"
	MODULO = "%"

	ADD = "+"
	SUBTRACT = "-"

	LSHIFT = "<<"
	RSHIFT = ">>"

	LESS_THAN = "<"
	LESS_THAN_EQUAL = "<="
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
	MODULUS_ASSIGN = "%="
	FLOOR_DIVISION_ASSIGN = "//="
	EXPONENTIATION_ASSIGN = "**="
	BITWISE_AND_ASSIGN = "&="
	BITWISE_XOR_ASSIGN = "^="
	BITWISE_OR_ASSIGN = "|="
	LSHIFT_ASSIGN = "<<="
	RSHIFT_ASSIGN = ">>="


# instead of an enum
Type = type | str | float | int | bool | None
BuiltinType = type


@dataclass(frozen=True)
class PrimitiveType:
	value: Type
	dtype: BuiltinType = type
	type: Literal["primitive_type"] = "primitive_type"


@dataclass(frozen=True)
class ArrayType:
	member_type: DataType
	dtype: BuiltinType = type
	type: Literal["array_type"] = "array_type"


@dataclass(frozen=True)
class FunctionType:
	parameters: list[Identifier]
	returns: DataType
	dtype: BuiltinType = type
	type: Literal["function_type"] = "function_type"


DataType = type | ArrayType | FunctionType | None


@dataclass(frozen=True, init=False, eq=False)
class String(str):
	type: Literal["literal"] = "literal"
	dtype: BuiltinType = str


@dataclass(frozen=True, init=False, eq=False)
class Float(float):
	type: Literal["literal"] = "literal"
	dtype: BuiltinType = float


@dataclass(frozen=True, init=False, eq=False)
class Int(int):
	type: Literal["literal"] = "literal"
	dtype: BuiltinType = int


@dataclass(frozen=True, init=False, eq=False)
class Bool(int):
	type: Literal["literal"] = "literal"
	dtype: BuiltinType = bool


@dataclass(frozen=True)
class Null:
	type: Literal["literal"] = "literal"
	dtype: None = None


@dataclass(frozen=True)
class Array:
	type: Literal["array"]
	dtype: ArrayType
	value: list[Expression]


@dataclass(frozen=True)
class Function:
	type: Literal["function"]
	dtype: FunctionType
	body: Block


@dataclass(frozen=True)
class Identifier:
	type: Literal["identifier"]
	dtype: DataType
	label: str


@dataclass(frozen=True)
class Index:
	type: Literal["index"]
	dtype: DataType  # member type (what gets returned by indexing)
	array: Expression
	index: Expression


@dataclass(frozen=True)
class Call:
	type: Literal["call"]
	dtype: DataType  # return type
	callee: Expression
	args: list[Expression]


@dataclass(frozen=True)
class If:
	type: Literal["if"]
	dtype: DataType
	then_branch: Block
	elif_branches: list[tuple[Expression, Block]]
	else_branch: Block | None
	has_value: bool = False


@dataclass(frozen=True)
class For:
	type: Literal["for"]
	dtype: DataType
	target: Identifier
	iterable: Expression
	body: Block
	has_value: bool = False


@dataclass(frozen=True)
class While:
	type: Literal["while"]
	dtype: DataType
	test: Expression
	body: Block
	has_value: bool = False


@dataclass(frozen=True)
class Block:
	type: Literal["block"]
	dtype: DataType
	body: list[Expression]
	has_value: bool = False


@dataclass(frozen=True)
class Unary:
	type: Literal["unary"]
	dtype: DataType
	operation: UnaryOp
	operand: Expression
	operator_loc: Literal["before", "after"]


@dataclass(frozen=True)
class Binary:  # includes assignment and declaration
	type: Literal["binary"]
	dtype: DataType
	operation: BinaryOp
	left: Expression
	right: Expression


@dataclass(frozen=True)
class Ternary:
	type: Literal["ternary"]
	dtype: DataType
	if_true: Expression
	condition: Expression
	if_false: Expression


@dataclass(frozen=True)
class Return:
	type: Literal["return"]
	dtype: DataType
	expression: Expression


@dataclass(frozen=True)
class Yield:
	type: Literal["yield"]
	dtype: DataType
	expression: Expression
	has_value: bool = True


Expression = (
	String
	| Float
	| Int
	| Bool
	| Null
	| PrimitiveType
	| Array
	| Function
	| Identifier
	| Index
	| Call
	| Unary
	| If
	| For
	| While
	| Block
	| Binary
	| Ternary
	| Return
	| Yield
)
