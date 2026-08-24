<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { SUSPECTS, WEAPONS, type Suspect, type Weapon } from '@agathos/game';
  import { currentView, send } from '../stores';
  import { actionsFor } from '../intent-gating';
  import { createSuggestIntent } from '../../transport/intents';
  import { trapDialogFocus } from '../modal-focus';
  import CardFace from './CardFace.svelte';

  export let onClose: () => void = () => {};

  let suspect: Suspect = SUSPECTS[0];
  let weapon: Weapon = WEAPONS[0];
  let panel: HTMLDivElement;

  $: actions = actionsFor($currentView);
  $: room = $currentView?.players[$currentView.myIndex]?.location ?? 'unknown room';

  function submit(): void {
    if (!actions.canSuggest) return;
    if (send(createSuggestIntent(suspect, weapon))) onClose();
  }

  function handleKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') onClose();
    trapDialogFocus(event, panel);
  }

  onMount(() => {
    const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void tick().then(() => panel?.focus());
    return () => restoreFocus?.focus();
  });
</script>

<div class="absolute inset-0 z-30 flex flex-col bg-mocha-crust/85 p-4 backdrop-blur-[2px]" role="region" aria-label="Make a suggestion" onkeydown={handleKey}>
  <div bind:this={panel} class="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-y-auto" tabindex="-1">
    <p class="text-xs font-semibold uppercase tracking-[0.2em] text-mocha-mauve">Suggestion · {room}</p>

    <div class="w-full max-w-3xl space-y-5">
      <div>
        <p id="suggest-suspect-label" class="mb-2 text-sm font-semibold text-mocha-subtext1">Suspect</p>
        <div class="flex flex-wrap gap-3" role="radiogroup" aria-labelledby="suggest-suspect-label">
          {#each SUSPECTS as option (option)}
            <button
              class="pick"
              type="button"
              role="radio"
              aria-checked={suspect === option}
              aria-label={`Suspect ${option}`}
              onclick={() => (suspect = option)}
            >
              <CardFace type="suspect" label={option} selected={suspect === option} />
            </button>
          {/each}
        </div>
      </div>

      <div>
        <p id="suggest-weapon-label" class="mb-2 text-sm font-semibold text-mocha-subtext1">Weapon</p>
        <div class="flex flex-wrap gap-3" role="radiogroup" aria-labelledby="suggest-weapon-label">
          {#each WEAPONS as option (option)}
            <button
              class="pick"
              type="button"
              role="radio"
              aria-checked={weapon === option}
              aria-label={`Weapon ${option}`}
              onclick={() => (weapon = option)}
            >
              <CardFace type="weapon" label={option} selected={weapon === option} />
            </button>
          {/each}
        </div>
      </div>
    </div>
  </div>

  <div class="mt-3 flex items-center justify-end gap-2 border-t border-mocha-surface1 pt-3">
    <button class="game-button" type="button" onclick={onClose}>Cancel</button>
    <button class="game-button game-button-primary" type="button" disabled={!actions.canSuggest} onclick={submit}>Confirm suggestion</button>
  </div>
</div>

<style>
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
</style>
