<script lang="ts">
  import {
    SUSPECTS,
    WEAPONS,
    type Suspect,
    type Weapon,
  } from '@agathos/game';
  import { currentView, send } from '../stores';
  import { actionsFor } from '../intent-gating';
  import {
    createEndTurnIntent,
    createRollIntent,
    createSuggestIntent,
    createUseSecretPassageIntent,
  } from '../../transport/intents';

  export let onAccuse: () => void = () => {};

  let suggestOpen = false;
  let suggestSuspect: Suspect = SUSPECTS[0];
  let suggestWeapon: Weapon = WEAPONS[0];

  $: actions = actionsFor($currentView);
  $: turnPlayer = $currentView?.players[$currentView.myIndex];
  $: phaseLabel = $currentView?.phase === 'finished' ? 'Case closed' :
    $currentView?.phase === 'playing' ? 'Investigation in progress' : 'Waiting room';

  function submitSuggestion(): void {
    if (!actions.canSuggest) return;
    if (send(createSuggestIntent(suggestSuspect, suggestWeapon))) suggestOpen = false;
  }

  function closeSuggestion(): void {
    suggestOpen = false;
  }

  function handleDialogKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') closeSuggestion();
  }
</script>

<section class="rounded-2xl border border-mocha-surface1 bg-mocha-mantle p-4" aria-labelledby="intent-title">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div>
      <p class="text-xs font-semibold uppercase tracking-[0.18em] text-mocha-mauve">{phaseLabel}</p>
      <h2 id="intent-title" class="mt-1 font-display text-xl font-semibold">
        {#if $currentView?.phase === 'finished'}
          Final report
        {:else if actions.myTurn}
          Your turn
        {:else}
          {turnPlayer?.name ?? 'Another detective'}'s turn
        {/if}
      </h2>
    </div>
    {#if $currentView?.lastDieRoll !== null && $currentView?.lastDieRoll !== undefined}
      <span class="rounded-lg bg-mocha-yellow/15 px-3 py-2 text-sm font-semibold text-mocha-yellow" role="status">Roll: {$currentView.lastDieRoll}</span>
    {/if}
  </div>

  {#if actions.failedAccusation}
    <p class="mt-3 rounded-xl border border-mocha-red/35 bg-mocha-red/10 px-3 py-2 text-sm text-mocha-red" role="status">
      Your accusation failed. You may only end your turn.
    </p>
  {:else if $currentView?.pendingReveal}
    <p class="mt-3 rounded-xl border border-mocha-peach/35 bg-mocha-peach/10 px-3 py-2 text-sm text-mocha-peach" role="status" aria-live="polite">
      A card reveal is in progress.
    </p>
  {/if}

  <div class="mt-4 flex flex-wrap gap-2">
    <button class="game-button game-button-primary" type="button" disabled={!actions.canRoll} onclick={() => send(createRollIntent())}>Roll dice</button>
    <button class="game-button" type="button" disabled={!actions.canUseSecretPassage} onclick={() => send(createUseSecretPassageIntent())}>Secret passage</button>
    <button class="game-button" type="button" disabled={!actions.canSuggest} onclick={() => (suggestOpen = true)}>Suggest</button>
    <button class="game-button" type="button" disabled={!actions.canAccuse} onclick={onAccuse}>Accuse</button>
    <button class="game-button game-button-end" type="button" disabled={!actions.canEndTurn} onclick={() => send(createEndTurnIntent())}>End turn</button>
  </div>
</section>

{#if suggestOpen}
  <div class="fixed inset-0 z-40 flex items-center justify-center bg-mocha-crust/75 p-4" role="presentation" onclick={closeSuggestion}>
    <div class="w-full max-w-md rounded-2xl border border-mocha-surface1 bg-mocha-base p-5 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="suggest-title" onclick={(event) => event.stopPropagation()} onkeydown={handleDialogKey} tabindex="-1">
      <div class="flex items-start justify-between gap-4">
        <div>
          <p class="text-xs font-semibold uppercase tracking-[0.18em] text-mocha-mauve">Room suggestion</p>
          <h2 id="suggest-title" class="mt-1 font-display text-2xl font-semibold">Name the suspects</h2>
        </div>
        <button class="text-mocha-overlay2 hover:text-mocha-text" type="button" aria-label="Close suggestion dialog" onclick={closeSuggestion}>Close</button>
      </div>
      <form class="mt-5 space-y-4" onsubmit={(event) => { event.preventDefault(); submitSuggestion(); }}>
        <label class="block text-sm font-semibold" for="suggest-suspect">Suspect
          <select id="suggest-suspect" bind:value={suggestSuspect} class="game-select">
            {#each SUSPECTS as suspect}<option value={suspect}>{suspect}</option>{/each}
          </select>
        </label>
        <label class="block text-sm font-semibold" for="suggest-weapon">Weapon
          <select id="suggest-weapon" bind:value={suggestWeapon} class="game-select">
            {#each WEAPONS as weapon}<option value={weapon}>{weapon}</option>{/each}
          </select>
        </label>
        <p class="text-sm text-mocha-overlay2">The room is your current room: {$currentView?.players[$currentView.myIndex]?.location ?? 'unknown'}.</p>
        <div class="flex justify-end gap-2">
          <button class="game-button" type="button" onclick={closeSuggestion}>Cancel</button>
          <button class="game-button game-button-primary" type="submit" disabled={!actions.canSuggest}>Submit suggestion</button>
        </div>
      </form>
    </div>
  </div>
{/if}
