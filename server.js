const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(path.join(__dirname, 'public')));

// ── GAME DATA ──
const SUITS = ['S', 'H', 'D', 'C'];
const SUIT_NAMES = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' };
const RANKS_LOW = ['A', '2', '3', '4', '5', '6'];
const RANKS_HIGH = ['8', '9', '10', 'J', 'Q', 'K'];

const SETS = [
  ...SUITS.map(s => ({
    id: `low_${s}`,
    name: `Low ${SUIT_NAMES[s]}`,
    cards: RANKS_LOW.map(r => r + s)
  })),
  ...SUITS.map(s => ({
    id: `high_${s}`,
    name: `High ${SUIT_NAMES[s]}`,
    cards: RANKS_HIGH.map(r => r + s)
  })),
  {
    id: 'sevens_jokers',
    name: '7s & Jokers',
    cards: ['7S', '7H', '7D', '7C', 'RJ', 'BJ']
  }
];

const SET_MAP = {};
SETS.forEach(s => s.cards.forEach(c => (SET_MAP[c] = s.id)));


// ── BOT SYSTEM ──

const BOT_NAMES = ['Nova','Zara','Rex','Luna','Ace','Blaze','Iris','Thor','Maya','Koda'];
const BOT_AVATARS = ['🤖','👾','🎭','🦾','⚡','🔮','🎯','🧿','💎','🌟'];
let botCounter = 0;

function createBot() {
  const idx = (botCounter++) % BOT_NAMES.length;
  return { id: 'bot_' + botCounter, name: BOT_NAMES[idx], avatar: BOT_AVATARS[idx], team: null, isBot: true };
}

// ── BOT KNOWLEDGE BASE ──
// For each room, each bot tracks a probability model of where every card is
// knowledge[card] = { [playerId]: probability 0-1 }  (sums to 1 across all players)
// confirmed[card] = playerId  (we know for sure)
// impossible[card] = Set of playerIds who definitely don't have it

class BotBrain {
  constructor(botId, roomPlayers) {
    this.botId = botId;
    this.confirmed = {};       // card -> playerId (certain)
    this.impossible = {};      // card -> Set<playerId>
    this.targetSetId = null;
    this.setAttempts = {};     // setId -> number of times tried
    // Track how often each human asked for each set (to detect their strategy)
    this.humanSetFocus = {};   // playerId -> { setId: count }
    // Initialize impossible sets
    SETS.forEach(s => s.cards.forEach(c => { this.impossible[c] = new Set(); }));
  }

  // Called whenever any ask happens (success or fail)
  observeAsk(fromId, toId, card, success, allPlayerIds) {
    if (success) {
      // fromId definitely has card now
      this.confirmed[card] = fromId;
      // toId no longer has it
      this.impossible[card] = this.impossible[card] || new Set();
      this.impossible[card].add(toId);
    } else {
      // toId definitely does NOT have card
      this.impossible[card] = this.impossible[card] || new Set();
      this.impossible[card].add(toId);
      // If everyone except one player is impossible, that player must have it
      const possible = allPlayerIds.filter(pid => !this.impossible[card].has(pid) && pid !== fromId);
      // fromId asked for it so they don't have it either
      this.impossible[card].add(fromId);
      const stillPossible = allPlayerIds.filter(pid => !this.impossible[card].has(pid));
      if (stillPossible.length === 1) {
        this.confirmed[card] = stillPossible[0];
      }
    }

    // Track human strategy patterns
    const setId = SET_MAP[card];
    if (fromId !== this.botId) {
      if (!this.humanSetFocus[fromId]) this.humanSetFocus[fromId] = {};
      this.humanSetFocus[fromId][setId] = (this.humanSetFocus[fromId][setId] || 0) + 1;
    }
  }

  // Returns confidence score for a set (0-1): how well located are all 6 cards
  setConfidence(setId, teamIds, opponentIds, hands) {
    const setInfo = SETS.find(s => s.id === setId);
    const wonCards = setInfo.cards.filter(c => {
      const holder = this.getCardHolder(c, [...teamIds, ...opponentIds], hands);
      return holder !== null;
    });
    return wonCards.length / 6;
  }

