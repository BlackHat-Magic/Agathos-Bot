import {
	getInteractionUserId,
	getCommandOptions,
	jsonResponse,
	MAX_SOURCE_LENGTH,
	parseInteraction,
	verifyDiscordRequest,
} from "./discord";
import { evaluate, EvaluatorServiceError } from "./evaluator";
import {
	formatErrorMessage,
	formatRollResponse,
	limitResponseContent,
	ResponseTooLongError,
} from "./format";
import type {
	ApplicationCommandInteraction,
	CommandOption,
	Env,
	Interaction,
	JsonValue,
} from "./types";

const EPHEMERAL = 64;

function interactionResponse(content: string, flags?: number): JsonValue {
	const data: Record<string, JsonValue> = {
		content: limitResponseContent(content),
		allowed_mentions: { parse: [] },
	};
	if (flags !== undefined) data.flags = flags;
	return {
		type: 4,
		data,
	};
}

function successResponse(content: string, userId: string): JsonValue {
	return {
		type: 4,
		data: {
			content: limitResponseContent(content),
			allowed_mentions: { parse: [], users: [userId] },
		},
	};
}

function errorResponse(message: string): Response {
	return jsonResponse(interactionResponse(formatErrorMessage(message), EPHEMERAL));
}

function invalidCommandResponse(): Response {
	return jsonResponse({ error: "invalid_command" }, 400);
}

function isValidRollOptions(
	options: readonly CommandOption[],
): options is readonly [{ name: "expression"; type: 3; value: string }] {
	return (
		options.length === 1 &&
		options[0].name === "expression" &&
		options[0].type === 3 &&
		typeof options[0].value === "string" &&
		options[0].value.length <= MAX_SOURCE_LENGTH
	);
}

async function dispatchApplicationCommand(
	interaction: ApplicationCommandInteraction,
	evaluator: Fetcher,
): Promise<Response> {
	let source: string;
	const options = getCommandOptions(interaction);
	if (interaction.data.name === "r") {
		if (options.length !== 0) return invalidCommandResponse();
		source = "d20";
	} else if (interaction.data.name === "roll") {
		if (!isValidRollOptions(options)) {
			return invalidCommandResponse();
		}
		source = options[0].value;
	} else {
		return jsonResponse({ error: "unsupported_command" }, 400);
	}

	const userId = getInteractionUserId(interaction);
	if (userId === null) return errorResponse("unable to identify the user");

	try {
		const result = await evaluate(evaluator, source);
		if (!result.ok) return errorResponse(result.error.message);
		return jsonResponse(successResponse(formatRollResponse(userId, source, result.value), userId));
	} catch (error) {
		if (error instanceof ResponseTooLongError) return errorResponse(error.message);
		if (error instanceof EvaluatorServiceError) {
			console.error("evaluator_service_error", error.message);
		} else {
			console.error("interaction_unexpected_error");
		}
		return errorResponse("the evaluator is temporarily unavailable");
	}
}

function isApplicationCommand(
	interaction: Interaction,
): interaction is ApplicationCommandInteraction {
	return interaction.type === 2;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		try {
			if (request.method !== "POST") {
				return jsonResponse({ error: "method_not_allowed" }, 405);
			}

			const rawBody = await request.text();
			const valid = await verifyDiscordRequest(
				rawBody,
				request.headers.get("X-Signature-Ed25519"),
				request.headers.get("X-Signature-Timestamp"),
				env.DISCORD_PUBLIC_KEY,
			);
			if (!valid) return jsonResponse({ error: "invalid_signature" }, 401);

			let interaction: Interaction;
			try {
				interaction = parseInteraction(rawBody);
			} catch {
				return jsonResponse({ error: "invalid_json" }, 400);
			}

			if (interaction.type === 1) return jsonResponse({ type: 1 });
			if (!isApplicationCommand(interaction)) {
				return jsonResponse({ error: "unsupported_interaction" }, 400);
			}
			return dispatchApplicationCommand(interaction, env.AGATHOS_EVALUATOR);
		} catch (error) {
			console.error("interaction_request_error", error);
			return jsonResponse({ error: "internal_error" }, 500);
		}
	},
};
