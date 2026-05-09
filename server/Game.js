// AC/DC game.
//
// Two players. Each turn one attacks, one defends. Both privately
// pick 1–3 within 15s; reveal is simultaneous. Match → defender blocks,
// turn ends, roles swap. Mismatch → attacker scores their pick, same
// turn continues with another pick round. Standard length is 10 attack
// turns (5 per player). A 30-point lead ends the game immediately.
// Ties at the end of regulation enter sudden death — alternating turns
// continue until somebody leads at the end of a turn.

const PICK_DURATION_MS = 15000;
// 3-second pause on every reveal so players can read the result
// (and the role-swap announce, on a block) before the next round.
const REVEAL_BLOCK_MS = 3000;
const REVEAL_SCORE_MS = 3000;
const REVEAL_FINAL_MS = 3000;
const GAME_LENGTH_TURNS = 10;
const INSTANT_WIN_LEAD = 30;
const PICK_MIN = 1;
const PICK_MAX = 3;
const ATTACKER_DEFAULT_PICK = 1;
const DEFENDER_DEFAULT_PICK = 3;

class Game {
  constructor(players, broadcast) {
    this.players = players; // Map<id, Player>
    this.broadcast = broadcast;

    const ids = Array.from(players.keys());
    this.playerAId = ids[0];
    this.playerBId = ids[1];

    this.scores = { [this.playerAId]: 0, [this.playerBId]: 0 };
    this.turnNumber = 1;
    // Player A always attacks first. Roles swap on each block.
    this.attackerId = this.playerAId;
    this.defenderId = this.playerBId;

    this.picks = { [this.playerAId]: null, [this.playerBId]: null };
    this.status = 'pick'; // pick | reveal | finished
    this.pickDeadline = 0;
    this.lastReveal = null;

    this.winnerId = null;
    this.endReason = null;

    this.pickTimeout = null;
    this.continueTimeout = null;
  }

  start() {
    this.beginPickRound();
  }

  // ── pick round lifecycle ─────────────────────────────────────────

  beginPickRound() {
    this.status = 'pick';
    this.picks[this.playerAId] = null;
    this.picks[this.playerBId] = null;
    this.pickDeadline = Date.now() + PICK_DURATION_MS;

    this.clearPickTimeout();
    this.pickTimeout = setTimeout(() => this.resolveTimeout(), PICK_DURATION_MS);

    this.broadcastView({ type: 'pick_started' });
  }

  handleAction(playerId, action) {
    if (!action || typeof action !== 'object') {
      return { success: false, error: 'Bad action' };
    }
    if (action.type === 'submit_pick') {
      return this.submitPick(playerId, action.value);
    }
    return { success: false, error: 'Unknown action' };
  }

  submitPick(playerId, value) {
    if (this.status !== 'pick') return { success: false, error: 'Not in pick phase' };
    if (playerId !== this.attackerId && playerId !== this.defenderId) {
      return { success: false, error: 'Not your turn' };
    }
    if (!Number.isInteger(value) || value < PICK_MIN || value > PICK_MAX) {
      return { success: false, error: `Pick must be ${PICK_MIN}–${PICK_MAX}` };
    }
    if (this.picks[playerId] != null) {
      return { success: false, error: 'Already picked' };
    }

    this.picks[playerId] = value;
    this.broadcastView({ type: 'pick_submitted', playerId });

    if (this.picks[this.attackerId] != null && this.picks[this.defenderId] != null) {
      this.resolve();
    }
    return { success: true };
  }

  resolveTimeout() {
    if (this.status !== 'pick') return;
    if (this.picks[this.attackerId] == null) this.picks[this.attackerId] = ATTACKER_DEFAULT_PICK;
    if (this.picks[this.defenderId] == null) this.picks[this.defenderId] = DEFENDER_DEFAULT_PICK;
    this.resolve();
  }

  // ── resolve picks → reveal → continuation or end ─────────────────

