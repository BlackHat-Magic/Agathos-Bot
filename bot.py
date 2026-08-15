import os

import discord
from discord.ext import commands
from dotenv import load_dotenv
from language.interpreter import (
	DieRollDetail,
	Interpreter,
	RollResult,
	RuntimeErrorBase,
)


DISCORD_MESSAGE_LIMIT = 2000
EXPECTED_ROLL_ERRORS = (
	SyntaxError,
	TypeError,
	NameError,
	ValueError,
	RecursionError,
	RuntimeErrorBase,
)


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


def evaluate_roll(
	expression: str,
	*,
	interpreter: Interpreter | None = None,
) -> object:
	source = expression.strip() or "d20"
	evaluator = interpreter or Interpreter()
	return evaluator.execute_source(source)


def escape_display_text(value: object) -> str:
	text = str(value).replace("\n", "\\n")
	return discord.utils.escape_mentions(discord.utils.escape_markdown(text))


def format_result(value: object) -> str:
	return _format_result(value, bold_total=True)


def _format_result(value: object, *, bold_total: bool) -> str:
	if isinstance(value, list):
		return (
			"["
			+ ", ".join(_format_result(item, bold_total=False) for item in value)
			+ "]"
		)

	if not isinstance(value, RollResult):
		text = escape_display_text(value)
		return f"**{text}**" if bold_total else text

	active_values: list[str] = []
	dropped_values: list[str] = []
	for detail in value.details:
		if not isinstance(detail, DieRollDetail):
			continue
		active_values.extend(str(item) for item in detail.values)
		dropped_values.extend(f"~~{item}~~" for item in detail.dropped)

	if not active_values and not dropped_values:
		return _format_result(value.total, bold_total=bold_total)
	active = ", ".join(active_values)
	dropped = " ".join(dropped_values)
	body = active
	if active and dropped:
		body += " "
	body += dropped
	total = escape_display_text(value.total)
	if bold_total:
		total = f"**{total}**"
	return f"[{body}] = {total}"


def build_roll_response(user_id: int, expression: str, result: object) -> str:
	response = "\n".join(
		[
			f"<@{user_id}> rolled `{escape_display_text(expression)}`:",
			format_result(result),
		]
	)
	if len(response) > DISCORD_MESSAGE_LIMIT:
		raise ValueError("result exceeds Discord's message length limit")
	return response


async def handle_roll(
	interaction: discord.Interaction,
	expression: str,
	*,
	interpreter: Interpreter | None = None,
) -> None:
	await interaction.response.defer()
	try:
		result = evaluate_roll(expression, interpreter=interpreter)
		response = build_roll_response(
			interaction.user.id,
			expression.strip() or "d20",
			result,
		)
	except EXPECTED_ROLL_ERRORS as error:
		await interaction.followup.send(f"Error: {error}", ephemeral=True)
		return

	await interaction.followup.send(response)


@client.tree.command(name="r", description="quickly roll a d20")
async def quick_roll(interaction: discord.Interaction):
	await handle_roll(interaction, "d20")


@client.tree.command(name="roll", description="evaluate a dice expression")
async def roll(
	interaction: discord.Interaction,
	expression: str,
):
	await handle_roll(interaction, expression)


def main() -> None:
	load_dotenv()
	token = os.getenv("DISCORD_CLIENT_TOKEN")
	if token is None:
		raise RuntimeError("DISCORD_CLIENT_TOKEN environment variable is not set")
	client.run(token)


if __name__ == "__main__":
	main()