  // Best guess for where a card is. Returns playerId or null if unknown.
  getCardHolder(card, allPlayerIds, hands) {
    // Check actual hand first (bot can see its own hand)
    for (const pid of allPlayerIds) {
      if (hands[pid] && hands[pid].includes(card)) return pid;
    }
    // Check confirmed knowledge
    if (this.confirmed[card] && allPlayerIds.includes(this.confirmed[card])) {
      return this.confirmed[card];
    }
    return null;
  }

  // Returns { setId, card, targetOpponent } for best ask action
  // or { setId, assignment } for declare
  // or null if no good move
  decideTurn(botId, room) {
    const myHand = room.hands[botId] || [];
    const wonIds = Object.keys(room.sets || {});
    const myTeam = room.players[botId].team;
    const oppTeam = myTeam === 'A' ? 'B' : 'A';
    const allPids = room.playerOrder;
    const teamPids = allPids.filter(pid => room.players[pid]?.team === myTeam);
    const oppPids = allPids.filter(pid => room.players[pid]?.team === oppTeam);
    const activeOpps = oppPids.filter(pid => (room.hands[pid] || []).length > 0);

    if (myHand.length === 0 || activeOpps.length === 0) return null;

    const teamHands = teamPids.flatMap(pid => room.hands[pid] || []);

    // ── CHECK DECLARE FIRST ──
    for (const setInfo of SETS) {
      if (wonIds.includes(setInfo.id)) continue;
      const teamHasCards = setInfo.cards.filter(c => teamHands.includes(c));
      if (teamHasCards.length === 6) {
        // Build assignment
        const assignment = {};
        let ok = true;
        setInfo.cards.forEach(card => {
          const holder = teamPids.find(pid => (room.hands[pid] || []).includes(card));
          if (holder) assignment[card] = holder; else ok = false;
        });
        if (ok) return { type: 'declare', setId: setInfo.id, assignment };
      }
    }

    // ── PICK TARGET SET ──
    const mySets = [...new Set(myHand.map(c => SET_MAP[c]))].filter(s => !wonIds.includes(s));
    if (mySets.length === 0) return null;

    // Score each set I hold cards from:
    // base = how many cards team has in that set
    // bonus = confidence from knowledge base (confirmed locations)
    // threat = if opponents are chasing same set, we might want to race them
    // penalty = if we've tried this set many times without progress
    const setScores = mySets.map(sid => {
      const setInfo = SETS.find(s => s.id === sid);
      const teamCount = setInfo.cards.filter(c => teamHands.includes(c)).length;
      const missingCards = setInfo.cards.filter(c => !teamHands.includes(c));

      // How many missing cards do we have confirmed locations for?
      const locatedMissing = missingCards.filter(c => {
        const holder = this.getCardHolder(c, allPids, room.hands);
        return holder !== null && oppPids.includes(holder);
      }).length;

      // Is any human opponent chasing this set?
      const opponentThreat = oppPids.reduce((sum, pid) => {
        return sum + ((this.humanSetFocus[pid]?.[sid] || 0));
      }, 0);

      // Penalty for sets we keep failing on
      const attempts = this.setAttempts[sid] || 0;

      let score = teamCount * 10        // heavily weight how many we already have
                + locatedMissing * 8    // reward knowing where missing cards are
                + opponentThreat * 3    // slight boost if opponents are competing for it (race them)
                - attempts * 2;         // small penalty for repeated attempts

      return { sid, score, missingCards, teamCount };
    });

    setScores.sort((a, b) => b.score - a.score);

    // Pick from top candidates with some randomness (top 2, weighted)
    const candidates = setScores.slice(0, Math.min(2, setScores.length));
    let chosen;
    if (candidates.length === 1 || Math.random() < 0.75) {
      chosen = candidates[0]; // 75% pick best
    } else {
      chosen = candidates[1]; // 25% pick second best (unpredictability)
    }

    this.targetSetId = chosen.sid;
    this.setAttempts[chosen.sid] = (this.setAttempts[chosen.sid] || 0) + 1;

    // ── PICK CARD TO ASK FOR ──
    const missingFromTeam = chosen.missingCards;
    if (missingFromTeam.length === 0) return null;

    // Try to pick a card we have confirmed location for (smart ask)
    const confirmedMissing = missingFromTeam.filter(c => {
      const holder = this.getCardHolder(c, allPids, room.hands);
      return holder && oppPids.includes(holder) && (room.hands[holder] || []).length > 0;
    });

    let cardToAsk, targetOpp;

    if (confirmedMissing.length > 0) {
      // We know where some card is — pick randomly among confirmed (not in order!)
      cardToAsk = confirmedMissing[Math.floor(Math.random() * confirmedMissing.length)];
      targetOpp = this.getCardHolder(cardToAsk, allPids, room.hands);
    } else {
      // No confirmed location — pick a random missing card and random opponent
      const shuffled = shuffle([...missingFromTeam]);
      cardToAsk = shuffled[0];
      const shuffledOpps = shuffle([...activeOpps]);
      targetOpp = shuffledOpps[0];
    }

    if (!targetOpp || !(room.hands[targetOpp] || []).length) {
      // Fallback: random
      targetOpp = activeOpps[Math.floor(Math.random() * activeOpps.length)];
    }

    return { type: 'ask', card: cardToAsk, toId: targetOpp };
  }
}

