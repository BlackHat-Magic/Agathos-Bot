export type ReplaceGameUrl = (url: URL) => void;

export function bootstrapGameFromUrl(
  url = new URL(window.location.href),
  replaceUrl: ReplaceGameUrl = next => window.history.replaceState({}, '', next),
): string | null {
  const game = usableGameId(url.searchParams.get('game')) ??
    usableGameId(url.searchParams.get('gameId'));
  if (game === null) return null;

  url.searchParams.set('game', game);
  url.searchParams.delete('gameId');
  replaceUrl(url);
  return game;
}

function usableGameId(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length === 0 ? null : trimmed;
}
