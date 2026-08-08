"""Runtime primitives for the Agathos expression interpreter."""

from __future__ import annotations


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
