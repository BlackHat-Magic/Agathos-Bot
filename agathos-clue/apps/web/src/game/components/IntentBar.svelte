<script lang="ts">
  import { currentView, send } from '../stores';
  import { actionsFor } from '../intent-gating';
  import {
    createEndTurnIntent,
    createRollIntent,
    createUseSecretPassageIntent,
  } from '../../transport/intents';

  export let onAccuse: () => void = () => {};
  export let onSuggest: () => void = () => {};

  $: view = $currentView;
  $: actions = actionsFor(view);
</script>

<section class="rounded-2xl border border-mocha-surface1 bg-mocha-mantle p-4" aria-label="Turn actions">
  <div class="mb-3 flex items-baseline justify-between gap-2">
    <h2 class="font-display text-lg font-semibold">Your move</h2>
    {#if view}
      <span class="text-xs uppercase tracking-[0.16em] text-mocha-overlay2">
        {view.turnIndex === view.myIndex ? 'Your turn' : `${view.players[view.turnIndex]?.name ?? 'Waiting'}'s turn`}
      </span>
    {/if}
  </div>

  <div class="flex flex-wrap gap-2">
    <button class="game-button" type="button" disabled={!actions.canRoll} onclick={() => send(createRollIntent())}>Roll dice</button>
    <button class="game-button" type="button" disabled={!actions.canUseSecretPassage} onclick={() => send(createUseSecretPassageIntent())}>Secret passage</button>
    <button class="game-button" type="button" disabled={!actions.canSuggest} onclick={onSuggest}>Suggest</button>
    <button class="game-button" type="button" disabled={!actions.canAccuse} onclick={onAccuse}>Accuse</button>
    <button class="game-button" type="button" disabled={!actions.canEndTurn} onclick={() => send(createEndTurnIntent())}>End turn</button>
  </div>
</section>
