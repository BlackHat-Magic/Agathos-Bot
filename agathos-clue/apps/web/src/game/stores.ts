import { writable } from 'svelte/store';
import type { GameView } from '@agathos/game';
import { session } from '../auth/standalone';
import { connect, type ConnectionStatus, type Transport } from '../transport/ws';
import type { ClientIntent } from '../transport/intents';
import type { LobbySnapshot } from '../transport/snapshots';

export const currentView = writable<GameView | null>(null);
export const lobby = writable<LobbySnapshot | null>(null);
export const gameId = writable<string | null>(null);
export const connectionStatus = writable<ConnectionStatus | 'idle'>('idle');
export const error = writable<string | null>(null);

let transport: Transport | null = null;
let stopTransportSubscriptions: (() => void) | null = null;
let selectedGameId: string | null = null;
let selectedToken: string | null = null;
let connectedGameId: string | null = null;
let connectedToken: string | null = null;

gameId.subscribe(id => {
  selectedGameId = id;
  syncTransport();
});

session.subscribe(value => {
  selectedToken = value?.token ?? null;
  syncTransport();
});

export function send(intent: ClientIntent): boolean {
  if (transport === null) {
    error.set(selectedGameId === null ? 'Choose a game before sending an action' : 'Not logged in');
    return false;
  }
  return transport.send(intent);
}

function syncTransport(): void {
  if (selectedGameId === null || selectedToken === null) {
    closeTransport();
    if (selectedGameId !== null && selectedToken === null) error.set('Not logged in');
    return;
  }

  if (transport !== null && connectedGameId === selectedGameId && connectedToken === selectedToken) return;
  closeTransport();

  currentView.set(null);
  lobby.set(null);
  error.set(null);
  try {
    transport = connect(selectedGameId, selectedToken);
    connectedGameId = selectedGameId;
    connectedToken = selectedToken;
    stopTransportSubscriptions = subscribeToTransport(transport);
  } catch (cause) {
    error.set(cause instanceof Error ? cause.message : 'Unable to connect to the game');
    connectionStatus.set('idle');
  }
}

function subscribeToTransport(nextTransport: Transport): () => void {
  let transportReady = false;
  const stops = [
    nextTransport.view.subscribe(value => {
      currentView.set(value);
      if (value !== null) {
        transportReady = true;
        error.set(null);
      }
    }),
    nextTransport.lobby.subscribe(value => {
      lobby.set(value);
      if (value !== null) {
        transportReady = true;
        error.set(null);
      }
    }),
    nextTransport.status.subscribe(value => {
      connectionStatus.set(value);
      if (value === 'open') {
        transportReady = true;
        error.set(null);
      }
    }),
    nextTransport.error.subscribe(value => {
      if (value !== null) error.set(value);
      else if (transportReady) error.set(null);
    }),
  ];
  return () => stops.forEach(stop => stop());
}

function closeTransport(): void {
  if (stopTransportSubscriptions !== null) {
    stopTransportSubscriptions();
    stopTransportSubscriptions = null;
  }
  if (transport !== null) {
    transport.close();
    transport = null;
  }
  connectedGameId = null;
  connectedToken = null;
  currentView.set(null);
  lobby.set(null);
  connectionStatus.set('idle');
}
