import type { ClientIntent } from '../transport/intents';
import { createJoinIntent, createLeaveIntent } from '../transport/intents';
import type { ConnectionStatus } from '../transport/ws';

export function shouldResetJoinedState(
  hasJoined: boolean,
  status: ConnectionStatus | 'idle',
  transportError: string | null,
  hasLobby: boolean,
): boolean {
  return hasJoined && (
    status === 'closed' ||
    (transportError !== null && status !== 'reconnecting') ||
    !hasLobby
  );
}

export function canManageLobby(hasJoined: boolean): boolean {
  return hasJoined;
}

export function canStartLobby(hasJoined: boolean, isHost: boolean): boolean {
  return hasJoined && isHost;
}

export function enqueueJoin(
  name: string,
  clearError: () => void,
  send: (intent: ClientIntent) => boolean,
  onAccepted?: (normalizedName: string) => void,
): boolean {
  const trimmedName = name.trim();
  if (trimmedName.length === 0) return false;
  clearError();
  const accepted = send(createJoinIntent(trimmedName));
  if (accepted) onAccepted?.(trimmedName);
  return accepted;
}

export function enqueueLeave(send: (intent: ClientIntent) => boolean): boolean {
  return send(createLeaveIntent());
}
