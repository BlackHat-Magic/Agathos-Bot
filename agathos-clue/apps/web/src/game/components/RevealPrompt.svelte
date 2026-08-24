<script lang="ts">
  import { createDeclineRevealIntent } from '../../transport/intents';
  import { revealRequest, send } from '../stores';

  $: request = $revealRequest;
  $: pending = request !== null;
  $: matches = request ?? [];
</script>

{#if pending}
  <div class="pointer-events-none absolute inset-0 z-20 flex flex-col items-center pt-[6%]" aria-live="assertive">
    <div class="title-text text-center">
      <p class="font-display text-5xl font-bold text-mocha-text drop-shadow-[0_4px_16px_rgb(0_0_0/90%)] sm:text-6xl">
        Show a card
      </p>
      {#if matches.length > 0}
        <p class="mt-2 text-lg text-mocha-subtext1 drop-shadow-[0_2px_8px_rgb(0_0_0/90%)]">
          A suggestion matches your hand — pick a glowing card below.
        </p>
      {:else}
        <p class="mt-2 text-lg text-mocha-subtext1 drop-shadow-[0_2px_8px_rgb(0_0_0/90%)]">
          You have no matching cards.
        </p>
        <button
          class="pointer-events-auto game-button game-button-primary mt-4"
          type="button"
          onclick={() => send(createDeclineRevealIntent())}
        >
          Decline reveal
        </button>
      {/if}
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
