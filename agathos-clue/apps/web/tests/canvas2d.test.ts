import { describe, expect, it } from 'vitest';
import type { GameView } from '@agathos/game';
import { Canvas2DRenderer } from '../src/game/canvas2d';
import { cellAtPoint, cellCenter, layoutFor } from '../src/game/board-layout';

describe('board layout', () => {
  it('preserves the canonical 24 x 25 aspect ratio', () => {
    const layout = layoutFor(1920, 1080);
    const aspect = layout.pxW / layout.pxH;
    expect(Math.abs(aspect - 24 / 25)).toBeLessThan(0.05);
  });

  it('centers cells in a square-cell layout', () => {
    const layout = layoutFor(240, 250);
    expect(cellCenter(0, 0, layout)).toEqual([5, 5]);
  });

  it('rejects points in the centered letterbox area', () => {
    const layout = layoutFor(480, 250);
    expect(cellAtPoint(10, 10, 480, 250, layout)).toBeNull();
    expect(cellAtPoint(125, 25, 480, 250, layout)).toEqual({ col: 0, row: 2 });
  });
});

describe('Canvas2DRenderer', () => {
  it('hit-tests canonical rooms, corridors, voids, and CSS-scaled canvases', () => {
    const canvas = new FakeCanvas(480, 250, 960, 500);
    const renderer = new Canvas2DRenderer();
    const clicked: string[] = [];
    renderer.onUserClickCell(location => clicked.push(location));
    renderer.attach(canvas as unknown as HTMLCanvasElement);

    canvas.click(410, 50); // backing (205, 25), canonical Ballroom cell (8, 2)
    canvas.click(750, 250); // backing (375, 125), outside the board's right edge
    canvas.click(250, 10); // backing (125, 5), canonical void (0, 0)

    expect(clicked).toEqual(['Ballroom']);

    canvas.click(510, 250); // backing (255, 125), canonical corridor (13, 12)
    expect(clicked).toEqual(['Ballroom', '13,12']);
  });

  it('does not duplicate listeners and detaches safely', () => {
    const canvas = new FakeCanvas(240, 250, 240, 250);
    const renderer = new Canvas2DRenderer();
    const clicked: string[] = [];
    renderer.onUserClickCell(location => clicked.push(location));
    renderer.attach(canvas as unknown as HTMLCanvasElement);
    renderer.attach(canvas as unknown as HTMLCanvasElement);
    canvas.click(125, 125); // canonical corridor (12, 12)
    expect(clicked).toEqual(['12,12']);

    renderer.detach();
    canvas.click(125, 125);
    expect(clicked).toEqual(['12,12']);
    renderer.highlightReachable(['Ballroom', '12,12']);
  });

  it('renders a view without requiring a browser canvas implementation', () => {
    const canvas = new FakeCanvas(240, 250, 240, 250);
    const renderer = new Canvas2DRenderer();
    renderer.attach(canvas as unknown as HTMLCanvasElement);
    renderer.render(view());
    renderer.highlightReachable(['Ballroom', '12,12']);
    expect(canvas.context.calls).toContain('fillRect');
    expect(canvas.context.calls).toContain('arc');
  });
});

function view(): GameView {
  return {
    phase: 'playing',
    boardWidth: 24,
    boardHeight: 25,
    players: [{
      name: 'Alice',
      suspect: 'Miss Scarlett',
      location: '12,12',
      handCount: 0,
      failedAccusation: false,
      isRobot: false,
      movedBySuggestion: false,
    }],
    weaponLocations: [{ weapon: 'Dagger', location: 'Ballroom' }],
    turnIndex: 0,
    winnerIndex: null,
    pendingReveal: null,
    lastDieRoll: null,
    myIndex: 0,
    myHand: [],
  };
}

class FakeContext {
  readonly calls: string[] = [];
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 0;
  font = '';
  textAlign = 'left';
  textBaseline = 'alphabetic';
  clearRect(): void { this.calls.push('clearRect'); }
  fillRect(): void { this.calls.push('fillRect'); }
  strokeRect(): void { this.calls.push('strokeRect'); }
  fillText(): void { this.calls.push('fillText'); }
  beginPath(): void { this.calls.push('beginPath'); }
  arc(): void { this.calls.push('arc'); }
  fill(): void { this.calls.push('fill'); }
  moveTo(): void { this.calls.push('moveTo'); }
  lineTo(): void { this.calls.push('lineTo'); }
  closePath(): void { this.calls.push('closePath'); }
  stroke(): void { this.calls.push('stroke'); }
  save(): void { this.calls.push('save'); }
  restore(): void { this.calls.push('restore'); }
  translate(): void { this.calls.push('translate'); }
}

class FakeCanvas {
  readonly context = new FakeContext();
  private readonly listeners = new Set<(event: MouseEvent) => void>();
  width: number;
  height: number;
  private readonly cssWidth: number;
  private readonly cssHeight: number;

  constructor(width: number, height: number, cssWidth: number, cssHeight: number) {
    this.width = width;
    this.height = height;
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
  }

  getContext(): CanvasRenderingContext2D {
    return this.context as unknown as CanvasRenderingContext2D;
  }

  addEventListener(_type: 'click', listener: (event: MouseEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'click', listener: (event: MouseEvent) => void): void {
    this.listeners.delete(listener);
  }

  getBoundingClientRect(): DOMRect {
    return { left: 0, top: 0, width: this.cssWidth, height: this.cssHeight } as DOMRect;
  }

  click(clientX: number, clientY: number): void {
    const event = { clientX, clientY } as MouseEvent;
    for (const listener of this.listeners) listener(event);
  }
}
