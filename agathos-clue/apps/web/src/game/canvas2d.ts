import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  ROOMS,
  SUSPECTS,
  WEAPONS,
  isRoom,
  isSuspect,
  isWeapon,
} from '@agathos/game';
import type { CellId, GameView, Room, Suspect, Weapon } from '@agathos/game';
import type { BoardRenderer, BoardLocation } from './BoardRenderer';
import {
  boardOrigin,
  canonicalRoomAt,
  canonicalSpaceAt,
  cellAtPoint,
  cellCenter,
  layoutFor,
  type BoardLayout,
} from './board-layout';

const ROOM_COLORS: Record<Room, string> = {
  'Ballroom': '#a6e3a1',
  'Billiard Room': '#94e2d5',
  'Conservatory': '#fab387',
  'Dining Room': '#eba0ac',
  'Hall': '#89b4fa',
  'Kitchen': '#f9e2af',
  'Library': '#cba6f7',
  'Lounge': '#f38ba8',
  'Study': '#89dceb',
};

const SUSPECT_COLORS: Record<Suspect, string> = {
  'Miss Scarlett': '#f38ba8',
  'Professor Plum': '#cba6f7',
  'Mrs. Peacock': '#89b4fa',
  'Colonel Mustard': '#fab387',
  'Mr. Green': '#a6e3a1',
  'Mrs. White': '#cdd6f4',
};

const WEAPON_COLORS: Record<Weapon, string> = {
  'Candlestick': '#f9e2af',
  'Dagger': '#cdd6f4',
  'Lead Pipe': '#9399b2',
  'Revolver': '#bac2de',
  'Rope': '#fab387',
  'Wrench': '#89dceb',
};

const CANVAS_BACKGROUND = '#1e1e2e';
const CORRIDOR_COLOR = '#313244';
const VOID_COLOR = '#181825';
const GRID_COLOR = '#585b70';
const HIGHLIGHT_COLOR = '#89b4fa';
const ANIMATION_MS = 180;

type Animation =
  | { kind: 'move' | 'suggestion'; suspect: Suspect; from: BoardLocation; to: BoardLocation; progress: number }
  | { kind: 'accusation'; suspect: Suspect; weapon: Weapon; room: Room; progress: number };

interface CanvasLike {
  width: number;
  height: number;
  getContext(contextId: '2d'): CanvasRenderingContext2D | null;
  addEventListener(type: 'click', listener: (event: MouseEvent) => void): void;
  removeEventListener(type: 'click', listener: (event: MouseEvent) => void): void;
  getBoundingClientRect(): DOMRect;
}

export class Canvas2DRenderer implements BoardRenderer<CanvasRenderingContext2D> {
  private canvas: CanvasLike | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private layout: BoardLayout | null = null;
  private clickCb: ((location: BoardLocation) => void) | null = null;
  private highlight = new Set<BoardLocation>();
  private currentView: GameView | null = null;
  private animation: Animation | null = null;
  private lifecycle = 0;

  attach(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
    this.detach();
    const nextCanvas = canvas as CanvasLike;
    const ctx = nextCanvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');

    this.canvas = nextCanvas;
    this.ctx = ctx;
    this.resize(nextCanvas.width, nextCanvas.height);
    nextCanvas.addEventListener('click', this.onClick);
    return ctx;
  }

  detach(): void {
    this.lifecycle += 1;
    this.animation = null;
    this.canvas?.removeEventListener('click', this.onClick);
    this.canvas = null;
    this.ctx = null;
    this.layout = null;
  }

  render(view: GameView): void {
    this.currentView = view;
    this.draw();
  }

  highlightReachable(spaces: BoardLocation[]): void {
    this.highlight = new Set(spaces.filter(isCanonicalLocation));
    this.draw();
  }

  animateMove(from: BoardLocation, to: BoardLocation): Promise<void> {
    const suspect = this.currentView?.players.find(player => player.location === from)?.suspect;
    if (!suspect || !isCanonicalLocation(from) || !isCanonicalLocation(to)) return Promise.resolve();
    return this.animate({ kind: 'move', suspect, from, to, progress: 0 });
  }

