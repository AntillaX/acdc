const Game = require('./Game');
const Player = require('./Player');

const MAX_PLAYERS = 2;

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map(); // ordered by insertion
    this.hostId = null;
    this.game = null;
    this.state = 'lobby'; // lobby | playing | finished
  }

  addPlayer(playerId, name, ws) {
    if (this.state !== 'lobby') {
      return { success: false, error: 'Game already in progress' };
    }
    if (this.players.size >= MAX_PLAYERS) {
      return { success: false, error: 'Room is full' };
    }
    const player = new Player(playerId, name, ws);
    this.players.set(playerId, player);
    if (!this.hostId) this.hostId = playerId;
    return { success: true };
  }

  getPlayer(playerId) {
    return this.players.get(playerId);
  }

  hasPlayer(playerId) {
    return this.players.has(playerId);
  }

  isEmpty() {
    if (this.players.size === 0) return true;
    for (const [, p] of this.players) {
      if (p.connected) return false;
    }
    return true;
  }

  connectedCount() {
    let n = 0;
    for (const [, p] of this.players) if (p.connected) n++;
    return n;
  }

  // Mid-game disconnect ends the round and bounces everyone back to
  // lobby — matches Level 0's leave/disconnect behaviour. With only
  // two players there's nothing to "wait out" anyway.
  handleDisconnect(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    const playerName = player.name;
    player.connected = false;
    player.ws = null;

    if (this.state === 'lobby') {
      this.players.delete(playerId);
      if (this.hostId === playerId) {
        const next = this.players.keys().next();
        this.hostId = next.done ? null : next.value;
      }
      this.broadcast({
        type: 'player_left',
        playerId,
        playerName,
        ...this.getState(),
      });
      return;
    }

    if (this.state === 'playing' && this.game) {
      this.game.destroy();
      this.game = null;
      this.state = 'lobby';
      // Drop the disconnected player so the survivor isn't stuck with
      // a ghost slot — they'll need a fresh opponent for the next game.
      this.players.delete(playerId);
      if (this.hostId === playerId) {
        const next = this.players.keys().next();
        this.hostId = next.done ? null : next.value;
      }
      this.broadcast({
        type: 'round_abandoned',
        leftId: playerId,
        leftName: playerName,
        ...this.getState(),
      });
      return;
    }

    // finished — just notify and let the survivor go home.
    this.broadcast({
      type: 'player_left',
      playerId,
      playerName,
      ...this.getState(),
    });
  }

  removeOccupant(playerId) {
    this.handleDisconnect(playerId);
  }

  reconnect(playerId, ws) {
    const player = this.players.get(playerId);
    if (!player) return { success: false, error: 'Player not found in this room' };
    player.ws = ws;
    player.connected = true;
    return { success: true };
  }

  startGame() {
    if (this.state !== 'lobby') {
      return { success: false, error: 'Game already started' };
    }
    if (this.connectedCount() < 2) {
      return { success: false, error: 'Need 2 players to start' };
    }
    this.state = 'playing';
    this.game = new Game(this.players, this.broadcast.bind(this));
    this.broadcast({ type: 'game_started', ...this.getState() });
    this.game.start();
    return { success: true };
  }

  playAgain() {
    if (this.state === 'lobby') return { success: false, error: 'No game to replay' };
    if (this.game) {
      this.game.destroy();
      this.game = null;
    }
    this.state = 'lobby';
    this.broadcast({ type: 'lobby_reset', ...this.getState() });
    return this.startGame();
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const [, player] of this.players) {
      if (player.connected && player.ws && player.ws.readyState === 1) {
        player.ws.send(data);
      }
    }
  }

  broadcastExcept(excludeId, msg) {
    const data = JSON.stringify(msg);
    for (const [id, player] of this.players) {
      if (id === excludeId) continue;
      if (player.connected && player.ws && player.ws.readyState === 1) {
        player.ws.send(data);
      }
    }
  }

  getState() {
    return {
      roomCode: this.code,
      hostId: this.hostId,
      roomState: this.state,
      players: this.getPlayersArray(),
    };
  }

  getFullState(viewerId) {
    const state = this.getState();
    if (this.game) {
      Object.assign(state, this.game.viewFor(viewerId));
    }
    return state;
  }

  getPlayersArray() {
    const arr = [];
    for (const [, player] of this.players) arr.push(player.toJSON());
    return arr;
  }

  destroy() {
    if (this.game) this.game.destroy();
  }
}

module.exports = Room;
