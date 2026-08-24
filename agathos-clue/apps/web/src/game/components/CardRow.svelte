<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Icon from '@iconify/svelte';
  import CardFace from './CardFace.svelte';
  import type { CardType } from '../card-face';

  export let type: CardType;
  export let options: readonly string[];
  export let value: string;
  export let labelledBy: string;

  let track: HTMLDivElement | undefined;
  let canPrev = false;
  let canNext = false;

  function updateArrows(): void {
    if (track === undefined) return;
    canPrev = track.scrollLeft > 2;
    canNext = track.scrollLeft < track.scrollWidth - track.clientWidth - 2;
  }

  function scrollRow(direction: -1 | 1): void {
    if (track === undefined) return;
    const step = (track.firstElementChild?.clientWidth ?? 104) + 12;
    track.scrollBy({ left: direction * step, behavior: 'smooth' });
  }

  onMount(() => {
    void tick().then(updateArrows);
  });
</script>

<div class="carousel">
  <button class="arrow" type="button" disabled={!canPrev} aria-label={`Previous ${type}`} onclick={() => scrollRow(-1)}>
    <Icon icon="hugeicons:arrow-left-01" width="18" height="18" aria-hidden="true" />
  </button>

  <div
    bind:this={track}
    class="track"
    role="radiogroup"
    aria-labelledby={labelledBy}
    onscroll={updateArrows}
  >
    {#each options as option (option)}
      <button
        class="pick"
        type="button"
        role="radio"
        aria-checked={value === option}
        aria-label={`${type} ${option}`}
        onclick={() => (value = option)}
      >
        <CardFace type={type} label={option} selected={value === option} />
      </button>
    {/each}
  </div>

  <button class="arrow" type="button" disabled={!canNext} aria-label={`Next ${type}`} onclick={() => scrollRow(1)}>
    <Icon icon="hugeicons:arrow-right-02" width="18" height="18" aria-hidden="true" />
  </button>
</div>

<style>
  .carousel {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .track {
    display: flex;
    flex: 1;
    gap: 0.75rem;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    padding: 0.5rem 0.25rem 0.75rem;
    scrollbar-width: none;
  }
  .track::-webkit-scrollbar {
    display: none;
  }
  .track :global(.pick) {
    scroll-snap-align: center;
  }

  .pick {
    padding: 0;
    background: none;
    border: none;
    cursor: pointer;
  }
  .pick:focus-visible {
    outline: 2px solid var(--color-mocha-lavender);
    outline-offset: 3px;
    border-radius: 0.75rem;
  }

  .arrow {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    border-radius: 9999px;
    border: 1px solid var(--color-mocha-surface1);
    background: var(--color-mocha-mantle);
    color: var(--color-mocha-subtext1);
    cursor: pointer;
  }
  .arrow:hover:not(:disabled) {
    color: var(--color-mocha-text);
    border-color: var(--color-mocha-overlay0);
  }
  .arrow:disabled {
    opacity: 0.35;
    cursor: default;
  }

  @media (prefers-reduced-motion: reduce) {
    .track {
      scroll-behavior: auto;
    }
  }
</style>
