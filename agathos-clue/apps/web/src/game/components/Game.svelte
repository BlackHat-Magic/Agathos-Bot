<script lang="ts">
  import { onMount } from 'svelte';
  import type { BoardLocation, BoardRenderer } from '../BoardRenderer';
  import { Canvas2DRenderer } from '../canvas2d';
  import { canClickMove } from '../movement-gating';
  import { finishedGameMessage } from '../result-message';
  import { currentView, diceRolling, error, send } from '../stores';
  import { createMoveToIntent } from '../../transport/intents';
  import IntentBar from './IntentBar.svelte';
  import Hand from './Hand.svelte';
  import EventLog from './EventLog.svelte';
  import DiceOverlay from './DiceOverlay.svelte';
  import SuggestPanel from './SuggestPanel.svelte';
  import RevealPrompt from './RevealPrompt.svelte';
  import RevealAnnouncement from './RevealAnnouncement.svelte';
  import AccuseModal from './AccuseModal.svelte';

  let canvas: HTMLCanvasElement;
  let boardFrame: HTMLDivElement;
  let renderer: BoardRenderer<CanvasRenderingContext2D> | null = null;
  let accuseOpen = false;
  let suggestOpen = false;

  function moveTo(destination: BoardLocation): void {
    if ($currentView !== null && canClickMove($currentView, destination)) {
      send(createMoveToIntent(destination));
    }
  }

  function resizeBoard(nextRenderer: BoardRenderer<CanvasRenderingContext2D>): void {
    const width = boardFrame.clientWidth;
    const height = boardFrame.clientHeight;
    if (width > 0 && height > 0) nextRenderer.resize(width, height);
  }

  onMount(() => {
    const nextRenderer = new Canvas2DRenderer();
    renderer = nextRenderer;
    nextRenderer.attach(canvas);
    nextRenderer.onUserClickCell(location => {
      if (canClickMove($currentView, location)) send(createMoveToIntent(location));
    });

    const resize = (): void => resizeBoard(nextRenderer);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(entries => {
        const entry = entries[0];
        if (entry) nextRenderer.resize(entry.contentRect.width, entry.contentRect.height);
      });
      observer.observe(boardFrame);
    } else {
      globalThis.addEventListener('resize', resize);
      resize();
    }
    resize();

    return () => {
      observer?.disconnect();
      if (typeof ResizeObserver === 'undefined') globalThis.removeEventListener('resize', resize);
      nextRenderer.detach();
      renderer = null;
    };
  });

  $: if (renderer !== null && $currentView !== null) {
    renderer.render($currentView);
    // Highlights wait until the dice have settled so the roll reads first.
    renderer.highlightReachable(
      $diceRolling ? [] : $currentView.reachableSpacesHints ?? []);
    animateArrivals($currentView);
  }

  /** Hop a piece along its path whenever the server reports it moved. */
  let previousLocations: BoardLocation[] = [];
  function animateArrivals(view: NonNullable<typeof $currentView>): void {
    const next = view.players.map(player => player.location);
    if (renderer === null) {
      previousLocations = next;
      return;
    }
    for (let index = 0; index < next.length; index += 1) {
      const from = previousLocations[index];
      const to = next[index];
      if (from === undefined || to === undefined || from === to) continue;
      void renderer.animateMove(from, to);
    }
    previousLocations = next;
  }

</script>

<svelte:head>
  <title>Clue | Investigation</title>
</svelte:head>

{#if $currentView}
  <main class="min-h-screen bg-mocha-crust px-3 py-3 text-mocha-text sm:px-5 sm:py-5">
    <div class="mx-auto max-w-[1500px]">
      <header class="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p class="text-xs font-semibold uppercase tracking-[0.22em] text-mocha-mauve">Agathos Clue</p>
          <h1 class="mt-1 font-display text-3xl font-bold sm:text-4xl">The case file</h1>
        </div>
        <p class="text-right text-sm text-mocha-overlay2" role="status" aria-live="polite">
          {$currentView.players[$currentView.myIndex]?.name ?? 'Detective'} · {$currentView.phase}
        </p>
      </header>

      {#if $error}
        <p class="mb-4 rounded-xl border border-mocha-red/35 bg-mocha-red/10 px-4 py-3 text-sm text-mocha-red" role="alert">{$error}</p>
      {/if}

      <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section class="min-w-0 rounded-3xl border border-mocha-surface1 bg-mocha-base p-2 shadow-2xl shadow-black/20 sm:p-4" aria-label="Game board">
          <div bind:this={boardFrame} class="relative aspect-[24/25] w-full overflow-hidden rounded-2xl bg-mocha-void">
            <canvas bind:this={canvas} width="960" height="1000" class="block h-full w-full" aria-label="Clue game board"></canvas>
            <DiceOverlay />
            {#if suggestOpen}
              <SuggestPanel onClose={() => (suggestOpen = false)} />
            {/if}
            {#if accuseOpen}
              <AccuseModal onClose={() => (accuseOpen = false)} />
            {/if}
            <RevealPrompt />
            <RevealAnnouncement />
          </div>
        </section>

        <aside class="space-y-4">
          <IntentBar onAccuse={() => (accuseOpen = true)} onSuggest={() => (suggestOpen = true)} />
          <EventLog />
        </aside>
      </div>

      {#if $currentView.phase === 'finished'}
        <section class="mt-4 rounded-2xl border border-mocha-green/35 bg-mocha-green/10 p-4" aria-labelledby="result-title">
          <p class="text-xs font-semibold uppercase tracking-[0.18em] text-mocha-green">Investigation complete</p>
          <h2 id="result-title" class="mt-1 font-display text-2xl font-semibold">
            {finishedGameMessage($currentView)}
          </h2>
          {#if $currentView.solution}
            <p class="mt-2 text-sm text-mocha-subtext1">
              Solution: {$currentView.solution.suspect.suspect}, {$currentView.solution.weapon.weapon}, {$currentView.solution.room.room}
            </p>
          {/if}
        </section>
      {/if}
    </div>
  </main>

  <Hand />
{/if}