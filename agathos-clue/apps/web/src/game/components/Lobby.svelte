<script lang="ts">
  import Icon from '@iconify/svelte';
  import { SUSPECTS, type Suspect } from '@agathos/game';
  import { beginStandaloneAuth, session } from '../../auth/standalone';
  import { bootstrapGameFromUrl } from '../bootstrap';
  import {
    canManageLobby as canManageLobbyState,
    canStartLobby as canStartLobbyState,
    enqueueLeave,
    shouldResetJoinedState,
  } from '../lobby-lifecycle';
  import {
    connectionStatus,
    error,
    gameId,
    lobby,
    send,
  } from '../stores';

  let requestedGameId = '';
  let playerName = '';
  let selectedSuspect: Suspect = SUSPECTS[0];
  let hasJoined = false;

  $: availableSuspects = SUSPECTS.filter(suspect =>
    !($lobby?.players.some(player => player.suspect === suspect) ?? false));
  $: isHost = $lobby?.hostUserId !== null && $lobby?.hostUserId === $session?.userId;
  $: canManageLobby = canManageLobbyState(hasJoined);
  $: canStartLobby = canStartLobbyState(hasJoined, isHost);
  $: allPlayersClaimed = ($lobby?.players.length ?? 0) > 0 &&
    ($lobby?.players.every(player => player.suspect !== null) ?? false);
  $: if (!availableSuspects.includes(selectedSuspect) && availableSuspects.length > 0) {
    selectedSuspect = availableSuspects[0];
  }
  $: if (shouldResetJoinedState(hasJoined, $connectionStatus, $error, $lobby !== null)) {
    hasJoined = false;
  }

  function openGame(): void {
    const id = requestedGameId.trim();
    if (id.length === 0) return;
    const url = new URL(window.location.href);
    url.searchParams.set('game', id);
    const selectedGameId = bootstrapGameFromUrl(
      url,
      url => window.history.replaceState({}, '', url),
    );
    if (selectedGameId === null) return;
    gameId.set(selectedGameId);
    hasJoined = false;
  }

  function joinLobby(): void {
    const name = playerName.trim();
    if (name.length === 0) return;
    if (send({ kind: 'join', name })) hasJoined = true;
  }

  function claimSuspect(): void {
    if (availableSuspects.length === 0) return;
    send({ kind: 'claimSuspect', suspect: selectedSuspect });
  }

  function startGame(): void {
    send({ kind: 'start' });
  }

  function leaveLobby(): void {
    if (enqueueLeave(send)) hasJoined = false;
  }
</script>

<svelte:head>
  <title>Clue | Lobby</title>
</svelte:head>

