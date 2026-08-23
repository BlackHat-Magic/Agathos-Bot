import { spaceAt } from './board';
import { reachable } from './pathfind';
import { evaluateAccusation } from './rules';
import type { Card, Game, Intent, Player, Room, Suspect, Weapon } from './types';
import { ROOMS } from './types';

export type Event =
  | { type: 'rolled'; playerIndex: number; result: number }
  | { type: 'moved'; playerIndex: number; destination: string | Room }
  | { type: 'usedSecretPassage'; playerIndex: number; to: Room }
  | { type: 'suggested'; playerIndex: number; suspect: Suspect; weapon: Weapon; room: Room }
  | { type: 'revealRequested'; revealerIndex: number }
  | { type: 'revealed'; revealerIndex: number; cardHint: 'private' }
  | { type: 'declinedReveal'; revealerIndex: number }
  | { type: 'accused'; playerIndex: number; correct: boolean }
  | { type: 'turnEnded'; playerIndex: number }
  | { type: 'gameWon'; playerIndex: number };

export type RNG = () => number;

const COORDINATE = /^\d+,\d+$/;

function playerAt(game: Game, playerIndex: number): Player {
  const player = game.players[playerIndex];
  if (!player) throw new Error(`unknown player index: ${playerIndex}`);
  return player;
}

function requireGameplayTurn(game: Game, playerIndex: number): void {
  if (game.phase !== 'playing') throw new Error('game is not in the playing phase');
  if (game.turnIndex !== playerIndex) throw new Error(`it is not player ${playerIndex}'s turn`);
  if (game.pendingReveal) throw new Error('a card reveal is pending');
}

function requireMovementAvailable(player: Player, intent: Intent): void {
  const movementIntent =
    intent.kind === 'roll' ||
    intent.kind === 'moveTo' ||
    intent.kind === 'useSecretPassage' ||
    intent.kind === 'suggest';
  if (player.guessedHere && movementIntent) {
    throw new Error('player cannot move or suggest after making a suggestion');
  }
}

function requireRevealTurn(game: Game, playerIndex: number): void {
  if (game.phase !== 'playing') throw new Error('game is not in the playing phase');
  if (!game.pendingReveal) throw new Error('there is no pending reveal');
  if (game.pendingReveal.revealerIndex !== playerIndex) {
    throw new Error('player is not the current revealer');
  }
}

function isRoom(value: string): value is Room {
  return (ROOMS as readonly string[]).includes(value);
}

function roomSpace(game: Game, room: Room) {
  for (const column of game.board) {
    for (const space of column) {
      if (space?.room === room) return space;
    }
  }
  throw new Error(`room is not on the board: ${room}`);
}

function destinationSpace(game: Game, destination: Room | string) {
  if (COORDINATE.test(destination)) {
    const [colText, rowText] = destination.split(',');
    const col = Number(colText);
    const row = Number(rowText);
    if (col >= game.board.length || row >= (game.board[col]?.length ?? 0)) {
      throw new Error(`destination is outside the board: ${destination}`);
    }
    return spaceAt(game.board, col, row);
  }

  if (!isRoom(destination)) throw new Error(`invalid destination: ${destination}`);
  return roomSpace(game, destination);
}

function matchesSuggestion(card: Card, pending: Game['pendingReveal']): boolean {
  if (!pending) return false;
  return (
    (card.type === 'suspect' && card.suspect === pending.suspect) ||
    (card.type === 'weapon' && card.weapon === pending.weapon) ||
    (card.type === 'room' && card.room === pending.room)
  );
}

function sameCard(a: Card, b: Card): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'suspect' && b.type === 'suspect') return a.suspect === b.suspect;
  if (a.type === 'weapon' && b.type === 'weapon') return a.weapon === b.weapon;
  return a.type === 'room' && b.type === 'room' && a.room === b.room;
}

function nextPlayerIndex(game: Game, index: number): number {
  return (index + 1) % game.players.length;
}

