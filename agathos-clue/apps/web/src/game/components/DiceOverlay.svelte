<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { Event } from '@agathos/game';
  import { currentView, diceRolling, events } from '../stores';
  import { SUSPECT_COLORS } from '../canvas2d';
  import {
    DICE_SETTLE_HOLD_MS,
    DICE_TUMBLE_MS,
    FACE_ROTATIONS,
    PIP_LAYOUT,
    splitRoll,
    tumbleStartRotation,
  } from '../dice';

  type Phase = 'idle' | 'tumbling' | 'settled';
  type RolledEvent = Extract<Event, { type: 'rolled' }>;

  /** Backlog guard: if many robots rolled while we were behind, keep it snappy. */
  const MAX_QUEUE = 6;

  const PIPS_PER_FACE: Record<number, number[]> = Object.fromEntries(
    Object.entries(PIP_LAYOUT).map(([value, pips]) => [value, [...pips]]),
  );

  let phase: Phase = 'idle';
  let rollSeq = 0;
  let faces = { die1: 1, die2: 1 };
  let startTransforms = ['', ''];
  let rollerName = '';
  let rollerColor = 'var(--color-mocha-mauve)';
  let timers: ReturnType<typeof setTimeout>[] = [];

  /**
   * Robot actions arrive as a rapid burst of state frames, so rolls are
   * queued and played in order — restarting on the newest roll silently
   * dropped every other player's dice.
   */
  let queue: RolledEvent[] = [];
  let seen = new Set<unknown>();
  let initialized = false;

  $: ingest($events);

  function ingest(list: readonly Event[]): void {
    if (!initialized) {
      // First sight of the game: existing history stays history.
      for (const event of list) seen.add(event);
      initialized = true;
      return;
    }
    const fresh: RolledEvent[] = [];
    for (let index = list.length - 1; index >= 0; index--) {
      const event = list[index];
      if (seen.has(event)) break;
      seen.add(event);
      if (event.type === 'rolled') fresh.unshift(event);
    }
    if (fresh.length === 0) return;
    queue.push(...fresh);
    while (queue.length > MAX_QUEUE) queue.shift();
    if (phase === 'idle') playNext();
  }

  function clearTimers(): void {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
  }

  function prefersReducedMotion(): boolean {
    return typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function playNext(): void {
    const roll = queue.shift();
    if (roll === undefined) return;
    diceRolling.set(true);
    rollSeq += 1;
    faces = splitRoll(roll.result);
    startTransforms = [
      tumbleStartRotation(faces.die1),
      tumbleStartRotation(faces.die2),
    ];
    const player = $currentView?.players[roll.playerIndex];
    rollerName = player?.name ?? 'A detective';
    rollerColor = player ? SUSPECT_COLORS[player.suspect] : rollerColor;

    if (prefersReducedMotion()) {
      phase = 'settled';
      timers.push(setTimeout(() => finishRoll(), DICE_SETTLE_HOLD_MS));
      return;
    }
    phase = 'tumbling';
    timers.push(setTimeout(() => (phase = 'settled'), DICE_TUMBLE_MS));
    timers.push(setTimeout(() => finishRoll(), DICE_TUMBLE_MS + DICE_SETTLE_HOLD_MS));
  }

  function finishRoll(): void {
    phase = 'idle';
    // Skip the long victory-lap hold while a backlog of rolls is waiting.
    if (queue.length > 0) {
      playNext();
      return;
    }
    diceRolling.set(false);
  }

  onDestroy(() => {
    clearTimers();
    diceRolling.set(false);
  });

  /** Jump to the start pose instantly, then transition into the resting face. */
  function tumble(node: HTMLDivElement, params: { start: string; end: string }): void {
    if (prefersReducedMotion() || phase === 'settled') {
      node.style.transform = params.end;
      return;
    }
    node.style.transition = 'none';
    node.style.transform = params.start;
    void node.offsetWidth;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      node.style.transition =
        `transform ${DICE_TUMBLE_MS}ms cubic-bezier(0.16, 0.84, 0.28, 1)`;
      node.style.transform = params.end;
    }));
  }
</script>

{#key rollSeq}
  {#if phase !== 'idle'}
    <div class="dice-overlay pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-5" aria-hidden={phase !== 'settled'}>
      <p
        class="roller-chip rounded-full border bg-mocha-mantle/95 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] backdrop-blur"
        style="border-color: {rollerColor}; color: {rollerColor};"
      >
        {rollerName}
      </p>

      <div class="dice-stage flex items-center gap-8">
        {#each [faces.die1, faces.die2] as value, dieIndex (dieIndex)}
          <div class="die" use:tumble={{ start: startTransforms[dieIndex]!, end: FACE_ROTATIONS[value]! }}>
            {#each [1, 2, 3, 4, 5, 6] as faceValue (faceValue)}
              <div class={`face face-${faceValue}`}>
                {#each PIPS_PER_FACE[faceValue] as pip (pip)}
                  <span class="pip" style="grid-area: {Math.floor(pip / 3) + 1} / {pip % 3 + 1};"></span>
                {/each}
              </div>
            {/each}
          </div>
        {/each}
      </div>

      {#if phase === 'settled'}
        <p class="total-badge font-display text-4xl font-bold text-mocha-text" style="text-shadow: 0 2px 16px rgb(0 0 0 / 60%);">
          {faces.die1 + faces.die2}
        </p>
        <p class="sr-only" role="status">{rollerName} rolled {faces.die1 + faces.die2}</p>
      {/if}
    </div>
  {/if}
{/key}

<style>
  .dice-stage {
    perspective: 700px;
  }

  .die {
    position: relative;
    width: 54px;
    height: 54px;
    transform-style: preserve-3d;
  }

  .face {
    position: absolute;
    inset: 0;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    grid-template-rows: repeat(3, 1fr);
    padding: 7px;
    border-radius: 10px;
    background: linear-gradient(160deg, var(--color-mocha-text) 0%, var(--color-mocha-rosewater) 100%);
    box-shadow: inset 0 0 8px rgb(17 17 27 / 35%);
  }
  .face-1 { transform: translateZ(27px); }
  .face-6 { transform: rotateY(180deg) translateZ(27px); }
  .face-2 { transform: rotateX(-90deg) translateZ(27px); }
  .face-5 { transform: rotateX(90deg) translateZ(27px); }
  .face-3 { transform: rotateY(90deg) translateZ(27px); }
  .face-4 { transform: rotateY(-90deg) translateZ(27px); }

  .pip {
    align-self: center;
    justify-self: center;
    width: 9px;
    height: 9px;
    border-radius: 9999px;
    background: var(--color-mocha-crust);
    box-shadow: inset 0 1px 2px rgb(0 0 0 / 45%);
  }

  @media (prefers-reduced-motion: reduce) {
    .die { transition: none; }
  }
</style>
