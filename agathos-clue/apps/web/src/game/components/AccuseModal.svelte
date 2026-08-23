<script lang="ts">
  import {
    ROOMS,
    SUSPECTS,
    WEAPONS,
    type Room,
    type Suspect,
    type Weapon,
  } from '@agathos/game';
  import { currentView, send } from '../stores';
  import { actionsFor } from '../intent-gating';
  import { createAccuseIntent } from '../../transport/intents';

  export let onClose: () => void = () => {};

  let suspect: Suspect = SUSPECTS[0];
  let weapon: Weapon = WEAPONS[0];
  let room: Room = ROOMS[0];

  $: actions = actionsFor($currentView);

  function submit(): void {
    if (!actions.canAccuse) return;
    send(createAccuseIntent(suspect, weapon, room));
    onClose();
  }

  function handleKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') onClose();
  }
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center bg-mocha-crust/80 p-4" role="presentation" onclick={onClose}>
  <div class="w-full max-w-lg rounded-2xl border border-mocha-red/40 bg-mocha-base p-5 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="accuse-title" onclick={(event) => event.stopPropagation()} onkeydown={handleKey} tabindex="-1">
    <div class="flex items-start justify-between gap-4">
      <div>
        <p class="text-xs font-semibold uppercase tracking-[0.18em] text-mocha-red">Final accusation</p>
        <h2 id="accuse-title" class="mt-1 font-display text-2xl font-semibold">Name the solution</h2>
      </div>
      <button class="text-mocha-overlay2 hover:text-mocha-text" type="button" aria-label="Close accusation dialog" onclick={onClose}>Close</button>
    </div>

    <p class="mt-4 rounded-xl border border-mocha-red/35 bg-mocha-red/10 px-3 py-3 text-sm leading-6 text-mocha-red" role="alert">
      An incorrect accusation removes you from future turns. Check your notes before confirming.
    </p>

    <form class="mt-5 space-y-4" onsubmit={(event) => { event.preventDefault(); submit(); }}>
      <label class="block text-sm font-semibold" for="accuse-suspect">Suspect
        <select id="accuse-suspect" bind:value={suspect} class="game-select">
          {#each SUSPECTS as value}<option value={value}>{value}</option>{/each}
        </select>
      </label>
      <label class="block text-sm font-semibold" for="accuse-weapon">Weapon
        <select id="accuse-weapon" bind:value={weapon} class="game-select">
          {#each WEAPONS as value}<option value={value}>{value}</option>{/each}
        </select>
      </label>
      <label class="block text-sm font-semibold" for="accuse-room">Room
        <select id="accuse-room" bind:value={room} class="game-select">
          {#each ROOMS as value}<option value={value}>{value}</option>{/each}
        </select>
      </label>
      <div class="flex justify-end gap-2 pt-2">
        <button class="game-button" type="button" onclick={onClose}>Cancel</button>
        <button class="game-button game-button-danger" type="submit" disabled={!actions.canAccuse}>Confirm accusation</button>
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
