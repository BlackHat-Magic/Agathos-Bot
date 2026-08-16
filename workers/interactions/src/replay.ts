import type { Env } from "./types";

export const REPLAY_RETENTION_SECONDS = 10 * 60;
const REPLAY_OBJECT_NAME = "discord-interactions";

type ClaimResult = { claimed: boolean };

export class ReplayGuard {
	private readonly ctx: DurableObjectState;

	constructor(ctx: DurableObjectState, env: Env) {
		this.ctx = ctx;
		ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS interaction_replays (interaction_id TEXT PRIMARY KEY, claimed_at INTEGER NOT NULL)",
		);
		ctx.storage.sql.exec(
			"CREATE INDEX IF NOT EXISTS interaction_replays_claimed_at_idx ON interaction_replays (claimed_at)",
		);
	}

	async fetch(request: Request): Promise<Response> {
		if (request.method !== "POST") {
			return new Response(JSON.stringify({ error: "method_not_allowed" }), {
				status: 405,
				headers: { "content-type": "application/json" },
			});
		}

		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return new Response(JSON.stringify({ error: "invalid_json" }), {
				status: 400,
				headers: { "content-type": "application/json" },
			});
		}
		if (
			typeof body !== "object" ||
			body === null ||
			!("id" in body) ||
			typeof body.id !== "string" ||
			body.id.length === 0
		) {
			return new Response(JSON.stringify({ error: "invalid_interaction_id" }), {
				status: 400,
				headers: { "content-type": "application/json" },
			});
		}

		const now = Math.floor(Date.now() / 1000);
		const cutoff = now - REPLAY_RETENTION_SECONDS;
		this.ctx.storage.sql.exec(
			"DELETE FROM interaction_replays WHERE claimed_at <= ?",
			cutoff,
		);
		this.ctx.storage.sql.exec(
			"INSERT OR IGNORE INTO interaction_replays (interaction_id, claimed_at) VALUES (?, ?)",
			body.id,
			now,
		);
		const changes = this.ctx.storage.sql
			.exec<{ changes: number }>("SELECT changes() AS changes")
			.one().changes;

		return new Response(JSON.stringify({ claimed: changes === 1 } satisfies ClaimResult), {
			headers: { "content-type": "application/json" },
		});
	}
}

export async function claimInteraction(
	namespace: DurableObjectNamespace,
	id: string,
): Promise<boolean> {
	const response = await namespace.getByName(REPLAY_OBJECT_NAME).fetch(
		"https://replay/claim",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id }),
		},
	);
	if (!response.ok) throw new Error("replay guard request failed");
	const result: unknown = await response.json();
	return (
		typeof result === "object" &&
		result !== null &&
		"claimed" in result &&
		result.claimed === true
	);
}

export function replayResponseMessage(): string {
	return "this interaction has already been processed";
}

export { REPLAY_OBJECT_NAME };
