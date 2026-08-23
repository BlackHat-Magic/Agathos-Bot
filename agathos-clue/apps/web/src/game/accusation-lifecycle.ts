export function enqueueAccusation(
  clearError: () => void,
  send: () => boolean,
): boolean {
  clearError();
  return send();
}