// Store brains per room
const botBrains = {}; // roomCode -> { botId -> BotBrain }

function getRoomBrains(room) {
  if (!botBrains[room.code]) botBrains[room.code] = {};
  return botBrains[room.code];
}

function getBotBrain(room, botId) {
  const brains = getRoomBrains(room);
  if (!brains[botId]) {
    brains[botId] = new BotBrain(botId, room.playerOrder);
  }
  return brains[botId];
}

// Called after every ask so all bots update their knowledge
function notifyAllBots(room, fromId, toId, card, success) {
  const allPids = room.playerOrder;
  Object.keys(room.players).forEach(pid => {
    if (!room.players[pid].isBot) return;
    getBotBrain(room, pid).observeAsk(fromId, toId, card, success, allPids);
  });
}

function executeBotTurn(room) {
  const turnPid = room.playerOrder[room.turnIndex];
  if (!turnPid || !room.players[turnPid]?.isBot) return;
  if (room.phase !== 'playing') return;

  const delay = 1200 + Math.random() * 1800; // 1.2-3s feels human
  setTimeout(() => {
    if (room.phase !== 'playing') return;
    if (room.playerOrder[room.turnIndex] !== turnPid) return;

    const brain = getBotBrain(room, turnPid);
    const action = brain.decideTurn(turnPid, room);

    if (!action) {
      // No valid move — pass to next player with cards
      const next = room.playerOrder.find(p => p !== turnPid && (room.hands[p] || []).length > 0);
      if (next) { room.turnIndex = room.playerOrder.indexOf(next); broadcastRoom(room); executeBotTurn(room); }
      return;
    }

    if (action.type === 'ask') {
      const fromPlayer = room.players[turnPid];
      const toPlayer = room.players[action.toId];
      const toHand = room.hands[action.toId] || [];
      const fromHand = room.hands[turnPid] || [];
      const card = action.card;
      const cd = cardLabel(card);

      if (toHand.includes(card)) {
        room.hands[action.toId] = toHand.filter(c => c !== card);
        room.hands[turnPid] = [...fromHand, card];
        notifyAllBots(room, turnPid, action.toId, card, true);
        addLog(room, `<b>${fromPlayer.name}</b> asked <b>${toPlayer.name}</b> for <span class="lc">${cd}</span> — ✅ Got it! Turn continues.`);
        broadcastRoom(room);
        setTimeout(() => executeBotTurn(room), 1000 + Math.random() * 800);
      } else {
        notifyAllBots(room, turnPid, action.toId, card, false);
        addLog(room, `<b>${fromPlayer.name}</b> asked <b>${toPlayer.name}</b> for <span class="lc">${cd}</span> — ❌ Nope! Turn passes to <b>${toPlayer.name}</b>.`);
        room.turnIndex = room.playerOrder.indexOf(action.toId);
        broadcastRoom(room);
        executeBotTurn(room);
      }

    } else if (action.type === 'declare') {
      const setInfo = SETS.find(s => s.id === action.setId);
      const declarer = room.players[turnPid];
      const myTeam = declarer.team;

      // Bot knows exactly who has what — always correct
      setInfo.cards.forEach(card => {
        room.playerOrder.forEach(pid => {
          room.hands[pid] = (room.hands[pid] || []).filter(c => c !== card);
        });
      });
      room.sets[action.setId] = { wonBy: myTeam };
      addLog(room, `<b>${declarer.name}</b> declared <b>${setInfo.name}</b> — ✅ CORRECT! Team ${myTeam} wins the set.`);

      if (!checkGameOver(room)) {
        const tp = room.playerOrder[room.turnIndex];
        if ((room.hands[tp] || []).length === 0) {
          const next = room.playerOrder.find(p => (room.hands[p] || []).length > 0);
          if (next) room.turnIndex = room.playerOrder.indexOf(next);
        }
        broadcastRoom(room);
        setTimeout(() => executeBotTurn(room), 800);
      } else {
        broadcastRoom(room);
      }
    }
  }, delay);
}

