import { writable } from 'svelte/store';
import type { Readable } from 'svelte/store';
import type { Event, GameView } from '@agathos/game';
import { createJoinIntent, type ClientIntent } from './intents';
import {
  parseServerMessage,
} from './snapshots';
import type {
  LobbySnapshot,
  PrivateReveal,
  ServerFrame,
} from './snapshots';

const OPEN = 1;
const MAX_RECONNECT_DELAY_MS = 15_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_QUEUE_SIZE = 32;
const MAX_EVENT_LOG = 64;

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface WebSocketLike {
  readonly readyState: number;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: unknown) => void,
  ): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string, protocols: string[]) => WebSocketLike;
export type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

export interface TransportOptions {
  origin?: string;
  socketFactory?: WebSocketFactory;
  maxQueueSize?: number;
  reconnectDelayMs?: number;
  setTimeout?: (callback: () => void, delay: number) => TimerHandle;
  clearTimeout?: (timer: TimerHandle) => void;
}

export interface Transport {
  readonly view: Readable<GameView | null>;
  readonly lobby: Readable<LobbySnapshot | null>;
  readonly events: Readable<readonly Event[]>;
  readonly privateReveal: Readable<PrivateReveal | null>;
  readonly status: Readable<ConnectionStatus>;
  readonly error: Readable<string | null>;
  send(intent: ClientIntent): boolean;
  close(): void;
}

export function buildWebSocketUrl(gameId: string, origin = currentPageOrigin()): string {
  if (gameId.length === 0) throw new TypeError('gameId must not be empty');
  const page = new URL(origin);
  page.protocol = page.protocol === 'https:' ? 'wss:' : 'ws:';
  page.pathname = '/ws';
  page.search = '';
  page.searchParams.set('gameId', gameId);
  return page.toString();
}

