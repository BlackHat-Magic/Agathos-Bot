import type { CellId, GameView, Room, Suspect, Weapon } from '@agathos/game';

export type BoardLocation = CellId | Room;

export interface BoardRenderer<Ctx> {
  attach(canvas: HTMLCanvasElement): Ctx;
  detach(): void;
  render(view: GameView): void;
  highlightReachable(spaces: BoardLocation[]): void;
  animateMove(from: BoardLocation, to: BoardLocation): Promise<void>;
  animateSuggestion(suspect: Suspect, from: BoardLocation, to: BoardLocation): Promise<void>;
  animateAccusation(suspect: Suspect, weapon: Weapon, room: Room): Promise<void>;
  onUserClickCell(cb: (cell: BoardLocation) => void): void;
  resize(w: number, h: number): void;
}
