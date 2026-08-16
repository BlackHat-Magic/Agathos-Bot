import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import {
	EVALUATOR_TIMEOUT_MS,
	EvaluatorServiceError,
	evaluate,
	isJsonContentType,
} from "./evaluator";
import {
	FIXED_PING_SIGNATURE_HEX,
	FIXED_PUBLIC_KEY_HEX,
	TEST_NOW_SECONDS,
	evaluatorJson,
	makeEnv,
	makeRequest,
	makeRollResult,
	signDiscordRequest,
} from "./fixtures";
import { verifyDiscordRequest } from "./discord";

const PING_BODY = '{"type":1}';

function fetcher(fetchImplementation: (input: RequestInfo, init?: RequestInit) => Promise<Response>): Fetcher {
	return { fetch: vi.fn(fetchImplementation) } as unknown as Fetcher;
}

async function signedRequest(body: string, timestamp = String(TEST_NOW_SECONDS)): Promise<Request> {
	return makeRequest(body, await signDiscordRequest(body, timestamp), timestamp);
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

function interactionData(payload: Record<string, unknown>): Record<string, unknown> {
	return payload.data as Record<string, unknown>;
}

function expectTemporaryEvaluatorError(payload: Record<string, unknown>): void {
	expect(payload).toEqual({
		type: 4,
		data: {
			content: "Error: the evaluator is temporarily unavailable",
			flags: 64,
			allowed_mentions: { parse: [] },
		},
	});
	const data = interactionData(payload);
	expect((data.content as string).length).toBeLessThanOrEqual(2000);
}

beforeEach(() => {
	vi.useFakeTimers({ now: TEST_NOW_SECONDS * 1000 });
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("verifyDiscordRequest", () => {
	it("accepts a fixed Ed25519 signature", async () => {
		expect(
			await verifyDiscordRequest(
				PING_BODY,
				FIXED_PING_SIGNATURE_HEX,
				String(TEST_NOW_SECONDS),
				FIXED_PUBLIC_KEY_HEX,
				TEST_NOW_SECONDS,
			),
		).toBe(true);
	});

	it("accepts a signature generated from the fixed test key", async () => {
		const body = '{"type":2,"data":{"name":"r"}}';
		const signature = await signDiscordRequest(body);
		expect(
			await verifyDiscordRequest(body, signature, String(TEST_NOW_SECONDS), FIXED_PUBLIC_KEY_HEX, TEST_NOW_SECONDS),
		).toBe(true);
	});

	it.each([
		["changed body", '{"type":1}x', String(TEST_NOW_SECONDS)],
		["changed timestamp", PING_BODY, String(TEST_NOW_SECONDS + 1)],
	])("rejects a %s", async (_name, body, timestamp) => {
		expect(
			await verifyDiscordRequest(
				body,
				FIXED_PING_SIGNATURE_HEX,
				timestamp,
				FIXED_PUBLIC_KEY_HEX,
				TEST_NOW_SECONDS,
			),
		).toBe(false);
	});

	it.each([
		[null, String(TEST_NOW_SECONDS)],
		[FIXED_PING_SIGNATURE_HEX, null],
		["not-hex", String(TEST_NOW_SECONDS)],
	])("rejects missing or malformed signature fields", async (signature, timestamp) => {
		expect(
			await verifyDiscordRequest(PING_BODY, signature, timestamp, FIXED_PUBLIC_KEY_HEX, TEST_NOW_SECONDS),
		).toBe(false);
	});

	it.each([
		"1700000000.0",
		" 1700000000",
		"-1700000000",
		"0x6553f100",
	])("rejects a malformed or non-decimal timestamp %j", async (timestamp) => {
		expect(
			await verifyDiscordRequest(
				PING_BODY,
				FIXED_PING_SIGNATURE_HEX,
				timestamp,
				FIXED_PUBLIC_KEY_HEX,
				TEST_NOW_SECONDS,
			),
		).toBe(false);
	});

	it.each(["9007199254740992", "999999999999999999999999999999"]) (
		"rejects an unsafe or overflowing timestamp %s",
		async (timestamp) => {
			expect(
				await verifyDiscordRequest(
					PING_BODY,
					FIXED_PING_SIGNATURE_HEX,
					timestamp,
					FIXED_PUBLIC_KEY_HEX,
					TEST_NOW_SECONDS,
				),
			).toBe(false);
		},
	);

	it.each([
		["short public key", "00".repeat(31), FIXED_PING_SIGNATURE_HEX],
		["short signature", FIXED_PUBLIC_KEY_HEX, "00".repeat(63)],
		["long signature", FIXED_PUBLIC_KEY_HEX, "00".repeat(65)],
	] as const)("rejects an invalid %s length", async (_name, publicKey, signature) => {
		expect(
			await verifyDiscordRequest(
				PING_BODY,
				signature,
				String(TEST_NOW_SECONDS),
				publicKey,
				TEST_NOW_SECONDS,
			),
		).toBe(false);
	});

	it.each([TEST_NOW_SECONDS - 301, TEST_NOW_SECONDS + 301])(
		"rejects a timestamp that is stale or from the future (%d)",
		async (timestamp) => {
			const signature = await signDiscordRequest(PING_BODY, String(timestamp));
			expect(
				await verifyDiscordRequest(
					PING_BODY,
					signature,
					String(timestamp),
					FIXED_PUBLIC_KEY_HEX,
					TEST_NOW_SECONDS,
				),
			).toBe(false);
		},
	);

	it("uses the injected clock and accepts the skew boundary", async () => {
		const timestamp = String(TEST_NOW_SECONDS + 300);
		const signature = await signDiscordRequest(PING_BODY, timestamp);
		expect(
			await verifyDiscordRequest(PING_BODY, signature, timestamp, FIXED_PUBLIC_KEY_HEX, TEST_NOW_SECONDS),
		).toBe(true);
	});
});

describe("interaction worker", () => {
	it("rejects non-POST requests with method_not_allowed", async () => {
		const evaluator = fetcher(async () => evaluatorJson({ ok: true, value: 1 }));
		const response = await worker.fetch(
			new Request("https://agathos.test/interactions", { method: "GET" }),
			makeEnv(evaluator),
		);
		expect(response.status).toBe(405);
		expect(await bodyOf(response)).toEqual({ error: "method_not_allowed" });
		expect(evaluator.fetch).not.toHaveBeenCalled();
	});

	it("verifies before parsing JSON and handles a signed PING", async () => {
		const evaluator = fetcher(async () => evaluatorJson({ ok: true, value: 1 }));
		const response = await worker.fetch(
			await signedRequest(PING_BODY),
			makeEnv(evaluator),
		);
		expect(response.status).toBe(200);
		expect(await bodyOf(response)).toEqual({ type: 1 });
		expect(evaluator.fetch).not.toHaveBeenCalled();
	});

	it("rejects unsupported interaction types", async () => {
		const evaluator = fetcher(async () => evaluatorJson({ ok: true, value: 1 }));
		const response = await worker.fetch(
			await signedRequest(JSON.stringify({ type: 3 })),
			makeEnv(evaluator),
		);
		expect(response.status).toBe(400);
		expect(await bodyOf(response)).toEqual({ error: "unsupported_interaction" });
		expect(evaluator.fetch).not.toHaveBeenCalled();
	});

	it("rejects unsupported application commands", async () => {
		const evaluator = fetcher(async () => evaluatorJson({ ok: true, value: 1 }));
		const response = await worker.fetch(
			await signedRequest(JSON.stringify({ id: "unknown-1", type: 2, data: { name: "unknown" } })),
			makeEnv(evaluator),
		);
		expect(response.status).toBe(400);
		expect(await bodyOf(response)).toEqual({ error: "unsupported_command" });
		expect(evaluator.fetch).not.toHaveBeenCalled();
	});

	it("requires an interaction id for application commands", async () => {
		const evaluator = fetcher(async () => evaluatorJson({ ok: true, value: 1 }));
		const response = await worker.fetch(
			await signedRequest(JSON.stringify({ type: 2, data: { name: "r" } })),
			makeEnv(evaluator),
		);

		expect(response.status).toBe(400);
		expect(await bodyOf(response)).toEqual({ error: "invalid_json" });
		expect(evaluator.fetch).not.toHaveBeenCalled();
	});

	it("rejects an invalid signature before parsing the request body", async () => {
		const evaluator = fetcher(async () => evaluatorJson({ ok: true, value: 1 }));
		const malformed = "{not json";
		const response = await worker.fetch(
			makeRequest(malformed, "00".repeat(64)),
			makeEnv(evaluator),
		);
		expect(response.status).toBe(401);
		expect(await bodyOf(response)).toEqual({ error: "invalid_signature" });
		expect(evaluator.fetch).not.toHaveBeenCalled();
	});

	it("returns invalid JSON only after a valid signature", async () => {
		const evaluator = fetcher(async () => evaluatorJson({ ok: true, value: 1 }));
		const malformed = "{not json";
		expect((await bodyOf(await worker.fetch(await signedRequest(malformed), makeEnv(evaluator)))).error).toBe(
			"invalid_json",
		);
		expect((await bodyOf(await worker.fetch(makeRequest(malformed, null), makeEnv(evaluator)))).error).toBe(
			"invalid_signature",
		);
	});

	it("evaluates /r as d20 and sends the expected evaluator request", async () => {
		const evaluator = fetcher(async () => evaluatorJson({ ok: true, value: makeRollResult(6) }));
		const response = await worker.fetch(
			await signedRequest(JSON.stringify({ id: "r-1", type: 2, data: { name: "r" }, user: { id: "42" } })),
			makeEnv(evaluator),
		);
		const payload = await bodyOf(response);
		const data = interactionData(payload);
		expect(response.status).toBe(200);
		expect(payload.type).toBe(4);
		expect(data.content).toBe("<@42> rolled `d20`:\n[4, 2] = **6**");
		expect(data.allowed_mentions).toEqual({ parse: [], users: ["42"] });
		expect(evaluator.fetch).toHaveBeenCalledWith(
			"https://agathos-evaluator/evaluate",
			expect.objectContaining({
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ source: "d20" }),
			}),
		);
	});

	it("rejects a replayed application command without evaluating it again", async () => {
		const evaluator = fetcher(async () => evaluatorJson({ ok: true, value: makeRollResult(6) }));
		const env = makeEnv(evaluator);
		const body = JSON.stringify({
			id: "duplicate-1",
			type: 2,
			data: { name: "r" },
			user: { id: "42" },
		});

		const first = await worker.fetch(await signedRequest(body), env);
		const second = await worker.fetch(await signedRequest(body), env);

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(await bodyOf(second)).toEqual({
			type: 4,
			data: {
				content: "Error: this interaction has already been processed",
				flags: 64,
				allowed_mentions: { parse: [] },
			},
		});
		expect(evaluator.fetch).toHaveBeenCalledTimes(1);
	});

	it("evaluates /roll with its expression option", async () => {
		const evaluator = fetcher(async () => evaluatorJson({ ok: true, value: 7 }));
		const body = JSON.stringify({
			id: "roll-1",
			type: 2,
			data: { name: "roll", options: [{ name: "expression", type: 3, value: "2d6" }] },
			member: { user: { id: "7" } },
		});
		const response = await worker.fetch(await signedRequest(body), makeEnv(evaluator));
		const payload = await bodyOf(response);
		expect(response.status).toBe(200);
		expect(payload.type).toBe(4);
		expect(payload.data).toEqual({
			content: "<@7> rolled `2d6`:\n**7**",
			allowed_mentions: { parse: [], users: ["7"] },
		});
		expect(evaluator.fetch).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ body: JSON.stringify({ source: "2d6" }) }),
		);
	});

	it.each([
		["malformed options object", { id: "malformed-options-object", type: 2, data: { name: "roll", options: {} } }, 400, "invalid_json"],
		["malformed option", { id: "malformed-option", type: 2, data: { name: "roll", options: [{}] } }, 400, "invalid_json"],
		["duplicate options", { id: "duplicate-options", type: 2, data: { name: "roll", options: [
			{ name: "expression", type: 3, value: "d20" }, { name: "expression", type: 3, value: "d6" },
		] }, user: { id: "1" } }, 400, "invalid_command"],
		["extra option", { id: "extra-option", type: 2, data: { name: "r", options: [{ name: "expression", type: 3, value: "d20" }] }, user: { id: "1" } }, 400, "invalid_command"],
		["wrong option type", { id: "wrong-option-type", type: 2, data: { name: "roll", options: [{ name: "expression", type: 4, value: "d20" }] }, user: { id: "1" } }, 400, "invalid_command"],
		["too-long option", { id: "too-long-option", type: 2, data: { name: "roll", options: [{ name: "expression", type: 3, value: "x".repeat(4097) }] }, user: { id: "1" } }, 400, "invalid_command"],
	] as const)("rejects %s", async (_name, command, status, error) => {
		const evaluator = fetcher(async () => evaluatorJson({ ok: true, value: 1 }));
		const response = await worker.fetch(await signedRequest(JSON.stringify(command)), makeEnv(evaluator));
		expect(response.status).toBe(status);
		expect((await bodyOf(response)).error).toBe(error);
		expect(evaluator.fetch).not.toHaveBeenCalled();
	});

	it("returns an ephemeral error with mentions disabled when the user is missing", async () => {
		const evaluator = fetcher(async () => evaluatorJson({ ok: true, value: 1 }));
		const body = JSON.stringify({ id: "missing-user-1", type: 2, data: { name: "r" } });
		const data = interactionData(await bodyOf(await worker.fetch(await signedRequest(body), makeEnv(evaluator))));
		expect(data.content).toBe("Error: unable to identify the user");
		expect(data.flags).toBe(64);
		expect(data.allowed_mentions).toEqual({ parse: [] });
		expect(evaluator.fetch).not.toHaveBeenCalled();
	});

	it("maps evaluator errors to an ephemeral escaped response", async () => {
		const evaluator = fetcher(async () => evaluatorJson({ ok: false, error: { code: "invalid", message: "bad *input*" } }));
		const body = JSON.stringify({ id: "error-1", type: 2, data: { name: "r" }, user: { id: "1" } });
		const data = interactionData(await bodyOf(await worker.fetch(await signedRequest(body), makeEnv(evaluator))));
		expect(data.content).toBe("Error: bad \\*input\\*");
		expect(data.flags).toBe(64);
		expect(data.allowed_mentions).toEqual({ parse: [] });
	});

	it("returns a bounded ephemeral error when evaluator JSON is malformed", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const evaluator = fetcher(async () =>
			new Response("not json", { headers: { "content-type": "application/json" } }),
		);
		const body = JSON.stringify({ id: "malformed-result-1", type: 2, data: { name: "r" }, user: { id: "1" } });
		const response = await worker.fetch(await signedRequest(body), makeEnv(evaluator));

		expect(response.status).toBe(200);
		expectTemporaryEvaluatorError(await bodyOf(response));
	});

	it("returns a bounded ephemeral error when the evaluator binding rejects", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const evaluator = fetcher(async () => {
			throw new Error("binding unavailable");
		});
		const body = JSON.stringify({ id: "binding-error-1", type: 2, data: { name: "r" }, user: { id: "1" } });
		const response = await worker.fetch(await signedRequest(body), makeEnv(evaluator));

		expect(response.status).toBe(200);
		expectTemporaryEvaluatorError(await bodyOf(response));
	});

	it("caps a successful response and returns a bounded error response", async () => {
		const evaluator = fetcher(async () => evaluatorJson({ ok: true, value: ["x".repeat(2100)] }));
		const body = JSON.stringify({ id: "long-response-1", type: 2, data: { name: "r" }, user: { id: "1" } });
		const data = interactionData(await bodyOf(await worker.fetch(await signedRequest(body), makeEnv(evaluator))));
		expect(data.content).toBe("Error: result exceeds Discord's message length limit");
		expect((data.content as string).length).toBeLessThanOrEqual(2000);
		expect(data.flags).toBe(64);
	});
});

