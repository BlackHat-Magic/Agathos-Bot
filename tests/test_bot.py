import inspect
import random
import unittest
from typing import cast
from unittest.mock import AsyncMock, patch

import discord
import bot
from language.interpreter import Interpreter, RollResult


class BotHelperTests(unittest.TestCase):
	def test_roll_expression_defaults_blank_input_to_d20(self):
		interpreter = Interpreter(rng=random.Random(0))
		result = bot.evaluate_rolls("", 1, interpreter=interpreter)[0]
		self.assertIsInstance(result, RollResult)
		assert isinstance(result, RollResult)
		self.assertEqual(result.total, 13)

	def test_evaluate_rolls_reuses_interpreter_rng_for_repetitions(self):
		interpreter = Interpreter(rng=random.Random(0))
		results = bot.evaluate_rolls("d20", 2, interpreter=interpreter)
		self.assertEqual([result.total for result in results], [13, 14])

	def test_repeat_validation_accepts_one_through_twenty_only(self):
		for repeat in (1, 20):
			with self.subTest(repeat=repeat):
				bot.validate_repeat(repeat)
		for repeat in (0, -1, 21):
			with self.subTest(repeat=repeat), self.assertRaises(ValueError):
				bot.validate_repeat(repeat)

	def test_format_result_uses_roll_result_details(self):
		result = Interpreter(rng=random.Random(0)).execute_source("+d20")
		self.assertIn("total=14", bot.format_result(result))
		self.assertIn("dropped=(13,)", bot.format_result(result))

	def test_bonus_expression_builder_uses_interpreter_syntax(self):
		self.assertEqual(bot.bonus_expression("+d20", 0), "+d20")
		self.assertEqual(bot.bonus_expression("+d20", 5), "+d20+5")
		self.assertEqual(bot.bonus_expression("-d20", -2), "-d20-2")

	def test_roll_command_exposes_no_legacy_dice_options(self):
		parameter_names = set(inspect.signature(bot.roll.callback).parameters)
		self.assertEqual(parameter_names, {"interaction", "expression", "repeat"})

	def test_cheat_words_are_not_special_cased(self):
		with self.assertRaises(NameError):
			bot.evaluate_rolls("cheat", 1)


class FakeUser:
	id: int

	def __init__(self, user_id: int):
		self.id = user_id


class FakeResponse:
	def __init__(self):
		self.defer: AsyncMock = AsyncMock()
		self.send_message: AsyncMock = AsyncMock()


class FakeFollowup:
	def __init__(self):
		self.send: AsyncMock = AsyncMock()


class FakeInteraction:
	user: FakeUser
	response: FakeResponse
	followup: FakeFollowup

	def __init__(self):
		self.user = FakeUser(123)
		self.response = FakeResponse()
		self.followup = FakeFollowup()


class BotCommandTests(unittest.IsolatedAsyncioTestCase):
	async def test_convenience_commands_build_interpreter_expressions(self):
		interaction = FakeInteraction()
		with patch.object(bot, "handle_roll", new=AsyncMock()) as handle_roll:
			await bot.advantage.callback(
				cast(discord.Interaction, interaction), bonus=5, repeat=2
			)
			handle_roll.assert_awaited_once_with(interaction, "+d20+5", 2)
		with patch.object(bot, "handle_roll", new=AsyncMock()) as handle_roll:
			await bot.disadvantage.callback(
				cast(discord.Interaction, interaction), bonus=-2, repeat=1
			)
			handle_roll.assert_awaited_once_with(interaction, "-d20-2", 1)

	async def test_quick_roll_delegates_to_d20(self):
		interaction = FakeInteraction()
		with patch.object(bot, "handle_roll", new=AsyncMock()) as handle_roll:
			await bot.quick_roll.callback(cast(discord.Interaction, interaction))
			handle_roll.assert_awaited_once_with(interaction, "d20", 1)

	async def test_successful_roll_defers_and_sends_formatted_result(self):
		interaction = FakeInteraction()
		await bot.handle_roll(
			cast(discord.Interaction, interaction),
			"d20",
			1,
			interpreter=Interpreter(rng=random.Random(0)),
		)
		interaction.response.defer.assert_awaited_once_with()
		interaction.followup.send.assert_awaited_once()
		assert interaction.followup.send.await_args is not None
		message = interaction.followup.send.await_args.args[0]
		self.assertIn("total=13", message)

	async def test_expected_roll_error_is_ephemeral_after_deferral(self):
		interaction = FakeInteraction()
		await bot.handle_roll(cast(discord.Interaction, interaction), "1 / 0", 1)
		interaction.response.defer.assert_awaited_once_with()
		interaction.followup.send.assert_awaited_once()
		assert interaction.followup.send.await_args is not None
		self.assertTrue(interaction.followup.send.await_args.kwargs["ephemeral"])
		self.assertIn("Error:", interaction.followup.send.await_args.args[0])

	async def test_parser_recursion_error_is_ephemeral_after_deferral(self):
		interaction = FakeInteraction()
		expression = "(" * 100 + "1" + ")" * 100

		await bot.handle_roll(cast(discord.Interaction, interaction), expression, 1)

		interaction.response.defer.assert_awaited_once_with()
		interaction.followup.send.assert_awaited_once()
		assert interaction.followup.send.await_args is not None
		self.assertTrue(interaction.followup.send.await_args.kwargs["ephemeral"])
		self.assertIn("Error:", interaction.followup.send.await_args.args[0])

	async def test_invalid_repeat_is_rejected_before_deferral(self):
		interaction = FakeInteraction()
		await bot.handle_roll(cast(discord.Interaction, interaction), "d20", 0)
		interaction.response.send_message.assert_awaited_once()
		assert interaction.response.send_message.await_args is not None
		self.assertTrue(
			interaction.response.send_message.await_args.kwargs["ephemeral"]
		)
		interaction.response.defer.assert_not_awaited()


class BotStartupTests(unittest.TestCase):
	def test_main_rejects_missing_token(self):
		with (
			patch.dict("os.environ", {}, clear=True),
			self.assertRaisesRegex(RuntimeError, "DISCORD_CLIENT_TOKEN"),
		):
			bot.main()

	def test_main_runs_client_with_configured_token(self):
		with (
			patch.dict("os.environ", {"DISCORD_CLIENT_TOKEN": "secret"}),
			patch.object(bot.client, "run") as run,
		):
			bot.main()
		run.assert_called_once_with("secret")
