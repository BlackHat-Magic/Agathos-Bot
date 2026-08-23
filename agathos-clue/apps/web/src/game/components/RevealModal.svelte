<script lang="ts">
  import type { Card, GameView } from '@agathos/game';
  import { currentView, send } from '../stores';
  import { createDeclineRevealIntent, createShowCardIntent } from '../../transport/intents';

  export let onClose: () => void = () => {};

  let selectedIndex = -1;

  $: view = $currentView;
  $: opportunities = validOpportunities(view);
  $: if (selectedIndex >= opportunities.length) selectedIndex = -1;

  function validOpportunities(nextView: GameView | null): Card[] {
    if (nextView === null || nextView.pendingReveal?.revealerIndex !== nextView.myIndex ||
        nextView.myRevealOpportunities === undefined) return [];
    return nextView.myRevealOpportunities;
  }

  function cardLabel(card: Card): string {
    switch (card.type) {
      case 'suspect': return card.suspect;
      case 'weapon': return card.weapon;
      case 'room': return card.room;
    }
  }

  function submitReveal(): void {
    const card = opportunities[selectedIndex];
    if (!card || view === null || view.pendingReveal?.revealerIndex !== view.myIndex) return;
    if (send(createShowCardIntent(card))) {
      selectedIndex = -1;
      onClose();
    }
  }

  function decline(): void {
    if (opportunities.length > 0 || view === null || view.pendingReveal?.revealerIndex !== view.myIndex) return;
    if (send(createDeclineRevealIntent())) {
      selectedIndex = -1;
      onClose();
    }
  }

  function handleKey(event: KeyboardEvent): void {
    if (event.key === 'Escape' && opportunities.length === 0) decline();
  }
</script>

{#if view !== null && view.pendingReveal?.revealerIndex === view.myIndex && view.myRevealOpportunities !== undefined}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-mocha-crust/80 p-4" role="presentation">
    <div class="w-full max-w-lg rounded-2xl border border-mocha-peach/45 bg-mocha-base p-5 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="reveal-title" onkeydown={handleKey} tabindex="-1">
      <p class="text-xs font-semibold uppercase tracking-[0.18em] text-mocha-peach">Private response</p>
      <h2 id="reveal-title" class="mt-1 font-display text-2xl font-semibold">Show one matching card</h2>
      <p class="mt-3 text-sm leading-6 text-mocha-subtext1">
        The suggestion is {view.pendingReveal.suspect}, {view.pendingReveal.weapon}, or {view.pendingReveal.room}.
        Only the suggester will see the selected card.
      </p>

      {#if opportunities.length > 0}
        <fieldset class="mt-5 space-y-2">
          <legend class="text-sm font-semibold">Matching cards</legend>
          {#each opportunities as card, index}
            <label class="flex cursor-pointer items-center gap-3 rounded-xl border border-mocha-surface1 bg-mocha-mantle px-3 py-3 has-[:checked]:border-mocha-mauve has-[:checked]:bg-mocha-mauve/10">
              <input class="accent-mocha-mauve" type="radio" name="reveal-card" value={index} bind:group={selectedIndex} />
              <span>
                <span class="block text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-mocha-mauve">{card.type}</span>
                <span class="block text-sm font-semibold">{cardLabel(card)}</span>
              </span>
            </label>
          {/each}
        </fieldset>
        <div class="mt-5 flex justify-end gap-2">
          <button class="game-button game-button-primary" type="button" disabled={selectedIndex < 0} onclick={submitReveal}>Show selected card</button>
        </div>
      {:else}
        <p class="mt-5 rounded-xl border border-mocha-surface1 bg-mocha-mantle px-3 py-3 text-sm text-mocha-overlay2" role="status">
          You have no matching cards. Decline to pass the reveal to the next detective.
        </p>
        <div class="mt-5 flex justify-end">
          <button class="game-button game-button-primary" type="button" onclick={decline}>Decline reveal</button>
        </div>
      {/if}
    </div>
  </div>
{/if}
