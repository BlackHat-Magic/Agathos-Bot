import type {
	ApplicationCommandInteraction,
	CommandOption,
	Interaction,
	JsonValue,
} from "./types";
import { limitResponseContent } from "./format";

const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
export const MAX_TIMESTAMP_SKEW_SECONDS = 300;
export const MAX_SOURCE_LENGTH = 4096;

export function hexToBytes(value: string): Uint8Array {
	if (!/^[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) {
		throw new Error("invalid hexadecimal value");
	}

	const bytes = new Uint8Array(value.length / 2);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

export async function verifyDiscordRequest(
	rawBody: string,
	signatureHex: string | null,
	timestamp: string | null,
	publicKeyHex: string,
	nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
	try {
		if (!signatureHex || !timestamp) return false;
		if (!/^\d+$/.test(timestamp)) return false;
		const timestampSeconds = Number(timestamp);
		if (
			!Number.isSafeInteger(timestampSeconds) ||
			!Number.isSafeInteger(nowSeconds) ||
			Math.abs(timestampSeconds - nowSeconds) > MAX_TIMESTAMP_SKEW_SECONDS
		) {
			return false;
		}

		const publicKeyBytes = hexToBytes(publicKeyHex);
		const signatureBytes = hexToBytes(signatureHex);
		if (
			publicKeyBytes.byteLength !== PUBLIC_KEY_BYTES ||
			signatureBytes.byteLength !== SIGNATURE_BYTES
		) {
			return false;
		}

		const message = new TextEncoder().encode(`${timestamp}${rawBody}`);
		const key = await crypto.subtle.importKey(
			"raw",
			publicKeyBytes,
			{ name: "Ed25519" },
			false,
			["verify"],
		);
		return await crypto.subtle.verify(
			"Ed25519",
			key,
			signatureBytes,
			message,
		);
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOption(value: unknown): CommandOption | null {
	if (!isRecord(value) || typeof value.name !== "string" || typeof value.type !== "number") {
		return null;
	}
	return { name: value.name, type: value.type, value: value.value };
}

export function parseInteraction(rawBody: string): Interaction {
	const value: unknown = JSON.parse(rawBody);
	if (!isRecord(value) || typeof value.type !== "number") {
		throw new TypeError("interaction must be an object with a numeric type");
	}

	if (value.type === 1) return { type: 1 };
	if (value.type !== 2) return { type: value.type };
	if (typeof value.id !== "string" || value.id.length === 0) {
		throw new TypeError("application command interaction id is malformed");
	}

	if (!isRecord(value.data) || typeof value.data.name !== "string") {
		throw new TypeError("application command data is malformed");
	}
	let options: CommandOption[] | undefined;
	if (value.data.options !== undefined) {
		if (!Array.isArray(value.data.options)) {
			throw new TypeError("application command options are malformed");
		}
		options = [];
		for (const option of value.data.options) {
			const parsed = parseOption(option);
			if (parsed === null) throw new TypeError("application command option is malformed");
			options.push(parsed);
		}
	}

	const member = isRecord(value.member) ? value.member : undefined;
	const memberUser = member && isRecord(member.user) ? member.user : undefined;
	const user = isRecord(value.user) ? value.user : undefined;
	return {
		type: 2,
		id: value.id,
		data: { name: value.data.name, options },
		member: memberUser && typeof memberUser.id === "string"
			? { user: { id: memberUser.id } }
			: undefined,
		user: user && typeof user.id === "string" ? { id: user.id } : undefined,
	};
}

export function getStringOption(
	interaction: ApplicationCommandInteraction,
	name: string,
): string | null {
	const option = interaction.data.options?.find((candidate) => candidate.name === name);
	return option?.type === 3 && typeof option.value === "string" ? option.value : null;
}

export function getCommandOptions(
	interaction: ApplicationCommandInteraction,
): readonly CommandOption[] {
	return interaction.data.options ?? [];
}

export function getInteractionUserId(
	interaction: ApplicationCommandInteraction,
): string | null {
	return interaction.member?.user?.id ?? interaction.user?.id ?? null;
}

export function jsonResponse(payload: JsonValue, status = 200): Response {
	let boundedPayload = payload;
	if (
		payload !== null &&
		!Array.isArray(payload) &&
		typeof payload === "object" &&
		payload.data !== null &&
		typeof payload.data === "object" &&
		!Array.isArray(payload.data) &&
		typeof payload.data.content === "string"
	) {
		boundedPayload = {
			...payload,
			data: { ...payload.data, content: limitResponseContent(payload.data.content) },
		};
	}
	return new Response(JSON.stringify(boundedPayload), {
		status,
		headers: { "content-type": "application/json" },
	});
}
