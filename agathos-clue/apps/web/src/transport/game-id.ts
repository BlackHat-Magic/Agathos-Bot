export const MAX_GAME_ID_LENGTH = 80;
const GAME_ID_PATTERN = /^clue-game:[A-Za-z0-9_-]{1,64}$/;

export function isValidGameId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_GAME_ID_LENGTH && GAME_ID_PATTERN.test(value);
}
