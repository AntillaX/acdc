(function () {
  'use strict';

  // ── Constants / DOM refs ────────────────────────────────────────
  const PICK_DURATION_MS = 15000;
  const SESSION_KEY = 'acdc.session.v1';

  const $ = (id) => document.getElementById(id);

  const screens = {
    landing:  $('landing-screen'),
    lobby:    $('lobby-screen'),
    game:     $('game-screen'),
    gameover: $('gameover-screen'),
  };

  // ── State (single source of truth) ──────────────────────────────
  const state = {
    screen: 'landing',
    ws: null,
    connected: false,

    roomCode: null,
    playerId: null,
    playerName: '',
    hostId: null,
    roomState: 'lobby',
    players: [],

    gameStatus: null,
    turnNumber: 1,
    attackerId: null,
    defenderId: null,
    scores: {},
    pickDeadline: 0,
    myPick: null,
    opponentSubmitted: false,
    lastReveal: null,

    winnerId: null,
    endReason: null,
    gameLengthTurns: 10,
    instantWinLead: 30,
  };

  let timerInterval = null;
  let lastScoreSnapshot = null; // for score-pulse animation

  // ── WebSocket plumbing ──────────────────────────────────────────
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Behind nginx the page is mounted at /acdc/ so the WS shares the
    // same prefix; locally it's just /. location.pathname captures both.
    const wsPath = location.pathname.replace(/[^/]*$/, '');
    state.ws = new WebSocket(`${proto}//${location.host}${wsPath}`);

    state.ws.addEventListener('open', () => {
      state.connected = true;
      const saved = loadSession();
      if (saved && saved.roomCode && saved.playerId) {
        send({ type: 'reconnect', roomCode: saved.roomCode, playerId: saved.playerId });
      }
    });

    state.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleServerMessage(msg);
    });

    state.ws.addEventListener('close', () => {
      state.connected = false;
      // Best-effort reconnect; sessionStorage keeps the roomCode/playerId
      // so we can rejoin on the next open.
      setTimeout(connect, 1500);
    });

    state.ws.addEventListener('error', () => { /* close handler retries */ });
  }

  function send(msg) {
    if (!state.ws || state.ws.readyState !== 1) return;
    state.ws.send(JSON.stringify(msg));
  }

  function saveSession() {
    if (!state.roomCode || !state.playerId) return;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      roomCode: state.roomCode,
      playerId: state.playerId,
      playerName: state.playerName,
    }));
  }
  function loadSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function clearSession() {
    sessionStorage.removeItem(SESSION_KEY);
  }

  // ── Message handlers ────────────────────────────────────────────
  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'error':
        showError(msg.message || 'Something went wrong');
        // If the saved session is invalid (stale room), drop it so the
        // landing screen renders cleanly.
        if (/not found|already in progress|full/i.test(msg.message || '')) {
          clearSession();
          state.roomCode = null;
          state.playerId = null;
          gotoScreen('landing');
        }
        return;

      case 'room_created':
      case 'room_joined':
      case 'reconnected':
        applyServerState(msg);
        if (msg.playerId) state.playerId = msg.playerId;
        if (msg.roomCode) state.roomCode = msg.roomCode;
        saveSession();
        routeAfterStateUpdate();
        return;

      case 'player_joined':
      case 'player_left':
      case 'player_reconnected':
      case 'player_disconnected':
      case 'lobby_reset':
        applyServerState(msg);
        routeAfterStateUpdate();
        return;

      case 'round_abandoned':
        applyServerState(msg);
        toast(`${msg.leftName || 'Opponent'} left — back to lobby`);
        routeAfterStateUpdate();
        return;

      case 'game_started':
        applyServerState(msg);
        gotoScreen('game');
        return;

      case 'pick_started':
      case 'pick_submitted':
      case 'reveal':
        applyServerState(msg);
        // gotoScreen renders only when actually switching screens; if
        // we're already on `game` it short-circuits without calling
        // render(). Without an explicit render here, a `reveal` message
        // would update state but leave the DOM stuck in pick-mode.
        if (state.screen !== 'game') gotoScreen('game');
        else render();
        return;

      case 'game_over':
        applyServerState(msg);
        gotoScreen('gameover');
        return;

      case 'left_room':
        clearSession();
        state.roomCode = null;
        state.playerId = null;
        gotoScreen('landing');
        return;

      default:
        // Unrecognised — ignore.
        return;
    }
  }

  // Merge server snapshot into local state. Server payloads include
  // both room-shape and game-shape fields; both are flat-merged here.
  function applyServerState(msg) {
    const fields = [
      'roomCode', 'hostId', 'roomState', 'players',
      'gameStatus', 'turnNumber', 'attackerId', 'defenderId',
      'scores', 'pickDeadline', 'myPick', 'opponentSubmitted',
      'lastReveal', 'winnerId', 'endReason',
      'gameLengthTurns', 'instantWinLead',
    ];
    for (const k of fields) {
      if (msg[k] !== undefined) state[k] = msg[k];
    }
  }

  function routeAfterStateUpdate() {
    if (state.roomState === 'lobby') {
      gotoScreen('lobby');
    } else if (state.roomState === 'playing') {
      if (state.gameStatus === 'finished') gotoScreen('gameover');
      else gotoScreen('game');
    } else if (state.roomState === 'finished') {
      gotoScreen('gameover');
    }
  }

  // ── Screen routing ──────────────────────────────────────────────
  function gotoScreen(name) {
    if (!screens[name]) return;
    if (state.screen === name) {
      render();
      return;
    }
    state.screen = name;
    Object.entries(screens).forEach(([k, el]) => {
      el.classList.toggle('active', k === name);
    });
    render();
  }

  function render() {
    if (state.screen === 'landing') renderLanding();
    if (state.screen === 'lobby') renderLobby();
    if (state.screen === 'game') renderGame();
    if (state.screen === 'gameover') renderGameOver();
  }

  // ── Landing ─────────────────────────────────────────────────────
  function renderLanding() {
    const nameInput = $('player-name');
    if (nameInput && state.playerName && nameInput.value === '') {
      nameInput.value = state.playerName;
    }
  }

  function showError(msg) {
    const el = $('landing-error');
    if (state.screen === 'landing' && el) {
      el.textContent = msg;
      setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 4000);
    } else {
      toast(msg);
    }
  }

  // ── Lobby ───────────────────────────────────────────────────────
  function renderLobby() {
    const codeBtn = $('room-code-display');
    codeBtn.textContent = state.roomCode || '----';

    const me = state.players.find((p) => p.id === state.playerId);
    const opp = state.players.find((p) => p.id !== state.playerId);

    const list = $('lobby-players');
    list.innerHTML = '';
    state.players.forEach((p) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.name + (p.id === state.playerId ? '' : '');
      li.appendChild(name);

      const tags = document.createElement('span');
      tags.style.display = 'flex';
      tags.style.gap = '0.4rem';

      if (p.id === state.hostId) {
        const t = document.createElement('span');
        t.className = 'tag tag-host';
        t.textContent = 'Host';
        tags.appendChild(t);
      }
      if (p.id === state.playerId) {
        const t = document.createElement('span');
        t.className = 'tag tag-you';
        t.textContent = 'You';
        tags.appendChild(t);
      }
      li.appendChild(tags);
      list.appendChild(li);
    });

    const hint = $('lobby-hint');
    if (!opp) {
      hint.textContent = 'Waiting for an opponent…';
    } else {
      hint.textContent = state.hostId === state.playerId
        ? 'Both players in. Tap Start when ready.'
        : 'Waiting on host to start…';
    }

    const startBtn = $('start-btn');
    const isHost = state.hostId === state.playerId;
    const canStart = isHost && state.players.length === 2;
    startBtn.disabled = !canStart;
    startBtn.style.display = isHost ? '' : 'none';
  }

  // ── Game ────────────────────────────────────────────────────────
  function renderGame() {
    const me = state.players.find((p) => p.id === state.playerId);
    const opp = state.players.find((p) => p.id !== state.playerId);
    if (!me || !opp) return;

    const isMeAttacker = state.attackerId === state.playerId;

    // Scoreboard
    $('score-name-me').textContent = me.name;
    $('score-name-opp').textContent = opp.name;
    const myScore = state.scores[state.playerId] || 0;
    const oppScore = state.scores[opp.id] || 0;
    $('score-value-me').textContent = String(myScore);
    $('score-value-opp').textContent = String(oppScore);

    const meCard = $('score-card-me');
    const oppCard = $('score-card-opp');
    meCard.classList.toggle('attacking', isMeAttacker);
    meCard.classList.toggle('defending', !isMeAttacker);
    oppCard.classList.toggle('attacking', !isMeAttacker);
    oppCard.classList.toggle('defending', isMeAttacker);

    const meRole = $('score-role-me');
    const oppRole = $('score-role-opp');
    meRole.textContent = isMeAttacker ? 'Attack' : 'Defend';
    oppRole.textContent = isMeAttacker ? 'Defend' : 'Attack';
    meRole.className = 'score-role ' + (isMeAttacker ? 'attack' : 'defend');
    oppRole.className = 'score-role ' + (isMeAttacker ? 'defend' : 'attack');

    // Score pulse — only on changes (and only on the side that scored).
    if (lastScoreSnapshot) {
      if (myScore > (lastScoreSnapshot[state.playerId] || 0)) pulseCard(meCard);
      if (oppScore > (lastScoreSnapshot[opp.id] || 0)) pulseCard(oppCard);
    }
    lastScoreSnapshot = { [state.playerId]: myScore, [opp.id]: oppScore };

    // Turn label
    $('turn-number').textContent = String(state.turnNumber);
    if (state.turnNumber > state.gameLengthTurns) {
      $('turn-suffix').textContent = 'sudden death';
    } else {
      $('turn-suffix').textContent = `of ${state.gameLengthTurns}`;
    }

    // Phase — pick area always rendered in the page; the reveal is a
    // full-screen overlay that sits above it during the 3s pause.
    const pickArea = $('pick-area');
    const overlay = $('reveal-overlay');
    if (state.gameStatus === 'reveal') {
      pickArea.hidden = true;
      overlay.hidden = false;
      renderRevealUI(me, opp, isMeAttacker);
      stopTimer();
    } else {
      pickArea.hidden = false;
      overlay.hidden = true;
      renderPickUI(isMeAttacker);
      startTimer();
    }
  }

  function renderPickUI(isMeAttacker) {
    const headline = $('pick-headline');
    const sub = $('pick-sub');
    headline.classList.remove('attack', 'defend');
    if (isMeAttacker) {
      headline.textContent = 'You are attacking';
      headline.classList.add('attack');
      sub.textContent = 'Pick 1–3. Score = your number, unless they match.';
    } else {
      headline.textContent = 'You are defending';
      headline.classList.add('defend');
      sub.textContent = 'Pick 1–3. Match their number to block the attack.';
    }

    const buttons = document.querySelectorAll('.pick-btn');
    const locked = state.myPick != null;
    buttons.forEach((btn) => {
      const v = Number(btn.dataset.value);
      btn.classList.toggle('selected', state.myPick === v);
      btn.disabled = locked;
    });

    // Fresh round → strip any lingering :focus from a previously-tapped
    // pick button. On mobile, focus-visible style is gold-bordered like
    // the selected style and reads as "still highlighted".
    if (!locked && document.activeElement && document.activeElement.matches('.pick-btn')) {
      document.activeElement.blur();
    }

    const status = $('pick-status');
    if (locked) {
      status.classList.add('locked');
      status.textContent = state.opponentSubmitted
        ? 'Both locked in — revealing…'
        : `Locked in: ${state.myPick} · waiting on opponent`;
    } else {
      status.classList.remove('locked');
      status.textContent = state.opponentSubmitted
        ? 'Opponent locked in — your move'
        : '';
    }
  }

  function renderRevealUI(me, opp, isMeAttacker) {
    const r = state.lastReveal;
    if (!r) return;

    // Turn header — "Turn 3" or "Sudden death turn 12".
    const turnText = $('reveal-turn-text');
    if (r.turnNumber > state.gameLengthTurns) {
      turnText.textContent = `Sudden death · turn ${r.turnNumber}`;
    } else {
      turnText.textContent = `Turn ${r.turnNumber} of ${state.gameLengthTurns}`;
    }

    $('reveal-name-me').textContent = me.name;
    $('reveal-name-opp').textContent = opp.name;
    const meRole = isMeAttacker ? 'Attack' : 'Defend';
    const oppRole = isMeAttacker ? 'Defend' : 'Attack';
    $('reveal-role-me').textContent = meRole;
    $('reveal-role-opp').textContent = oppRole;
    $('reveal-role-me').className = 'reveal-card-role ' + (isMeAttacker ? 'attack' : 'defend');
    $('reveal-role-opp').className = 'reveal-card-role ' + (isMeAttacker ? 'defend' : 'attack');

    $('reveal-card-me').className = 'reveal-card ' + (isMeAttacker ? 'attack' : 'defend');
    $('reveal-card-opp').className = 'reveal-card ' + (isMeAttacker ? 'defend' : 'attack');

    const myPickValue = isMeAttacker ? r.attackerPick : r.defenderPick;
    const oppPickValue = isMeAttacker ? r.defenderPick : r.attackerPick;
    $('reveal-value-me').textContent = String(myPickValue);
    $('reveal-value-opp').textContent = String(oppPickValue);

    const result = $('reveal-result');
    if (r.blocked) {
      result.className = 'reveal-result blocked';
      result.textContent = 'BLOCKED';
    } else {
      result.className = 'reveal-result scored';
      const attackerPlayer = state.players.find((p) => p.id === r.attackerId);
      const attackerName = attackerPlayer ? attackerPlayer.name : 'Attacker';
      result.textContent = `+${r.pointsAwarded} to ${attackerName}`;
    }

    // On a block, roles swap for the next turn (unless the game is
    // ending — but in that case the gameover screen takes over before
    // this overlay can mislead anyone). Tell the player what's coming.
    const swap = $('reveal-swap');
    if (r.blocked) {
      // I was the attacker this turn → I defend next, and vice versa.
      const willAttackNext = !isMeAttacker;
      swap.textContent = willAttackNext ? 'Your turn to attack' : 'Your turn to defend';
      swap.className = 'reveal-swap ' + (willAttackNext ? 'attack' : 'defend');
      swap.hidden = false;
    } else {
      swap.hidden = true;
    }
  }

  function pulseCard(el) {
    el.classList.remove('scored');
    void el.offsetWidth; // restart animation
    el.classList.add('scored');
    setTimeout(() => el.classList.remove('scored'), 700);
  }

  // Timer interpolation against server-supplied pickDeadline.
  function startTimer() {
    stopTimer();
    timerInterval = setInterval(updateTimer, 100);
    updateTimer();
  }
  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }
  function updateTimer() {
    const fill = $('timer-fill');
    const value = $('timer-value');
    if (!fill || !value) return;
    if (!state.pickDeadline) {
      fill.style.width = '100%';
      fill.classList.remove('warn');
      value.textContent = '15';
      return;
    }
    const remaining = Math.max(0, state.pickDeadline - Date.now());
    const pct = Math.max(0, Math.min(1, remaining / PICK_DURATION_MS));
    fill.style.width = (pct * 100).toFixed(1) + '%';
    fill.classList.toggle('warn', remaining < 4000);
    value.textContent = Math.ceil(remaining / 1000).toString();
    if (remaining <= 0) stopTimer();
  }

  // ── Game over ───────────────────────────────────────────────────
  function renderGameOver() {
    const me = state.players.find((p) => p.id === state.playerId);
    const opp = state.players.find((p) => p.id !== state.playerId);
    if (!me || !opp) return;
    const myScore = state.scores[state.playerId] || 0;
    const oppScore = state.scores[opp.id] || 0;
    const won = state.winnerId === state.playerId;

    const headline = $('over-headline');
    headline.textContent = won ? 'You win' : 'You lose';
    headline.className = 'over-headline ' + (won ? 'win' : 'loss');

    const reason = $('over-reason');
    if (state.endReason === 'lead') {
      reason.textContent = `${state.instantWinLead}-point lead`;
    } else if (state.endReason === 'turns_complete') {
      reason.textContent = `After ${state.gameLengthTurns} turns`;
    } else if (state.endReason === 'sudden_death') {
      reason.textContent = 'Sudden death';
    } else {
      reason.textContent = '';
    }

    $('final-name-me').textContent = me.name;
    $('final-name-opp').textContent = opp.name;
    $('final-value-me').textContent = String(myScore);
    $('final-value-opp').textContent = String(oppScore);

    const meRow = $('final-row-me');
    const oppRow = $('final-row-opp');
    meRow.classList.toggle('winner', won);
    oppRow.classList.toggle('winner', !won);

    const playAgainBtn = $('play-again-btn');
    const isHost = state.hostId === state.playerId;
    playAgainBtn.style.display = isHost ? '' : 'none';
  }

  // ── Toast ───────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  // ── Event wiring ────────────────────────────────────────────────
  function getName() {
    const v = ($('player-name').value || '').trim().slice(0, 16);
    return v;
  }

  $('create-btn').addEventListener('click', () => {
    const name = getName();
    if (!name) { showError('Enter a name first'); return; }
    state.playerName = name;
    saveSession();
    send({ type: 'create_room', playerName: name });
    track('acdc_create_attempt');
  });

  $('join-btn').addEventListener('click', () => {
    const name = getName();
    if (!name) { showError('Enter a name first'); return; }
    const code = ($('room-code-input').value || '').toUpperCase().trim();
    if (code.length !== 4) { showError('Enter the 4-letter code'); return; }
    state.playerName = name;
    saveSession();
    send({ type: 'join_room', playerName: name, roomCode: code });
    track('acdc_join_attempt');
  });

  $('room-code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('join-btn').click(); }
  });
  $('player-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const code = ($('room-code-input').value || '').trim();
      if (code.length === 4) $('join-btn').click(); else $('create-btn').click();
    }
  });

  $('room-code-display').addEventListener('click', async () => {
    if (!state.roomCode) return;
    try {
      await navigator.clipboard.writeText(state.roomCode);
    } catch { /* ignore — fallback below */ }
    const btn = $('room-code-display');
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1200);
  });

  $('start-btn').addEventListener('click', () => {
    send({ type: 'start_game' });
    track('acdc_start');
  });

  $('play-again-btn').addEventListener('click', () => {
    send({ type: 'play_again' });
    track('acdc_play_again');
  });

  document.querySelectorAll('.pick-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = Number(btn.dataset.value);
      if (!Number.isInteger(v) || state.gameStatus !== 'pick') return;
      if (state.myPick != null) return;
      // Drop focus right away so a sticky :focus-visible halo doesn't
      // bleed into the next round and look like a pre-selection.
      btn.blur();
      // Optimistic UI: server will broadcast pick_submitted shortly.
      state.myPick = v;
      renderGame();
      send({ type: 'game_action', action: { type: 'submit_pick', value: v } });
      track('acdc_pick', { value: v });
    });
  });

  function leaveAndGoHome() {
    send({ type: 'leave_room' });
    clearSession();
    state.roomCode = null;
    state.playerId = null;
    gotoScreen('landing');
  }
  $('lobby-leave-btn').addEventListener('click', leaveAndGoHome);
  $('game-leave-btn').addEventListener('click', leaveAndGoHome);
  $('over-leave-btn').addEventListener('click', leaveAndGoHome);

  // Rules modal — opened from the lobby and during a game. Closed via
  // the × button, the "Got it" CTA, the backdrop, or Escape.
  function openRules() {
    $('rules-modal').hidden = false;
    track('acdc_open_rules');
  }
  function closeRules() {
    $('rules-modal').hidden = true;
  }
  $('lobby-rules-btn').addEventListener('click', openRules);
  $('game-rules-btn').addEventListener('click', openRules);
  document.querySelectorAll('[data-modal-close]').forEach((el) => {
    el.addEventListener('click', closeRules);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('rules-modal').hidden) closeRules();
  });

  // GA tracking helper — no-op if gtag isn't loaded.
  function track(name, params) {
    if (typeof window.gtag === 'function') {
      window.gtag('event', name, params || {});
    }
  }

  // Boot
  connect();
  gotoScreen('landing');
})();
