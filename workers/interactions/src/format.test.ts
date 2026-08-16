import { describe, expect, it } from "vitest";
import {
	DISCORD_MESSAGE_LIMIT,
	SAFE_RESPONSE_FALLBACK,
	ResponseTooLongError,
	escapeDisplayText,
	formatErrorMessage,
	formatResult,
	formatRollResponse,
	limitResponseContent,
} from "./format";
import { makeDieDetail, makeRollResult } from "./fixtures";

describe("formatResult", () => {
	it.each([
		[null, "**None**"],
		[true, "**True**"],
		[false, "**False**"],
		[3, "**3**"],
		[2.5, "**2.5**"],
		["text", "**text**"],
	])("formats scalar %j", (value, expected) => {
		expect(formatResult(value)).toBe(expected);
	});

	it("escapes Markdown and mentions in scalar result output", () => {
		expect(formatResult("bad *text* @everyone <@123>")) .toBe(
			"**bad \\*text\\* @\u200beveryone <@\u200b123>**",
		);
	});

	it("formats nested arrays and scalars without bolding array members", () => {
		expect(formatResult([null, true, 3, "text", [false, "nested"]])).toBe(
		"[None, True, 3, text, [False, nested]]",
		);
	});

	it("formats a roll with active dice and composition details", () => {
		expect(
			formatResult({
				...makeRollResult(9, makeDieDetail({ values: [4, 4, 1] })),
			}),
		).toBe("[4, 4, 1] = **9**");
	});

	it("formats dropped dice with strike-through markers", () => {
		expect(
			formatResult(
				makeRollResult(5, makeDieDetail({ values: [4], dropped: [1] })),
			),
		).toBe("[4 ~~1~~] = **5**");
	});

	it("formats a roll with no die details as its scalar total", () => {
		expect(formatResult(makeRollResult(7, null))).toBe("**7**");
	});

	it("formats a roll with only composition details as its scalar total", () => {
		expect(
			formatResult({
				kind: "roll_result",
				total: 6,
				details: [{ kind: "roll_composition_detail", operation: "+", left: 4, right: 2, result: 6 }],
			}),
		).toBe("**6**");
	});

	it("formats nested roll results without bolding nested totals", () => {
		expect(
			formatResult([
				makeRollResult(14, makeDieDetail({ values: [14], dropped: [13] })),
				3,
			]),
		).toBe("[[14 ~~13~~] = 14, 3]");
	});
});

describe("escaping and response limits", () => {
	it("escapes Markdown, mentions, newlines, and backticks", () => {
		expect(escapeDisplayText("line\n")).toBe("line\\\\n");
		expect(escapeDisplayText("\\~*|_`")) .toBe(String.raw`\\\~\*\|\_\``);
		expect(escapeDisplayText("`code` @everyone @here <@123> @!123 @&123")).toBe(
		"\\`code\\` @\u200beveryone @\u200bhere <@\u200b123> @\u200b!123 @\u200b&123",
		);
	});

	it("escapes the displayed expression and preserves the response shape", () => {
		expect(formatRollResponse("123", " d20`\nfoo", 4)).toBe(
			"<@123> rolled `d20\\`\\\\nfoo`:\n**4**",
		);
		expect(formatRollResponse("123", "", 4)).toBe(
			"<@123> rolled `d20`:\n**4**",
		);
	});

	it("caps successful and error content at 2000 characters", () => {
		expect(limitResponseContent("x".repeat(DISCORD_MESSAGE_LIMIT))).toHaveLength(2000);
		expect(limitResponseContent("x".repeat(DISCORD_MESSAGE_LIMIT + 1))).toBe(
		SAFE_RESPONSE_FALLBACK,
	);
		expect(formatErrorMessage("x".repeat(DISCORD_MESSAGE_LIMIT))).toBe(
		SAFE_RESPONSE_FALLBACK,
	);
			expect(() =>
			formatRollResponse("123", "d20", ["x".repeat(DISCORD_MESSAGE_LIMIT)]),
		).toThrow(ResponseTooLongError);
	});

	it("truncates an oversized custom fallback to the Discord limit", () => {
		expect(
			limitResponseContent(
				"y".repeat(DISCORD_MESSAGE_LIMIT + 1),
				"x".repeat(DISCORD_MESSAGE_LIMIT + 1),
			),
		).toHaveLength(
			DISCORD_MESSAGE_LIMIT,
		);
	});
});
