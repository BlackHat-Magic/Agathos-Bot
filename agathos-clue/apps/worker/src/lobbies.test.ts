import { describe, expect, it } from 'vitest';
import { createGame } from '@agathos/game';
import {
  claimLobbySuspect,
  createLobby,
  createStartPlayers,
  hydrateLobby,
  joinLobby,
  leaveLobby,
  lobbyView,
  serializeLobby,
  setLobbyOrder,
} from './lobbies';

function lobbyWithPlayers() {
  let lobby = createLobby();
  lobby = joinLobby(lobby, 'alice', ' Alice ');
  lobby = joinLobby(lobby, 'bob', 'Bob');
  lobby = claimLobbySuspect(lobby, 'alice', 'Miss Scarlett');
  lobby = claimLobbySuspect(lobby, 'bob', 'Professor Plum');
  return lobby;
}

describe('lobby helpers', () => {
  it('normalizes names and rejects invalid lifecycle payloads without mutation', () => {
    const lobby = createLobby();
    expect(joinLobby(lobby, 'alice', ' Alice ')).toEqual({
      hostUserId: 'alice',
      players: [{ userId: 'alice', name: 'Alice', suspect: null }],
    });
    expect(() => joinLobby(lobby, 'alice', '   ')).toThrow('1-32');
    expect(() => joinLobby(lobby, 'alice', 'x'.repeat(33))).toThrow('1-32');
    expect(lobby).toEqual({ hostUserId: null, players: [] });
    expect(() => claimLobbySuspect(lobby, 'nobody', 'Miss Scarlett')).toThrow('not in the lobby');
    expect(() => claimLobbySuspect(lobby, 'nobody', 'not a suspect')).toThrow('invalid suspect');
  });

  it('rejects duplicate users and a seventh participant', () => {
    let lobby = createLobby();
    for (let index = 0; index < 6; index += 1) {
      lobby = joinLobby(lobby, `user-${index}`, `User ${index}`);
    }
    expect(() => joinLobby(lobby, 'user-0', 'Another name')).toThrow('already');
    expect(() => joinLobby(lobby, 'user-6', 'User 6')).toThrow('full');
    expect(lobby.players).toHaveLength(6);
  });

  it('allows changing a claim and rejects another player claim', () => {
    const lobby = lobbyWithPlayers();
    expect(() => claimLobbySuspect(lobby, 'alice', 'Professor Plum')).toThrow('already claimed');
    const changed = claimLobbySuspect(lobby, 'alice', 'Mrs. Peacock');
    expect(changed.players.map(player => player.suspect)).toEqual(['Mrs. Peacock', 'Professor Plum']);
  });

  it('requires a complete unique order of claimed suspects and leaves unclaimed users last', () => {
    let lobby = lobbyWithPlayers();
    lobby = joinLobby(lobby, 'carol', 'Carol');
    expect(() => setLobbyOrder(lobby, 'bob', ['Professor Plum', 'Miss Scarlett'])).toThrow('only the host');
    expect(() => setLobbyOrder(lobby, 'alice', ['Miss Scarlett'])).toThrow('complete');
    expect(() => setLobbyOrder(lobby, 'alice', ['Miss Scarlett', 'Miss Scarlett'])).toThrow('duplicate');
    expect(() => setLobbyOrder(lobby, 'alice', ['Miss Scarlett', 'Mrs. White'])).toThrow('unknown');
    const ordered = setLobbyOrder(lobby, 'alice', ['Professor Plum', 'Miss Scarlett']);
    expect(ordered.players.map(player => player.userId)).toEqual(['bob', 'alice', 'carol']);
    expect(ordered.hostUserId).toBe('alice');
    expect(lobbyView(ordered, 'game-1').players.map(player => player.isHost)).toEqual([false, true, false]);
    expect(lobby.players.map(player => player.userId)).toEqual(['alice', 'bob', 'carol']);
  });

  it('hydrates only strict JSON-safe lobby state', () => {
    const persisted = serializeLobby(lobbyWithPlayers());
    expect(hydrateLobby(JSON.parse(JSON.stringify(persisted)))).toEqual(persisted);
    expect(() => hydrateLobby({ ...persisted, extra: true })).toThrow('unexpected or missing');
    expect(() => hydrateLobby({ ...persisted, players: [{ ...persisted.players[0], suspect: 'bad' }] }))
      .toThrow('invalid suspect');
    expect(() => hydrateLobby({ players: [...persisted.players, persisted.players[0]] })).toThrow('duplicate lobby user');
    expect(hydrateLobby({ players: persisted.players })).toEqual(persisted);
    expect(() => hydrateLobby({ players: persisted.players, extra: true })).toThrow('unexpected or missing');
    expect(() => hydrateLobby({ ...persisted, hostUserId: 'missing' })).toThrow('not in the lobby');
  });

  it('reassigns the host after leave and exposes only redacted lobby data', () => {
    const lobby = lobbyWithPlayers();
    const remaining = leaveLobby(lobby, 'alice');
    expect(remaining.players.map(player => player.userId)).toEqual(['bob']);
    expect(remaining.hostUserId).toBe('bob');
    expect(lobbyView(remaining, 'game-1')).toEqual({
      type: 'lobby',
      gameId: 'game-1',
      hostUserId: 'bob',
      players: [{ name: 'Bob', suspect: 'Professor Plum', isHost: true }],
    });
    expect(leaveLobby(remaining, 'bob')).toEqual({ hostUserId: null, players: [] });
  });

  it('creates six canonical players with claimed humans followed by robots', () => {
    const lobby = lobbyWithPlayers();
    const players = createStartPlayers(lobby);
    expect(players).toHaveLength(6);
    expect(players.slice(0, 2).map(player => ({
      name: player.name,
      suspect: player.suspect,
      userId: player.userId,
      isRobot: player.isRobot,
    }))).toEqual([
      { name: 'Alice', suspect: 'Miss Scarlett', userId: 'alice', isRobot: false },
      { name: 'Bob', suspect: 'Professor Plum', userId: 'bob', isRobot: false },
    ]);
    expect(players.slice(2).every(player => player.isRobot && player.userId === undefined)).toBe(true);
    const game = createGame(players);
    expect(() => game.players.forEach(player => {
      if (!player.isRobot) expect(player.userId).toBeDefined();
    })).not.toThrow();
  });
});
