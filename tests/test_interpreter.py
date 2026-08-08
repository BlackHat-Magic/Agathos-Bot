import unittest
from typing import cast

from language.interpreter import (
	CallDepthError,
	DivisionByZeroError,
	ExecutionLimitError,
	InvalidDiceError,
	InvalidOperationError,
	RuntimeEnv,
	RuntimeErrorBase,
	UndefinedNameError,
	_BreakSignal,
	_ContinueSignal,
	_ReturnSignal,
	_YieldSignal,
)


class RuntimeEnvTests(unittest.TestCase):
	def test_declaration_stores_value_in_current_environment(self):
		env = RuntimeEnv()

		env.declare("answer", 42)

		self.assertEqual(env.lookup("answer"), 42)

	def test_child_environment_shadows_parent(self):
		parent = RuntimeEnv()
		parent.declare("value", "outer")
		child = parent.child()

		child.declare("value", "inner")

		self.assertEqual(parent.lookup("value"), "outer")
		self.assertEqual(child.lookup("value"), "inner")

	def test_assignment_updates_nearest_same_name_binding_only(self):
		parent = RuntimeEnv()
		parent.declare("value", "outer")
		child = parent.child()
		child.declare("value", "inner")

		child.assign("value", "updated")

		self.assertEqual(child.lookup("value"), "updated")
		self.assertEqual(parent.lookup("value"), "outer")

	def test_assignment_updates_ancestor_when_child_has_no_binding(self):
		parent = RuntimeEnv()
		parent.declare("value", "outer")
		child = parent.child()

		child.assign("value", "updated")

		self.assertEqual(parent.lookup("value"), "updated")

	def test_lookup_rejects_undefined_name(self):
		with self.assertRaises(UndefinedNameError):
			RuntimeEnv().lookup("missing")

	def test_assignment_rejects_undefined_name(self):
		with self.assertRaises(UndefinedNameError):
			RuntimeEnv().assign("missing", 1)

	def test_declaration_rejects_duplicate_current_binding(self):
		env = RuntimeEnv()
		env.declare("value", 1)

		with self.assertRaises(InvalidOperationError):
			env.declare("value", 2)

	def test_child_declaration_can_shadow_without_duplicate_error(self):
		parent = RuntimeEnv()
		parent.declare("value", 1)
		child = parent.child()

		child.declare("value", 2)

		self.assertEqual(child.lookup("value"), 2)

	def test_parent_must_be_runtime_environment(self):
		with self.assertRaises(TypeError):
			RuntimeEnv(parent=cast(RuntimeEnv, object()))

	def test_parent_link_is_read_only(self):
		parent = RuntimeEnv()
		child = parent.child()

		with self.assertRaises(AttributeError):
			setattr(child, "parent", child)

		self.assertIs(child.parent, parent)


class RuntimeErrorHierarchyTests(unittest.TestCase):
	def test_runtime_errors_share_common_base(self):
		error_types = (
			UndefinedNameError,
			InvalidOperationError,
			DivisionByZeroError,
			InvalidDiceError,
			ExecutionLimitError,
			CallDepthError,
		)

		for error_type in error_types:
			with self.subTest(error_type=error_type):
				self.assertTrue(issubclass(error_type, RuntimeErrorBase))
				self.assertTrue(issubclass(error_type, Exception))


class RuntimeControlSignalTests(unittest.TestCase):
	def test_value_signals_preserve_value_and_exception_args(self):
		for signal_type in (_ReturnSignal, _YieldSignal):
			with self.subTest(signal_type=signal_type):
				signal = signal_type("value")
				self.assertEqual(signal.value, "value")
				self.assertEqual(signal.args, ("value",))
				self.assertNotEqual(signal, signal_type("value"))

	def test_empty_signals_have_no_value_or_exception_args(self):
		for signal_type in (_BreakSignal, _ContinueSignal):
			with self.subTest(signal_type=signal_type):
				signal = signal_type()
				self.assertEqual(signal.args, ())
				self.assertNotEqual(signal, signal_type())


if __name__ == "__main__":
	unittest.main()
