# Reveal and Movement Rendering Fixes

## Goal

Restore the private card announcement when a computer player shows a card and remove the visible destination flicker during multi-cell movement.

## Scope

- Web client only; the worker protocol and gameplay rules remain unchanged.
- Preserve the existing private reveal transport and card presentation.
- Preserve the existing movement speed and hop animation.

## Design

### Private reveals

`RevealAnnouncement.svelte` will treat a private reveal without a card as a consumed pass, not as an active visible announcement. It will not occupy the active-overlay state or its timer. Card-bearing reveals will remain eligible for display even if an earlier empty-handed reveal or stale active reveal exists. The existing title/dice gate and fallback remain, but the fallback cannot be blocked by a non-visible reveal.

The server remains authoritative. The existing robot private-frame tests already verify that the card-bearing frame reaches the human suggester; web behavior will consume that frame and render the sender name and `CardFace`.

### Movement rendering

`Canvas2DRenderer.animateHopPath` will own one flight state for the complete path. Individual hop segments will not clear `flightSuspect`; only the final segment, cancellation, replacement, or detach will clear it. This prevents the public state token at the destination from appearing between segment promises.

Reachable-space highlights will be cleared when movement begins. The next render may restore valid hints after movement finishes, but no destination ring will be drawn while the piece is in flight.

### Verification

- Add or update web tests covering private reveal consumption and movement flight lifecycle.
- Run all web tests, Svelte check, strict TypeScript compilation, and the production build.
- Deploy the verified web bundle and confirm the worker remains unchanged.
