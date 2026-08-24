<script lang="ts">
  import Icon from '@iconify/svelte';
  import { accentFor, glyphFor, type CardType } from '../card-face';

  export let type: CardType;
  export let label: string;
  export let selected = false;
</script>

<!-- The single source of card visuals: fixed 52:71 aspect like the fan. -->
<div class="card-face {type}" class:selected style="--accent: {accentFor(type, label)};">
  <span class="type-label">{type}</span>
  <span class="glyph"><Icon icon={glyphFor(type)} width="34" height="34" aria-hidden="true" /></span>
  <span class="name">{label}</span>
</div>

<style>
  .card-face {
    display: flex;
    width: var(--card-w, 104px);
    aspect-ratio: 52 / 71;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.6rem;
    padding: 0.5rem;
    text-align: center;
    border-radius: 0.75rem;
    border: 1.5px solid var(--accent);
    background: linear-gradient(180deg, var(--color-mocha-base) 0%, var(--color-mocha-mantle) 100%);
    box-shadow: 0 6px 16px rgb(0 0 0 / 35%);
  }

  .type-label {
    font-size: 0.6rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--accent);
  }

  .glyph {
    color: var(--color-mocha-overlay1);
  }

  .name {
    font-size: 0.8rem;
    font-weight: 600;
    line-height: 1.15;
    color: var(--color-mocha-text);
  }

  .card-face.selected {
    box-shadow:
      0 0 0 2px var(--color-mocha-lavender),
      0 12px 32px rgb(0 0 0 / 55%);
  }
</style>
