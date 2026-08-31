<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { SUSPECTS, WEAPONS, type Suspect, type Weapon } from '@agathos/game';
  import { currentView, send } from '../stores';
  import { actionsFor } from '../intent-gating';
  import { createSuggestIntent } from '../../transport/intents';
  import { trapDialogFocus } from '../modal-focus';
  import CardRow from './CardRow.svelte';

  export let onClose: () => void = () => {};

  let suspect: Suspect = SUSPECTS[0];
  let weapon: Weapon = WEAPONS[0];
  let dialog: HTMLDivElement;

  $: actions = actionsFor($currentView);
  $: room = $currentView?.players[$currentView.myIndex]?.location ?? 'unknown room';

  function submit(): void {
    if (!actions.canSuggest) return;
    if (send(createSuggestIntent(suspect, weapon))) onClose();
  }

  function handleKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') onClose();
    trapDialogFocus(event, dialog);
  }

  onMount(() => {
    const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void tick().then(() => dialog?.focus());
    return () => restoreFocus?.focus();
  });
</script>

<div bind:this={dialog} class="absolute inset-0 z-30 flex flex-col bg-mocha-crust/85 p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label="Make a suggestion" tabindex="-1" onkeydown={handleKey}>
  <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-y-auto">
    <p class="text-xs font-semibold uppercase tracking-[0.2em] text-mocha-mauve">Suggestion · {room}</p>

    <div class="w-full max-w-3xl space-y-5">
      <div>
        <p id="suggest-suspect-label" class="mb-1 text-sm font-semibold text-mocha-subtext1">Suspect</p>
        <CardRow type="suspect" options={SUSPECTS} bind:value={suspect} labelledBy="suggest-suspect-label" />
      </div>

      <div>
        <p id="suggest-weapon-label" class="mb-1 text-sm font-semibold text-mocha-subtext1">Weapon</p>
        <CardRow type="weapon" options={WEAPONS} bind:value={weapon} labelledBy="suggest-weapon-label" />
      </div>
    </div>
  </div>

  <div class="mt-3 flex items-center justify-end gap-2 border-t border-mocha-surface1 pt-3">
    <button class="game-button" type="button" onclick={onClose}>Cancel</button>
    <button class="game-button game-button-primary" type="button" disabled={!actions.canSuggest} onclick={submit}>Confirm suggestion</button>
  </div>
</div>
