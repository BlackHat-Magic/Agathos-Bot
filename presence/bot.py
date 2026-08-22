import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass

import discord


DEFAULT_ACTIVITY = "Agathos dice tools"
STATUS_VALUES = {
	"online": discord.Status.online,
	"idle": discord.Status.idle,
	"dnd": discord.Status.dnd,
	"invisible": discord.Status.invisible,
}

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class PresenceConfig:
	token: str
	status: discord.Status
	activity: str

	@classmethod
	def from_env(cls, environ: Mapping[str, str] | None = None) -> "PresenceConfig":
		environ = os.environ if environ is None else environ

		token = environ.get("DISCORD_CLIENT_TOKEN", "").strip()
		if not token:
			raise ValueError("DISCORD_CLIENT_TOKEN must be non-empty")

		status_name = environ.get("DISCORD_PRESENCE_STATUS", "online").strip().lower()
		try:
			status = STATUS_VALUES[status_name]
		except KeyError:
			raise ValueError(
				"DISCORD_PRESENCE_STATUS must be one of: online, idle, dnd, invisible"
			) from None

		configured_activity = environ.get("DISCORD_PRESENCE_ACTIVITY")
		if configured_activity is None:
			activity = DEFAULT_ACTIVITY
		else:
			activity = configured_activity.strip()
			if not activity:
				raise ValueError("DISCORD_PRESENCE_ACTIVITY must be non-empty")

		return cls(token=token, status=status, activity=activity)


def create_client(config: PresenceConfig) -> discord.Client:
	client = discord.Client(intents=discord.Intents.none())

	@client.event
	async def on_ready() -> None:
		logger.info("Authenticated as %s; connection ready", client.user)
		await client.change_presence(
			status=config.status,
			activity=discord.Game(name=config.activity),
		)

	return client


def main() -> None:
	config = PresenceConfig.from_env()
	client = create_client(config)
	client.run(config.token)


if __name__ == "__main__":
	main()
