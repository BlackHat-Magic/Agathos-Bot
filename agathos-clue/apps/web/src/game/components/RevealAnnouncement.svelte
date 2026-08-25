<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { Card } from '@agathos/game';
  import { currentView, diceRolling, privateReveal, titlesBusy } from '../stores';
  import type { PrivateReveal } from '../../transport/snapshots';
  import { activateReveal, type RevealAnnouncementState } from '../reveal-announcement-state';
  import CardFace from './CardFace.svelte';

  const TIMEOUT_MS = 30_000;

  let active: PrivateReveal | null = null;
  let queued: PrivateReveal | null = null;
  let dismissed: PrivateReveal | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  let fallbackGeneration = 0;
  let activeTimerGeneration = 0;
  const consumedReveals = new WeakSet<object>();

  $: if ($privateReveal !== null &&
    !consumedReveals.has($privateReveal) &&
    $privateReveal !== active &&
    $privateReveal !== queued &&
    $privateReveal !== dismissed) {
    // Hold until its "revealed a card" title has played.
    queued = $privateReveal;
    scheduleFallback(queued);
  }

  $: if (queued !== null && !$titlesBusy && !$diceRolling) {
    announce(queued);
  }

  function announce(reveal: PrivateReveal, expectedGeneration = fallbackGeneration): void {
    if (expectedGeneration !== fallbackGeneration || queued !== reveal) return;
    if (fallbackTimer !== undefined) {
      clearTimeout(fallbackTimer);
      fallbackTimer = undefined;
    }
    const current: RevealAnnouncementState = { active, queued, dismissed };
    const next = activateReveal(current, reveal);
    if (active?.card !== undefined && active !== reveal) consumedReveals.add(active);
    active = next.active;
    queued = next.queued;
    dismissed = next.dismissed;
    if (reveal.card === undefined) {
      consumedReveals.add(reveal);
      return;
    }
    consumedReveals.add(reveal);
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const timerGeneration = ++activeTimerGeneration;
    const activeTimer = setTimeout(() => {
      if (timerGeneration !== activeTimerGeneration) return;
      timer = undefined;
      dismiss();
    }, TIMEOUT_MS);
    timer = activeTimer;
  }

  /** The card must never be silently lost to a stuck gate. */
  function scheduleFallback(reveal: PrivateReveal): void {
    const generation = ++fallbackGeneration;
    if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
    const retry = setTimeout(() => {
      if (generation !== fallbackGeneration || queued !== reveal) return;
      fallbackTimer = undefined;
      announce(reveal, generation);
    }, 1_500);
    fallbackTimer = retry;
  }

  function dismiss(): void {
    activeTimerGeneration += 1;
    if (active?.card !== undefined) consumedReveals.add(active);
    dismissed = active ?? dismissed;
    active = null;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  onDestroy(() => {
    fallbackGeneration += 1;
    activeTimerGeneration += 1;
    if (timer !== undefined) clearTimeout(timer);
    if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
  });

  function cardLabel(card: Card): string {
    switch (card.type) {
      case 'suspect': return card.suspect;
      case 'weapon': return card.weapon;
      case 'room': return card.room;
    }
  }
</script>

{#if active?.card !== undefined}
  {@const name = $currentView?.players[active.fromIndex]?.name ?? 'Someone'}
  <div class="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-6" aria-live="polite">
    <div class="title-text flex flex-col items-center gap-5 rounded-3xl bg-mocha-crust/70 px-10 py-8 shadow-2xl shadow-black/50 backdrop-blur-sm">
      <p class="text-center font-display text-4xl font-bold text-mocha-text drop-shadow-[0_3px_12px_rgb(0_0_0/90%)] sm:text-5xl">
        {name} showed you:
      </p>
      <div style="--card-w: 150px;">
        <CardFace type={active.card.type} label={cardLabel(active.card)} />
      </div>
      <button class="pointer-events-auto game-button game-button-primary" type="button" onclick={dismiss}>
        Okay
      </button>
    </div>
  </div>
{/if}

<style>
  .title-text {
    animation: title-in 0.45s cubic-bezier(0.2, 1.1, 0.3, 1) both;
  }

  @keyframes title-in {
    from {
      opacity: 0;
      transform: scale(1.35);
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