export function connect(gameId: string, token: string, options: TransportOptions = {}): Transport {
  if (gameId.length === 0) throw new TypeError('gameId must not be empty');
  if (token.length === 0) throw new TypeError('token must not be empty');

  const viewStore = writable<GameView | null>(null);
  const lobbyStore = writable<LobbySnapshot | null>(null);
  const eventsStore = writable<readonly Event[]>([]);
  const privateRevealStore = writable<PrivateReveal | null>(null);
  const statusStore = writable<ConnectionStatus>('connecting');
  const errorStore = writable<string | null>(null);
  const queue: ClientIntent[] = [];
  const maxQueueSize = options.maxQueueSize ?? DEFAULT_QUEUE_SIZE;
  const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const socketFactory = options.socketFactory ?? defaultSocketFactory;
  const setTimer = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
  const clearTimer = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
  const url = buildWebSocketUrl(gameId, options.origin ?? currentPageOrigin());
  const protocol = `bearer.${token}`;

  let socket: WebSocketLike | undefined;
  let reconnectTimer: TimerHandle | undefined;
  let reconnectAttempt = 0;
  let isClosed = false;
  let isOpen = false;
  let replayJoinOnOpen = false;
  let lastJoinIntent: Extract<ClientIntent, { kind: 'join' }> | undefined;
  let currentView: GameView | null = null;
  let currentPrivateReveal: PrivateReveal | null = null;
  let currentEvents: Event[] = [];

  const transport: Transport = {
    view: viewStore,
    lobby: lobbyStore,
    events: eventsStore,
    privateReveal: privateRevealStore,
    status: statusStore,
    error: errorStore,
    send,
    close,
  };

  openSocket();
  return transport;

  function openSocket(): void {
    if (isClosed || socket !== undefined) return;
    try {
      const nextSocket = socketFactory(url, [protocol]);
      socket = nextSocket;
      nextSocket.addEventListener('open', () => handleOpen(nextSocket));
      nextSocket.addEventListener('message', event => handleMessage(nextSocket, event));
      nextSocket.addEventListener('close', () => handleClose(nextSocket));
      nextSocket.addEventListener('error', () => handleSocketError(nextSocket));
    } catch (error) {
      setTransportError(errorMessage(error));
      handleUnexpectedSocketFailure();
    }
  }

  function handleOpen(openedSocket: WebSocketLike): void {
    if (isClosed || socket !== openedSocket) return;
    reconnectAttempt = 0;
    isOpen = true;
    statusStore.set('open');
    errorStore.set(null);
    if (replayJoinOnOpen && lastJoinIntent !== undefined) {
      replayJoinOnOpen = false;
      removeQueuedJoinIntents();
      if (!sendImmediately(openedSocket, lastJoinIntent)) return;
    }
    flushQueue(openedSocket);
  }

  function handleMessage(messageSocket: WebSocketLike, event: unknown): void {
    if (isClosed || socket !== messageSocket) return;
    const parsed = parseServerMessage(messageData(event));
    if (!parsed.ok) {
      setTransportError(parsed.error);
      return;
    }
    applyFrame(parsed.frame);
  }

  function handleClose(closedSocket: WebSocketLike): void {
    if (socket !== closedSocket) return;
    const wasOpen = isOpen;
    socket = undefined;
    isOpen = false;
    if (isClosed) return;
    replayJoinOnOpen = (wasOpen || replayJoinOnOpen) && lastJoinIntent !== undefined;
    statusStore.set('reconnecting');
    scheduleReconnect();
  }

  function handleSocketError(errorSocket: WebSocketLike): void {
    if (isClosed || socket !== errorSocket) return;
    replayJoinOnOpen = (isOpen || replayJoinOnOpen) && lastJoinIntent !== undefined;
    socket = undefined;
    isOpen = false;
    statusStore.set('reconnecting');
    setTransportError('WebSocket connection error');
    scheduleReconnect();
    try {
      errorSocket.close(1011, 'transport error');
    } catch {
      // The socket is already unusable; the reconnect is already scheduled.
    }
  }

  function handleUnexpectedSocketFailure(): void {
    socket = undefined;
    isOpen = false;
    if (isClosed) return;
    statusStore.set('reconnecting');
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (isClosed || reconnectTimer !== undefined || socket !== undefined) return;
    const delay = Math.min(
      reconnectDelayMs * 2 ** reconnectAttempt,
      MAX_RECONNECT_DELAY_MS,
    );
    reconnectAttempt += 1;
    reconnectTimer = setTimer(() => {
      reconnectTimer = undefined;
      openSocket();
    }, delay);
  }

  function flushQueue(openedSocket: WebSocketLike): void {
    while (!isClosed && socket === openedSocket && openedSocket.readyState === OPEN && queue.length > 0) {
      const intent = queue[0]!;
      try {
        openedSocket.send(JSON.stringify({ intent }));
        queue.shift();
      } catch (error) {
        setTransportError(errorMessage(error));
        try {
          openedSocket.close(1011, 'transport send failed');
        } catch {
          handleClose(openedSocket);
        }
        return;
      }
    }
  }

  function send(intent: ClientIntent): boolean {
    if (isClosed) {
      setTransportError('transport is closed');
      return false;
    }
    const acceptedIntent = intent.kind === 'join' ? createJoinIntent(intent.name) : intent;
    if (socket?.readyState === OPEN && isOpen) {
      if (!sendImmediately(socket, acceptedIntent)) return false;
      rememberAcceptedIntent(acceptedIntent);
      return true;
    }
    if (acceptedIntent.kind === 'join' && replaceQueuedJoin(acceptedIntent)) return true;
    if (acceptedIntent.kind === 'leave') {
      removeQueuedJoinIntents();
      replayJoinOnOpen = false;
    }
    if (queue.length >= maxQueueSize) {
      setTransportError(`send queue is full (${maxQueueSize} intents)`);
      return false;
    }
    queue.push(acceptedIntent);
    rememberAcceptedIntent(acceptedIntent);
    return true;
  }

  function close(): void {
    if (isClosed) return;
    isClosed = true;
    clearRememberedJoin();
    queue.length = 0;
    if (reconnectTimer !== undefined) {
      clearTimer(reconnectTimer);
      reconnectTimer = undefined;
    }
    const closingSocket = socket;
    socket = undefined;
    isOpen = false;
    statusStore.set('closed');
    if (closingSocket !== undefined) {
      try {
        closingSocket.close(1000, 'client closed');
      } catch {
        // The socket is already closed; explicit close still prevents retries.
      }
    }
  }

  function applyFrame(frame: ServerFrame): void {
    switch (frame.type) {
      case 'state':
        // A state frame is the public baseline. A following private frame is
        // the only authority that may add a local reveal to this baseline.
        clearRememberedJoin();
        currentPrivateReveal = null;
        privateRevealStore.set(null);
        setView(frame.view);
        lobbyStore.set(null);
        currentEvents = [...currentEvents, ...frame.events].slice(-MAX_EVENT_LOG);
        eventsStore.set(currentEvents);
        errorStore.set(null);
        return;
      case 'private':
        currentPrivateReveal = frame.reveal;
        privateRevealStore.set(frame.reveal);
        if (currentView !== null) setView(applyPrivateReveal(currentView));
        return;
      case 'lobby':
        currentPrivateReveal = null;
        privateRevealStore.set(null);
        setView(null);
        lobbyStore.set(frame);
        currentEvents = [];
        eventsStore.set(currentEvents);
        errorStore.set(null);
        return;
      case 'ready':
        clearRememberedJoin();
        currentPrivateReveal = null;
        privateRevealStore.set(null);
        setView(null);
        lobbyStore.set(null);
        errorStore.set(null);
        return;
      case 'error':
        if (frame.intentKind === 'join') clearRememberedJoin();
        setTransportError(frame.message);
        return;
    }
  }

  function setView(nextView: GameView | null): void {
    currentView = nextView;
    viewStore.set(nextView);
  }

  function applyPrivateReveal(view: GameView): GameView {
    if (currentPrivateReveal?.card === undefined) {
      const { lastSuggestionReveal: _lastSuggestionReveal, ...publicView } = view;
      return publicView;
    }
    return {
      ...view,
      lastSuggestionReveal: {
        fromIndex: currentPrivateReveal.fromIndex,
        card: currentPrivateReveal.card,
      },
    };
  }

  function setTransportError(message: string): void {
    errorStore.set(message);
  }

  function sendImmediately(openedSocket: WebSocketLike, intent: ClientIntent): boolean {
    try {
      openedSocket.send(JSON.stringify({ intent }));
      return true;
    } catch (error) {
      setTransportError(errorMessage(error));
      try {
        openedSocket.close(1011, 'transport send failed');
      } catch {
        handleClose(openedSocket);
      }
      return false;
    }
  }

  function rememberAcceptedIntent(intent: ClientIntent): void {
    if (intent.kind === 'join') {
      lastJoinIntent = { ...intent };
      return;
    }
    if (intent.kind === 'leave') clearRememberedJoin();
  }

  function clearRememberedJoin(): void {
    lastJoinIntent = undefined;
    replayJoinOnOpen = false;
    removeQueuedJoinIntents();
  }

  function replaceQueuedJoin(intent: Extract<ClientIntent, { kind: 'join' }>): boolean {
    const index = queue.findIndex(queuedIntent => queuedIntent.kind === 'join');
    if (index < 0) return false;
    queue[index] = intent;
    rememberAcceptedIntent(intent);
    return true;
  }

  function removeQueuedJoinIntents(): void {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (queue[index]?.kind === 'join') queue.splice(index, 1);
    }
  }

}

function defaultSocketFactory(url: string, protocols: string[]): WebSocketLike {
  return new WebSocket(url, protocols) as unknown as WebSocketLike;
}

function currentPageOrigin(): string {
  if (typeof globalThis.location?.origin !== 'string' || globalThis.location.origin.length === 0) {
    throw new Error('current page origin is unavailable');
  }
  return globalThis.location.origin;
}

function messageData(event: unknown): unknown {
  if (typeof event === 'object' && event !== null && 'data' in event) {
    return (event as { data: unknown }).data;
  }
  return event;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'WebSocket operation failed';
}
