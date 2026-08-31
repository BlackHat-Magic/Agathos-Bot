import type { Event, GameView } from '@agathos/game';

export function formatEvent(event: Event, view: GameView | null): string {
  const playerName = (index: number): string => view?.players[index]?.name ?? 'A detective';
  switch (event.type) {
    case 'rolled': return `${playerName(event.playerIndex)} rolled ${event.result}`;
    case 'moved': return `${playerName(event.playerIndex)} moved to ${event.destination}`;
    case 'usedSecretPassage': return `${playerName(event.playerIndex)} used a secret passage to ${event.to}`;
    case 'suggested': return `${playerName(event.playerIndex)} suggested ${event.suspect}, ${event.weapon}, and ${event.room}`;
    case 'revealRequested': return `Asking ${playerName(event.revealerIndex)} to show a card…`;
    case 'revealed': return `${playerName(event.revealerIndex)} revealed a card privately`;
    case 'declinedReveal': return `${playerName(event.revealerIndex)} has nothing to show`;
    case 'accused': return `${playerName(event.playerIndex)} made a ${event.correct ? 'correct' : 'failed'} accusation`;
    case 'turnEnded': return `${playerName(event.playerIndex)} ended their turn`;
    case 'gameWon': return `${playerName(event.playerIndex)} solved the case`;
    case 'timedOut': return `${playerName(event.playerIndex)} timed out while ${event.action === 'turn' ? 'taking a turn' : 'revealing a card'}`;
  }
}

export function relativeEventLabel(index: number, total: number): string {
  const distance = total - index - 1;
  if (distance === 0) return 'Latest';
  if (distance === 1) return '1 action ago';
  return `${distance} actions ago`;
}
