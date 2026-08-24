<script lang="ts">
  import type { Card } from '@agathos/game';
  import { currentView, privateReveal, revealRequest, send } from '../stores';
  import { fanCenters, fanPlacements, nearestCard } from '../hand-fan';
  import { createShowCardIntent } from '../../transport/intents';
  import CardFace from './CardFace.svelte';

  let fan: HTMLUListElement | undefined;
  let raised = false;
  let hoverIndex: number | null = null;
  let selectedCard: Card | null = null;

  $: cards = $currentView?.myHand ?? [];
  $: request = $revealRequest;
  $: hasRequest = request !== null && request.length > 0;
  $: fanWidth = fan?.clientWidth ?? 780;
  $: centers = fanCenters(cards.length, Math.max(fanWidth, 1));
  $: placements = fanPlacements(cards.length, hoverIndex);
  // A pending reveal splays the hand until it is resolved; it never re-tucks mid-choice.
  $: if (hasRequest) raised = true;
  $: if (!hasRequest) selectedCard = null;

  function cardLabel(card: Card): string {
    switch (card.type) {
      case 'suspect': return card.suspect;
      case 'weapon': return card.weapon;
      case 'room': return card.room;
    }
  }

  function cardKey(card: Card): string {
    return `${card.type}:${cardLabel(card)}`;
  }

  function isRevealMatch(card: Card): boolean {
    if (request === null) return false;
    const key = cardKey(card);
    return request.some(candidate => cardKey(candidate) === key);
  }

  function toggleSelect(card: Card): void {
    selectedCard = cardKey(selectedCard ?? {}) === cardKey(card) ? null : card;
  }

  function confirmShow(): void {
    if (selectedCard === null || !hasRequest) return;
    if (send(createShowCardIntent(selectedCard))) selectedCard = null;
  }

  function raise(): void {
    raised = true;
  }

  /** Lower again when the cursor exits toward the board, keeping hover state honest. */
  function lowerFromFan(): void {
    hoverIndex = null;
    if (!hasRequest) raised = false;
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
  class="hand-dock pointer-events-none fixed inset-x-0 bottom-0 z-40 flex flex-col items-center"
  class:raised
  class:requesting={hasRequest}
  aria-label="Your private cards"
>
  {#if raised && hasRequest}
    <p
      class="reveal-note pointer-events-none mb-1 rounded-full bg-mocha-yellow/15 px-4 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-mocha-yellow"
      role="status"
    >
      Choose a matching card to show
    </p>
  {/if}

  {#if raised && selectedCard !== null}
    <div class="confirm-bar pointer-events-auto mb-2 flex items-center gap-3 rounded-full border border-mocha-lavender/50 bg-mocha-mantle/95 py-2 pl-4 pr-2 shadow-xl shadow-black/40 backdrop-blur">
      <span class="text-sm text-mocha-text">
        Show <strong class="text-mocha-lavender">{cardLabel(selectedCard)}</strong>?
      </span>
      <button class="game-button game-button-primary !py-1.5" type="button" onclick={confirmShow}>Show card</button>
      <button class="game-button !py-1.5" type="button" onclick={() => (selectedCard = null)}>Keep choosing</button>
    </div>
  {/if}

  <ul
    bind:this={fan}
    class="pointer-events-auto relative h-[178px] w-[min(94vw,780px)] min-w-[300px]"
    aria-label="Your private hand"
    onpointerenter={raise}
    onpointermove={trackPointer}
    onpointerleave={lowerFromFan}
  >
    {#each cards as card, index (index)}
      {@const match = hasRequest && isRevealMatch(card)}
      <li
        class="absolute bottom-0 left-1/2 {hasRequest && !match ? 'dimmed' : ''}"
        style="transform: translateX(-50%) translateX({placements[index]?.shiftPx ?? 0}px) translateY({placements[index]?.liftPx ?? 0}px) rotate({placements[index]?.angle ?? 0}deg) scale({placements[index]?.scale ?? 1}); z-index: {selectedCard !== null && cardKey(selectedCard) === cardKey(card) ? 50 : placements[index]?.z ?? 10};"
        aria-label={`${card.type} card: ${cardLabel(card)}`}
      >
        {#if match}
          <button
            class="block cursor-pointer"
            type="button"
            aria-pressed={selectedCard !== null && cardKey(selectedCard) === cardKey(card)}
            onclick={() => toggleSelect(card)}
          >
            <CardFace
              type={card.type}
              label={cardLabel(card)}
              highlight
              selected={hoverIndex === index ||
                (selectedCard !== null && cardKey(selectedCard) === cardKey(card))}
            />
          </button>
        {:else}
          <CardFace type={card.type} label={cardLabel(card)} selected={hoverIndex === index} />
        {/if}
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
  .hand-dock.raised {
    transform: translateY(0);
  }
  /* While a reveal is requested the hand splays fully and never re-tucks. */
  .hand-dock.requesting {
    transform: translateY(-12px);
  }

  /* Fan pivot lives far below the card so rotation draws the arc;
     without it cards spin around their own centers and the fan collapses. */
  .hand-dock :global(li) {
    transform-origin: 50% 240%;
    transition: transform 0.22s ease;
  }

  .hand-dock :global(li.dimmed) {
    filter: brightness(0.55) saturate(0.6);
  }

  @media (prefers-reduced-motion: reduce) {
    .hand-dock,
    .hand-dock :global(li) {
      transition: none;
    }
  }
</style>
