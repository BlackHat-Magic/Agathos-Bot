import type {
	EvaluatorValue,
	RollResultValue,
} from "./types";

export const DISCORD_MESSAGE_LIMIT = 2000;
export const SAFE_RESPONSE_FALLBACK = "Error: response could not be displayed.";

export class ResponseTooLongError extends Error {
	constructor() {
		super("result exceeds Discord's message length limit");
		this.name = "ResponseTooLongError";
	}
}

export function limitResponseContent(
	content: string,
	fallback = SAFE_RESPONSE_FALLBACK,
): string {
	if (content.length <= DISCORD_MESSAGE_LIMIT) return content;
	return fallback.length <= DISCORD_MESSAGE_LIMIT
		? fallback
		: fallback.slice(0, DISCORD_MESSAGE_LIMIT);
}

function displayValue(value: unknown): string {
	if (value === null) return "None";
	if (typeof value === "boolean") return value ? "True" : "False";
	return String(value);
}

export function escapeDisplayText(value: unknown): string {
	const text = displayValue(value).replace(/\n/g, "\\n");
	const markdownEscaped = text.replace(/[\\~*|_`]/g, "\\$&");
	return markdownEscaped.replace(
		/@(everyone|here|[!&]?\d{1,32})/gi,
		(_match, mention: string) => `@\u200b${mention}`,
	);
}

function formatNonRoll(value: Exclude<EvaluatorValue, RollResultValue>, boldTotal: boolean): string {
	const text = escapeDisplayText(value);
	return boldTotal ? `**${text}**` : text;
}

function formatRollResult(value: RollResultValue, boldTotal: boolean): string {
	const activeValues: string[] = [];
	const droppedValues: string[] = [];
	for (const detail of value.details) {
		if (detail.kind !== "die_roll_detail") continue;
		activeValues.push(...detail.values.map(String));
		droppedValues.push(...detail.dropped.map((item) => `~~${item}~~`));
	}

	if (activeValues.length === 0 && droppedValues.length === 0) {
		return formatNonRoll(value.total, boldTotal);
	}

	let body = activeValues.join(", ");
	if (activeValues.length > 0 && droppedValues.length > 0) body += " ";
	body += droppedValues.join(" ");
	const total = escapeDisplayText(value.total);
	return `[${body}] = ${boldTotal ? `**${total}**` : total}`;
}

function isRollResult(value: EvaluatorValue): value is RollResultValue {
	return typeof value === "object" && value !== null && !Array.isArray(value) && value.kind === "roll_result";
}

function formatValue(value: EvaluatorValue, boldTotal: boolean): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => formatValue(item, false)).join(", ")}]`;
	}
	if (isRollResult(value)) {
		return formatRollResult(value, boldTotal);
	}
	return formatNonRoll(value, boldTotal);
}

export function formatResult(value: EvaluatorValue): string {
	return formatValue(value, true);
}

export function formatRollResponse(
	userId: string,
	expression: string,
	value: EvaluatorValue,
): string {
	const displayExpression = expression.trim() || "d20";
	const response = [
		`<@${userId}> rolled \`${escapeDisplayText(displayExpression)}\`:`,
		formatResult(value),
	].join("\n");
	const limited = limitResponseContent(response);
	if (limited !== response) throw new ResponseTooLongError();
	return limited;
}

export function formatErrorMessage(message: string): string {
	return limitResponseContent(`Error: ${escapeDisplayText(message)}`);
}
