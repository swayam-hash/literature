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
  shuffled.forEach((card, i) => hands[playerIds[i % 6]].push(card));
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
  const pid = socket.id;

  // Create room
  socket.on('create_room', ({ name, avatar }) => {
    if (!name?.trim()) return socket.emit('error_msg', 'Name required');
    const code = createRoom(pid, name.trim(), avatar || '🎴');
    socket.join(code);
    socket.emit('joined_room', { code, playerId: pid });
    broadcastRoom(rooms[code]);
  });

  // Join room
  socket.on('join_room', ({ name, code, avatar }) => {
    const room = rooms[code?.toUpperCase()];
    if (!room) return socket.emit('error_msg', 'Room not found');
    if (room.phase !== 'lobby') return socket.emit('error_msg', 'Game already started');
    if (Object.keys(room.players).length >= 6) return socket.emit('error_msg', 'Room is full (6 players max)');
    if (!name?.trim()) return socket.emit('error_msg', 'Name required');

    room.players[pid] = { id: pid, name: name.trim(), team: null, avatar: avatar || '🎴' };
    room.playerOrder.push(pid);
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
    if (pids.length !== 6 || teamA.length !== 3 || teamB.length !== 3)
      return socket.emit('error_msg', 'Need exactly 6 players, 3 per team');

    room.hands = dealCards(pids);
    room.phase = 'playing';
    room.turnIndex = Math.floor(Math.random() * 6);
    const firstPlayer = room.players[pids[room.turnIndex]];
    addLog(room, `🃏 Game started! <b>${firstPlayer.name}</b> goes first.`);
    broadcastRoom(room);
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
      // If declarer's team got/kept the set, turn goes to declarer; else to opponent team
      // Actually: turn stays with current turn player unless the current player has no cards
      // If current turn player has 0 cards, pass to next player with cards on same team, or any
      const turnPid = room.playerOrder[room.turnIndex];
      if ((room.hands[turnPid] || []).length === 0) {
        // Find next player with cards
        const next = room.playerOrder.find(p => (room.hands[p] || []).length > 0);
        if (next) room.turnIndex = room.playerOrder.indexOf(next);
      }
    }

    broadcastRoom(room);
  });

  // Disconnect
  socket.on('disconnect', () => {
    // Find which room they were in
    const room = Object.values(rooms).find(r => r.players[pid]);
    if (!room) return;
    if (room.phase === 'lobby') {
      delete room.players[pid];
      room.playerOrder = room.playerOrder.filter(id => id !== pid);
      if (Object.keys(room.players).length === 0) {
        delete rooms[room.code];
        return;
      }
      if (room.hostId === pid) {
        room.hostId = room.playerOrder[0];
      }
      broadcastRoom(room);
    } else {
      // In game — mark as disconnected but keep state
      if (room.players[pid]) room.players[pid].disconnected = true;
      broadcastRoom(room);
    }
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
