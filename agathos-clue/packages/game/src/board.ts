import type { BoardSpace, Room, Suspect } from './types';
import { STARTING_POSITIONS } from './types';

export { STARTING_POSITIONS };

export const BOARD_WIDTH = 24;
export const BOARD_HEIGHT = 25;

export function buildBoard(): BoardSpace[][] {
  const board: (BoardSpace | null)[][] = Array.from(
    { length: BOARD_WIDTH },
    () => Array<BoardSpace | null>(BOARD_HEIGHT).fill(null),
  );

  const mkRoomSpace = (r: Room): BoardSpace => ({ room: r, pos: null, accesses: [] });
  const rooms: Record<Room, BoardSpace> = {
    'Ballroom': mkRoomSpace('Ballroom'),
    'Billiard Room': mkRoomSpace('Billiard Room'),
    'Conservatory': mkRoomSpace('Conservatory'),
    'Dining Room': mkRoomSpace('Dining Room'),
    'Hall': mkRoomSpace('Hall'),
    'Kitchen': mkRoomSpace('Kitchen'),
    'Library': mkRoomSpace('Library'),
    'Lounge': mkRoomSpace('Lounge'),
    'Study': mkRoomSpace('Study'),
  };

  for (let col = 0; col < BOARD_WIDTH; col++) {
    for (let row = 0; row < BOARD_HEIGHT; row++) {
      const assign = (space: BoardSpace) => { board[col][row] = space; };
      if ((col >= 10 && col <= 13 && row === 1) || (col >= 8 && col <= 15 && row >= 2 && row <= 7))
        assign(rooms.Ballroom);
      else if (col <= 5 && row >= 8 && row <= 12)
        assign(rooms['Billiard Room']);
      else if ((col <= 5 && row >= 1 && row <= 4) || (col >= 1 && col <= 4 && row === 5))
        assign(rooms.Conservatory);
      else if ((col >= 19 && col <= 23 && row === 9) || (col >= 16 && col <= 23 && row >= 10 && row <= 15))
        assign(rooms['Dining Room']);
      else if (col >= 9 && col <= 14 && row >= 18 && row <= 23)
        assign(rooms.Hall);
      else if ((col >= 18 && col <= 23 && row <= 5) || (col >= 18 && col <= 22 && row === 6))
        assign(rooms.Kitchen);
      else if ((col >= 1 && col <= 5 && (row === 14 || row === 18)) || (col <= 6 && row >= 15 && row <= 17))
        assign(rooms.Library);
      else if (col >= 17 && row >= 19 && !(col === 17 && row === 24))
        assign(rooms.Lounge);
      else if (col <= 6 && row >= 21 && !(col === 6 && row === 24))
        assign(rooms.Study);
      else {
        if (col === 0 && row !== 6 && row !== 19) continue;
        if (col === 23 && row !== 7 && row !== 17) continue;
        if (row === 0 && col !== 9 && col !== 14) continue;
        if (row === 24 && col !== 7 && col !== 16) continue;
        board[col][row] = { room: null, pos: [col, row], accesses: [] };
      }
    }
  }

  const sp = (x: number, y: number): BoardSpace => {
    const s = board[x][y];
    if (!s) throw new Error(`no space at ${x},${y}`);
    return s;
  };

  rooms.Ballroom.accesses = [sp(7, 5), sp(9, 8), sp(14, 8), sp(16, 5)];
  rooms['Billiard Room'].accesses = [sp(6, 9), sp(1, 13)];
  rooms.Conservatory.accesses = [rooms.Lounge, sp(5, 5)];
  rooms['Dining Room'].accesses = [sp(15, 12), sp(16, 16)];
  rooms.Hall.accesses = [sp(11, 17), sp(12, 17), sp(8, 20)];
  rooms.Kitchen.accesses = [rooms.Study, sp(19, 7)];
  rooms.Library.accesses = [sp(3, 13), sp(7, 16)];
  rooms.Lounge.accesses = [rooms.Conservatory, sp(17, 18)];
  rooms.Study.accesses = [rooms.Kitchen, sp(6, 20)];

  for (let col = 0; col < BOARD_WIDTH; col++) {
    for (let row = 0; row < BOARD_HEIGHT; row++) {
      const space = board[col][row];
      if (!space || space.room || space.accesses.length || space.pos == null) continue;
      const [c, r] = space.pos;
      const consider = (x: number, y: number) => {
        if (x < 0 || x >= BOARD_WIDTH || y < 0 || y >= BOARD_HEIGHT) return;
        const accessee = board[x][y];
        if (!accessee) return;
        if (accessee.room && !accessee.accesses.includes(space)) return;
        space.accesses.push(accessee);
      };
      consider(c - 1, r);
      consider(c + 1, r);
      consider(c, r - 1);
      consider(c, r + 1);
    }
  }

  return board as BoardSpace[][];
}

export function spaceAt(board: BoardSpace[][], col: number, row: number): BoardSpace {
  const s = board[col][row];
  if (!s) throw new Error(`no space at ${col},${row}`);
  return s;
}

export function suspectStart(suspect: Suspect, board: BoardSpace[][]): BoardSpace {
  return spaceAt(board, ...STARTING_POSITIONS[suspect]);
}