// rooms: { [code]: Room }
const rooms = {};

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function dealCards(playerIds) {
  const deck = [];
  SUITS.forEach(s => {
    [...RANKS_LOW, ...RANKS_HIGH].forEach(r => deck.push(r + s));
    deck.push('7' + s);
  });
  deck.push('RJ', 'BJ');
  const shuffled = shuffle(deck);
  const hands = {};
  playerIds.forEach(id => (hands[id] = []));
  // Deal as evenly as possible, extras go to first players
  shuffled.forEach((card, i) => {
    const pid = playerIds[i % playerIds.length];
    hands[pid].push(card);
  });
  return hands;
}

function randCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createRoom(hostId, hostName) {
  let code;
  do { code = randCode(); } while (rooms[code]);
  rooms[code] = {
    code,
    hostId,
    phase: 'lobby', // lobby | playing | ended
    players: {
      [hostId]: { id: hostId, name: hostName, team: null }
    },
    playerOrder: [hostId],
    hands: {},
    turnIndex: 0,
    sets: {}, // { [setId]: { wonBy: 'A'|'B'|'none' } }
    log: []
  };
  return code;
}

function roomPublicState(room, forPlayerId) {
  // Send full hands only to each respective player
  const publicPlayers = {};
  Object.values(room.players).forEach(p => {
    publicPlayers[p.id] = {
      id: p.id,
      name: p.name,
      team: p.team,
      cardCount: (room.hands[p.id] || []).length
    };
  });

  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    players: publicPlayers,
    playerOrder: room.playerOrder,
    turnPlayerId: room.playerOrder[room.turnIndex] || null,
    sets: room.sets,
    log: room.log.slice(-50),
    myHand: room.hands[forPlayerId] || []
  };
}

function broadcastRoom(room) {
  Object.keys(room.players).forEach(pid => {
    const socket = io.sockets.sockets.get(pid);
    if (socket) socket.emit('room_update', roomPublicState(room, pid));
  });
}

function addLog(room, html) {
  room.log.push({ text: html, ts: Date.now() });
  if (room.log.length > 100) room.log = room.log.slice(-100);
}

function checkGameOver(room) {
  if (Object.keys(room.sets).length === 9) {
    room.phase = 'ended';
    let scoreA = 0, scoreB = 0;
    Object.values(room.sets).forEach(s => {
      if (s.wonBy === 'A') scoreA++;
      else if (s.wonBy === 'B') scoreB++;
    });
    const winner = scoreA > scoreB ? 'A' : scoreB > scoreA ? 'B' : 'Tie';
    addLog(room, `🏁 Game over! Team A: <b>${scoreA}</b> — Team B: <b>${scoreB}</b>. ${winner === 'Tie' ? "It's a tie!" : `Team <b>${winner}</b> wins!`}`);
    return true;
  }
  return false;
}

