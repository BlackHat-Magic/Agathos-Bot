"""Runtime primitives for the Agathos expression interpreter."""

from __future__ import annotations

import random
from collections.abc import Sequence

from .expressions import (
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
		if isinstance(expression, Binary):
			return self._evaluate_binary(expression, environment)

		raise InvalidOperationError(
			f"unsupported expression: {type(expression).__name__}"
		)

	def _evaluate_binary(self, expression: Binary, environment: RuntimeEnv) -> object:
		if expression.operation not in (
			BinaryOp.DECLARATION,
			BinaryOp.ASSIGNMENT,
		):
			raise InvalidOperationError(
				f"operator is not implemented: {expression.operation.value}"
			)
		if not isinstance(expression.left, Identifier):
			raise InvalidOperationError("assignment target must be an identifier")

		if expression.operation == BinaryOp.DECLARATION:
			value = self._evaluate(expression.right, environment)
			environment.declare(expression.left.label, value)
			return value
		value = self._evaluate(expression.right, environment)
		environment.assign(expression.left.label, value)
		return value

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
