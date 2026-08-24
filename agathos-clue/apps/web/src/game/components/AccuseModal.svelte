<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    ROOMS,
    SUSPECTS,
    WEAPONS,
    type Room,
    type Suspect,
    type Weapon,
  } from '@agathos/game';
  import { currentView, error, events, send } from '../stores';
  import { enqueueAccusation } from '../accusation-lifecycle';
  import { actionsFor } from '../intent-gating';
  import {
    shouldCloseAfterAccusation,
    type AccusationBaseline,
  } from './accusation-reconciliation';
  import { createAccuseIntent } from '../../transport/intents';
  import { focusDialog, trapDialogFocus } from '../modal-focus';
  import CardPicker from './CardPicker.svelte';
  import type { Event } from '@agathos/game';

  export let onClose: () => void = () => {};

  let suspect: Suspect = SUSPECTS[0];
  let weapon: Weapon = WEAPONS[0];
  let room: Room = ROOMS[0];
  let dialog: HTMLDivElement;
  let accusationPending = false;
  let eventsBeforeAccusation: readonly Event[] = [];
  let accusationBaseline: AccusationBaseline | null = null;

  $: actions = actionsFor($currentView);
  $: if (accusationPending && $error !== null) accusationPending = false;
  $: if (
    accusationPending &&
    $currentView !== null &&
    (
      (accusationBaseline !== null && shouldCloseAfterAccusation($currentView, accusationBaseline)) ||
      $events.some(event =>
        !eventsBeforeAccusation.includes(event) &&
        event.type === 'accused' && event.playerIndex === $currentView?.myIndex)
    )
  ) {
    accusationPending = false;
    onClose();
  }

  onMount(() => {
    const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void tick().then(() => {
      if (dialog !== undefined) focusDialog(dialog);
    });
    return () => restoreFocus?.focus();
  });

  function submit(): void {
    if (!actions.canAccuse || accusationPending) return;
    const viewBeforeAccusation = $currentView;
    const eventsBeforeSubmit = [...$events];
    if (enqueueAccusation(
      () => error.set(null),
      () => send(createAccuseIntent(suspect, weapon, room)),
    )) {
      eventsBeforeAccusation = eventsBeforeSubmit;
      accusationBaseline = viewBeforeAccusation === null ? null : {
        phase: viewBeforeAccusation.phase,
        failedAccusation: viewBeforeAccusation.players[viewBeforeAccusation.myIndex]?.failedAccusation ?? false,
      };
      accusationPending = true;
    }
  }

  function close(): void {
    if (!accusationPending) onClose();
  }

  function handleKey(event: KeyboardEvent): void {
    if (event.key === 'Escape' && !accusationPending) close();
    trapDialogFocus(event, dialog);
  }
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center bg-mocha-crust/80 p-4" role="presentation" onclick={close}>
  <div bind:this={dialog} class="w-full max-w-3xl rounded-2xl border border-mocha-red/40 bg-mocha-base p-5 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="accuse-title" aria-busy={accusationPending} onclick={(event) => event.stopPropagation()} onkeydown={handleKey} tabindex="-1">
    <div class="flex items-start justify-between gap-4">
      <div>
        <p class="text-xs font-semibold uppercase tracking-[0.18em] text-mocha-red">Final accusation</p>
        <h2 id="accuse-title" class="mt-1 font-display text-2xl font-semibold">Name the solution</h2>
      </div>
      <button class="text-mocha-overlay2 hover:text-mocha-text" type="button" aria-label="Close accusation dialog" disabled={accusationPending} onclick={close}>Close</button>
    </div>

    <p class="mt-4 rounded-xl border border-mocha-red/35 bg-mocha-red/10 px-3 py-3 text-sm leading-6 text-mocha-red" role="alert">
      An incorrect accusation removes you from future turns. Check your notes before confirming.
    </p>

    {#if accusationPending}
      <p class="mt-4 rounded-xl border border-mocha-yellow/35 bg-mocha-yellow/10 px-3 py-3 text-sm text-mocha-yellow" role="status" aria-live="polite">
        Accusation sent. Waiting for the game server to confirm it.
      </p>
    {:else if $error}
      <p class="mt-4 rounded-xl border border-mocha-red/35 bg-mocha-red/10 px-3 py-3 text-sm text-mocha-red" role="alert">{$error}</p>
    {/if}

    <form class="mt-5 space-y-5" onsubmit={(event) => { event.preventDefault(); submit(); }}>
      <div>
        <p id="accuse-suspect-label" class="mb-2 text-sm font-semibold text-mocha-subtext1">Suspect</p>
        <CardPicker type="suspect" options={SUSPECTS} bind:value={suspect} labelledBy="accuse-suspect-label" />
      </div>
      <div>
        <p id="accuse-weapon-label" class="mb-2 text-sm font-semibold text-mocha-subtext1">Weapon</p>
        <CardPicker type="weapon" options={WEAPONS} bind:value={weapon} labelledBy="accuse-weapon-label" />
      </div>
      <div>
        <p id="accuse-room-label" class="mb-2 text-sm font-semibold text-mocha-subtext1">Room</p>
        <CardPicker type="room" options={ROOMS} bind:value={room} labelledBy="accuse-room-label" />
      </div>
      <div class="flex justify-end gap-2 pt-2">
         <button class="game-button" type="button" disabled={accusationPending} onclick={close}>Cancel</button>
         <button class="game-button game-button-danger" type="submit" disabled={!actions.canAccuse || accusationPending}>Confirm accusation</button>
      </div>
    </form>

    {#if $currentView?.solution}
      <div class="mt-5 border-t border-mocha-surface1 pt-4" aria-live="polite">
        <p class="text-xs font-semibold uppercase tracking-[0.16em] text-mocha-green">Solution revealed</p>
        <p class="mt-2 text-sm text-mocha-subtext1">
          {$currentView.solution.suspect.suspect}, {$currentView.solution.weapon.weapon}, {$currentView.solution.room.room}
        </p>
      </div>
    {/if}
  </div>
</div>
