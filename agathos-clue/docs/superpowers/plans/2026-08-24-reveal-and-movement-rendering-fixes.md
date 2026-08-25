# Reveal and Movement Rendering Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore private card announcements for robot reveals and remove destination flicker from multi-hop movement animations.

**Architecture:** Keep the worker protocol unchanged. Extract the small reveal-state transition into a pure web helper so the no-card/card replacement behavior is directly testable, then use that helper from `RevealAnnouncement.svelte`. Keep movement animation state inside `Canvas2DRenderer`, but pass a segment-preservation flag so the mover remains suppressed until the final hop completes.

**Tech Stack:** Svelte 5, TypeScript, Canvas2D, Vitest, Svelte-check, Vite, Wrangler.

---

## File Map

- Create `apps/web/src/game/reveal-announcement-state.ts`: pure private-reveal activation state transitions.
- Create `apps/web/tests/reveal-announcement-state.test.ts`: regression tests for empty-handed reveals and later card reveals.
- Modify `apps/web/src/game/components/RevealAnnouncement.svelte`: consume no-card frames without blocking visible card frames and remove the fallback's stale-active guard.
- Modify `apps/web/src/game/canvas2d.ts`: preserve `flightSuspect` across a complete hop path and clear reachable highlights when movement begins.
- Modify `apps/web/tests/canvas2d.test.ts`: verify movement clears highlights and preserves flight suppression between hop segments.
- Do not modify the worker or WebSocket protocol; existing worker tests cover robot private-frame delivery.

### Task 1: Add Testable Reveal State Transitions

**Files:**
- Create: `apps/web/src/game/reveal-announcement-state.ts`
- Test: `apps/web/tests/reveal-announcement-state.test.ts`

- [ ] **Step 1: Write the failing state-transition tests**

Create tests with this behavior:

```ts
import { describe, expect, it } from 'vitest';
import type { PrivateReveal } from '../src/transport/snapshots';
import { activateReveal, type RevealAnnouncementState } from '../src/game/reveal-announcement-state';

const cardReveal: PrivateReveal = {
  fromIndex: 1,
  card: { type: 'weapon', weapon: 'Lead Pipe' },
};

const emptyReveal: PrivateReveal = { fromIndex: 1 };

const emptyState: RevealAnnouncementState = {
  active: null,
  queued: cardReveal,
  dismissed: null,
};

describe('activateReveal', () => {
  it('consumes an empty-handed reveal without activating an invisible overlay', () => {
    expect(activateReveal(emptyState, emptyReveal)).toEqual({
      active: null,
      queued: null,
      dismissed: emptyReveal,
    });
  });

  it('allows a card reveal to replace a stale queued reveal', () => {
    expect(activateReveal(emptyState, cardReveal)).toEqual({
      active: cardReveal,
      queued: null,
      dismissed: null,
    });
  });

  it('does not hide an already-visible card when an empty reveal arrives', () => {
    const state = { ...emptyState, active: cardReveal, queued: null };
    expect(activateReveal(state, emptyReveal)).toEqual({
      active: cardReveal,
      queued: null,
      dismissed: emptyReveal,
    });
  });
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run from `agathos-clue/apps/web`:

```bash
bun run test tests/reveal-announcement-state.test.ts
```

Expected: FAIL because `reveal-announcement-state.ts` and `activateReveal` do not exist.

- [ ] **Step 3: Implement the pure state transition**

Create the state type and function:

```ts
import type { PrivateReveal } from '../transport/snapshots';

export interface RevealAnnouncementState {
  active: PrivateReveal | null;
  queued: PrivateReveal | null;
  dismissed: PrivateReveal | null;
}

