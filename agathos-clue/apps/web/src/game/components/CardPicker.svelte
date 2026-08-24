<script lang="ts">
  import Icon from '@iconify/svelte';
  import { accentFor, glyphFor, type CardType } from '../card-face';

  export let type: CardType;
  export let options: readonly string[];
  export let value: string;
  export let labelledBy: string;

  function choose(option: string): void {
    value = option;
  }
</script>

<div class="picker-row" role="radiogroup" aria-labelledby={labelledBy}>
  {#each options as option (option)}
    {@const accent = accentFor(type, option)}
    <button
      class="pick-card"
      class:selected={value === option}
      type="button"
      role="radio"
      aria-checked={value === option}
      aria-label={`${type} ${option}`}
      style="--accent: {accent};"
      onclick={() => choose(option)}
    >
      <span class="glyph"><Icon icon={glyphFor(type)} width="22" height="22" aria-hidden="true" /></span>
      <span class="name">{option}</span>
      {#if value === option}
        <span class="check"><Icon icon="hugeicons:checkmark-circle-02" width="16" height="16" aria-hidden="true" /></span>
      {/if}
    </button>
  {/each}
</div>

<style>
  .picker-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .pick-card {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    width: 84px;
    min-height: 92px;
    padding: 0.5rem 0.375rem;
    text-align: center;
    border-radius: 0.75rem;
    border: 1.5px solid var(--color-mocha-surface1);
    background: linear-gradient(180deg, var(--color-mocha-base) 0%, var(--color-mocha-mantle) 100%);
    color: var(--color-mocha-text);
    cursor: pointer;
    transition:
      transform 0.16s ease,
      border-color 0.16s ease,
      box-shadow 0.16s ease;
  }
  .pick-card:hover {
    transform: translateY(-2px);
    border-color: var(--accent);
  }
  .pick-card:focus-visible {
    outline: 2px solid var(--color-mocha-lavender);
    outline-offset: 2px;
  }
  .pick-card.selected {
    border-color: var(--accent);
    box-shadow:
      0 0 0 2px var(--color-mocha-lavender),
      0 8px 20px rgb(0 0 0 / 45%);
    transform: translateY(-4px);
  }

  .glyph {
    color: var(--accent);
  }
  .name {
    font-size: 0.72rem;
    font-weight: 600;
    line-height: 1.15;
  }

  .check {
    position: absolute;
    top: -7px;
    right: -7px;
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border-radius: 9999px;
    background: var(--color-mocha-lavender);
    color: var(--color-mocha-crust);
  }

  @media (prefers-reduced-motion: reduce) {
    .pick-card { transition: none; }
  }
</style>
