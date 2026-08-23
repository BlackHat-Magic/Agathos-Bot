import { describe, it, expect } from 'bun:test';
import { buildBoard, spaceAt } from '../src/board';
import { reachable } from '../src/pathfind';

describe('reachable', () => {
  const board = buildBoard();

  it('returns empty at limit 0', () => {
    const here = spaceAt(board, 16, 24);   // Miss Scarlett start
    const r = reachable(here, 0);
    expect(r.spaces).toHaveLength(0);
  });

  // NOTE: The original plan test claimed "can reach Ballroom door from Miss
  // Scarlett in <=6" but asserted `toContain('Hall')` — internally
  // inconsistent (Ballroom != Hall). Tracing the actual board geometry:
  // from Miss Scarlett's start (16, 24), no room is reachable within limit 6;
  // Hall first becomes reachable at limit 11, Ballroom at limit 18. The
  // nearest room is Lounge (door at (17,18)), which becomes reachable at
  // limit 7. Adjusted (not pre-authorized, unlike the third test, but the
  // plan test is provably wrong on both Ballroom-and-6 and Hall-and-6
  // interpretations; the implementation matches clue.py:329-372 exactly).
  it('can reach Lounge from Miss Scarlett within a die-roll range', () => {
    const here = spaceAt(board, 16, 24);
    const r = reachable(here, 7);
    const roomIds = r.spaces.map(s => s.room).filter(Boolean);
    expect(roomIds).toContain('Lounge');
  });

  // NOTE: The original plan's third test used spaceAt(board, 9, 18) as the
  // start, but (9, 18) is INSIDE Hall (a room cell) per clue.py:126
  // (9 <= x <= 14 && 18 <= y <= 23). Starting from the Hall room directly
  // means Hall is the *source* and is filtered out by the `space == source`
  // check at clue.py:354, so the assertion would never see Hall in
  // r.spaces. Pre-authorized adjustment: start from the corridor door above
  // Hall at (11, 17) and assert entering Hall costs 0.
  it('entering a room through a door costs 0', () => {
    const start = spaceAt(board, 11, 17);   // corridor cell above Hall's door
    const r = reachable(start, 1);
    const hall = r.spaces.find(s => s.room === 'Hall');
    expect(hall).toBeDefined();
    expect(r.cost.get(hall!)).toBe(0);
  });

  it('does not chain through secret passage during dice move', () => {
    const lounge = buildBoard()[19][23]!; // Lounge
    const r = reachable(lounge, 25);
    // Conservatory reachable via passage is NOT in dice-reachable list
    expect(r.spaces.map(s => s.room)).not.toContain('Conservatory');
  });
});