<main class="min-h-screen px-4 py-8 text-mocha-text sm:px-8">
  <div class="mx-auto grid max-w-5xl gap-8 lg:grid-cols-[1fr_1.15fr] lg:items-start">
    <section class="space-y-6 pt-4 lg:pt-12">
      <div class="flex items-center gap-3 text-mocha-mauve">
        <Icon icon="hugeicons:game-controller-03" width="28" height="28" aria-hidden="true" />
        <span class="text-sm font-semibold uppercase tracking-[0.28em]">Agathos Clue</span>
      </div>
      <div>
        <p class="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-mocha-overlay2">Private game room</p>
        <h1 class="max-w-xl font-display text-5xl font-bold leading-[0.95] text-mocha-text sm:text-6xl">
          Gather your detectives.
        </h1>
        <p class="mt-5 max-w-lg text-lg leading-8 text-mocha-subtext0">
          Join the room, choose your suspect, and let the host start the investigation.
        </p>
      </div>
      <div class="flex items-center gap-2 text-sm text-mocha-overlay1">
        <span class="h-2 w-2 rounded-full bg-mocha-green"></span>
        Secure Discord session required
      </div>
    </section>

    <section class="rounded-3xl border border-mocha-surface1 bg-mocha-base/90 p-6 shadow-2xl shadow-black/20 sm:p-8">
      <div class="mb-8 flex items-start justify-between gap-4">
        <div>
          <p class="mb-2 text-sm font-semibold uppercase tracking-[0.18em] text-mocha-mauve">Lobby</p>
          <h2 class="font-display text-3xl font-bold">Ready room</h2>
        </div>
        <Icon icon="hugeicons:door-01" width="30" height="30" class="text-mocha-peach" aria-hidden="true" />
      </div>

      {#if !$session}
        <div class="rounded-2xl border border-mocha-surface1 bg-mocha-mantle p-5">
          <p class="text-mocha-subtext0">Sign in to connect to a lobby and play with your group.</p>
          <button
            class="mt-5 inline-flex items-center gap-2 rounded-xl bg-mocha-mauve px-4 py-3 font-semibold text-mocha-crust transition hover:bg-mocha-pink focus:outline-2 focus:outline-offset-2 focus:outline-mocha-mauve"
            type="button"
            onclick={beginStandaloneAuth}
          >
            <Icon icon="hugeicons:discord" width="20" height="20" aria-hidden="true" />
            Sign in with Discord
          </button>
        </div>
      {:else if !$gameId}
        <form onsubmit={(event) => { event.preventDefault(); openGame(); }} class="space-y-4">
          <label class="block text-sm font-semibold" for="game-id">Game room ID</label>
          <div class="flex flex-col gap-3 sm:flex-row">
            <input
              id="game-id"
              bind:value={requestedGameId}
              class="min-w-0 flex-1 rounded-xl border border-mocha-surface1 bg-mocha-mantle px-4 py-3 text-mocha-text outline-none placeholder:text-mocha-overlay1 focus:border-mocha-mauve"
              placeholder="clue-game:..."
              autocomplete="off"
            />
            <button
              class="inline-flex items-center justify-center gap-2 rounded-xl bg-mocha-mauve px-4 py-3 font-semibold text-mocha-crust transition hover:bg-mocha-pink focus:outline-2 focus:outline-offset-2 focus:outline-mocha-mauve"
              type="submit"
            >
              <Icon icon="hugeicons:arrow-right-02" width="20" height="20" aria-hidden="true" />
              Enter room
            </button>
          </div>
          <p class="text-sm text-mocha-overlay2">Use the room ID supplied by the game host.</p>
        </form>
      {:else}
        <div class="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-mocha-mantle px-4 py-3 text-sm">
          <span class="text-mocha-overlay2">Room</span>
          <code class="break-all text-mocha-sky">{$gameId}</code>
        </div>

        {#if $lobby}
          <div class="space-y-3">
            <div class="flex items-center justify-between">
              <h3 class="font-display text-xl font-semibold">Detectives</h3>
              <span class="text-sm text-mocha-overlay2">{$lobby.players.length} / 6</span>
            </div>
            <ul class="space-y-2" aria-label="Lobby players">
              {#each $lobby.players as player}
                <li class="flex items-center justify-between rounded-xl border border-mocha-surface1/70 bg-mocha-mantle px-4 py-3">
                  <span class="flex min-w-0 items-center gap-3">
                    <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-mocha-surface0 text-mocha-peach">
                      <Icon icon="hugeicons:user" width="17" height="17" aria-hidden="true" />
                    </span>
                    <span class="truncate">{player.name}</span>
                    {#if player.isHost}
                      <span class="rounded-md bg-mocha-peach/15 px-2 py-1 text-xs font-semibold text-mocha-peach">HOST</span>
                    {/if}
                  </span>
                  <span class="ml-3 shrink-0 text-right text-sm text-mocha-overlay2">
                    {player.suspect ?? 'Choosing'}
                  </span>
                </li>
              {/each}
            </ul>
          </div>

          {#if !canManageLobby}
            <form onsubmit={(event) => { event.preventDefault(); joinLobby(); }} class="mt-6 space-y-3 border-t border-mocha-surface1 pt-6">
              <label class="block text-sm font-semibold" for="player-name">Your display name</label>
              <div class="flex flex-col gap-3 sm:flex-row">
                <input
                  id="player-name"
                  bind:value={playerName}
                  class="min-w-0 flex-1 rounded-xl border border-mocha-surface1 bg-mocha-mantle px-4 py-3 outline-none placeholder:text-mocha-overlay1 focus:border-mocha-mauve"
                  placeholder="Detective name"
                  maxlength="32"
                  autocomplete="nickname"
                />
                <button
                  class="inline-flex items-center justify-center gap-2 rounded-xl border border-mocha-mauve px-4 py-3 font-semibold text-mocha-mauve transition hover:bg-mocha-mauve/10 focus:outline-2 focus:outline-offset-2 focus:outline-mocha-mauve"
                  type="submit"
                >
                  <Icon icon="hugeicons:user-add-01" width="20" height="20" aria-hidden="true" />
                  Join lobby
                </button>
              </div>
            </form>
          {:else}
            <div class="mt-6 grid gap-4 border-t border-mocha-surface1 pt-6 sm:grid-cols-[1fr_auto] sm:items-end">
              <label class="block text-sm font-semibold" for="suspect">Choose your suspect
                <select
                  id="suspect"
                  bind:value={selectedSuspect}
                  disabled={availableSuspects.length === 0}
                  class="mt-2 block w-full rounded-xl border border-mocha-surface1 bg-mocha-mantle px-4 py-3 font-normal text-mocha-text outline-none focus:border-mocha-mauve disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {#each availableSuspects as suspect}
                    <option value={suspect}>{suspect}</option>
                  {/each}
                </select>
              </label>
              <button
                class="inline-flex items-center justify-center gap-2 rounded-xl bg-mocha-surface0 px-4 py-3 font-semibold text-mocha-text transition hover:bg-mocha-surface1 focus:outline-2 focus:outline-offset-2 focus:outline-mocha-mauve disabled:cursor-not-allowed disabled:opacity-50"
                type="button"
                disabled={availableSuspects.length === 0}
                onclick={claimSuspect}
              >
                <Icon icon="hugeicons:checkmark-circle-02" width="20" height="20" aria-hidden="true" />
                Claim suspect
              </button>
            </div>
          {/if}

          {#if canStartLobby}
            <button
              class="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-mocha-green px-4 py-3 font-semibold text-mocha-crust transition hover:brightness-110 focus:outline-2 focus:outline-offset-2 focus:outline-mocha-green disabled:cursor-not-allowed disabled:opacity-50"
              type="button"
              disabled={!allPlayersClaimed}
              onclick={startGame}
            >
              <Icon icon="hugeicons:play" width="20" height="20" aria-hidden="true" />
              Start investigation
            </button>
            {#if !allPlayersClaimed}
              <p class="mt-2 text-center text-sm text-mocha-overlay2">Every detective must choose a suspect first.</p>
            {/if}
          {/if}

          {#if canManageLobby}
            <div class="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-mocha-surface1/70 bg-mocha-mantle px-4 py-3">
              <span class="text-sm text-mocha-overlay2">Joined as <strong class="text-mocha-text">{playerName}</strong></span>
              <button
                class="inline-flex items-center justify-center gap-2 rounded-lg border border-mocha-red/40 px-3 py-2 text-sm font-semibold text-mocha-red transition hover:bg-mocha-red/10 focus:outline-2 focus:outline-offset-2 focus:outline-mocha-red"
                type="button"
                onclick={leaveLobby}
              >
                <Icon icon="hugeicons:logout-03" width="18" height="18" aria-hidden="true" />
                Leave lobby
              </button>
            </div>
          {/if}
        {:else}
          <div class="rounded-2xl border border-mocha-surface1 bg-mocha-mantle p-5 text-mocha-subtext0">
            <div class="flex items-center gap-3">
              <span class="h-2 w-2 animate-pulse rounded-full bg-mocha-yellow"></span>
              Connecting to the room...
            </div>
          </div>
        {/if}
      {/if}

      {#if $connectionStatus !== 'idle'}
        <p class="mt-5 text-xs uppercase tracking-[0.14em] text-mocha-overlay1" role="status" aria-live="polite">Connection: {$connectionStatus}</p>
      {/if}
      {#if $error}
        <p class="mt-3 rounded-xl border border-mocha-red/30 bg-mocha-red/10 px-4 py-3 text-sm text-mocha-red" role="alert">{$error}</p>
      {/if}
    </section>
  </div>
</main>
