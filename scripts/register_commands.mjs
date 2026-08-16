const API_BASE = "https://discord.com/api/v10";

const COMMANDS = [
	{
		name: "r",
		description: "quickly roll a d20",
		type: 1,
	},
	{
		name: "roll",
		description: "evaluate a dice expression",
		type: 1,
		options: [
			{
				name: "expression",
				description: "dice expression to evaluate",
				type: 3,
				required: true,
			},
		],
	},
];

const USAGE = `Usage: bun scripts/register_commands.mjs [--global]

Registers /r and /roll with Discord. Without --global, DISCORD_GUILD_ID is
required and commands are registered for that guild. --global registers the
commands for the application globally.

Required environment variables:
  DISCORD_APPLICATION_ID
  DISCORD_BOT_TOKEN
  DISCORD_GUILD_ID  (required unless --global is used)`;

function fail(message) {
	console.error(`register_commands: ${message}`);
	process.exitCode = 1;
}

function requiredEnvironment(name) {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

async function main() {
	const argumentsList = process.argv.slice(2);
	if (argumentsList.includes("--help")) {
		console.log(USAGE);
		return;
	}
	if (argumentsList.some((argument) => argument !== "--global")) {
		throw new Error(`unknown argument (use --help for usage)`);
	}

	const global = argumentsList.includes("--global");
	const applicationId = requiredEnvironment("DISCORD_APPLICATION_ID");
	const botToken = requiredEnvironment("DISCORD_BOT_TOKEN");
	const guildId = global ? null : requiredEnvironment("DISCORD_GUILD_ID");
	const endpoint = global
		? `${API_BASE}/applications/${applicationId}/commands`
		: `${API_BASE}/applications/${applicationId}/guilds/${guildId}/commands`;

	const response = await fetch(endpoint, {
		method: "PUT",
		headers: {
			Authorization: `Bot ${botToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(COMMANDS),
	});
	const responseBody = await response.text();
	if (response.status < 200 || response.status >= 300) {
		const safeResponseBody = responseBody.replaceAll(botToken, "[REDACTED]");
		throw new Error(
			`Discord command registration failed (HTTP ${response.status}): ${safeResponseBody || response.statusText}`,
		);
	}

	console.log(
		`Registered ${COMMANDS.length} Discord application commands ${global ? "globally" : `for guild ${guildId}`}.`,
	);
}

try {
	await main();
} catch (error) {
	fail(error instanceof Error ? error.message : "unknown error");
}
