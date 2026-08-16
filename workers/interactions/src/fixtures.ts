import type {
	DieRollDetailValue,
	Env,
	EvaluatorValue,
	RollResultValue,
} from "./types";

function makeReplayGuard(): DurableObjectNamespace {
	const claimed = new Set<string>();
	return {
		getByName: () => ({
			fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body)) as { id: string };
				const isNew = !claimed.has(body.id);
				if (isNew) claimed.add(body.id);
				return new Response(JSON.stringify({ claimed: isNew }), {
					headers: { "content-type": "application/json" },
				});
			},
		}),
	} as unknown as DurableObjectNamespace;
}

export const TEST_NOW_SECONDS = 1_700_000_000;
export const FIXED_PUBLIC_KEY_HEX =
	"d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const FIXED_PRIVATE_SEED_HEX =
	"9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
export const FIXED_PING_SIGNATURE_HEX =
	"1695961a47c91a1ec033b819b7e87e3dbc583dd0cee6d1fd0216f58ac87b6228ae531ddbf91fb7bc28d7edf7f08604da16f54624f38a6bc0614e4dc13cd47f0f";

function hexToBytes(value: string): Uint8Array {
	return Uint8Array.from(value.match(/../g)!, (part) => Number.parseInt(part, 16));
}

function bytesToHex(value: ArrayBuffer): string {
	return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function signDiscordRequest(
	rawBody: string,
	timestamp = String(TEST_NOW_SECONDS),
): Promise<string> {
	const pkcs8Prefix = hexToBytes("302e020100300506032b657004220420");
	const privateKey = await crypto.subtle.importKey(
		"pkcs8",
		Uint8Array.from([...pkcs8Prefix, ...hexToBytes(FIXED_PRIVATE_SEED_HEX)]),
		{ name: "Ed25519" },
		false,
		["sign"],
	);
	const message = new TextEncoder().encode(`${timestamp}${rawBody}`);
	return bytesToHex(await crypto.subtle.sign("Ed25519", privateKey, message));
}

export function makeRequest(
	rawBody: string,
	signature: string | null,
	timestamp: string | null = String(TEST_NOW_SECONDS),
): Request {
	const headers = new Headers();
	if (signature !== null) headers.set("X-Signature-Ed25519", signature);
	if (timestamp !== null) headers.set("X-Signature-Timestamp", timestamp);
	return new Request("https://agathos.test/interactions", {
		method: "POST",
		headers,
		body: rawBody,
	});
}

export function makeEnv(
	fetcher: Fetcher,
	replayGuard: DurableObjectNamespace = makeReplayGuard(),
): Env {
	return {
		AGATHOS_EVALUATOR: fetcher,
		DISCORD_PUBLIC_KEY: FIXED_PUBLIC_KEY_HEX,
		REPLAY_GUARD: replayGuard,
	};
}

export function makeDieDetail(
	overrides: Partial<DieRollDetailValue> = {},
): DieRollDetailValue {
	return {
		kind: "die_roll_detail",
		sides: 6,
		rolls: [4, 2],
		rerolls: [[], []],
		dropped: [],
		clamped: [[], []],
		values: [4, 2],
		nested: [],
		...overrides,
	};
}

export function makeRollResult(
	total = 6,
	detail: DieRollDetailValue | null = makeDieDetail(),
): RollResultValue {
	return {
		kind: "roll_result",
		total,
		details: detail === null ? [] : [detail],
	};
}

export function evaluatorJson(
	payload: EvaluatorValue | { ok: boolean; value?: unknown; error?: unknown },
	status = 200,
	contentType = "application/json; charset=utf-8",
): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": contentType },
	});
}