  resolve() {
    this.clearPickTimeout();

    const aPick = this.picks[this.attackerId];
    const dPick = this.picks[this.defenderId];
    const blocked = aPick === dPick;
    const points = blocked ? 0 : aPick;

    if (!blocked) {
      this.scores[this.attackerId] += points;
    }

    this.lastReveal = {
      turnNumber: this.turnNumber,
      attackerId: this.attackerId,
      defenderId: this.defenderId,
      attackerPick: aPick,
      defenderPick: dPick,
      blocked,
      pointsAwarded: points,
    };

    this.status = 'reveal';
    this.broadcastView({ type: 'reveal' });

    // Instant-win on a 30-point lead trumps everything else.
    const aScore = this.scores[this.playerAId];
    const bScore = this.scores[this.playerBId];
    if (Math.abs(aScore - bScore) >= INSTANT_WIN_LEAD) {
      const winner = aScore > bScore ? this.playerAId : this.playerBId;
      this.scheduleEnd(winner, 'lead');
      return;
    }

    if (blocked) {
      // Turn just ended. Decide whether to swap+continue or end the game.
      const completedTurn = this.turnNumber;
      if (completedTurn >= GAME_LENGTH_TURNS && aScore !== bScore) {
        const winner = aScore > bScore ? this.playerAId : this.playerBId;
        this.scheduleEnd(winner, completedTurn === GAME_LENGTH_TURNS ? 'turns_complete' : 'sudden_death');
        return;
      }
      // Continue (regulation or sudden-death tie) — swap and start the next turn.
      this.continueTimeout = setTimeout(() => {
        if (this.status !== 'reveal') return;
        this.turnNumber += 1;
        const prevAttacker = this.attackerId;
        this.attackerId = this.defenderId;
        this.defenderId = prevAttacker;
        this.beginPickRound();
      }, REVEAL_BLOCK_MS);
    } else {
      // Same attack turn keeps going — same roles, fresh pick round.
      this.continueTimeout = setTimeout(() => {
        if (this.status !== 'reveal') return;
        this.beginPickRound();
      }, REVEAL_SCORE_MS);
    }
  }

  scheduleEnd(winnerId, reason) {
    this.continueTimeout = setTimeout(() => {
      if (this.status === 'finished') return;
      this.endGame(winnerId, reason);
    }, REVEAL_FINAL_MS);
  }

  endGame(winnerId, reason) {
    this.clearAllTimeouts();
    this.status = 'finished';
    this.winnerId = winnerId;
    this.endReason = reason;
    this.broadcastView({ type: 'game_over' });
  }

  // ── per-viewer state ─────────────────────────────────────────────

  // The opponent's in-progress pick is private during the pick phase;
  // each viewer sees their own value plus a boolean "opponent has
  // submitted". On reveal/finished, both picks are public via lastReveal.
  viewFor(viewerId) {
    const myPick = this.picks[viewerId];
    const opponentId = viewerId === this.playerAId ? this.playerBId : this.playerAId;
    const opponentSubmitted = this.picks[opponentId] != null;
    return {
      gameStatus: this.status,
      turnNumber: this.turnNumber,
      attackerId: this.attackerId,
      defenderId: this.defenderId,
      scores: { ...this.scores },
      pickDeadline: this.status === 'pick' ? this.pickDeadline : 0,
      myPick: myPick == null ? null : myPick,
      opponentSubmitted,
      lastReveal: this.lastReveal,
      winnerId: this.winnerId,
      endReason: this.endReason,
      gameLengthTurns: GAME_LENGTH_TURNS,
      instantWinLead: INSTANT_WIN_LEAD,
      pickMin: PICK_MIN,
      pickMax: PICK_MAX,
    };
  }

  // Generic view for a non-player observer (only used as a fallback —
  // AC/DC is locked to the two seated players, no spectators).
  getFullState() {
    return {
      gameStatus: this.status,
      turnNumber: this.turnNumber,
      attackerId: this.attackerId,
      defenderId: this.defenderId,
      scores: { ...this.scores },
      pickDeadline: this.status === 'pick' ? this.pickDeadline : 0,
      lastReveal: this.lastReveal,
      winnerId: this.winnerId,
      endReason: this.endReason,
      gameLengthTurns: GAME_LENGTH_TURNS,
      instantWinLead: INSTANT_WIN_LEAD,
      pickMin: PICK_MIN,
      pickMax: PICK_MAX,
    };
  }

  broadcastView(extra) {
    // Send a tailored snapshot to each player so picks stay private.
    for (const [id, player] of this.players) {
      if (!player.connected || !player.ws || player.ws.readyState !== 1) continue;
      const payload = { ...extra, ...this.viewFor(id) };
      player.ws.send(JSON.stringify(payload));
    }
  }

  clearPickTimeout() {
    if (this.pickTimeout) {
      clearTimeout(this.pickTimeout);
      this.pickTimeout = null;
    }
  }

  clearAllTimeouts() {
    this.clearPickTimeout();
    if (this.continueTimeout) {
      clearTimeout(this.continueTimeout);
      this.continueTimeout = null;
    }
  }

  destroy() {
    this.clearAllTimeouts();
  }
}

module.exports = Game;
