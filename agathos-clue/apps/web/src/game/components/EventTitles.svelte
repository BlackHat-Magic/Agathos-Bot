<script lang="ts">
  import { onDestroy } from 'svelte';
  import { currentView, diceRolling, events, titlesBusy } from '../stores';
  import { formatEvent } from '../event-format';
  import type { Event } from '@agathos/game';

  /** A title always stays readable for at least this long, bursts included. */
  const MIN_VISIBLE_MS = 5_000;
  /** After this long without a successor, a title retires to the ticker. */
  const HOLD_CAP_MS = 12_000;
  const MAX_QUEUE = 8;

  let current: Event | null = null;
  let compact: Event | null = null;
  let shownAt = 0;
  let queue: Event[] = [];
  let seen = new Set<unknown>();
  let initialized = false;
  let timers: ReturnType<typeof setTimeout>[] = [];

  $: ingest($events);

  function ingest(list: readonly Event[]): void {
    if (!initialized) {
      for (const event of list) seen.add(event);
      initialized = true;
      return;
    }
    const fresh: Event[] = [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const event = list[index];
      if (seen.has(event)) break;
      seen.add(event);
      // Rolls already speak through the dice overlay.
      if (event.type !== 'rolled') fresh.unshift(event);
    }
    if (fresh.length === 0) return;
    queue.push(...fresh);
    while (queue.length > MAX_QUEUE) queue.shift();
    drain();
  }

  /**
   * Advance the pipeline: a fresh title replaces the visible one once it has
   * been readable for MIN_VISIBLE_MS; otherwise the visible title holds until
   * its cap, then retires to the persistent ticker. There is never a stretch
   * with neither a title nor a ticker after the first event.
   */
  function drain(): void {
    if ($diceRolling) {
      titlesBusy.set(true);
      schedule(drain, 250);
      return;
    }
    if (current !== null) {
      const remaining = MIN_VISIBLE_MS - (Date.now() - shownAt);
      if (remaining > 0) {
        schedule(drain, remaining);
        return;
      }
      if (queue.length > 0) {
        advance();
        return;
      }
      return; // still inside its hold window; the cap timer will retire it
    }
    if (queue.length > 0) {
      advance();
      return;
    }
    if (compact === null) titlesBusy.set(false);
  }

  function advance(): void {
    const next = queue.shift();
    if (next === undefined) return;
    compact = null;
    current = next;
    shownAt = Date.now();
    titlesBusy.set(true);
    schedule(() => {
      compact = current;
      current = null;
      drain();
    }, HOLD_CAP_MS);
  }

  function schedule(fn: () => void, delay: number): void {
    timers.push(setTimeout(fn, delay));
  }

  function clearTimers(): void {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
  }

  onDestroy(() => {
    clearTimers();
    titlesBusy.set(false);
  });
</script>

{#if current !== null}
  <div class="pointer-events-none absolute inset-x-0 top-[10%] z-20 flex justify-center px-6" aria-live="polite">
    <p class="title-text max-w-full text-center font-display text-3xl font-bold text-mocha-text drop-shadow-[0_4px_18px_rgb(0_0_0/95%)] sm:text-4xl">
      {formatEvent(current, $currentView)}
    </p>
  </div>
{:else if compact !== null}
  <div class="pointer-events-none absolute inset-x-0 top-[3%] z-20 flex justify-center px-6">
    <p class="ticker rounded-full border border-mocha-surface1 bg-mocha-crust/85 px-4 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-mocha-subtext1 backdrop-blur-sm">
      Last: {formatEvent(compact, $currentView)}
    </p>
  </div>
{/if}

<style>
  .title-text {
    animation: title-in 0.4s cubic-bezier(0.2, 1.1, 0.3, 1) both;
  }

  @keyframes title-in {
    from {
      opacity: 0;
      transform: scale(1.25);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .title-text {
      animation: none;
    }
  }
</style>
