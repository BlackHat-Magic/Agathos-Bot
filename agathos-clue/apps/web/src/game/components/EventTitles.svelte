<script lang="ts">
  import { onDestroy } from 'svelte';
  import { currentView, diceRolling, events, titlesBusy } from '../stores';
  import { formatEvent } from '../event-format';
  import type { Event } from '@agathos/game';

  const DISPLAY_MS = 1_400;
  const MAX_QUEUE = 8;

  let queue: Event[] = [];
  let seen = new Set<unknown>();
  let initialized = false;
  let current: Event | null = null;
  let timers: ReturnType<typeof setTimeout>[] = [];

  $: ingest($events, $diceRolling);

  function ingest(list: readonly Event[], rolling: boolean): void {
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
    // Hold titles while the dice are on screen so they never talk over each other.
    if (current === null && !rolling) playNext();
    else if (current === null) titlesBusy.set(true);
  }

  function playNext(): void {
    if ($diceRolling) {
      titlesBusy.set(true);
      timers.push(setTimeout(playNext, 250));
      return;
    }
    const next = queue.shift();
    if (next === undefined) {
      titlesBusy.set(false);
      return;
    }
    titlesBusy.set(true);
    current = next;
    timers.push(setTimeout(() => {
      current = null;
      if (queue.length > 0 || $diceRolling) playNext();
      else titlesBusy.set(false);
    }, DISPLAY_MS));
  }

  onDestroy(() => {
    clearTimers();
    titlesBusy.set(false);
  });

  function clearTimers(): void {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
  }
</script>

{#if current !== null}
  <div class="pointer-events-none absolute inset-0 z-20 flex items-start justify-center pt-[10%]" aria-live="polite">
    <p class="title-text max-w-[85%] text-center font-display text-3xl font-bold text-mocha-text drop-shadow-[0_4px_18px_rgb(0_0_0/95%)] sm:text-4xl">
      {formatEvent(current, $currentView)}
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
