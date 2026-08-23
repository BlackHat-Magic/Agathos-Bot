import type { ClientIntent } from '../transport/intents';
import { createLeaveIntent } from '../transport/intents';
import type { ConnectionStatus } from '../transport/ws';

export function shouldResetJoinedState(
  hasJoined: boolean,
  status: ConnectionStatus | 'idle',
  transportError: string | null,
  hasLobby: boolean,
): boolean {
  return hasJoined && (
    status === 'reconnecting' ||
    status === 'closed' ||
    transportError !== null ||
    !hasLobby
  );
}

export function canManageLobby(hasJoined: boolean): boolean {
  return hasJoined;
}

export function canStartLobby(hasJoined: boolean, isHost: boolean): boolean {
  return hasJoined && isHost;
}

export function enqueueLeave(send: (intent: ClientIntent) => boolean): boolean {
  return send(createLeaveIntent());
}
