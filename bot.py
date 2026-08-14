import os

import discord
from discord.ext import commands
from dotenv import load_dotenv
from language.interpreter import Interpreter, RollResult, RuntimeErrorBase


MAX_REPETITIONS = 20
DISCORD_MESSAGE_LIMIT = 2000
EXPECTED_ROLL_ERRORS = (SyntaxError, TypeError, NameError, ValueError, RuntimeErrorBase)


load_dotenv()

intents = discord.Intents.default()
intents.message_content = True

client = commands.Bot(command_prefix="d!", intents=intents)


@client.event
async def on_ready():
	print(f"Logged in as {client.user}.")
	try:
		synced = await client.tree.sync()
		print(f"Synced {len(synced)} command(s).")
	except Exception as e:
		print(e)


def validate_repeat(repeat: int) -> None:
	if isinstance(repeat, bool) or not isinstance(repeat, int):
		raise ValueError("repeat must be an integer")
	if not 1 <= repeat <= MAX_REPETITIONS:
		raise ValueError(f"repeat must be between 1 and {MAX_REPETITIONS}")


def evaluate_rolls(
	expression: str,
	repeat: int,
	*,
	interpreter: Interpreter | None = None,
) -> list[object]:
	validate_repeat(repeat)
	source = expression.strip() or "d20"
	evaluator = interpreter or Interpreter()
	return [evaluator.execute_source(source) for _ in range(repeat)]


def format_result(value: object) -> str:
	if isinstance(value, RollResult):
		return value.format()
	return str(value)


def bonus_expression(base: str, bonus: int) -> str:
	return f"{base}{bonus:+d}" if bonus else base


def build_roll_response(user_id: int, expression: str, results: list[object]) -> str:
	lines = [f"<@{user_id}> Rolled: `[{expression}]`"]
	for index, result in enumerate(results, start=1):
		lines.append(f"Roll {index}: `{format_result(result)}`")
	response = "\n".join(lines)
	if len(response) > DISCORD_MESSAGE_LIMIT:
		raise ValueError("result exceeds Discord's message length limit")
	return response


async def handle_roll(
	interaction: discord.Interaction,
	expression: str,
	repeat: int,
	*,
	interpreter: Interpreter | None = None,
) -> None:
	try:
		validate_repeat(repeat)
	except ValueError as error:
		await interaction.response.send_message(f"Error: {error}", ephemeral=True)
		return

	await interaction.response.defer()
	try:
		results = evaluate_rolls(expression, repeat, interpreter=interpreter)
		response = build_roll_response(
			interaction.user.id,
			expression.strip() or "d20",
			results,
		)
	except EXPECTED_ROLL_ERRORS as error:
		await interaction.followup.send(f"Error: {error}", ephemeral=True)
		return

	await interaction.followup.send(response)


@client.tree.command(name="r", description="quickly roll a d20")
async def quick_roll(interaction: discord.Interaction):
	await handle_roll(interaction, "d20", 1)


@client.tree.command(name="roll", description="evaluate a dice expression")
async def roll(
	interaction: discord.Interaction,
	expression: str,
	repeat: int = 1,
):
	await handle_roll(interaction, expression, repeat)


@client.tree.command(name="advantage", description="roll a d20 with advantage")
async def advantage(interaction: discord.Interaction, bonus: int = 0, repeat: int = 1):
	await handle_roll(interaction, bonus_expression("+d20", bonus), repeat)


@client.tree.command(name="disadvantage", description="roll a d20 with disadvantage")
async def disadvantage(
	interaction: discord.Interaction, bonus: int = 0, repeat: int = 1
):
	await handle_roll(interaction, bonus_expression("-d20", bonus), repeat)


token = os.getenv("DISCORD_CLIENT_TOKEN")
if token is None:
	raise RuntimeError("DISCORD_CLIENT_TOKEN environment variable is not set")
client.run(token)
