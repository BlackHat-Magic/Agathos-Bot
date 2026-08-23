import { BOARD_HEIGHT, BOARD_WIDTH, buildBoard } from '@agathos/game';
import type { BoardSpace, Room } from '@agathos/game';

export const CELL = 28;

export interface BoardLayout {
  cellW: number;
  cellH: number;
  pxW: number;
  pxH: number;
}

export interface BoardPoint {
  col: number;
  row: number;
}

export function layoutFor(canvasW: number, canvasH: number): BoardLayout {
  const width = Math.max(0, Math.floor(canvasW));
  const height = Math.max(0, Math.floor(canvasH));
  const cellW = Math.floor(width / BOARD_WIDTH);
  const cellH = Math.floor(height / BOARD_HEIGHT);
  const cell = Math.min(cellW, cellH);
  return { cellW: cell, cellH: cell, pxW: cell * BOARD_WIDTH, pxH: cell * BOARD_HEIGHT };
}

export function boardOrigin(canvasW: number, canvasH: number, layout: BoardLayout): [number, number] {
  return [Math.floor((canvasW - layout.pxW) / 2), Math.floor((canvasH - layout.pxH) / 2)];
}

export function cellCenter(col: number, row: number, layout: BoardLayout): [number, number] {
  return [col * layout.cellW + layout.cellW / 2, row * layout.cellH + layout.cellH / 2];
}

export function cellAtPoint(
  x: number,
  y: number,
  canvasW: number,
  canvasH: number,
  layout: BoardLayout,
): BoardPoint | null {
  if (layout.cellW <= 0 || layout.cellH <= 0 || !Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  const [originX, originY] = boardOrigin(canvasW, canvasH, layout);
  const boardX = x - originX;
  const boardY = y - originY;
  if (boardX < 0 || boardY < 0 || boardX >= layout.pxW || boardY >= layout.pxH) return null;

  const col = Math.floor(boardX / layout.cellW);
  const row = Math.floor(boardY / layout.cellH);
  if (col < 0 || col >= BOARD_WIDTH || row < 0 || row >= BOARD_HEIGHT) return null;
  return { col, row };
}

const CANONICAL_BOARD = buildBoard();

export function canonicalSpaceAt(col: number, row: number): BoardSpace | null {
  if (!Number.isInteger(col) || !Number.isInteger(row) ||
      col < 0 || col >= BOARD_WIDTH || row < 0 || row >= BOARD_HEIGHT) {
    return null;
  }
  return CANONICAL_BOARD[col]?.[row] ?? null;
}

export function canonicalRoomAt(col: number, row: number): Room | null {
  return canonicalSpaceAt(col, row)?.room ?? null;
}
