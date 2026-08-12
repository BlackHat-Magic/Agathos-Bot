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


def brace_balance(source: str) -> int:
	"""Return the net brace balance, ignoring strings and comments."""
	balance = 0
	delimiter: str | None = None
	escaped = False
	in_comment = False

	for character in source:
		if in_comment:
			if character in "\r\n":
				in_comment = False
			continue

		if delimiter is not None:
			if escaped:
				escaped = False
			elif character == "\\":
				escaped = True
			elif character == delimiter:
				delimiter = None
			continue

		if character == "#":
			in_comment = True
		elif character in "'\"":
			delimiter = character
		elif character == "{":
			balance += 1
		elif character == "}":
			balance -= 1
			if balance < 0:
				raise ValueError("unmatched closing brace")

	return balance


def _line_without_ending(line: str) -> str:
	if line.endswith("\r\n"):
		return line[:-2]
	if line.endswith(("\r", "\n")):
		return line[:-1]
	return line


def read_submission(input_stream: TextIO, output_stream: TextIO) -> str:
	"""Read one complete submission, prompting for balanced continuations."""
	_write_prompt(output_stream, ">>> ")
	try:
		line = input_stream.readline()
	except EOFError:
		raise
	if not line:
		raise EOFError

	lines = [_line_without_ending(line)]
	while brace_balance("\n".join(lines)) > 0:
		_write_prompt(output_stream, "... ")
		try:
			line = input_stream.readline()
		except EOFError as error:
			raise EOFError("unbalanced input") from error
		if not line:
			raise EOFError("unbalanced input")
		lines.append(_line_without_ending(line))

	return "\n".join(lines) + "\n"


def run_repl(
	input_stream: TextIO = sys.stdin,
	output_stream: TextIO = sys.stdout,
	interpreter: Interpreter | None = None,
) -> None:
	"""Run the expression REPL until an exit command or end of input."""
	active_interpreter = interpreter if interpreter is not None else Interpreter()

	while True:
		try:
			source = read_submission(input_stream, output_stream)
		except EOFError as error:
			if str(error):
				print_error(error, output_stream)
			else:
				output_stream.write("\n")
			return
		except KeyboardInterrupt:
			output_stream.write("\n")
			continue
		except ValueError as error:
			print_error(error, output_stream)
			continue

		command = source.strip()
		if command in ("exit", "quit"):
			return
		if command == "help":
			_print_help(output_stream)
			continue
		if not command:
			continue

		try:
			result = active_interpreter.execute_persistent_source(source)
		except KeyboardInterrupt:
			output_stream.write("\n")
			continue
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
