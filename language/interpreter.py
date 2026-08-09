"""Runtime primitives for the Agathos expression interpreter."""

from __future__ import annotations

import random
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from .expressions import (
	Array,
	Binary,
	BinaryOp,
	Block,
	Bool,
	Float,
	Identifier,
	Int,
	Null,
	PrimitiveType,
	String,
	Unary,
	UnaryOp,
	Expression,
)
from .lexer import Tokenizer
from .parser import Parser


class RuntimeErrorBase(Exception):
	"""Base class for errors raised while executing Agathos expressions."""


class UndefinedNameError(RuntimeErrorBase):
	"""Raised when an expression refers to an unbound name."""


class InvalidOperationError(RuntimeErrorBase):
	"""Raised when an expression requests an invalid runtime operation."""


class DivisionByZeroError(RuntimeErrorBase):
	"""Raised when an expression divides by zero."""


class InvalidDiceError(RuntimeErrorBase):
	"""Raised when an expression uses invalid dice parameters."""


class ExecutionLimitError(RuntimeErrorBase):
	"""Raised when expression execution exceeds its configured limit."""


class CallDepthError(RuntimeErrorBase):
	"""Raised when expression calls exceed the configured depth limit."""


@dataclass(frozen=True)
class DieRollDetail:
	"""Immutable detail for one group of dice."""

	sides: int
	rolls: tuple[int, ...]
	rerolls: tuple[tuple[int, ...], ...]
	dropped: tuple[int, ...]

	def format(self) -> str:
		"""Return a stable, human-readable representation of this detail."""
		return (
			f"d{self.sides} rolls={self.rolls!r} "
			f"rerolls={self.rerolls!r} dropped={self.dropped!r}"
		)


@dataclass(frozen=True)
class RollCompositionDetail:
	"""Immutable detail describing arithmetic around roll results."""

	operation: str
	left: int | float
	right: int | float
	result: int | float

	def format(self) -> str:
		"""Return a stable representation of one arithmetic composition."""
		return f"({self.left!r} {self.operation} {self.right!r} = {self.result!r})"


@dataclass(frozen=True)
class RollResult:
	"""A numeric result with immutable structured roll details."""

	total: int | float
	details: tuple[object, ...]

	def format(self) -> str:
		"""Return deterministic text containing the total and all details."""
		formatted = []
		for detail in self.details:
			if isinstance(detail, (DieRollDetail, RollCompositionDetail)):
				formatted.append(detail.format())
			else:
				formatted.append(repr(detail))
		return f"total={self.total!r} details=[{'; '.join(formatted)}]"


class RuntimeEnv:
	"""A lexical runtime frame with an optional read-only enclosing environment."""

	__slots__ = ("_parent", "_values")

	def __init__(self, parent: RuntimeEnv | None = None) -> None:
		"""Create an empty frame chained to ``parent`` when provided.

		Raises:
			TypeError: If ``parent`` is neither a ``RuntimeEnv`` nor ``None``.
		"""
		if parent is not None and not isinstance(parent, RuntimeEnv):
			raise TypeError("parent must be a RuntimeEnv or None")
		self._parent = parent
		self._values: dict[str, object] = {}

	@property
	def parent(self) -> RuntimeEnv | None:
		"""Return the enclosing environment without allowing reassignment."""
		return self._parent

	def child(self) -> RuntimeEnv:
		"""Return a new empty frame whose parent is this environment."""
		return RuntimeEnv(parent=self)

	def declare(self, name: str, value: object) -> None:
		"""Bind ``name`` in this frame, rejecting duplicate local bindings.

		Raises:
			InvalidOperationError: If ``name`` is already bound in this frame.
		"""
		if name in self._values:
			raise InvalidOperationError(f"name already declared: {name}")
		self._values[name] = value

	def lookup(self, name: str) -> object:
		"""Return the nearest binding for ``name``.

		Raises:
			UndefinedNameError: If ``name`` is not bound in this chain.
		"""
		if name in self._values:
			return self._values[name]
		if self._parent is not None:
			return self._parent.lookup(name)
		raise UndefinedNameError(f"undefined name: {name}")

	def assign(self, name: str, value: object) -> None:
		"""Update the nearest binding for ``name``.

		The update mutates the frame containing the nearest binding, which may be
		an ancestor of this environment.

		Raises:
			UndefinedNameError: If ``name`` is not bound in this chain.
		"""
		if name in self._values:
			self._values[name] = value
			return
		if self._parent is not None:
			self._parent.assign(name, value)
			return
		raise UndefinedNameError(f"undefined name: {name}")


