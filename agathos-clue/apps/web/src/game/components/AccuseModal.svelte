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
  import { trapDialogFocus } from '../modal-focus';
  import CardRow from './CardRow.svelte';
  import type { Event } from '@agathos/game';

  export let onClose: () => void = () => {};

  let suspect: Suspect = SUSPECTS[0];
  let weapon: Weapon = WEAPONS[0];
  let room: Room = ROOMS[0];
  let panel: HTMLDivElement;
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
    void tick().then(() => panel?.focus());
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
    trapDialogFocus(event, panel);
  }
</script>

<div class="absolute inset-0 z-30 flex flex-col bg-mocha-crust/85 p-4 backdrop-blur-[2px]" role="region" aria-label="Make an accusation" aria-busy={accusationPending} onkeydown={handleKey}>
  <div bind:this={panel} class="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-y-auto" tabindex="-1">
    <p class="text-xs font-semibold uppercase tracking-[0.2em] text-mocha-red">Final accusation</p>

    <div class="w-full max-w-3xl space-y-5">
      <div>
        <p id="accuse-suspect-label" class="mb-1 text-sm font-semibold text-mocha-subtext1">Suspect</p>
        <CardRow type="suspect" options={SUSPECTS} bind:value={suspect} labelledBy="accuse-suspect-label" />
      </div>

      <div>
        <p id="accuse-weapon-label" class="mb-1 text-sm font-semibold text-mocha-subtext1">Weapon</p>
        <CardRow type="weapon" options={WEAPONS} bind:value={weapon} labelledBy="accuse-weapon-label" />
      </div>

      <div>
        <p id="accuse-room-label" class="mb-1 text-sm font-semibold text-mocha-subtext1">Room</p>
        <CardRow type="room" options={ROOMS} bind:value={room} labelledBy="accuse-room-label" />
      </div>
    </div>

    <p class="max-w-xl text-center text-sm text-mocha-red" role="alert">
      An incorrect accusation removes you from future turns. Check your notes before confirming.
    </p>
    {#if accusationPending}
      <p class="text-sm text-mocha-yellow" role="status" aria-live="polite">
        Accusation sent. Waiting for the game server to confirm it.
      </p>
    {:else if $error}
      <p class="text-sm text-mocha-red" role="alert">{$error}</p>
    {/if}

    {#if $currentView?.solution}
      <p class="text-center text-sm text-mocha-green" aria-live="polite">
        Solution revealed: {$currentView.solution.suspect.suspect}, {$currentView.solution.weapon.weapon}, {$currentView.solution.room.room}
      </p>
    {/if}
  </div>

  <div class="mt-3 flex items-center justify-end gap-2 border-t border-mocha-surface1 pt-3">
    <button class="game-button" type="button" disabled={accusationPending} onclick={close}>Cancel</button>
    <button class="game-button game-button-danger" type="button" disabled={!actions.canAccuse || accusationPending} onclick={submit}>Confirm accusation</button>
  </div>
</div>

<style>
  .carousel :global(.pick:disabled) {
    cursor: default;
    opacity: 0.7;
  }
</style>
