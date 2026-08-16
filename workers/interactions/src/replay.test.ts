import { describe, expect, it, vi } from "vitest";
import type { Env } from "./types";
import { ReplayGuard } from "./replay";

describe("ReplayGuard schema", () => {
	it("indexes claimed_at for retention cleanup", () => {
		const exec = vi.fn();
		const state = {
			storage: { sql: { exec } },
		} as unknown as DurableObjectState;

		new ReplayGuard(state, {} as Env);

		expect(exec).toHaveBeenCalledWith(
			"CREATE INDEX IF NOT EXISTS interaction_replays_claimed_at_idx ON interaction_replays (claimed_at)",
		);
	});
});
