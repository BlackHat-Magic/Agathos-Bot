<script lang="ts">
  import type { Card } from '@agathos/game';
  import { currentView, privateReveal } from '../stores';
  import { fanCenters, fanPlacements, nearestCard } from '../hand-fan';
  import CardFace from './CardFace.svelte';

  let fan: HTMLUListElement | undefined;
  let raised = false;
  let hoverIndex: number | null = null;

  $: cards = $currentView?.myHand ?? [];
  $: fanWidth = fan?.clientWidth ?? 780;
  $: centers = fanCenters(cards.length, Math.max(fanWidth, 1));
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

  function raise(): void {
    raised = true;
  }

  /** Lower again when the cursor exits toward the board, keeping hover state honest. */
  function lowerFromFan(): void {
    hoverIndex = null;
    raised = false;
  }

  /**
   * Continuous nearest-card matching against rest-pose arc centers. Per-card
   * pointerenter cannot work here: the hovered card's scaled hit area swallows
   * its neighbors, so sliding sideways never leaves the first card.
   */
  function trackPointer(event: PointerEvent): void {
    if (cards.length === 0 || fan === undefined || fan.clientWidth === 0) return;
    hoverIndex = nearestCard(centers, event.clientX - fan.getBoundingClientRect().left);
  }
</script>

<section
  class="hand-dock pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center"
  class:raised
  aria-label="Your private cards"
>
  <ul
    bind:this={fan}
    class="pointer-events-auto relative h-[178px] w-[min(94vw,780px)] min-w-[300px]"
    tabindex="0"
    aria-label="Your private hand"
    onpointerenter={raise}
    onpointermove={trackPointer}
    onpointerleave={lowerFromFan}
    onfocusin={raise}
    onfocusout={() => (hoverIndex = null)}
  >
    {#each cards as card, index (index)}
      <li
        class="absolute bottom-0 left-1/2"
        style="transform: translateX(-50%) translateX({placements[index]?.shiftPx ?? 0}px) translateY({placements[index]?.liftPx ?? 0}px) rotate({placements[index]?.angle ?? 0}deg) scale({placements[index]?.scale ?? 1}); z-index: {placements[index]?.z ?? 10};"
        aria-label={`${card.type} card: ${cardLabel(card)}`}
      >
        <CardFace type={card.type} label={cardLabel(card)} selected={hoverIndex === index} />
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

  /* Fan pivot lives far below the card so rotation draws the arc;
     without it cards spin around their own centers and the fan collapses. */
  .hand-dock :global(li) {
    transform-origin: 50% 240%;
    transition: transform 0.22s ease;
  }

  @media (prefers-reduced-motion: reduce) {
    .hand-dock,
    .hand-dock :global(li) {
      transition: none;
    }
  }
</style>
