"""Runtime primitives for the Agathos expression interpreter."""

from __future__ import annotations

from dataclasses import dataclass


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
	"""A lexical runtime frame with an optional enclosing environment."""

	def __init__(self, parent: RuntimeEnv | None = None) -> None:
		"""Create an empty frame chained to ``parent`` when provided."""
		self.parent = parent
		self._values: dict[str, object] = {}

	def child(self) -> RuntimeEnv:
		"""Return a new empty frame whose parent is this environment."""
		return RuntimeEnv(parent=self)

	def declare(self, name: str, value: object) -> None:
		"""Bind ``name`` in this frame, rejecting duplicate local bindings."""
		if name in self._values:
			raise InvalidOperationError(f"name already declared: {name}")
		self._values[name] = value

	def lookup(self, name: str) -> object:
		"""Return the nearest binding for ``name`` or raise if it is undefined."""
		if name in self._values:
			return self._values[name]
		if self.parent is not None:
			return self.parent.lookup(name)
		raise UndefinedNameError(f"undefined name: {name}")

	def assign(self, name: str, value: object) -> None:
		"""Update the nearest binding for ``name`` or raise if it is undefined."""
		if name in self._values:
			self._values[name] = value
			return
		if self.parent is not None:
			self.parent.assign(name, value)
			return
		raise UndefinedNameError(f"undefined name: {name}")


@dataclass
class _ReturnSignal(Exception):
	value: object


@dataclass
class _BreakSignal(Exception):
	pass


@dataclass
class _ContinueSignal(Exception):
	pass


@dataclass
class _YieldSignal(Exception):
	value: object
