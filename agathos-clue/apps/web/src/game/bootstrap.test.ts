import { describe, expect, it } from 'vitest';
import { bootstrapGameFromUrl } from './bootstrap';

describe('game URL bootstrap', () => {
  it('keeps the game parameter and removes the gameId alias', () => {
    const url = new URL('https://example.test/play?game=clue-game:one&gameId=clue-game:two&invite=abc');
    const replaced: URL[] = [];

    expect(bootstrapGameFromUrl(url, next => replaced.push(next))).toBe('clue-game:one');
    expect(url.searchParams.get('game')).toBe('clue-game:one');
    expect(url.searchParams.has('gameId')).toBe(false);
    expect(url.searchParams.get('invite')).toBe('abc');
    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.toString()).toBe(url.toString());
  });

  it('canonicalizes gameId when game is absent', () => {
    const url = new URL('https://example.test/play?gameId=%20clue-game%3Atwo%20');
    const replaced: URL[] = [];

    expect(bootstrapGameFromUrl(url, next => replaced.push(next))).toBe('clue-game:two');
    expect(url.search).toBe('?game=clue-game%3Atwo');
    expect(replaced).toHaveLength(1);
  });

  it('does not rewrite a URL without a usable room id', () => {
    const url = new URL('https://example.test/play?game=&gameId=');
    const before = url.toString();

    expect(bootstrapGameFromUrl(url, () => { throw new Error('unexpected URL update'); })).toBeNull();
    expect(url.toString()).toBe(before);
  });
});
