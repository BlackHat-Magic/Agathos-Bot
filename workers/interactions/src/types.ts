export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface Env {
	AGATHOS_EVALUATOR: Fetcher;
	DISCORD_PUBLIC_KEY: string;
	REPLAY_GUARD: DurableObjectNamespace;
}

export interface DiscordUser {
	id: string;
}

export interface DiscordMember {
	user?: DiscordUser;
}

export interface CommandOption {
	name: string;
	type: number;
	value?: unknown;
}

export interface ApplicationCommandData {
	name: string;
	options?: CommandOption[];
}

export interface PingInteraction {
	type: 1;
}

export interface ApplicationCommandInteraction {
	type: 2;
	id: string;
	data: ApplicationCommandData;
	member?: DiscordMember;
	user?: DiscordUser;
}

export interface UnsupportedInteraction {
	type: number;
}

export type Interaction =
	| PingInteraction
	| ApplicationCommandInteraction
	| UnsupportedInteraction;

export interface RollResultValue {
	kind: "roll_result";
	total: number;
	details: RollDetailValue[];
}

export interface DieRollDetailValue {
	kind: "die_roll_detail";
	sides: number;
	rolls: number[];
	rerolls: number[][];
	dropped: number[];
	clamped: number[][][];
	values: number[];
	nested: EvaluatorValue[];
}

export interface RollCompositionDetailValue {
	kind: "roll_composition_detail";
	operation: string;
	left: number;
	right: number;
	result: number;
}

export type RollDetailValue =
	| DieRollDetailValue
	| RollCompositionDetailValue;
export type EvaluatorValue =
	| JsonPrimitive
	| EvaluatorValue[]
	| RollResultValue;

export interface EvaluationError {
	code: string;
	message: string;
}

export interface SuccessfulEvaluation {
	ok: true;
	value: EvaluatorValue;
}

export interface FailedEvaluation {
	ok: false;
	error: EvaluationError;
}

export type EvaluationResponse = SuccessfulEvaluation | FailedEvaluation;
