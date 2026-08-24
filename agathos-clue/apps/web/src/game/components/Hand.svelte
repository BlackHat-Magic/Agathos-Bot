<script lang="ts">
  import type { Card } from '@agathos/game';
  import Icon from '@iconify/svelte';
  import { currentView, privateReveal } from '../stores';
  import { fanPlacements, hoveredSlot } from '../hand-fan';

  let expanded = false;
  let pinned = false;
  let hoverIndex: number | null = null;
  let fan: HTMLUListElement | undefined;

  $: cards = $currentView?.myHand ?? [];
  $: placements = fanPlacements(cards.length, hoverIndex);

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

  function expand(): void {
    expanded = true;
  }

  function collapse(): void {
    if (!pinned) {
      expanded = false;
      hoverIndex = null;
    }
  }

  function togglePinned(): void {
    pinned = !pinned;
    expanded = pinned || expanded;
    if (!pinned && !expanded) hoverIndex = null;
  }

  function trackPointer(event: PointerEvent): void {
    if (fan === undefined || fan.clientWidth === 0) return;
    const bounds = fan.getBoundingClientRect();
    const cursor = (event.clientX - bounds.left) / bounds.width;
    hoverIndex = hoveredSlot(cards.length, cursor);
  }

  function clearHover(): void {
    hoverIndex = null;
  }
</script>

<section
  class="hand-dock pointer-events-none fixed inset-x-0 bottom-0 z-40 flex flex-col items-center"
  class:expanded
  class:pinned
  aria-label="Your private cards"
>
  <div class="pointer-events-auto absolute inset-x-0 bottom-0 h-8" onpointerenter={expand}></div>

  <button
    class="hand-tab pointer-events-auto relative z-50 flex items-center gap-2 rounded-t-xl border border-b-0 border-mocha-surface1 bg-mocha-mantle/95 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-mocha-subtext1 backdrop-blur transition-colors hover:text-mocha-text focus:outline-2 focus:-outline-offset-4 focus:outline-mocha-mauve"
    type="button"
    aria-expanded={expanded || pinned}
    onclick={togglePinned}
    onpointerenter={expand}
  >
    <Icon icon="hugeicons:cards-01" width="14" height="14" aria-hidden="true" />
    Hand · {cards.length}
    {#if $privateReveal?.card}
      <span class="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-mocha-green shadow-[0_0_8px] shadow-mocha-green" role="presentation"></span>
      <span class="sr-only">New private reveal waiting</span>
    {/if}
  </button>

  <ul
    bind:this={fan}
    class="hand-fan pointer-events-auto relative h-[150px] w-[min(94vw,780px)] min-w-[300px]"
    onpointermove={trackPointer}
    onpointerleave={clearHover}
    aria-label="Your private hand"
  >
    {#each cards as card, index (index)}
      <li
        class="hand-card absolute bottom-[-96px] left-1/2 rounded-xl border bg-gradient-to-b from-mocha-base to-mocha-mantle px-3 pb-3 pt-2 text-center shadow-lg shadow-black/40 {card.type === 'suspect' ? 'type-suspect' : card.type === 'weapon' ? 'type-weapon' : 'type-room'}"
        class:hovered={hoverIndex === index}
        style="transform: translateX(-50%) translateX({placements[index]?.shiftPx ?? 0}px) translateY({placements[index]?.liftPx ?? 0}px) rotate({placements[index]?.angle ?? 0}deg) scale({placements[index]?.scale ?? 1}); z-index: {placements[index]?.z ?? 10};"
        aria-label={`${card.type} card: ${cardLabel(card)}`}
      >
        <span class="type-label block text-[0.6rem] font-semibold uppercase tracking-[0.16em]">{card.type}</span>
        <span class="mt-3 block text-mocha-overlay1"><Icon icon={cardGlyph(card)} width="34" height="34" aria-hidden="true" /></span>
        <span class="mt-3 block text-sm font-semibold leading-tight text-mocha-text">{cardLabel(card)}</span>
      </li>
    {:else}
      <li class="absolute inset-x-0 top-6 text-center text-xs uppercase tracking-[0.18em] text-mocha-overlay2">
        No cards dealt yet.
      </li>
    {/each}
  </ul>

  {#if $privateReveal?.card}
    <p class="reveal-chip pointer-events-auto absolute left-1/2 top-9 z-50 -translate-x-1/2 whitespace-nowrap rounded-full border border-mocha-green/40 bg-mocha-mantle/95 px-4 py-1 text-xs text-mocha-green shadow-lg shadow-black/30 backdrop-blur" role="status" aria-live="polite">
      Shown privately: {cardLabel($privateReveal.card)}
    </p>
  {/if}
</section>

<style>
  /* Tucked below the viewport edge; only the tab peeks out until approached. */
  .hand-dock {
    transform: translateY(calc(100% - 36px));
    transition: transform 0.32s cubic-bezier(0.22, 0.9, 0.28, 1);
  }
  .hand-dock.expanded,
  .hand-dock.pinned,
  .hand-dock:focus-within {
    transform: translateY(0);
  }

  .hand-card {
    width: 104px;
    height: 142px;
    transform-origin: 50% 260%;
    transition:
      transform 0.22s ease,
      border-color 0.22s ease,
      box-shadow 0.22s ease;
  }
  .hand-card.type-suspect { border-color: var(--color-mocha-mauve); color-scheme: dark; }
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
