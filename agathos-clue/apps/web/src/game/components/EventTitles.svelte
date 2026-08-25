<script lang="ts">
  import { onDestroy } from 'svelte';
  import { currentView, diceRolling, events, titlesBusy } from '../stores';
  import { formatEvent } from '../event-format';
  import type { Event } from '@agathos/game';

  /**
   * Banners must not outlive the moment they describe: retire to the ticker
   * quickly so the top of the board always reflects the latest event.
   */
  const HOLD_CAP_MS = 3_000;
  const MAX_QUEUE = 8;

  let current: Event | null = null;
  let compact: Event | null = null;
  let queue: Event[] = [];
  let seen = new Set<unknown>();
  let initialized = false;
  let capTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimers: ReturnType<typeof setTimeout>[] = [];
  let titleGeneration = 0;

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

    // Reveal requests are time-sensitive: whoever must respond should see
    // the banner now, not after the preceding banner's hold elapses. Any
    // banner it displaces falls to the ticker for context.
    const priorityIndex = fresh.findIndex(event => event.type === 'revealRequested');
    if (priorityIndex !== -1) {
      const priority = fresh[priorityIndex]!;
      const displaced = fresh.filter(event => event !== priority);
      compact = current ?? displaced[displaced.length - 1] ?? compact;
      queue.length = 0;
      current = priority;
      titlesBusy.set(true);
      scheduleCap();
      return;
    }

    queue.push(...fresh);
    while (queue.length > MAX_QUEUE) queue.shift();
    drain();
  }

  /** Turn handoffs announce who acts next, not who just finished. */
  function titleFor(event: Event): string {
    if (event.type === 'turnEnded' && $currentView !== null) {
      const next = $currentView.players[$currentView.turnIndex];
      return `It's now ${next?.name ?? 'the next detective'}'s turn`;
    }
    return formatEvent(event, $currentView);
  }

  function drain(): void {
    if ($diceRolling) {
      // Never talk over the dice; retry shortly.
      titlesBusy.set(true);
      scheduleRetry(drain, 250);
      return;
    }
    const next = queue.shift();
    if (next === undefined) {
      if (current === null) titlesBusy.set(false);
      return;
    }
    show(next);
  }

  function show(next: Event): void {
    compact = null;
    current = next;
    titlesBusy.set(true);
    scheduleCap();
  }

  function scheduleCap(): void {
    const generation = ++titleGeneration;
    if (capTimer !== undefined) clearTimeout(capTimer);
    const timer = setTimeout(() => {
      if (generation !== titleGeneration) return;
      capTimer = undefined;
      compact = current;
      current = null;
      drain();
    }, HOLD_CAP_MS);
    capTimer = timer;
  }

  function scheduleRetry(fn: () => void, delay: number): void {
    const generation = titleGeneration;
    const timer = setTimeout(() => {
      retryTimers = retryTimers.filter(candidate => candidate !== timer);
      if (generation === titleGeneration) fn();
    }, delay);
    retryTimers.push(timer);
  }

  function clearTimers(): void {
    titleGeneration += 1;
    if (capTimer !== undefined) clearTimeout(capTimer);
    capTimer = undefined;
    for (const timer of retryTimers) clearTimeout(timer);
    retryTimers = [];
    titlesBusy.set(false);
  }

  onDestroy(clearTimers);
</script>

{#if current !== null}
  <div class="pointer-events-none absolute inset-x-0 top-[10%] z-20 flex justify-center px-6" aria-live="polite">
    <div class="title-backdrop title-text rounded-2xl px-10 py-6 text-center">
      <p class="max-w-full font-display text-3xl font-bold text-mocha-text drop-shadow-[0_4px_18px_rgb(0_0_0/95%)] sm:text-4xl">
        {titleFor(current)}
      </p>
    </div>
  </div>
{:else if compact !== null}
  <div class="pointer-events-none absolute inset-x-0 top-[3%] z-20 flex justify-center px-6">
    <p class="ticker rounded-full border border-mocha-surface1 bg-mocha-crust/85 px-4 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-mocha-subtext1 backdrop-blur-sm">
      Last: {titleFor(compact)}
    </p>
  </div>
{/if}

<style>
  /* Same gradient plinth as the reveal prompt for board separation. */
  .title-backdrop {
    background: linear-gradient(
      180deg,
      rgb(17 17 27 / 92%) 0%,
      rgb(17 17 27 / 72%) 65%,
      rgb(17 17 27 / 30%) 100%
    );
    box-shadow:
      0 12px 48px rgb(0 0 0 / 65%),
      inset 0 1px 0 rgb(205 214 244 / 8%);
  }

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
