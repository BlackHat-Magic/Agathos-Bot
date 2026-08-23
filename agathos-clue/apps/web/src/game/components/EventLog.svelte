<script lang="ts">
  import { currentView, events } from '../stores';
  import { formatEvent, relativeEventLabel } from '../event-format';
</script>

<section class="rounded-2xl border border-mocha-surface1 bg-mocha-mantle p-4" aria-labelledby="event-log-title">
  <div class="flex items-center justify-between gap-3">
    <h2 id="event-log-title" class="font-display text-lg font-semibold">Case file</h2>
    <span class="text-xs uppercase tracking-[0.16em] text-mocha-overlay2">Live</span>
  </div>
  <ol class="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1" aria-live="polite" aria-label="Game events">
    {#each $events as event, index}
      <li class="rounded-xl border border-mocha-surface1/70 bg-mocha-base px-3 py-2">
        <p class="text-sm leading-5 text-mocha-subtext1">{formatEvent(event, $currentView)}</p>
        <p class="mt-1 text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-mocha-overlay2">{relativeEventLabel(index, $events.length)}</p>
      </li>
    {:else}
      <li class="rounded-xl border border-dashed border-mocha-surface1 px-3 py-4 text-sm text-mocha-overlay2">No events recorded yet.</li>
    {/each}
  </ol>
</section>
