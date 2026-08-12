"""Interactive command-line shell for the Agathos expression language."""

from __future__ import annotations

import sys
from typing import TextIO

from .interpreter import Interpreter, RollResult, RuntimeErrorBase


def format_result(value: object) -> str:
	"""Format an interpreter result for display."""
	if isinstance(value, RollResult):
		return value.format()
	return str(value)


def print_error(error: BaseException, output_stream: TextIO) -> None:
	"""Write one concise error message to the REPL output stream."""
	output_stream.write(f"Error: {error}\n")


def _print_help(output_stream: TextIO) -> None:
	output_stream.write("Commands: help, exit, quit\n")


def _write_prompt(output_stream: TextIO, prompt: str) -> None:
	output_stream.write(prompt)
	output_stream.flush()


def run_repl(
	input_stream: TextIO = sys.stdin,
	output_stream: TextIO = sys.stdout,
	interpreter: Interpreter | None = None,
) -> None:
	"""Run the expression REPL until an exit command or end of input."""
	active_interpreter = interpreter if interpreter is not None else Interpreter()

	while True:
		_write_prompt(output_stream, ">>> ")
		try:
			line = input_stream.readline()
		except EOFError, KeyboardInterrupt:
			output_stream.write("\n")
			return

		if not line:
			return

		command = line.strip()
		if command in ("exit", "quit"):
			return
		if command == "help":
			_print_help(output_stream)
			continue
		if not command:
			continue

		try:
			result = active_interpreter.execute_source(line)
		except (
			NameError,
			RuntimeErrorBase,
			SyntaxError,
			TypeError,
			ValueError,
		) as error:
			print_error(error, output_stream)
			continue
		output_stream.write(f"{format_result(result)}\n")


def main() -> None:
	"""Start the expression REPL using standard input and output."""
	run_repl()


if __name__ == "__main__":
	main()
