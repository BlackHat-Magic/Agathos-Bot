<script lang="ts">
  import { createDeclineRevealIntent } from '../../transport/intents';
  import { diceRolling, revealRequest, send, titlesBusy } from '../stores';

  $: request = $revealRequest;
  $: pending = request !== null;
  // Let the dice and action titles finish before asking for a card.
  $: settled = !$diceRolling && !$titlesBusy;
  $: matches = request ?? [];
</script>

{#if pending && settled}
  <div class="pointer-events-none absolute inset-0 z-20 flex flex-col items-center pt-[4%]" aria-live="assertive">
    <div class="title-text rounded-2xl px-10 py-6 text-center title-backdrop">
      <p class="font-display text-5xl font-bold text-mocha-text drop-shadow-[0_4px_16px_rgb(0_0_0/90%)] sm:text-6xl">
        Show a card
      </p>
      {#if matches.length > 0}
        <p class="mt-3 text-lg text-mocha-subtext1">
          A suggestion matches your hand — pick a glowing card below.
        </p>
      {:else}
        <p class="mt-3 text-lg text-mocha-subtext1">
          You have no matching cards.
        </p>
        <button
          class="pointer-events-auto game-button game-button-primary mt-4"
          type="button"
          onclick={() => send(createDeclineRevealIntent())}
        >
          I have nothing to show
        </button>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* Gradient plinth lifts the title off the busy board behind it. */
  .title-backdrop {
    background: linear-gradient(
      180deg,
      rgb(17 17 27 / 92%) 0%,
      rgb(17 17 27 / 72%) 65%,
      rgb(17 17 27 / 30%) 100%
    );
    box-shadow:
      0 12px 48px rgb(0 0 0 / 65%),
      inset 0 1px 0 rgb(205 214 244 / 8%);
  }

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