class Interpreter:
	"""Execute the scalar and block subset of the Agathos expression language.

	Each call to :meth:`execute` starts with a fresh root environment and resets
	the execution counter. Declarations and assignments mutate only that
	execution's environments; the interpreter instance retains its configured
	random source and limits. Unsupported expression kinds and operators raise
	``InvalidOperationError``. Parsing errors from :meth:`execute_source` are
	propagated unchanged.
	"""

	def __init__(
		self,
		rng: random.Random | None = None,
		max_steps: int = 100_000,
		max_call_depth: int = 100,
	) -> None:
		"""Create an interpreter with optional randomness and execution limits.

		Raises:
			ValueError: If either execution limit is negative.
			TypeError: If a limit is not an integer.
		"""
		if not isinstance(max_steps, int) or isinstance(max_steps, bool):
			raise TypeError("max_steps must be an integer")
		if not isinstance(max_call_depth, int) or isinstance(max_call_depth, bool):
			raise TypeError("max_call_depth must be an integer")
		if max_steps < 0:
			raise ValueError("max_steps must not be negative")
		if max_call_depth < 0:
			raise ValueError("max_call_depth must not be negative")

		self.rng = rng if rng is not None else random.Random()
		self.max_steps = max_steps
		self.max_call_depth = max_call_depth
		self._steps = 0
		self._call_depth = 0

	def _tick(self) -> None:
		"""Account for one AST dispatch and enforce the step limit."""
		if self._steps >= self.max_steps:
			raise ExecutionLimitError(
				f"execution exceeded maximum step count: {self.max_steps}"
			)
		self._steps += 1

	def _evaluate(self, expression: Expression, environment: RuntimeEnv) -> object:
		self._tick()

		if isinstance(expression, String):
			return str(expression)
		if isinstance(expression, Float):
			return float(expression)
		if isinstance(expression, Bool):
			return bool(expression)
		if isinstance(expression, Int):
			return int(expression)
		if isinstance(expression, Null):
			return None
		if isinstance(expression, Array):
			return [self._evaluate(item, environment) for item in expression.value]
		if isinstance(expression, PrimitiveType):
			raise InvalidOperationError("type descriptors are not runtime values")
		if isinstance(expression, Identifier):
			value = environment.lookup(expression.label)
			if isinstance(value, PrimitiveType):
				raise InvalidOperationError("type descriptors are not runtime values")
			return value
		if isinstance(expression, Block):
			child = environment.child()
			value: object = None
			for child_expression in expression.body:
				value = self._evaluate(child_expression, child)
			return value
		if isinstance(expression, Unary):
			return self._evaluate_unary(expression, environment)
		if isinstance(expression, Binary):
			return self._evaluate_binary(expression, environment)

		raise InvalidOperationError(
			f"unsupported expression: {type(expression).__name__}"
		)

	@staticmethod
	def _numeric(value: object) -> int | float:
		"""Extract a non-boolean numeric value or reject it."""
		if isinstance(value, RollResult):
			value = value.total
		if isinstance(value, bool) or not isinstance(value, (int, float)):
			raise InvalidOperationError("expected a numeric operand")
		return value

	@staticmethod
	def _is_numeric(value: object) -> bool:
		return isinstance(value, RollResult) or (
			isinstance(value, (int, float)) and not isinstance(value, bool)
		)

	def _combine_result(
		self,
		left: object,
		right: object,
		total: int | float,
		operation: str,
	) -> int | float | RollResult:
		"""Preserve roll children and append one composition when needed."""
		if not isinstance(left, RollResult) and not isinstance(right, RollResult):
			return total

		details: list[object] = []
		if isinstance(left, RollResult):
			details.extend(left.details)
		if isinstance(right, RollResult):
			details.extend(right.details)
		details.append(
			RollCompositionDetail(
				operation=operation,
				left=self._numeric(left),
				right=self._numeric(right),
				result=total,
			)
		)
		return RollResult(total=total, details=tuple(details))

	def _combine_unary(
		self, value: object, total: int | float, operation: str
	) -> int | float | RollResult:
		if not isinstance(value, RollResult):
			return total
		return RollResult(
			total=total,
			details=(
				*value.details,
				RollCompositionDetail(
					operation=operation,
					left=self._numeric(value),
					right=0,
					result=total,
				),
			),
		)

	def _evaluate_unary(self, expression: Unary, environment: RuntimeEnv) -> object:
		operation = expression.operation
		if operation in (UnaryOp.INCREMENT, UnaryOp.DECREMENT):
			if not isinstance(expression.operand, Identifier):
				raise InvalidOperationError("increment target must be an identifier")
			old_value = environment.lookup(expression.operand.label)
			old_total = self._numeric(old_value)
			if not isinstance(old_total, int):
				raise InvalidOperationError("increment target must be an integer")
			delta = 1 if operation == UnaryOp.INCREMENT else -1
			new_value = self._combine_result(
				old_value, delta, old_total + delta, operation.value
			)
			environment.assign(expression.operand.label, new_value)
			return new_value if expression.operator_loc == "before" else old_value

		value = self._evaluate(expression.operand, environment)
		if operation == UnaryOp.LOGICAL_NOT:
			if not isinstance(value, bool):
				raise InvalidOperationError("logical not requires a boolean operand")
			return not value
		if operation == UnaryOp.BITWISE_NOT:
			numeric = self._numeric(value)
			if not isinstance(numeric, int):
				raise InvalidOperationError("bitwise not requires an integer operand")
			return self._combine_unary(value, ~numeric, operation.value)
		if operation in (UnaryOp.POSITIVE, UnaryOp.NEGATIVE):
			numeric = self._numeric(value)
			total = +numeric if operation == UnaryOp.POSITIVE else -numeric
			return self._combine_unary(value, total, operation.value)
		raise InvalidOperationError(f"operator is not implemented: {operation.value}")

	def _compare_values(self, left: object, right: object) -> tuple[Any, Any]:
		if self._is_numeric(left) and self._is_numeric(right):
			return self._numeric(left), self._numeric(right)
		if self._is_numeric(left) != self._is_numeric(right):
			raise InvalidOperationError(
				"comparison operands must have compatible types"
			)
		if type(left) is not type(right):
			raise InvalidOperationError(
				"comparison operands must have compatible types"
			)
		return left, right

	def _apply_binary(self, operation: BinaryOp, left: object, right: object) -> object:
		if operation in (
			BinaryOp.DIE_ROLL,
			BinaryOp.REROLL_BELOW,
			BinaryOp.REROLL_ABOVE,
			BinaryOp.MINIMUM,
			BinaryOp.MAXIMUM,
		):
			raise InvalidOperationError(
				f"operator is not implemented: {operation.value}"
			)

		if operation in (
			BinaryOp.ADD,
			BinaryOp.SUBTRACT,
			BinaryOp.MULTIPLY,
			BinaryOp.DIVIDE,
			BinaryOp.FLOOR_DIVIDE,
			BinaryOp.MODULO,
			BinaryOp.EXPONENT,
		):
			left_number = self._numeric(left)
			right_number = self._numeric(right)
			if (
				operation
				in (
					BinaryOp.DIVIDE,
					BinaryOp.FLOOR_DIVIDE,
					BinaryOp.MODULO,
				)
				and right_number == 0
			):
				raise DivisionByZeroError("division or modulo by zero")
			try:
				match operation:
					case BinaryOp.ADD:
						total = left_number + right_number
					case BinaryOp.SUBTRACT:
						total = left_number - right_number
					case BinaryOp.MULTIPLY:
						total = left_number * right_number
					case BinaryOp.DIVIDE:
						total = left_number / right_number
					case BinaryOp.FLOOR_DIVIDE:
						total = left_number // right_number
					case BinaryOp.MODULO:
						total = left_number % right_number
					case BinaryOp.EXPONENT:
						total = left_number**right_number
					case _:
						raise AssertionError(operation)
			except (ArithmeticError, TypeError, ValueError) as error:
				raise InvalidOperationError("invalid arithmetic operands") from error
			if not isinstance(total, (int, float)):
				raise InvalidOperationError("arithmetic did not produce a number")
			return self._combine_result(left, right, total, operation.value)

		if operation in (BinaryOp.LSHIFT, BinaryOp.RSHIFT):
			left_number = self._numeric(left)
			right_number = self._numeric(right)
			if not isinstance(left_number, int) or not isinstance(right_number, int):
				raise InvalidOperationError("shift operands must be integers")
			try:
				total = (
					left_number << right_number
					if operation == BinaryOp.LSHIFT
					else left_number >> right_number
				)
			except (ArithmeticError, ValueError) as error:
				raise InvalidOperationError("invalid shift operands") from error
			return self._combine_result(left, right, total, operation.value)

		if operation in (
			BinaryOp.BITWISE_AND,
			BinaryOp.BITWISE_XOR,
			BinaryOp.BITWISE_OR,
		):
			left_number = self._numeric(left)
			right_number = self._numeric(right)
			if not isinstance(left_number, int) or not isinstance(right_number, int):
				raise InvalidOperationError("bitwise operands must be integers")
			match operation:
				case BinaryOp.BITWISE_AND:
					total = left_number & right_number
				case BinaryOp.BITWISE_XOR:
					total = left_number ^ right_number
				case BinaryOp.BITWISE_OR:
					total = left_number | right_number
				case _:
					raise AssertionError(operation)
			return self._combine_result(left, right, total, operation.value)

		if operation in (
			BinaryOp.LESS_THAN,
			BinaryOp.LESS_THAN_EQUAL,
			BinaryOp.GREATER_THAN,
			BinaryOp.GREATER_THAN_EQUAL,
		):
			left_value, right_value = self._compare_values(left, right)
			try:
				match operation:
					case BinaryOp.LESS_THAN:
						return left_value < right_value
					case BinaryOp.LESS_THAN_EQUAL:
						return left_value <= right_value
					case BinaryOp.GREATER_THAN:
						return left_value > right_value
					case BinaryOp.GREATER_THAN_EQUAL:
						return left_value >= right_value
					case _:
						raise AssertionError(operation)
			except TypeError as error:
				raise InvalidOperationError("invalid comparison operands") from error

		if operation in (BinaryOp.EQUAL, BinaryOp.NOT_EQUAL):
			try:
				left_value, right_value = self._compare_values(left, right)
			except InvalidOperationError:
				return operation == BinaryOp.NOT_EQUAL
			result = left_value == right_value
			return not result if operation == BinaryOp.NOT_EQUAL else result

		if operation == BinaryOp.IN:
			if not isinstance(right, list):
				raise InvalidOperationError("membership right operand must be a list")
			return any(self._apply_binary(BinaryOp.EQUAL, left, item) for item in right)

		if operation in (BinaryOp.LOGICAL_AND, BinaryOp.LOGICAL_OR):
			if not isinstance(left, bool) or not isinstance(right, bool):
				raise InvalidOperationError("logical operands must be booleans")
			return (
				left and right if operation == BinaryOp.LOGICAL_AND else left or right
			)

		raise InvalidOperationError(f"operator is not implemented: {operation.value}")

	def _evaluate_binary(self, expression: Binary, environment: RuntimeEnv) -> object:
		if expression.operation in (
			BinaryOp.DECLARATION,
			BinaryOp.ASSIGNMENT,
			BinaryOp.ADDITION_ASSIGN,
			BinaryOp.SUBTRACTION_ASSIGN,
			BinaryOp.MULTIPLICATION_ASSIGN,
			BinaryOp.DIVISION_ASSIGN,
			BinaryOp.MODULUS_ASSIGN,
			BinaryOp.FLOOR_DIVISION_ASSIGN,
			BinaryOp.EXPONENTIATION_ASSIGN,
			BinaryOp.BITWISE_AND_ASSIGN,
			BinaryOp.BITWISE_XOR_ASSIGN,
			BinaryOp.BITWISE_OR_ASSIGN,
			BinaryOp.LSHIFT_ASSIGN,
			BinaryOp.RSHIFT_ASSIGN,
		):
			if not isinstance(expression.left, Identifier):
				raise InvalidOperationError("assignment target must be an identifier")
			if expression.operation == BinaryOp.DECLARATION:
				value = self._evaluate(expression.right, environment)
				environment.declare(expression.left.label, value)
				return value
			if expression.operation == BinaryOp.ASSIGNMENT:
				value = self._evaluate(expression.right, environment)
				environment.assign(expression.left.label, value)
				return value
			current = environment.lookup(expression.left.label)
			right = self._evaluate(expression.right, environment)
			base_operation = {
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
			}[expression.operation]
			value = self._apply_binary(base_operation, current, right)
			environment.assign(expression.left.label, value)
			return value

		if expression.operation in (
			BinaryOp.LOGICAL_AND,
			BinaryOp.LOGICAL_OR,
		):
			left = self._evaluate(expression.left, environment)
			if not isinstance(left, bool):
				raise InvalidOperationError("logical operands must be booleans")
			if expression.operation == BinaryOp.LOGICAL_AND and not left:
				return False
			if expression.operation == BinaryOp.LOGICAL_OR and left:
				return True
			right = self._evaluate(expression.right, environment)
			return self._apply_binary(expression.operation, left, right)

		left = self._evaluate(expression.left, environment)
		right = self._evaluate(expression.right, environment)
		return self._apply_binary(expression.operation, left, right)

	def execute(self, expressions: Sequence[Expression]) -> object:
		"""Evaluate expressions in order and return the latest result.

		The root environment and step counter are fresh for every call. An empty
		program returns ``None``. Runtime errors are raised as they occur, and
		partial environment changes are discarded when the call ends.
		"""
		self._steps = 0
		self._call_depth = 0
		environment = RuntimeEnv()
		value: object = None
		for expression in expressions:
			value = self._evaluate(expression, environment)
		return value

	def execute_source(self, source: str) -> object:
		"""Tokenize, parse, and execute one source program.

		Parsing errors and runtime errors are propagated to the caller. The
		program itself has no persistent environment or external side effects.
		"""
		expressions = Parser(Tokenizer(source).tokenize()).parse_program()
		return self.execute(expressions)


class _ReturnSignal(Exception):
	def __init__(self, value: object) -> None:
		super().__init__(value)
		self.value = value


class _BreakSignal(Exception):
	def __init__(self) -> None:
		super().__init__()


class _ContinueSignal(Exception):
	def __init__(self) -> None:
		super().__init__()


class _YieldSignal(Exception):
	def __init__(self, value: object) -> None:
		super().__init__(value)
		self.value = value