/** Apply one server-authoritative intent directly to the canonical game. */
export function applyIntent(
  game: Game,
  playerIndex: number,
  intent: Intent,
  rng: RNG = Math.random,
): Event[] {
  if (intent.kind === 'wait') return [];

  const player = playerAt(game, playerIndex);

  if (intent.kind === 'join' || intent.kind === 'claimSuspect' || intent.kind === 'start' ||
      intent.kind === 'setOrder' || intent.kind === 'leave') {
    return [];
  }

  if (intent.kind === 'showCard' || intent.kind === 'declineReveal') {
    requireRevealTurn(game, playerIndex);
  } else {
    requireGameplayTurn(game, playerIndex);
    requireMovementAvailable(player, intent);
    if (player.failedAccusation && intent.kind !== 'endTurn') {
      throw new Error('players with failed accusations may only end their turn');
    }
  }

  switch (intent.kind) {
    case 'roll': {
      if (game.hasRolledThisTurn || game.hasMovedThisTurn) {
        throw new Error('player must move or end their turn before rolling again');
      }
      const result = Math.floor(rng() * 6) + 1 + Math.floor(rng() * 6) + 1;
      game.lastDieRoll = result;
      game.hasRolledThisTurn = true;
      return [{ type: 'rolled', playerIndex, result }];
    }

    case 'moveTo': {
      if (!game.hasRolledThisTurn || game.lastDieRoll === null) {
        throw new Error('player must roll before moving');
      }
      const destination = destinationSpace(game, intent.destination);
      const destinations = reachable(player.piece.location, game.lastDieRoll);
      if (!destinations.spaces.includes(destination)) {
        throw new Error('destination is not reachable with the current roll');
      }
      const enteredRoom = destination.room != null;
      player.piece.location = destination;
      game.lastDieRoll = null;
      game.hasMovedThisTurn = true;
      if (enteredRoom) player.enteredRoomThisTurn = true;
      return [{ type: 'moved', playerIndex, destination: intent.destination }];
    }

    case 'useSecretPassage': {
      if (game.hasMovedThisTurn) {
        throw new Error('secret passages can only be used before moving');
      }
      if (game.hasRolledThisTurn) {
        throw new Error('secret passages can only be used before rolling');
      }
      const destination = player.piece.location.accesses.find(space => space.room != null);
      if (!player.piece.location.room || !destination?.room) {
        throw new Error('no secret passage from the current location');
      }
      player.piece.location = destination;
      game.hasMovedThisTurn = true;
      player.enteredRoomThisTurn = true;
      return [{ type: 'usedSecretPassage', playerIndex, to: destination.room }];
    }

    case 'suggest': {
      if (game.players.length < 2) {
        throw new Error('suggestions require at least two players');
      }
      const room = player.piece.location.room;
      if (!room) throw new Error('suggestions can only be made in a room');
      if (player.guessedHere) throw new Error('player has already suggested in this room');
      if (!player.enteredRoomThisTurn && !player.movedBySuggestion) {
        throw new Error('player must enter a room before suggesting');
      }

      player.guessedHere = true;
      const suspectPlayer = game.players.find(p => p !== player && p.suspect === intent.suspect);
      if (suspectPlayer) {
        suspectPlayer.piece.location = player.piece.location;
        suspectPlayer.enteredRoomThisTurn = false;
        suspectPlayer.movedBySuggestion = true;
      }
      const weaponPiece = game.weapons.find(piece => piece.weapon === intent.weapon);
      if (weaponPiece) weaponPiece.location = player.piece.location;

      const revealerIndex = nextPlayerIndex(game, playerIndex);
      game.pendingReveal = {
        suggesterIndex: playerIndex,
        suspect: intent.suspect,
        weapon: intent.weapon,
        room,
        revealerIndex,
      };

      return [
        { type: 'suggested', playerIndex, suspect: intent.suspect, weapon: intent.weapon, room },
        { type: 'revealRequested', revealerIndex },
      ];
    }

    case 'showCard': {
      const pending = game.pendingReveal;
      if (!pending) throw new Error('there is no pending reveal');
      if (!player.cards.some(card => sameCard(card, intent.card))) {
        throw new Error('revealer does not own that card');
      }
      if (!matchesSuggestion(intent.card, pending)) {
        throw new Error('card does not match the pending suggestion');
      }

      game.pendingReveal = null;
      return [{ type: 'revealed', revealerIndex: playerIndex, cardHint: 'private' }];
    }

    case 'declineReveal': {
      const pending = game.pendingReveal;
      if (!pending) throw new Error('there is no pending reveal');
      if (player.cards.some(card => matchesSuggestion(card, pending))) {
        throw new Error('revealer must show a matching card instead of declining');
      }

      const events: Event[] = [{ type: 'declinedReveal', revealerIndex: playerIndex }];
      const next = nextPlayerIndex(game, playerIndex);
      if (next === pending.suggesterIndex) {
        game.pendingReveal = null;
      } else {
        pending.revealerIndex = next;
        events.push({ type: 'revealRequested', revealerIndex: next });
      }
      return events;
    }

    case 'accuse': {
      const correct = evaluateAccusation(game, playerIndex, {
        suspect: intent.suspect,
        weapon: intent.weapon,
        room: intent.room,
      });
      const events: Event[] = [{ type: 'accused', playerIndex, correct }];
      if (correct) events.push({ type: 'gameWon', playerIndex });
      return events;
    }

    case 'endTurn': {
      player.guessedHere = false;
      player.movedBySuggestion = false;
      player.enteredRoomThisTurn = false;
      game.lastDieRoll = null;
      game.hasRolledThisTurn = false;
      game.hasMovedThisTurn = false;

      let next = nextPlayerIndex(game, playerIndex);
      while (next !== playerIndex && game.players[next]!.failedAccusation) {
        next = nextPlayerIndex(game, next);
      }
      if (game.players[next]!.failedAccusation) next = playerIndex;
      game.turnIndex = next;
      return [{ type: 'turnEnded', playerIndex }];
    }
  }
}
