<script lang="ts">
  import Game from './game/components/Game.svelte';
  import Lobby from './game/components/Lobby.svelte';
  import { currentView } from './game/stores';
</script>

{#if $currentView && $currentView.phase !== 'lobby'}
  <Game />
{:else}
  <Lobby />
{/if}