  animateSuggestion(suspect: Suspect, from: BoardLocation, to: BoardLocation): Promise<void> {
    if (!isSuspect(suspect) || !isCanonicalLocation(from) || !isCanonicalLocation(to)) {
      return Promise.resolve();
    }
    return this.animate({ kind: 'suggestion', suspect, from, to, progress: 0 });
  }

  animateAccusation(suspect: Suspect, weapon: Weapon, room: Room): Promise<void> {
    if (!isSuspect(suspect) || !isWeapon(weapon) || !isRoom(room)) return Promise.resolve();
    return this.animate({ kind: 'accusation', suspect, weapon, room, progress: 0 });
  }

  onUserClickCell(cb: (location: BoardLocation) => void): void {
    this.clickCb = cb;
  }

  resize(w: number, h: number): void {
    if (!Number.isFinite(w) || !Number.isFinite(h)) return;
    const width = Math.max(0, Math.floor(w));
    const height = Math.max(0, Math.floor(h));
    if (this.canvas && (this.canvas.width !== width || this.canvas.height !== height)) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.layout = layoutFor(width, height);
    this.draw();
  }

  roomAt(col: number, row: number): Room | null {
    return canonicalRoomAt(col, row);
  }

  private onClick = (event: MouseEvent): void => {
    if (!this.canvas || !this.layout || !this.clickCb) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const x = (event.clientX - rect.left) * this.canvas.width / rect.width;
    const y = (event.clientY - rect.top) * this.canvas.height / rect.height;
    const point = cellAtPoint(x, y, this.canvas.width, this.canvas.height, this.layout);
    if (!point) return;

    const space = canonicalSpaceAt(point.col, point.row);
    if (!space) return;
    this.clickCb(space.room ?? `${point.col},${point.row}`);
  };

  private animate(animation: Animation): Promise<void> {
    if (!this.canvas || !this.ctx || !this.layout) return Promise.resolve();
    const lifecycle = this.lifecycle;
    this.animation = animation;
    const start = now();

    return new Promise(resolve => {
      const tick = (timestamp: number): void => {
        if (lifecycle !== this.lifecycle || !this.canvas || !this.ctx || !this.layout) {
          resolve();
          return;
        }
        this.animation = { ...animation, progress: Math.min(1, (timestamp - start) / ANIMATION_MS) };
        this.draw();
        if (this.animation.progress >= 1) {
          this.animation = null;
          this.draw();
          resolve();
          return;
        }
        requestFrame(tick);
      };
      requestFrame(tick);
    });
  }

  private draw(): void {
    if (!this.canvas || !this.ctx || !this.layout || !this.currentView) return;
    const { canvas, ctx, layout } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = CANVAS_BACKGROUND;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const [originX, originY] = boardOrigin(canvas.width, canvas.height, layout);
    ctx.save();
    ctx.translate(originX, originY);
    this.drawBoard(ctx, layout);
    this.drawHighlights(ctx, layout);
    this.drawPieces(ctx, layout, this.currentView);
    this.drawAnimation(ctx, layout);
    ctx.restore();
  }

