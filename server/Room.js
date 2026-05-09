const Game = require('./Game');
const Player = require('./Player');

const MAX_PLAYERS = 2;
// Window we'll wait for a transient WS drop (refresh / network blip)
// to come back before abandoning the round. Browser refresh + WS
// reconnect typically happens in well under a second; 10s gives
// plenty of headroom for slower phones and flaky networks.
const DISCONNECT_GRACE_MS = 10000;

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map(); // ordered by insertion
    this.hostId = null;
    this.game = null;
    this.state = 'lobby'; // lobby | playing | finished
    // Per-player grace timers. Any time a player disconnects mid-game
    // we start one of these; if they reconnect before it fires, the
    // round continues unscathed.
    this.graceTimers = new Map();
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

  // Mid-game disconnect: hold the seat for `DISCONNECT_GRACE_MS` so
  // the player can refresh / reconnect without abandoning the round.
  // The Leave button (removeOccupant) bypasses this — that's a
  // deliberate exit, not a transient drop.
  handleDisconnect(playerId, immediate = false) {
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
      if (immediate) {
        this._endRoundDueToLeave(playerId, playerName);
      } else {
        this._startGraceTimer(playerId);
        this.broadcast({
          type: 'player_disconnected',
          playerId,
          playerName,
          graceMs: DISCONNECT_GRACE_MS,
          ...this.getState(),
        });
      }
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
    // Deliberate Leave — no grace, end the round immediately.
    this.handleDisconnect(playerId, true);
  }

  reconnect(playerId, ws) {
    const player = this.players.get(playerId);
    if (!player) return { success: false, error: 'Player not found in this room' };
    player.ws = ws;
    player.connected = true;
    // They came back inside the grace window — cancel the abandonment
    // timer and let the game keep going.
    this._clearGraceTimer(playerId);
    return { success: true };
  }

  _startGraceTimer(playerId) {
    this._clearGraceTimer(playerId);
    const t = setTimeout(() => {
      this.graceTimers.delete(playerId);
      this._onGraceExpired(playerId);
    }, DISCONNECT_GRACE_MS);
    this.graceTimers.set(playerId, t);
  }

  _clearGraceTimer(playerId) {
    const t = this.graceTimers.get(playerId);
    if (t) {
      clearTimeout(t);
      this.graceTimers.delete(playerId);
    }
  }

  _onGraceExpired(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    if (player.connected) return;            // already back, no-op
    if (this.state !== 'playing' || !this.game) return; // game already ended
    this._endRoundDueToLeave(playerId, player.name);
  }

  _endRoundDueToLeave(leftId, leftName) {
    if (this.game) {
      this.game.destroy();
      this.game = null;
    }
    // The round's ending no matter who else may have been mid-grace.
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
    this.state = 'lobby';
    this.players.delete(leftId);
    if (this.hostId === leftId) {
      const next = this.players.keys().next();
      this.hostId = next.done ? null : next.value;
    }
    this.broadcast({
      type: 'round_abandoned',
      leftId,
      leftName,
      ...this.getState(),
    });
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
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
    if (this.game) this.game.destroy();
  }
}

module.exports = Room;
