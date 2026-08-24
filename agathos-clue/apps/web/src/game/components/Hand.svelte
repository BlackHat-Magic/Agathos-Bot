<script lang="ts">
  import type { Card } from '@agathos/game';
  import Icon from '@iconify/svelte';
  import { currentView, privateReveal } from '../stores';
  import { fanPlacements } from '../hand-fan';

  let raised = false;
  let hoverIndex: number | null = null;

  $: cards = $currentView?.myHand ?? [];
  $: placements = fanPlacements(cards.length, hoverIndex);
  // A fresh private reveal deserves attention even while tucked.
  $: if ($privateReveal?.card !== undefined) raised = true;

  function cardLabel(card: Card): string {
    switch (card.type) {
      case 'suspect': return card.suspect;
      case 'weapon': return card.weapon;
      case 'room': return card.room;
    }
  }

  function cardGlyph(card: Card): string {
    switch (card.type) {
      case 'suspect': return 'hugeicons:user';
      case 'weapon': return 'hugeicons:knife-02';
      case 'room': return 'hugeicons:door-01';
    }
  }

  function raise(): void {
    raised = true;
  }

  /** Lower again when the cursor exits toward the board, keeping hover state honest. */
  function lowerFromFan(): void {
    hoverIndex = null;
    raised = false;
  }
</script>

<section
  class="hand-dock pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center"
  class:raised
  aria-label="Your private cards"
>
  <ul
    class="pointer-events-auto relative h-[178px] w-[min(94vw,780px)] min-w-[300px]"
    tabindex="0"
    aria-label="Your private hand"
    onpointerenter={raise}
    onpointerleave={lowerFromFan}
    onfocusin={raise}
    onfocusout={() => (hoverIndex = null)}
  >
    {#each cards as card, index (index)}
      <li
        class="hand-card absolute bottom-0 left-1/2 rounded-xl border bg-gradient-to-b from-mocha-base to-mocha-mantle px-3 pb-3 pt-2 text-center shadow-lg shadow-black/40 {card.type === 'suspect' ? 'type-suspect' : card.type === 'weapon' ? 'type-weapon' : 'type-room'}"
        class:hovered={hoverIndex === index}
        style="transform: translateX(-50%) translateX({placements[index]?.shiftPx ?? 0}px) translateY({placements[index]?.liftPx ?? 0}px) rotate({placements[index]?.angle ?? 0}deg) scale({placements[index]?.scale ?? 1}); z-index: {placements[index]?.z ?? 10};"
        aria-label={`${card.type} card: ${cardLabel(card)}`}
        onpointerenter={() => setHover(index)}
      >
        <span class="type-label block text-[0.6rem] font-semibold uppercase tracking-[0.16em]">{card.type}</span>
        <span class="mt-3 block text-mocha-overlay1"><Icon icon={cardGlyph(card)} width="34" height="34" aria-hidden="true" /></span>
        <span class="mt-3 block text-sm font-semibold leading-tight text-mocha-text">{cardLabel(card)}</span>
      </li>
    {:else}
      <li class="absolute inset-x-0 top-8 text-center text-xs uppercase tracking-[0.18em] text-mocha-overlay2">
        No cards dealt yet.
      </li>
    {/each}
  </ul>

  {#if $privateReveal?.card && raised}
    <p class="reveal-chip pointer-events-none absolute left-1/2 top-[-44px] -translate-x-1/2 whitespace-nowrap rounded-full border border-mocha-green/40 bg-mocha-mantle/95 px-4 py-1 text-xs text-mocha-green shadow-lg shadow-black/30 backdrop-blur" role="status" aria-live="polite">
      Shown privately: {cardLabel($privateReveal.card)}
    </p>
  {/if}
</section>

<style>
  /* Tucked: sunk so only the top ~16px tips of the cards break the bottom edge. */
  .hand-dock {
    transform: translateY(calc(100% - 88px));
    transition: transform 0.32s cubic-bezier(0.22, 0.9, 0.28, 1);
  }
  .hand-dock.raised,
  .hand-dock:focus-within {
    transform: translateY(0);
  }

  .hand-card {
    width: 104px;
    height: 142px;
    transform-origin: 50% 240%;
    transition:
      transform 0.22s ease,
      border-color 0.22s ease,
      box-shadow 0.22s ease;
  }
  .hand-card.type-suspect { border-color: var(--color-mocha-mauve); }
  .hand-card.type-suspect .type-label { color: var(--color-mocha-mauve); }
  .hand-card.type-weapon { border-color: var(--color-mocha-red); }
  .hand-card.type-weapon .type-label { color: var(--color-mocha-red); }
  .hand-card.type-room { border-color: var(--color-mocha-teal); }
  .hand-card.type-room .type-label { color: var(--color-mocha-teal); }

  .hand-card.hovered {
    box-shadow:
      0 0 0 2px var(--color-mocha-lavender),
      0 12px 32px rgb(0 0 0 / 55%);
  }

  @media (prefers-reduced-motion: reduce) {
    .hand-dock,
    .hand-card {
      transition: none;
    }
  }
</style>
