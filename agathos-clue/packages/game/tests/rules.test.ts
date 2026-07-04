import { describe, it, expect } from 'bun:test';
import { createGame, begin, resolveSuggestion, evaluateAccusation } from '../src/rules';
import { buildBoard, suspectStart } from '../src/board';
import type { Card, Player, Suspect } from '../src/types';

function mkPlayer(suspect: Suspect, idx: number, cards: Card[] = [], isRobot = true): Player {
  return {
    name: suspect, index: idx, suspect,
    piece: { suspect, location: suspectStart(suspect, buildBoard()) },
    cards, failedAccusation: false, guessedHere: false, movedBySuggestion: false,
    isRobot,
  };
}

describe('begin', () => {
  it('selects one suspect/weapon/room as solution and deals all others', () => {
    const p1 = mkPlayer('Miss Scarlett', 0);
    const p2 = mkPlayer('Professor Plum', 1);
    const p3 = mkPlayer('Mrs. Peacock', 2);
    const game = createGame([p1, p2, p3]);
    begin(game, () => 0);  // deterministic random injection
    expect(game.solution).not.toBeNull();
    expect(game.solution!.suspect.type).toBe('suspect');
    const totalDealt = game.players.reduce((n, p) => n + p.cards.length, 0);
    // 6 + 6 + 9 = 21 cards; minus 3 in solution = 18 dealt
    expect(totalDealt).toBe(18);
  });

  it('alternates deal across 3 players as evenly as possible', () => {
    const players = [mkPlayer('Miss Scarlett', 0), mkPlayer('Professor Plum', 1), mkPlayer('Mrs. Peacock', 2)];
    const game = createGame(players);
    begin(game, () => 0);
    // 18 cards / 3 players = 6 each
    for (const p of players) expect(p.cards.length).toBe(6);
  });
});

describe('resolveSuggestion', () => {
  it('returns the first matching card from the next player clockwise', () => {
    const cards: Card[] = [
      { type: 'suspect', suspect: 'Miss Scarlett' },
    ];
    const suggester = mkPlayer('Colonel Mustard', 0);
    const next = mkPlayer('Mrs. White', 1, cards);
    const after = mkPlayer('Mr. Green', 2, [{ type: 'weapon', weapon: 'Rope' }]);
    const g = createGame([suggester, next, after]);
    const result = resolveSuggestion(g, 0, {
      suspect: 'Miss Scarlett', weapon: 'Candlestick', room: 'Hall'
    });
    expect(result.revealerIndex).toBe(1);
    expect(result.card).toEqual(cards[0]);
  });

  it('returns null when nobody has any matching card', () => {
    const a = mkPlayer('Colonel Mustard', 0);
    const b = mkPlayer('Mrs. White', 1);
    const c = mkPlayer('Mr. Green', 2);
    const g = createGame([a, b, c]);
    const result = resolveSuggestion(g, 0, {
      suspect: 'Miss Scarlett', weapon: 'Candlestick', room: 'Hall'
    });
    expect(result.revealerIndex).toBeNull();
    expect(result.card).toBeNull();
  });
});

describe('evaluateAccusation', () => {
  it('wins when matches solution', () => {
    const players = [mkPlayer('Miss Scarlett', 0), mkPlayer('Professor Plum', 1)];
    const g = createGame(players);
    g.solution = {
      suspect: { type: 'suspect', suspect: 'Miss Scarlett' },
      weapon: { type: 'weapon', weapon: 'Rope' },
      room: { type: 'room', room: 'Library' },
    };
    expect(evaluateAccusation(g, 0, { suspect: 'Miss Scarlett', weapon: 'Rope', room: 'Library' })).toBe(true);
  });
  it('marks the player failedAccusation on loss', () => {
    const players = [mkPlayer('Miss Scarlett', 0), mkPlayer('Professor Plum', 1)];
    const g = createGame(players);
    g.solution = {
      suspect: { type: 'suspect', suspect: 'Miss Scarlett' },
      weapon: { type: 'weapon', weapon: 'Rope' },
      room: { type: 'room', room: 'Library' },
    };
    expect(evaluateAccusation(g, 0, { suspect: 'Professor Plum', weapon: 'Rope', room: 'Library' })).toBe(false);
    expect(players[0].failedAccusation).toBe(true);
  });
});