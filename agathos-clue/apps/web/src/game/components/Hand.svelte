<script lang="ts">
  import type { Card } from '@agathos/game';
  import { currentView, privateReveal } from '../stores';

  function cardLabel(card: Card): string {
    switch (card.type) {
      case 'suspect': return card.suspect;
      case 'weapon': return card.weapon;
      case 'room': return card.room;
    }
  }

  function cardType(card: Card): string {
    return card.type[0]!.toUpperCase() + card.type.slice(1);
  }
</script>

<section class="rounded-2xl border border-mocha-surface1 bg-mocha-mantle p-4" aria-labelledby="hand-title">
  <div class="flex items-center justify-between gap-3">
    <h2 id="hand-title" class="font-display text-lg font-semibold">Your hand</h2>
    <span class="text-xs uppercase tracking-[0.16em] text-mocha-overlay2">Private</span>
  </div>

  <ul class="mt-3 grid grid-cols-2 gap-2" aria-label="Your private cards">
    {#each $currentView?.myHand ?? [] as card}
      <li class="rounded-xl border border-mocha-mauve/30 bg-mocha-base px-3 py-3">
        <span class="block text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-mocha-mauve">{cardType(card)}</span>
        <span class="mt-1 block text-sm font-semibold text-mocha-text">{cardLabel(card)}</span>
      </li>
    {:else}
      <li class="col-span-2 rounded-xl border border-dashed border-mocha-surface1 px-3 py-4 text-sm text-mocha-overlay2">
        No cards dealt yet.
      </li>
    {/each}
  </ul>

  {#if $privateReveal?.card}
    <div class="mt-3 rounded-xl border border-mocha-green/35 bg-mocha-green/10 px-3 py-3" role="status" aria-live="polite">
      <span class="block text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-mocha-green">Private reveal</span>
      <span class="mt-1 block text-sm text-mocha-text">{cardLabel($privateReveal.card)}</span>
    </div>
  {/if}
</section>