// ── SOCKET HANDLERS ──
io.on('connection', (socket) => {
  // pid = persistent player ID sent by client via 'register' event
  // This stays stable across reconnects unlike socket.id
  let pid = null;

  socket.on('register', (persistentId, callback) => {
    pid = persistentId;
    socketToPlayer[socket.id] = pid;
    playerToSocket[pid] = socket.id;
    // Ack so client knows registration is complete
    if (typeof callback === 'function') callback({ ok: true });
    // If player was already in a room, re-sync them instantly
    const room = Object.values(rooms).find(r => r.players[pid]);
    if (room) {
      if (room.players[pid]) room.players[pid].disconnected = false;
      socket.join(room.code);
      socket.emit('room_update', roomPublicState(room, pid));
    }
  });

  // Create room
  socket.on('create_room', ({ name, avatar }) => {
    if (!pid) return socket.emit('error_msg', 'Register first');
    if (!name?.trim()) return socket.emit('error_msg', 'Name required');
    const code = createRoom(pid, name.trim(), avatar || '🎴');
    socket.join(code);
    socket.emit('joined_room', { code, playerId: pid });
    broadcastRoom(rooms[code]);
  });

  // Join room
  socket.on('join_room', ({ name, code, avatar }) => {
    if (!pid) return socket.emit('error_msg', 'Register first');
    const room = rooms[code?.toUpperCase()];
    if (!room) return socket.emit('error_msg', 'Room not found');
    if (room.phase !== 'lobby') return socket.emit('error_msg', 'Game already started');
    if (Object.keys(room.players).length >= 6) return socket.emit('error_msg', 'Room is full (6 players max)');
    if (!name?.trim()) return socket.emit('error_msg', 'Name required');

    // If player already in room (reconnect scenario), just re-sync
    if (!room.players[pid]) {
      room.players[pid] = { id: pid, name: name.trim(), team: null, avatar: avatar || '🎴' };
      room.playerOrder.push(pid);
    }
    socket.join(code.toUpperCase());
    socket.emit('joined_room', { code: code.toUpperCase(), playerId: pid });
    broadcastRoom(room);
  });

  // Assign team (host only)
  socket.on('assign_team', ({ targetId, team }) => {
    const room = Object.values(rooms).find(r => r.players[pid] && r.hostId === pid);
    if (!room || room.phase !== 'lobby') return;
    if (!room.players[targetId]) return;
    room.players[targetId].team = team; // 'A', 'B', or null
    broadcastRoom(room);
  });

  // Start game (host only)
  socket.on('start_game', () => {
    const room = Object.values(rooms).find(r => r.hostId === pid);
    if (!room || room.phase !== 'lobby') return socket.emit('error_msg', 'Cannot start');
    const pids = room.playerOrder;
    const teamA = pids.filter(id => room.players[id].team === 'A');
    const teamB = pids.filter(id => room.players[id].team === 'B');
    const total = pids.length;
    if (total < 4 || total > 8 || total % 2 !== 0)
      return socket.emit('error_msg', 'Need 4, 6, or 8 players');
    if (teamA.length !== teamB.length)
      return socket.emit('error_msg', 'Teams must be equal size');
    if (teamA.length + teamB.length !== total)
      return socket.emit('error_msg', 'All players must be assigned to a team');

    room.hands = dealCards(pids);
    room.phase = 'playing';
    room.turnIndex = Math.floor(Math.random() * 6);
    const firstPlayer = room.players[pids[room.turnIndex]];
    addLog(room, `🃏 Game started! <b>${firstPlayer.name}</b> goes first.`);
    broadcastRoom(room);
    executeBotTurn(room);
  });

  // Ask for a card
  socket.on('ask_card', ({ toId, card }) => {
    const room = Object.values(rooms).find(r => r.players[pid]);
    if (!room || room.phase !== 'playing') return;
    const turnPid = room.playerOrder[room.turnIndex];
    if (turnPid !== pid) return socket.emit('error_msg', "It's not your turn");

    const fromPlayer = room.players[pid];
    const toPlayer = room.players[toId];
    if (!toPlayer) return socket.emit('error_msg', 'Player not found');
    if (toPlayer.team === fromPlayer.team) return socket.emit('error_msg', 'Can only ask opponents');

    // Must have a card from same set
    const setId = SET_MAP[card];
    const myHand = room.hands[pid] || [];
    const hasSetCard = myHand.some(c => SET_MAP[c] === setId && c !== card);
    if (!hasSetCard) return socket.emit('error_msg', 'You must hold a card from that set to ask');

    const toHand = room.hands[toId] || [];
    const cardName = cardLabel(card);

    if (toHand.includes(card)) {
      // Transfer card
      room.hands[toId] = toHand.filter(c => c !== card);
      room.hands[pid] = [...myHand, card];
      addLog(room, `<b>${fromPlayer.name}</b> asked <b>${toPlayer.name}</b> for <span class="log-card">${cardName}</span> — ✅ Got it! Turn continues.`);
      // Turn stays with asker
    } else {
      addLog(room, `<b>${fromPlayer.name}</b> asked <b>${toPlayer.name}</b> for <span class="log-card">${cardName}</span> — ❌ Nope! Turn passes to <b>${toPlayer.name}</b>.`);
      // Turn passes to the asked player
      const newIdx = room.playerOrder.indexOf(toId);
      room.turnIndex = newIdx;
    }
    broadcastRoom(room);
  });

  // Declare a set
  socket.on('declare_set', ({ setId, assignment }) => {
    // assignment: { [card]: playerId }
    const room = Object.values(rooms).find(r => r.players[pid]);
    if (!room || room.phase !== 'playing') return;
    if (room.sets[setId]) return socket.emit('error_msg', 'Set already declared');

    const declarer = room.players[pid];
    const myTeam = declarer.team;
    const oppTeam = myTeam === 'A' ? 'B' : 'A';
    const setInfo = SETS.find(s => s.id === setId);
    if (!setInfo) return socket.emit('error_msg', 'Invalid set');

    // Validate assignment covers all cards
    const missingCards = setInfo.cards.filter(c => !assignment[c]);
    if (missingCards.length > 0) return socket.emit('error_msg', 'Assign all cards');

    // Check each card
    let allCorrect = true;
    let wrongWithOpponent = false;

    setInfo.cards.forEach(card => {
      const assignedTo = assignment[card];
      const actualHand = room.hands[assignedTo] || [];
      if (!actualHand.includes(card)) {
        allCorrect = false;
        // Find actual holder
        const actualHolder = room.playerOrder.find(p => (room.hands[p] || []).includes(card));
        if (actualHolder && room.players[actualHolder].team !== myTeam) {
          wrongWithOpponent = true;
        }
      }
    });

    // Remove all set cards from all hands
    setInfo.cards.forEach(card => {
      room.playerOrder.forEach(p => {
        room.hands[p] = (room.hands[p] || []).filter(c => c !== card);
      });
    });

    let wonBy;
    if (allCorrect) {
      wonBy = myTeam;
      addLog(room, `<b>${declarer.name}</b> declared <b>${setInfo.name}</b> — ✅ CORRECT! Team ${myTeam} wins the set.`);
    } else if (wrongWithOpponent) {
      wonBy = oppTeam;
      addLog(room, `<b>${declarer.name}</b> declared <b>${setInfo.name}</b> — ❌ WRONG! A card was with opponents. Team ${oppTeam} wins the set.`);
    } else {
      wonBy = 'none';
      addLog(room, `<b>${declarer.name}</b> declared <b>${setInfo.name}</b> — ❌ WRONG! All misplaced cards were within Team ${myTeam}. Set discarded.`);
    }

    room.sets[setId] = { wonBy };

    if (!checkGameOver(room)) {
      const turnPid = room.playerOrder[room.turnIndex];
      if ((room.hands[turnPid] || []).length === 0) {
        const next = room.playerOrder.find(p => (room.hands[p] || []).length > 0);
        if (next) room.turnIndex = room.playerOrder.indexOf(next);
      }
    }

    broadcastRoom(room);
    executeBotTurn(room);
  });

  // Add a bot to the room (host only)
  socket.on('add_bot', () => {
    const room = Object.values(rooms).find(r => r.hostId === pid);
    if (!room || room.phase !== 'lobby') return socket.emit('error_msg', 'Cannot add bot now');
    if (Object.keys(room.players).length >= 8) return socket.emit('error_msg', 'Room is full');
    const bot = createBot();
    room.players[bot.id] = bot;
    room.playerOrder.push(bot.id);
    room.hands[bot.id] = [];
    broadcastRoom(room);
  });

  // Remove all bots (host only)
  socket.on('remove_bots', () => {
    const room = Object.values(rooms).find(r => r.hostId === pid);
    if (!room || room.phase !== 'lobby') return;
    const botIds = room.playerOrder.filter(id => room.players[id]?.isBot);
    botIds.forEach(id => { delete room.players[id]; delete room.hands[id]; });
    room.playerOrder = room.playerOrder.filter(id => !botIds.includes(id));
    broadcastRoom(room);
  });

  // Client requests current room state (used on reconnect / tab focus)
  socket.on('get_state', () => {
    if (!pid) return;
    const room = Object.values(rooms).find(r => r.players[pid]);
    if (room) {
      socket.join(room.code);
      socket.emit('room_update', roomPublicState(room, pid));
    }
  });

  // Rejoin after reconnect — re-register player in room
  socket.on('rejoin_room', ({ code, name, avatar }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error_msg', 'Room not found');
    // Update socket id mapping — old pid is gone, use new one
    // Find if this name already exists in the room
    const existingPid = Object.keys(room.players).find(p => room.players[p].name === name);
    if (existingPid && existingPid !== pid) {
      // Transfer player data to new socket id
      room.players[pid] = { ...room.players[existingPid], id: pid };
      delete room.players[existingPid];
      room.playerOrder = room.playerOrder.map(p => p === existingPid ? pid : p);
      if (room.hostId === existingPid) room.hostId = pid;
      if (room.turnPlayerId === existingPid) room.turnPlayerId = pid; // won't exist but just in case
      // Also fix hands
      if (room.hands[existingPid]) { room.hands[pid] = room.hands[existingPid]; delete room.hands[existingPid]; }
    }
    socket.join(code);
    socket.emit('room_update', roomPublicState(room, pid));
  });

  // Disconnect
  socket.on('disconnect', () => {
    if (!pid) return;
    // Clean up socket mapping
    if (socketToPlayer[socket.id] === pid) delete socketToPlayer[socket.id];
    // DON'T remove player from room on disconnect — they may just be switching tabs
    // Only mark as disconnected so UI can show it, but keep their place
    const room = Object.values(rooms).find(r => r.players[pid]);
    if (!room) return;
    if (room.players[pid]) room.players[pid].disconnected = true;
    // Give them 60 seconds to reconnect before removing from lobby
    if (room.phase === 'lobby') {
      setTimeout(() => {
        // If still disconnected (playerToSocket still points to old socket), remove
        if (playerToSocket[pid] === socket.id) {
          delete room.players[pid];
          room.playerOrder = room.playerOrder.filter(id => id !== pid);
          delete playerToSocket[pid];
          if (Object.keys(room.players).filter(id => !room.players[id]?.isBot).length === 0) {
            delete rooms[room.code];
            return;
          }
          if (room.hostId === pid) room.hostId = room.playerOrder.find(id => !room.players[id]?.isBot);
          broadcastRoom(room);
        }
      }, 60000); // 60 second grace period
    }
    broadcastRoom(room);
  });
});

function cardLabel(card) {
  if (card === 'RJ') return 'Red Joker';
  if (card === 'BJ') return 'Black Joker';
  const suit = card.slice(-1);
  const rank = card.slice(0, -1);
  const suitSymbol = { S: '♠', H: '♥', D: '♦', C: '♣' }[suit];
  return `${rank}${suitSymbol}`;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Literature server running on port ${PORT}`));