describe("evaluator service", () => {
	it("accepts JSON media types with valid parameters and rejects JSONP", () => {
		expect(isJsonContentType("application/json")).toBe(true);
		expect(isJsonContentType("Application/JSON; charset=utf-8")).toBe(true);
		expect(isJsonContentType("application/jsonp")).toBe(false);
		expect(isJsonContentType("text/json")).toBe(false);
	});

	it("returns successful evaluator JSON", async () => {
		const value = makeRollResult(6);
		const result = await evaluate(fetcher(async () => evaluatorJson({ ok: true, value })), "d20");
		expect(result).toEqual({ ok: true, value });
	});

	it("returns a structured evaluator language error", async () => {
		const result = await evaluate(
			fetcher(async () => evaluatorJson({ ok: false, error: { code: "syntax_error", message: "bad input" } })),
			"d20 +",
		);
		expect(result).toEqual({
			ok: false,
			error: { code: "syntax_error", message: "bad input" },
		});
	});

	it.each([
		["malformed JSON", new Response("not json", { headers: { "content-type": "application/json" } })],
		["malformed envelope", evaluatorJson({ ok: true, value: {} })],
		["non-JSON", new Response("{}", { headers: { "content-type": "text/plain" } })],
		["JSONP", new Response("callback({})", { headers: { "content-type": "application/jsonp" } })],
		["non-2xx", new Response("{}", { status: 503, headers: { "content-type": "application/json" } })],
	])("rejects %s evaluator responses", async (_name, response) => {
		await expect(evaluate(fetcher(async () => response), "d20")).rejects.toBeInstanceOf(EvaluatorServiceError);
	});

	it("wraps evaluator request rejection", async () => {
		await expect(
			evaluate(fetcher(async () => { throw new Error("network down"); }), "d20"),
		).rejects.toMatchObject({ name: "EvaluatorServiceError", message: "evaluator service request failed" });
	});

	it("aborts a stalled evaluator request without waiting in real time", async () => {
		vi.useFakeTimers();
		const stalled = fetcher(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
		}));
		const pending = evaluate(stalled, "d20");
		const rejection = expect(pending).rejects.toMatchObject({ name: "EvaluatorServiceError" });
		await vi.advanceTimersByTimeAsync(EVALUATOR_TIMEOUT_MS);
		await rejection;
	});
});