  private drawBoard(ctx: CanvasRenderingContext2D, layout: BoardLayout): void {
    ctx.font = `${Math.max(8, Math.floor(layout.cellW * 0.38))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let col = 0; col < BOARD_WIDTH; col += 1) {
      for (let row = 0; row < BOARD_HEIGHT; row += 1) {
        const space = canonicalSpaceAt(col, row);
        const x = col * layout.cellW;
        const y = row * layout.cellH;
        ctx.fillStyle = space?.room ? ROOM_COLORS[space.room] : space ? CORRIDOR_COLOR : VOID_COLOR;
        ctx.fillRect(x, y, layout.cellW, layout.cellH);
        if (space) {
          ctx.strokeStyle = GRID_COLOR;
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, y + 0.5, layout.cellW - 1, layout.cellH - 1);
        }
      }
    }

    for (const room of ROOMS) {
      const cells = roomCells(room);
      if (cells.length === 0) continue;
      const [x, y] = averageCellCenter(cells, layout);
      ctx.fillStyle = '#1e1e2e';
      ctx.fillText(room, x, y);
    }
  }

  private drawHighlights(ctx: CanvasRenderingContext2D, layout: BoardLayout): void {
    ctx.strokeStyle = HIGHLIGHT_COLOR;
    ctx.lineWidth = Math.max(2, layout.cellW * 0.1);
    for (const location of this.highlight) {
      for (const [col, row] of cellsForLocation(location)) {
        const inset = Math.max(1, layout.cellW * 0.12);
        ctx.strokeRect(
          col * layout.cellW + inset,
          row * layout.cellH + inset,
          layout.cellW - inset * 2,
          layout.cellH - inset * 2,
        );
      }
    }
  }

  private drawPieces(
    ctx: CanvasRenderingContext2D,
    layout: BoardLayout,
    view: GameView,
  ): void {
    const locations = new Map<BoardLocation, number>();
    for (const player of view.players) {
      const [x, y] = locationCenter(player.location, layout);
      const offset = locations.get(player.location) ?? 0;
      locations.set(player.location, offset + 1);
      const angle = offset * Math.PI / 3;
      const radius = Math.min(layout.cellW, layout.cellH) * 0.18;
      ctx.fillStyle = SUSPECT_COLORS[player.suspect];
      ctx.beginPath();
      ctx.arc(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius, layout.cellW * 0.28, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const weapon of view.weaponLocations) {
      const [x, y] = locationCenter(weapon.location, layout);
      ctx.fillStyle = WEAPON_COLORS[weapon.weapon];
      ctx.beginPath();
      ctx.moveTo(x, y - layout.cellH * 0.22);
      ctx.lineTo(x + layout.cellW * 0.16, y);
      ctx.lineTo(x, y + layout.cellH * 0.22);
      ctx.lineTo(x - layout.cellW * 0.16, y);
      ctx.closePath();
      ctx.fill();
    }
  }

  private drawAnimation(ctx: CanvasRenderingContext2D, layout: BoardLayout): void {
    const animation = this.animation;
    if (!animation) return;
    if (animation.kind === 'accusation') {
      const [x, y] = locationCenter(animation.room, layout);
      ctx.strokeStyle = SUSPECT_COLORS[animation.suspect];
      ctx.lineWidth = Math.max(2, layout.cellW * 0.1);
      const radius = layout.cellW * (0.35 + animation.progress * 0.25);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }

    const from = locationCenter(animation.from, layout);
    const to = locationCenter(animation.to, layout);
    const x = from[0] + (to[0] - from[0]) * animation.progress;
    const y = from[1] + (to[1] - from[1]) * animation.progress;
    ctx.fillStyle = SUSPECT_COLORS[animation.suspect];
    ctx.beginPath();
    ctx.arc(x, y, layout.cellW * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function isCanonicalLocation(location: BoardLocation): boolean {
  if (isRoom(location)) return true;
  const point = parseCellId(location);
  return point !== null && canonicalSpaceAt(point[0], point[1])?.room === null;
}

function parseCellId(location: string): [number, number] | null {
  const match = /^(\d+),(\d+)$/.exec(location);
  if (!match) return null;
  const col = Number(match[1]);
  const row = Number(match[2]);
  return Number.isSafeInteger(col) && Number.isSafeInteger(row) ? [col, row] : null;
}

function cellsForLocation(location: BoardLocation): Array<[number, number]> {
  if (isRoom(location)) {
    const cells: Array<[number, number]> = [];
    for (let col = 0; col < BOARD_WIDTH; col += 1) {
      for (let row = 0; row < BOARD_HEIGHT; row += 1) {
        if (canonicalRoomAt(col, row) === location) cells.push([col, row]);
      }
    }
    return cells;
  }
  const point = parseCellId(location);
  return point === null || !canonicalSpaceAt(point[0], point[1]) ? [] : [point];
}

function roomCells(room: Room): Array<[number, number]> {
  return cellsForLocation(room);
}

function averageCellCenter(cells: Array<[number, number]>, layout: BoardLayout): [number, number] {
  let x = 0;
  let y = 0;
  for (const [col, row] of cells) {
    const center = cellCenter(col, row, layout);
    x += center[0];
    y += center[1];
  }
  return [x / cells.length, y / cells.length];
}

function locationCenter(location: BoardLocation, layout: BoardLayout): [number, number] {
  const cells = cellsForLocation(location);
  return cells.length > 0 ? averageCellCenter(cells, layout) : [0, 0];
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function requestFrame(callback: (timestamp: number) => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback);
  else setTimeout(() => callback(now()), 16);
}
