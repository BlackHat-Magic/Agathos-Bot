import io
import unittest

from language.interpreter import Interpreter, RollResult, RuntimeErrorBase
from language.repl import format_result, run_repl


class FakeInterpreter(Interpreter):
	def __init__(
		self, results: tuple[object, ...] = (), errors: tuple[BaseException, ...] = ()
	):
		self.sources: list[str] = []
		self.results = iter(results)
		self.errors = iter(errors)

	def execute_source(self, source: str) -> object:
		self.sources.append(source)
		error = next(self.errors, None)
		if error is not None:
			raise error
		return next(self.results, "result")


class RaisingInput(io.StringIO):
	def readline(self, size: int = -1) -> str:
		raise KeyboardInterrupt


class ReplTests(unittest.TestCase):
	def run_repl_with(self, source, interpreter=None):
		output = io.StringIO()
		run_repl(io.StringIO(source), output, interpreter)
		return output.getvalue()

	def test_commands_print_help_and_exit_without_execution(self):
		interpreter = FakeInterpreter()

		output = self.run_repl_with("help\nexit\n", interpreter)

		self.assertEqual(interpreter.sources, [])
		self.assertIn("Commands: help, exit, quit\n", output)
		self.assertEqual(output.count(">>> "), 2)

	def test_results_are_printed_and_the_interpreter_is_reused(self):
		interpreter = FakeInterpreter(results=(1, "text"))

		output = self.run_repl_with("1\n2\nquit\n", interpreter)

		self.assertEqual(interpreter.sources, ["1\n", "2\n"])
		self.assertIn(">>> 1\n", output)
		self.assertIn(">>> text\n", output)

	def test_roll_results_use_their_format_method(self):
		result = RollResult(total=4, details=())

		self.assertEqual(format_result(result), "total=4 details=[]")
		self.assertEqual(format_result(4), "4")

	def test_expected_errors_are_printed_and_the_loop_continues(self):
		interpreter = FakeInterpreter(
			results=(7,),
			errors=(SyntaxError("bad syntax"), RuntimeErrorBase("bad runtime")),
		)

		output = self.run_repl_with("bad\nbad again\n7\nexit\n", interpreter)

		self.assertEqual(interpreter.sources, ["bad\n", "bad again\n", "7\n"])
		self.assertIn("Error: bad syntax\n", output)
		self.assertIn("Error: bad runtime\n", output)
		self.assertIn("7\n", output)
		self.assertNotIn("Traceback", output)

	def test_eof_quit_and_exit_end_the_loop(self):
		for command in ("", "quit\n", "exit\n"):
			with self.subTest(command=command):
				output = self.run_repl_with(command, FakeInterpreter())
				self.assertIn(">>> ", output)

	def test_keyboard_interrupt_cancels_cleanly(self):
		output = io.StringIO()

		run_repl(RaisingInput(), output, FakeInterpreter())

		self.assertEqual(output.getvalue(), ">>> \n")


class ReplIntegrationTests(unittest.TestCase):
	def test_real_interpreter_errors_do_not_stop_following_commands(self):
		output = io.StringIO()

		run_repl(io.StringIO("1 / 0\n2\nexit\n"), output, Interpreter())

		self.assertIn("Error: division or modulo by zero\n", output.getvalue())
		self.assertIn("2\n", output.getvalue())


if __name__ == "__main__":
	unittest.main()
