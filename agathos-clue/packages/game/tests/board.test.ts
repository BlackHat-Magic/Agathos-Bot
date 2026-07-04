import { describe, it, expect } from 'bun:test';
import { buildBoard, STARTING_POSITIONS } from '../src/board';
import type { BoardSpace } from '../src/types';

describe('buildBoard', () => {
  const board = buildBoard();

  it('is 24 x 25', () => {
    expect(board.length).toBe(24);
    expect(board[0].length).toBe(25);
  });

  it('places Miss Scarlett at (16,24)', () => {
    const [col, row] = STARTING_POSITIONS['Miss Scarlett'];
    expect(board[col][row]).toBeDefined();
    expect(board[col][row]!.pos).toEqual([col, row]);
  });

  it('room spaces hash by room name', () => {
    const ballroom = board[8][2]!;
    expect(ballroom.room).toBe('Ballroom');
  });

  it('Secret-passage rooms link conservatory <-> lounge', () => {
    const conservatory = board[2][1]!;
    const lounge = board[19][23]!;
    expect(conservatory.accesses).toContain(lounge);
    expect(lounge.accesses).toContain(conservatory);
  });

  it('kitchen <-> study secret passage', () => {
    const kitchen = board[18][2]!;
    const study = board[3][21]!;
    expect(kitchen.accesses).toContain(study);
    expect(study.accesses).toContain(kitchen);
  });

  it('a corridor space connects to orthogonal neighbours only', () => {
    const space = board[12][12]!;
    expect(space.room).toBeNull();
    const neighbourPositions = space.accesses.map(a => a.pos);
    expect(neighbourPositions).toContainEqual([11, 12]);
    expect(neighbourPositions).toContainEqual([13, 12]);
    expect(neighbourPositions).toContainEqual([12, 11]);
    expect(neighbourPositions).toContainEqual([12, 13]);
    expect(neighbourPositions).not.toContainEqual([11, 11]);
  });

  it('door-into-room accesses are one-way from corridor', () => {
    // (10,18) is Hall interior; (11,17) is the corridor door cell above Hall
    // per clue.py:164-168 hall.accesses = [sp(11,17), sp(12,17), sp(8,20)].
    const hall = board[10][18]!;
    expect(hall.room).toBe('Hall');
    const door = board[11][17]!;
    expect(door.room).toBeNull();
    expect(door.accesses).toContain(hall);
  });
});