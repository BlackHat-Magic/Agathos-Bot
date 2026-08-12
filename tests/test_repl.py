import io
import unittest

from language.interpreter import Interpreter, RollResult, RuntimeErrorBase
from language.repl import _write_prompt, format_result, run_repl


class FakeInterpreter(Interpreter):
	def __init__(
		self,
		results: tuple[object, ...] = (),
		errors: tuple[BaseException, ...] = (),
		interrupt_on_execute: bool = False,
	):
		self.sources: list[str] = []
		self.results = iter(results)
		self.errors = iter(errors)
		self.interrupt_on_execute = interrupt_on_execute

	def execute_source(self, source: str) -> object:
		self.sources.append(source)
		if self.interrupt_on_execute:
			self.interrupt_on_execute = False
			raise KeyboardInterrupt
		error = next(self.errors, None)
		if error is not None:
			raise error
		return next(self.results, "result")


class RaisingInput(io.StringIO):
	def __init__(self, events: list[tuple[str, str | None]]):
		super().__init__("exit\n")
		self.events = events
		self.interrupt = True

	def readline(self, size: int = -1) -> str:
		self.events.append(("read", None))
		if self.interrupt:
			self.interrupt = False
			raise KeyboardInterrupt
		return super().readline(size)


class TrackingInput(io.StringIO):
	def __init__(self, source: str, events: list[tuple[str, str | None]]):
		super().__init__(source)
		self.events = events

	def readline(self, size: int = -1) -> str:
		self.events.append(("read", None))
		return super().readline(size)


class TrackingOutput(io.StringIO):
	def __init__(self, events: list[tuple[str, str | None]]):
		super().__init__()
		self.events = events

	def write(self, value: str) -> int:
		self.events.append(("write", value))
		return super().write(value)

	def flush(self) -> None:
		self.events.append(("flush", None))
		super().flush()


class HostileFormattable:
	def __str__(self) -> str:
		return "safe string"

	def format(self) -> str:
		raise AssertionError("format must not be called")


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
		self.assertEqual(format_result("{}"), "{}")
		self.assertEqual(format_result(HostileFormattable()), "safe string")

	def test_prompts_flush_before_input(self):
		events: list[tuple[str, str | None]] = []

		run_repl(
			TrackingInput("1\nexit\n", events),
			TrackingOutput(events),
			FakeInterpreter(),
		)

		self.assertEqual(
			events,
			[
				("write", ">>> "),
				("flush", None),
				("read", None),
				("write", "result\n"),
				("write", ">>> "),
				("flush", None),
				("read", None),
			],
		)

	def test_continuation_prompts_flush_before_input(self):
		events: list[tuple[str, str | None]] = []
		output = TrackingOutput(events)

		_write_prompt(output, "... ")

		self.assertEqual(events, [("write", "... "), ("flush", None)])

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

	def test_keyboard_interrupt_cancels_input_and_continues(self):
		events: list[tuple[str, str | None]] = []
		output = TrackingOutput(events)

		run_repl(RaisingInput(events), output, FakeInterpreter())

		self.assertEqual(output.getvalue(), ">>> \n>>> ")

	def test_keyboard_interrupt_cancels_submission_and_continues(self):
		interpreter = FakeInterpreter(interrupt_on_execute=True)

		output = io.StringIO()
		run_repl(io.StringIO("1\nexit\n"), output, interpreter)

		self.assertEqual(output.getvalue(), ">>> \n>>> ")


class ReplIntegrationTests(unittest.TestCase):
	def test_real_interpreter_errors_do_not_stop_following_commands(self):
		output = io.StringIO()

		run_repl(io.StringIO("1 / 0\n2\nexit\n"), output, Interpreter())

		self.assertIn("Error: division or modulo by zero\n", output.getvalue())
		self.assertIn("2\n", output.getvalue())


if __name__ == "__main__":
	unittest.main()
