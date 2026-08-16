import type {
	EvaluationResponse,
	DieRollDetailValue,
	EvaluatorValue,
	RollCompositionDetailValue,
	RollDetailValue,
	RollResultValue,
} from "./types";

export const EVALUATOR_TIMEOUT_MS = 2500;

export class EvaluatorServiceError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "EvaluatorServiceError";
	}
}

export function assertSuccessfulEvaluatorResponse(response: Response): void {
	if (!response.ok || response.status < 200 || response.status >= 300) {
		throw new EvaluatorServiceError(
			`evaluator service returned HTTP ${response.status}`,
		);
	}
}

export function isJsonContentType(contentType: string | null): boolean {
	if (contentType === null) return false;
	const [mediaType, ...parameters] = contentType.split(";");
	if (mediaType.trim().toLowerCase() !== "application/json") return false;
	const parameterPattern =
		/^\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+\s*=\s*(?:"(?:[\t !#-\[\]-~\x80-\uFFFF]|\\[\t !#-\[\]-~\x80-\uFFFF])*"|[!#$%&'*+\-.^_`|~0-9A-Za-z]+)\s*$/;
	return parameters.every((parameter) => parameterPattern.test(parameter));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isRollCompositionDetail(value: unknown): value is RollCompositionDetailValue {
	return (
		isRecord(value) &&
		value.kind === "roll_composition_detail" &&
		typeof value.operation === "string" &&
		isNumber(value.left) &&
		isNumber(value.right) &&
		isNumber(value.result)
	);
}

function isNumberArray(value: unknown): value is number[] {
	return Array.isArray(value) && value.every(isNumber);
}

function isDieRollDetail(value: unknown): value is DieRollDetailValue {
	return (
		isRecord(value) &&
		value.kind === "die_roll_detail" &&
		isNumber(value.sides) &&
		isNumberArray(value.rolls) &&
		Array.isArray(value.rerolls) && value.rerolls.every(isNumberArray) &&
		isNumberArray(value.dropped) &&
		Array.isArray(value.clamped) &&
		value.clamped.every(
			(history) => Array.isArray(history) && history.every(isNumberArray),
		) &&
		isNumberArray(value.values) &&
		Array.isArray(value.nested) && value.nested.every(isEvaluatorValue)
	);
}

function isRollResult(value: unknown): value is RollResultValue {
	return (
		isRecord(value) &&
		value.kind === "roll_result" &&
		isNumber(value.total) &&
		Array.isArray(value.details) &&
		value.details.every(
			(detail) => isDieRollDetail(detail) || isRollCompositionDetail(detail),
		)
	);
}

export function isEvaluatorValue(value: unknown): value is EvaluatorValue {
	if (value === null || typeof value === "boolean" || typeof value === "string") return true;
	if (isNumber(value)) return true;
	if (Array.isArray(value)) return value.every(isEvaluatorValue);
	return isRollResult(value);
}

function isEvaluationResponse(value: unknown): value is EvaluationResponse {
	if (!isRecord(value) || typeof value.ok !== "boolean") return false;
	if (value.ok) return isEvaluatorValue(value.value);
	return (
		isRecord(value.error) &&
		typeof value.error.code === "string" &&
		typeof value.error.message === "string"
	);
}

export function parseEvaluationResponse(value: unknown): EvaluationResponse {
	if (!isEvaluationResponse(value)) {
		throw new EvaluatorServiceError("evaluator returned a malformed response");
	}
	return value;
}

export async function evaluate(
	evaluator: Fetcher,
	source: string,
): Promise<EvaluationResponse> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), EVALUATOR_TIMEOUT_MS);
	try {
		let response: Response;
		try {
			response = await evaluator.fetch("https://agathos-evaluator/evaluate", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ source }),
				signal: controller.signal,
			});
		} catch (error) {
			throw new EvaluatorServiceError("evaluator service request failed", { cause: error });
		}

		assertSuccessfulEvaluatorResponse(response);

		if (!isJsonContentType(response.headers.get("content-type"))) {
			throw new EvaluatorServiceError("evaluator returned a non-JSON response");
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch (error) {
			throw new EvaluatorServiceError("evaluator returned invalid JSON", { cause: error });
		}
		return parseEvaluationResponse(payload);
	} catch (error) {
		if (error instanceof EvaluatorServiceError) throw error;
		throw new EvaluatorServiceError("evaluator service request failed", { cause: error });
	} finally {
		clearTimeout(timeout);
	}
}
