<script lang="ts">
  import Lobby from './game/components/Lobby.svelte';
  import { currentView } from './game/stores';
</script>

{#if $currentView && $currentView.phase !== 'lobby'}
  <main class="flex min-h-screen items-center justify-center px-6 text-center text-mocha-text">
    <section class="max-w-lg rounded-3xl border border-mocha-surface1 bg-mocha-base p-8">
      <p class="text-sm font-semibold uppercase tracking-[0.2em] text-mocha-mauve">Investigation underway</p>
      <h1 class="mt-3 font-display text-4xl font-bold">The board is ready.</h1>
      <p class="mt-4 text-mocha-subtext0">
        Game controls will appear here once the board interface is connected.
      </p>
    </section>
  </main>
{:else}
  <Lobby />
{/if}
