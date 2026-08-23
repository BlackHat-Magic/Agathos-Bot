import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('returns an empty layout for unusable or too-tiny dimensions', () => {
    for (const [width, height] of [
      [Number.NaN, 250],
      [Number.POSITIVE_INFINITY, 250],
      [Number.NEGATIVE_INFINITY, 250],
      [-1, 250],
      [0, 250],
      [23, 24],
    ]) {
      const layout = layoutFor(width, height);
      expect(layout).toEqual({ cellW: 0, cellH: 0, pxW: 0, pxH: 0 });
      expect(cellAtPoint(1, 1, width, height, layout)).toBeNull();
    }
  });

  it('rejects nonfinite and unusable hit-test dimensions', () => {
    const layout = layoutFor(480, 250);
    expect(cellAtPoint(1, 1, Number.NaN, 250, layout)).toBeNull();
    expect(cellAtPoint(1, 1, 480, Number.POSITIVE_INFINITY, layout)).toBeNull();
    expect(cellAtPoint(1, 1, -480, 250, layout)).toBeNull();
    expect(cellAtPoint(Number.NaN, 1, 480, 250, layout)).toBeNull();
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

  it('skips invalid and stale player and weapon locations', () => {
    const canvas = new FakeCanvas(240, 250, 240, 250);
    const renderer = new Canvas2DRenderer();
    renderer.attach(canvas as unknown as HTMLCanvasElement);
    renderer.render({
      ...view(),
      players: [{ ...view().players[0], location: 'not-a-room' },
        { ...view().players[0], location: '999,999' },
        { ...view().players[0], location: '08,2' }],
      weaponLocations: [{ weapon: 'Dagger', location: 'not-a-cell' }],
    });

    expect(canvas.context.arcRadii).toEqual([]);
  });

  it('emphasizes the current player and halos suspect tokens', () => {
    const canvas = new FakeCanvas(240, 250, 240, 250);
    const renderer = new Canvas2DRenderer();
    renderer.attach(canvas as unknown as HTMLCanvasElement);
    const firstPlayer = view().players[0];
    renderer.render({
      ...view(),
      myIndex: 1,
      players: [firstPlayer, { ...firstPlayer, name: 'Bob', suspect: 'Mrs. Peacock' }],
    });

    expect(canvas.context.arcRadii).toEqual(expect.arrayContaining([10 * 0.28, 10 * 0.34, 10 * 0.34 + 2]));
    expect(canvas.context.strokeStyles).toContain('#1e1e2e');
    expect(canvas.context.strokeStyles).toContain('#f9e2af');
  });

  it('resolves a replaced animation and ignores its stale frame', async () => {
    const frames: Array<(timestamp: number) => void> = [];
    vi.stubGlobal('requestAnimationFrame', (callback: (timestamp: number) => void) => {
      frames.push(callback);
      return frames.length;
    });
    const canvas = new FakeCanvas(240, 250, 240, 250);
    const renderer = new Canvas2DRenderer();
    renderer.attach(canvas as unknown as HTMLCanvasElement);
    renderer.render(view());

    const first = renderer.animateSuggestion('Miss Scarlett', '12,12', '13,12');
    const second = renderer.animateSuggestion('Mrs. Peacock', '12,12', '13,12');
    await expect(first).resolves.toBeUndefined();

    const callsBeforeStaleFrame = canvas.context.calls.length;
    frames[0]!(Number.MAX_VALUE);
    expect(canvas.context.calls.length).toBe(callsBeforeStaleFrame);

    frames[1]!(Number.MAX_VALUE);
    await expect(second).resolves.toBeUndefined();
  });

  it('settles the active animation when detached', async () => {
    const frames: Array<(timestamp: number) => void> = [];
    vi.stubGlobal('requestAnimationFrame', (callback: (timestamp: number) => void) => {
      frames.push(callback);
      return frames.length;
    });
    const canvas = new FakeCanvas(240, 250, 240, 250);
    const renderer = new Canvas2DRenderer();
    renderer.attach(canvas as unknown as HTMLCanvasElement);
    renderer.render(view());

    const pending = renderer.animateSuggestion('Miss Scarlett', '12,12', '13,12');
    renderer.detach();
    await expect(pending).resolves.toBeUndefined();
    frames[0]!(Number.MAX_VALUE);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
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
  readonly arcRadii: number[] = [];
  readonly strokeStyles: string[] = [];
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
  arc(_x: number, _y: number, radius: number): void { this.calls.push('arc'); this.arcRadii.push(radius); }
  fill(): void { this.calls.push('fill'); }
  moveTo(): void { this.calls.push('moveTo'); }
  lineTo(): void { this.calls.push('lineTo'); }
  closePath(): void { this.calls.push('closePath'); }
  stroke(): void { this.calls.push('stroke'); this.strokeStyles.push(this.strokeStyle); }
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
