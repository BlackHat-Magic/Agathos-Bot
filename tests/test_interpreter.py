import unittest

from language.interpreter import (
	CallDepthError,
	DivisionByZeroError,
	ExecutionLimitError,
	InvalidDiceError,
	InvalidOperationError,
	RuntimeEnv,
	RuntimeErrorBase,
	UndefinedNameError,
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

	def test_assignment_updates_nearest_binding(self):
		parent = RuntimeEnv()
		parent.declare("outer", 1)
		child = parent.child()
		child.declare("inner", 2)

		child.assign("inner", 3)
		child.assign("outer", 4)

		self.assertEqual(child.lookup("inner"), 3)
		self.assertEqual(parent.lookup("outer"), 4)

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


if __name__ == "__main__":
	unittest.main()
