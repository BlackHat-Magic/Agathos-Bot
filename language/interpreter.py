"""Runtime primitives for the Agathos expression interpreter."""

from __future__ import annotations

import random
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any

from .expressions import (
	Array,
	ArrayType,
	Binary,
	BinaryOp,
	Block,
	Bool,
	Call,
	Float,
	Function,
	FunctionType,
	Identifier,
	Int,
	Null,
	PrimitiveType,
	Return,
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


@dataclass(frozen=True, init=False)
class DieRollDetail:
	"""Immutable detail for one group of dice."""

	sides: int
	rolls: tuple[int, ...]
	rerolls: tuple[tuple[int, ...], ...]
	dropped: tuple[int, ...]
	clamped: tuple[tuple[tuple[int, int], ...], ...]
	values: tuple[int, ...]
	nested: tuple[object, ...]

	def __init__(
		self,
		sides: int,
		rolls: Iterable[int],
		rerolls: Iterable[Iterable[int]],
		dropped: Iterable[int],
		clamped: Iterable[object] = (),
		values: Iterable[object] | None = None,
		nested: Iterable[object] = (),
	) -> None:
		rolls_tuple = tuple(rolls)
		rerolls_tuple = tuple(tuple(roll) for roll in rerolls)
		normalized_clamped: list[tuple[tuple[int, int], ...]] = []
		for clamp in clamped:
			if clamp is None:
				normalized_clamped.append(())
				continue
			if not isinstance(clamp, Iterable):
				raise TypeError("clamped entries must be iterable")
			clamp_values = tuple(clamp)
			if len(clamp_values) == 2:
				original, replacement = clamp_values
				if (
					isinstance(original, int)
					and not isinstance(original, bool)
					and isinstance(replacement, int)
					and not isinstance(replacement, bool)
				):
					normalized_clamped.append(((original, replacement),))
					continue
			history: list[tuple[int, int]] = []
			for pair in clamp_values:
				if not isinstance(pair, Iterable):
					raise ValueError("clamped entries must be pairs of integers")
				try:
					original, replacement = tuple(pair)
				except (TypeError, ValueError) as error:
					raise ValueError(
						"clamped entries must be pairs of integers"
					) from error
				if (
					not isinstance(original, int)
					or isinstance(original, bool)
					or not isinstance(replacement, int)
					or isinstance(replacement, bool)
				):
					raise TypeError("clamped entries must contain integers")
				history.append((original, replacement))
			normalized_clamped.append(tuple(history))
		clamped_tuple = tuple(normalized_clamped)
		if values is None:
			current_values = []
			for index, original in enumerate(rolls_tuple):
				reroll = rerolls_tuple[index] if index < len(rerolls_tuple) else ()
				value = reroll[-1] if reroll else original
				clamp_history = (
					clamped_tuple[index] if index < len(clamped_tuple) else ()
				)
				if clamp_history:
					value = clamp_history[-1][1]
				current_values.append(value)
			values_tuple = tuple(current_values)
		else:
			values_tuple = tuple(values)
			if len(values_tuple) != len(rolls_tuple):
				raise ValueError("values must contain one value per tracked die")
			if any(
				not isinstance(value, int) or isinstance(value, bool)
				for value in values_tuple
			):
				raise TypeError("values must contain integers")
		object.__setattr__(self, "sides", sides)
		object.__setattr__(self, "rolls", rolls_tuple)
		object.__setattr__(self, "rerolls", rerolls_tuple)
		object.__setattr__(self, "dropped", tuple(dropped))
		object.__setattr__(self, "clamped", clamped_tuple)
		object.__setattr__(self, "values", values_tuple)
		object.__setattr__(self, "nested", tuple(nested))

	def format(self) -> str:
		"""Return a stable, human-readable representation of this detail."""
		formatted = (
			f"d{self.sides} rolls={self.rolls!r} "
			f"rerolls={self.rerolls!r} values={self.values!r} "
			f"dropped={self.dropped!r}"
		)
		if any(self.clamped):
			formatted += f" clamped={self.clamped!r}"
		if self.nested:
			formatted_nested = []
			for detail in self.nested:
				if isinstance(detail, (DieRollDetail, RollCompositionDetail)):
					formatted_nested.append(detail.format())
				else:
					formatted_nested.append(repr(detail))
			formatted += f" nested=[{'; '.join(formatted_nested)}]"
		return formatted


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


@dataclass(frozen=True, init=False)
class RollResult:
	"""A numeric result with immutable structured roll details."""

	total: int | float
	details: tuple[object, ...]

	def __init__(self, total: int | float, details: Iterable[object]) -> None:
		object.__setattr__(self, "total", total)
		object.__setattr__(self, "details", tuple(details))

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


@dataclass(frozen=True)
class RuntimeFunction:
	"""A named function and the environment in which it was declared."""

	function: Function
	environment: RuntimeEnv


class Interpreter:
	"""Execute the scalar, block, and function subset of Agathos.

	Each call to :meth:`execute` starts with a fresh root environment and resets
	the execution counter. Declarations and assignments mutate only that
	execution's environments; the interpreter instance retains its configured
	random source and limits. Unsupported expression kinds and operators raise
	``InvalidOperationError``. Parsing errors from :meth:`execute_source` are
	propagated unchanged.

	Function definitions bind a named :class:`RuntimeFunction` in the current
	lexical environment. A function captures that environment, and each call
	uses a child frame for its parameters and local declarations, so nested
	functions and recursive calls resolve names lexically. ``return`` exits the
	nearest function; explicit values are checked against the function's
	declared return type, while no-value functions may return only ``None``.
	Calls at or beyond ``max_call_depth`` raise :class:`CallDepthError`.
	"""

	def __init__(
		self,
		rng: random.Random | None = None,
		max_steps: int = 100_000,
		max_call_depth: int = 100,
	) -> None:
		"""Create an interpreter with optional randomness and execution limits.

		``max_call_depth`` limits active nested function calls. A call that would
		exceed it raises :class:`CallDepthError`, and the depth counter is restored
		even when a call raises another runtime error.

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
		if isinstance(expression, Function):
			environment.declare(
				expression.name, RuntimeFunction(expression, environment)
			)
			return None
		if isinstance(expression, Call):
			callee = self._evaluate(expression.callee, environment)
			arguments = [
				self._evaluate(argument, environment) for argument in expression.args
			]
			if not isinstance(callee, RuntimeFunction):
				raise InvalidOperationError("callee is not a runtime function")
			function = callee.function
			if not isinstance(function.dtype, FunctionType):
				raise InvalidOperationError(
					f"function has an invalid type descriptor: {function.name}"
				)
			if len(arguments) != len(function.dtype.parameters):
				raise InvalidOperationError(
					"function called with incorrect argument count"
				)
			if self._call_depth >= self.max_call_depth:
				raise CallDepthError(
					f"call depth exceeded maximum: {self.max_call_depth}"
				)
			self._call_depth += 1
			try:
				call_environment = callee.environment.child()
				for parameter, argument in zip(function.dtype.parameters, arguments):
					call_environment.declare(parameter.label, argument)
				try:
					self._evaluate(function.body, call_environment)
				except _ReturnSignal as signal:
					return self._validate_function_return(function, signal.value)
				if function.dtype.returns is not None:
					raise InvalidOperationError(
						f"value-returning function fell through: {function.name}"
					)
				return None
			finally:
				self._call_depth -= 1
		if isinstance(expression, Return):
			value = (
				self._evaluate(expression.expression, environment)
				if expression.expression is not None
				else None
			)
			raise _ReturnSignal(value)
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

	@classmethod
	def _matches_return_type(cls, value: object, return_type: object) -> bool:
		"""Return whether a runtime value satisfies a function return contract."""
		if return_type is None:
			return value is None
		if value is None:
			return False
		if isinstance(return_type, ArrayType):
			return isinstance(value, list) and all(
				cls._matches_return_type(item, return_type.member_type)
				for item in value
			)
		if isinstance(return_type, FunctionType):
			return isinstance(value, RuntimeFunction)
		if return_type in (int, float) and isinstance(value, RollResult):
			value = value.total
		return isinstance(return_type, type) and type(value) is return_type

	@classmethod
	def _validate_function_return(cls, function: Function, value: object) -> object:
		"""Validate and return a value emitted by a function's return signal."""
		if not isinstance(function.dtype, FunctionType):
			raise InvalidOperationError(
				f"function has an invalid type descriptor: {function.name}"
			)
		if not cls._matches_return_type(value, function.dtype.returns):
			expected = (
				"no value"
				if function.dtype.returns is None
				else repr(function.dtype.returns)
			)
			raise InvalidOperationError(
				f"invalid return value for function {function.name}: expected {expected}"
			)
		return value

	@staticmethod
	def _is_numeric(value: object) -> bool:
		return isinstance(value, RollResult) or (
			isinstance(value, (int, float)) and not isinstance(value, bool)
		)

	@classmethod
	def _dice_integer(cls, value: object, name: str) -> int:
		try:
			numeric = cls._numeric(value)
		except InvalidOperationError as error:
			raise InvalidDiceError(f"{name} must be numeric") from error
		if isinstance(numeric, float) and not numeric.is_integer():
			raise InvalidDiceError(f"{name} must be integral")
		return int(numeric)

	def _roll_dice(self, count: int, sides: int) -> DieRollDetail:
		rolls = []
		for _ in range(count):
			self._tick()
			rolls.append(self.rng.randint(1, sides))
		return DieRollDetail(
			sides=sides,
			rolls=rolls,
			rerolls=[()] * count,
			dropped=(),
			values=rolls,
		)

	@staticmethod
	def _detail_values(detail: DieRollDetail) -> list[int]:
		return list(detail.values)

	def _modify_dice(
		self, operation: BinaryOp, left: object, right: object
	) -> RollResult:
		if not isinstance(left, RollResult):
			raise InvalidDiceError("dice modifiers require a roll result")
		threshold = self._dice_integer(right, "dice threshold")
		new_details: list[object] = []
		total_delta = 0
		for detail in left.details:
			if not isinstance(detail, DieRollDetail):
				new_details.append(detail)
				continue

			previous_values = self._detail_values(detail)
			values = previous_values.copy()
			rerolls = [
				list(detail.rerolls[index]) if index < len(detail.rerolls) else []
				for index in range(len(detail.rolls))
			]
			clamped = [
				list(detail.clamped[index]) if index < len(detail.clamped) else []
				for index in range(len(detail.rolls))
			]
			for index, value in enumerate(values):
				if operation in (BinaryOp.REROLL_BELOW, BinaryOp.REROLL_ABOVE):
					qualifies = (
						value < threshold
						if operation == BinaryOp.REROLL_BELOW
						else value > threshold
					)
					while qualifies:
						self._tick()
						value = self.rng.randint(1, detail.sides)
						rerolls[index].append(value)
						qualifies = (
							value < threshold
							if operation == BinaryOp.REROLL_BELOW
							else value > threshold
						)
				else:
					qualifies = (
						value < threshold
						if operation == BinaryOp.MINIMUM
						else value > threshold
					)
					if qualifies:
						clamped[index].append((value, threshold))
						value = threshold
				values[index] = value

			total_delta += sum(values) - sum(previous_values)
			clamp_details = clamped if any(clamped) else ()
			new_details.append(
				DieRollDetail(
					sides=detail.sides,
					rolls=detail.rolls,
					rerolls=rerolls,
					dropped=detail.dropped,
					clamped=clamp_details,
					values=values,
					nested=detail.nested,
				)
			)

		return RollResult(total=left.total + total_delta, details=new_details)

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
		if operation == BinaryOp.DIE_ROLL:
			count = self._dice_integer(left, "dice count")
			sides = self._dice_integer(right, "dice sides")
			if count < 0:
				raise InvalidDiceError("dice count must not be negative")
			if sides < 1:
				raise InvalidDiceError("dice sides must be at least one")
			detail = self._roll_dice(count, sides)
			parent_details = left.details if isinstance(left, RollResult) else ()
			if parent_details:
				detail = DieRollDetail(
					sides=detail.sides,
					rolls=detail.rolls,
					rerolls=detail.rerolls,
					dropped=detail.dropped,
					clamped=detail.clamped,
					values=detail.values,
					nested=parent_details,
				)
			return RollResult(
				total=sum(detail.values),
				details=(detail,) if count or parent_details else (),
			)

		if operation in (
			BinaryOp.REROLL_BELOW,
			BinaryOp.REROLL_ABOVE,
			BinaryOp.MINIMUM,
			BinaryOp.MAXIMUM,
		):
			return self._modify_dice(operation, left, right)

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
		partial environment changes are discarded when the call ends. Function
		definitions capture the environment where they execute; calls create
		lexical child frames, and ``return`` exits the nearest function after its
		value is checked against the declared return mode and type. A call that
		would exceed ``max_call_depth`` raises :class:`CallDepthError`.

		Raises:
			CallDepthError: If nested function calls exceed ``max_call_depth``.
			InvalidOperationError: If a return escapes a function or violates its
				declared return contract.
		"""
		self._steps = 0
		self._call_depth = 0
		environment = RuntimeEnv()
		value: object = None
		try:
			for expression in expressions:
				value = self._evaluate(expression, environment)
		except _ReturnSignal as signal:
			raise InvalidOperationError("return outside a function") from signal
		return value

	def execute_source(self, source: str) -> object:
		"""Tokenize, parse, and execute one source program.

		Function declarations become available after their declaration executes,
		and calls use lexical closures over the declaration environment. Explicit
		returns are validated at the call boundary; value-returning functions must
		produce their declared type, while no-value functions return ``None``.
		Parsing errors, :class:`CallDepthError`, and other runtime errors are
		propagated to the caller. The program itself has no persistent environment
		or external side effects.
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
