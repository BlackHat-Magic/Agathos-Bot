import asyncio
import unittest
from unittest.mock import AsyncMock, patch

import discord

from presence.bot import PresenceConfig, create_client, main


class PresenceConfigTests(unittest.TestCase):
	def test_defaults(self):
		config = PresenceConfig.from_env({"DISCORD_CLIENT_TOKEN": "token"})

		self.assertEqual(config.token, "token")
		self.assertIs(config.status, discord.Status.online)
		self.assertEqual(config.activity, "Agathos dice tools")

	def test_custom_status_and_activity(self):
		config = PresenceConfig.from_env(
			{
				"DISCORD_CLIENT_TOKEN": "token",
				"DISCORD_PRESENCE_STATUS": "idle",
				"DISCORD_PRESENCE_ACTIVITY": "Rolling dice",
			}
		)

		self.assertIs(config.status, discord.Status.idle)
		self.assertEqual(config.activity, "Rolling dice")

	def test_missing_token_is_rejected(self):
		with self.assertRaisesRegex(ValueError, "DISCORD_CLIENT_TOKEN"):
			PresenceConfig.from_env({})

	def test_invalid_status_is_rejected(self):
		with self.assertRaisesRegex(ValueError, "DISCORD_PRESENCE_STATUS"):
			PresenceConfig.from_env(
				{
					"DISCORD_CLIENT_TOKEN": "token",
					"DISCORD_PRESENCE_STATUS": "away",
				}
			)

	def test_blank_activity_is_rejected(self):
		with self.assertRaisesRegex(ValueError, "DISCORD_PRESENCE_ACTIVITY"):
			PresenceConfig.from_env(
				{
					"DISCORD_CLIENT_TOKEN": "token",
					"DISCORD_PRESENCE_ACTIVITY": " \t ",
				}
			)


class PresenceClientTests(unittest.TestCase):
	def test_client_has_no_gateway_intents(self):
		config = PresenceConfig(
			token="token",
			status=discord.Status.online,
			activity="Agathos dice tools",
		)

		client = create_client(config)

		self.assertIs(type(client), discord.Client)
		self.assertEqual(client.intents.value, 0)
		self.assertFalse(client.intents.message_content)

	def test_ready_sets_configured_presence(self):
		config = PresenceConfig(
			token="token",
			status=discord.Status.dnd,
			activity="Rolling dice",
		)
		client = create_client(config)
		client.change_presence = AsyncMock()

		asyncio.run(client.on_ready())

		client.change_presence.assert_awaited_once()
		call = client.change_presence.await_args
		assert call is not None
		self.assertIs(call.kwargs["status"], discord.Status.dnd)
		self.assertIsInstance(call.kwargs["activity"], discord.Game)
		self.assertEqual(call.kwargs["activity"].name, "Rolling dice")

	def test_main_runs_with_configured_token(self):
		config = PresenceConfig(
			token="token",
			status=discord.Status.online,
			activity="Agathos dice tools",
		)

		with (
			patch(
				"presence.bot.PresenceConfig.from_env", return_value=config
			) as from_env,
			patch("presence.bot.create_client") as create_client_mock,
		):
			client = create_client_mock.return_value
			with patch.object(client, "run") as run:
				main()

		from_env.assert_called_once_with()
		create_client_mock.assert_called_once_with(config)
		run.assert_called_once_with("token")


if __name__ == "__main__":
	unittest.main()