export function activateReveal(
  state: RevealAnnouncementState,
  reveal: PrivateReveal,
): RevealAnnouncementState {
  if (reveal.card === undefined) {
    return {
      active: state.active,
      queued: null,
      dismissed: reveal,
    };
  }
  return {
    active: reveal,
    queued: null,
    dismissed: state.dismissed,
  };
}
```

- [ ] **Step 4: Run the focused test and confirm it passes**

```bash
bun run test tests/reveal-announcement-state.test.ts
```

Expected: 3 tests pass.

### Task 2: Wire the Reveal Component to the Correct State Behavior

**Files:**
- Modify: `apps/web/src/game/components/RevealAnnouncement.svelte:1-59`

- [ ] **Step 1: Replace component-local activation assignments with the helper**

Import `activateReveal` and `RevealAnnouncementState`. Keep the component's existing `$privateReveal` queue logic, but replace `announce` with:

```ts
function announce(reveal: PrivateReveal): void {
  if (timer !== undefined) clearTimeout(timer);
  if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);

  const current: RevealAnnouncementState = { active, queued, dismissed };
  const next = activateReveal(current, reveal);
  active = next.active;
  queued = next.queued;
  dismissed = next.dismissed;

  if (reveal.card === undefined) return;
  timer = setTimeout(dismiss, TIMEOUT_MS);
}
```

Use the helper's type for the local state shape without changing the existing Svelte variables:

```ts
import { activateReveal, type RevealAnnouncementState } from '../reveal-announcement-state';
```

- [ ] **Step 2: Remove the stale-active fallback guard**

Change the fallback condition from:

```ts
if (queued !== null && active === null) announce(queued);
```

to:

```ts
if (queued !== null) announce(queued);
```

This ensures a card-bearing frame cannot be lost behind an invisible or stale active state.

- [ ] **Step 3: Run reveal and transport regressions**

```bash
bun run test tests/reveal-announcement-state.test.ts src/transport/ws.test.ts
```

Expected: all focused tests pass, including the existing private-frame test that adds `lastSuggestionReveal` only in the local view.

### Task 3: Preserve One Flight Across the Full Movement Path

**Files:**
- Modify: `apps/web/src/game/canvas2d.ts:128-151,205-260`
- Test: `apps/web/tests/canvas2d.test.ts`

- [ ] **Step 1: Add a regression test for highlight clearing**

After attaching and rendering the fake canvas, call `highlightReachable(['13,12'])`, then start `animateMove('12,12', '13,12')`. Assert that the renderer's internal highlight set is empty immediately after movement begins through a test-only structural cast:

```ts
renderer.highlightReachable(['13,12']);
void renderer.animateMove('12,12', '13,12');
expect((renderer as unknown as { highlight: Set<string> }).highlight.size).toBe(0);
```

- [ ] **Step 2: Add a regression test for multi-hop suppression**

Use a path with at least two hops, stub `requestAnimationFrame`, render a non-current player at the destination, start `animateMove`, complete the first segment with `Number.MAX_VALUE`, and assert the static token radius is not drawn at the segment boundary. Then complete the remaining queued frame(s) and await the promise. The test must distinguish the static token radius (`layout.cellW * 0.28`) from the animated radius (`layout.cellW * 0.3`).

- [ ] **Step 3: Run the focused Canvas2D tests and confirm the new behavior fails**

```bash
bun run test tests/canvas2d.test.ts
```

Expected: the new highlight assertion and/or multi-hop suppression assertion fails against the current implementation.

- [ ] **Step 4: Clear reachable highlights at movement start**

In `animateMove`, after validating `suspect`, `from`, and `to`, clear and redraw before starting the path:

```ts
this.highlight.clear();
this.draw();
return this.animateHopPath(suspect, hopPath(from, to));
```

- [ ] **Step 5: Add a segment-preservation parameter**

Change the private method signature to:

```ts
private animate(
  animation: Animation,
  durationMs = ANIMATION_MS,
  preserveFlight = false,
): Promise<void>
```

Pass `preserveFlight` through both completion paths:

```ts
this.clearFlightFor(animation, preserveFlight);
```

Update the helper to leave the field set between segments:

```ts
private clearFlightFor(animation: Animation, preserveFlight = false): void {
  if (!preserveFlight && animation.kind !== 'accusation' &&
      this.flightSuspect === animation.suspect) {
    this.flightSuspect = null;
  }
}
```

Keep `cancelAnimation()` calling `clearFlightFor(animation.animation)` with the default `false`, so replacement and detach always clear the flight.

- [ ] **Step 6: Mark only the final hop as flight-clearing**

In `animateHopPath`, preserve the existing safety cap while ensuring the final executed segment clears the flight. Create a bounded path first, then calculate `isFinal` against that bounded path:

```ts
const path = waypoints.length > 12 ? waypoints.slice(0, 2) : waypoints;
for (let index = 1; index < path.length; index += 1) {
  const isFinal = index === path.length - 1;
  const from = path[index - 1]!;
  const to = path[index]!;
  chain = chain.then(() => this.animate(
    { kind: 'move', suspect, from, to, progress: 0 },
    segmentMs,
    !isFinal,
  ));
}
```

The existing `cancelAnimation` and `detach` paths remain authoritative cleanup paths.

- [ ] **Step 7: Run the focused Canvas2D tests and confirm they pass**

```bash
bun run test tests/canvas2d.test.ts
```

Expected: all existing tests and the new movement regressions pass.

### Task 4: Full Verification and Production Deployment

**Files:**
- Verify: `apps/web/src/game/reveal-announcement-state.ts`
- Verify: `apps/web/src/game/components/RevealAnnouncement.svelte`
- Verify: `apps/web/src/game/canvas2d.ts`
- Verify: `apps/web/tests/reveal-announcement-state.test.ts`
- Verify: `apps/web/tests/canvas2d.test.ts`

- [ ] **Step 1: Run the complete web test suite**

From `agathos-clue/apps/web`:

```bash
bun run test
```

Expected: all web test files pass; the current baseline is 19 files and 115 tests, plus the new reveal-state tests.

- [ ] **Step 2: Run Svelte-check and strict TypeScript compilation**

```bash
bun run typecheck
bunx tsc -b --force
```

Expected: zero Svelte errors/warnings and exit code 0 from strict TypeScript compilation.

- [ ] **Step 3: Build the production bundle**

From `agathos-clue`:

```bash
export VITE_DISCORD_CLIENT_ID=1152547279513845811
bun run build
```

Expected: Vite completes successfully.

- [ ] **Step 4: Run the worker regression suite without changing worker code**

```bash
cd apps/worker
bun run test
bun run typecheck
npx wrangler deploy --dry-run
```

Expected: all 95 worker tests pass, worker typecheck passes, and Wrangler dry-run succeeds.

- [ ] **Step 5: Deploy the verified web/worker application**

```bash
npx wrangler deploy
```

Expected: Wrangler reports a successful deployment. Confirm the deployed bundle loads and perform one manual flow: a robot shows a card to the human suggester, then a piece traverses multiple cells without a destination ring or token flash.
