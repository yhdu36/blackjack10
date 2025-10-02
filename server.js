const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// ----- Table Config -----
const MAX_PLAYERS = 10;
const MIN_PLAYERS = 1;
const SHOE_DECKS = 6; // 6-deck shoe; reshuffle between rounds only
const BASE_BET = 10;

// ----- Game State -----
let table = {
  state: 'waiting', // waiting | dealing | playerTurn | dealerTurn | settling
  players: [],      // {id, name, hand:[], bet, done, busted, blackjack, standing, bankroll }
  dealer: { hand: [] },
  deck: [],
  currentIdx: -1,
  round: 0
};

// ----- Helpers -----
function createDeck(nDecks = 1) {
  const suits = ['♠', '♥', '♦', '♣'];
  const ranks = [
    { r: 'A', v: 11 }, { r: '2', v: 2 }, { r: '3', v: 3 }, { r: '4', v: 4 },
    { r: '5', v: 5 }, { r: '6', v: 6 }, { r: '7', v: 7 }, { r: '8', v: 8 },
    { r: '9', v: 9 }, { r: '10', v: 10 }, { r: 'J', v: 10 }, { r: 'Q', v: 10 }, { r: 'K', v: 10 }
  ];
  const deck = [];
  for (let d = 0; d < nDecks; d++) {
    for (const s of suits) for (const rk of ranks) deck.push({ rank: rk.r, suit: s, value: rk.v });
  }
  // Fisher–Yates shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function handValue(hand) {
  let total = 0;
  let aces = 0;
  for (const c of hand) {
    total += c.value;
    if (c.rank === 'A') aces++;
  }
  // Convert Aces 11->1 while busting
  let softAces = aces;
  while (total > 21 && softAces > 0) {
    total -= 10;
    softAces--;
  }
  const isSoft = softAces > 0; // at least one Ace still counted as 11
  return { total, isSoft };
}

function dealOne(to) {
  if (table.deck.length === 0) {
    // We don't reshuffle mid-hand; with a 6-deck shoe this should be rare.
    // As a safeguard, we'll just stop dealing additional cards.
    return;
  }
  to.push(table.deck.pop());
}

// ----- View Building (masking logic) -----
function makeViewFor(playerId, revealAll = false) {
  const dealerVisible = (table.state === 'dealerTurn' || table.state === 'settling') || revealAll;

  const dealerHand = dealerVisible
    ? table.dealer.hand
    : (table.dealer.hand.length > 1
        ? [table.dealer.hand[0], { rank: '❓', suit: '', value: 0 }]
        : table.dealer.hand);

  const playersView = table.players.map(p => {
    const base = {
      id: p.id,
      name: p.name,
      bet: p.bet,
      done: p.done,
      busted: p.busted,
      blackjack: p.blackjack,
      standing: p.standing,
      bankroll: p.bankroll
    };

    // If revealAll (settling) -> show all hands to everyone.
    if (revealAll) return { ...base, hand: p.hand };

    // Personalized view during the round:
    if (p.id === playerId) {
      return { ...base, hand: p.hand };
    } else {
      // Mask others' hands: show first card + a mask card if there are >=2 cards
      if (p.hand.length >= 2) {
        return { ...base, hand: [p.hand[0], { rank: '■', suit: '', value: 0 }] };
      }
      return { ...base, hand: p.hand };
    }
  });

  return {
    state: table.state,
    players: playersView,
    dealer: { hand: dealerHand },
    deckCount: table.deck.length,
    currentIdx: table.currentIdx,
    round: table.round
  };
}

function broadcast() {
  const revealAll = (table.state === 'settling');
  const publicView = makeViewFor(null, revealAll);

  // Send a generic (masked) snapshot to everyone…
  io.emit('state', publicView);

  // …then personalize for each seated player (only during non-settling states)
  if (!revealAll) {
    for (const p of table.players) {
      io.to(p.id).emit('state', makeViewFor(p.id, false));
    }
  }
}

function canStart() {
  return table.players.length >= MIN_PLAYERS && table.players.length <= MAX_PLAYERS;
}

function resetRound() {
  table.deck = createDeck(SHOE_DECKS); // fresh shoe each round
  table.dealer = { hand: [] };
  table.players.forEach(p => {
    p.hand = [];
    p.done = false;
    p.busted = false;
    p.blackjack = false;
    p.standing = false;
    if (typeof p.bankroll !== 'number') p.bankroll = 100;
    p.bet = BASE_BET; // flat bet UI; can be exposed later
  });
}

function startRound() {
  if (!canStart()) return;
  table.round += 1;
  table.state = 'dealing';
  resetRound();

  // Initial deal: two to each player, two to dealer
  for (let i = 0; i < 2; i++) {
    for (const p of table.players) dealOne(p.hand);
    dealOne(table.dealer.hand);
  }

  // Mark naturals
  for (const p of table.players) {
    const hv = handValue(p.hand);
    p.blackjack = (p.hand.length === 2 && hv.total === 21);
  }

  // If all players BJ, go straight to dealer then settle
  const allBJ = table.players.length > 0 && table.players.every(p => p.blackjack);
  if (allBJ) {
    table.state = 'dealerTurn';
    dealerPlayThenSettle();
  } else {
    table.state = 'playerTurn';
    table.currentIdx = table.players.findIndex(p => !p.blackjack);
    if (table.currentIdx === -1) {
      table.state = 'dealerTurn';
      dealerPlayThenSettle();
    }
  }

  broadcast();
}

function nextPlayer() {
  let idx = table.currentIdx;
  do {
    idx++;
    if (idx >= table.players.length) {
      table.currentIdx = -1;
      table.state = 'dealerTurn';
      broadcast();
      dealerPlayThenSettle();
      return;
    }
  } while (table.players[idx].done || table.players[idx].blackjack);
  table.currentIdx = idx;
  broadcast();
}

function dealerPlayThenSettle() {
  // Reveal hole card (by switching to dealerTurn already) and play
  broadcast();

  while (true) {
    const hv = handValue(table.dealer.hand);
    if (hv.total < 17) {
      dealOne(table.dealer.hand);
      continue;
    }
    if (hv.total === 17 && hv.isSoft === true) {
      // Dealer stands on soft 17 (per rules)
      break;
    }
    break;
  }

  table.state = 'settling';

  const dealerHV = handValue(table.dealer.hand);
  const dealerBust = dealerHV.total > 21;
  const dealerBJ = (table.dealer.hand.length === 2 && dealerHV.total === 21);

  for (const p of table.players) {
    const hv = handValue(p.hand);
    if (p.blackjack) {
      if (dealerBJ) {
        // push
      } else {
        p.bankroll += Math.floor(p.bet * 1.5);
      }
      continue;
    }
    if (p.busted) {
      p.bankroll -= p.bet;
      continue;
    }
    if (dealerBust) {
      p.bankroll += p.bet;
      continue;
    }
    if (hv.total > dealerHV.total) {
      p.bankroll += p.bet;
    } else if (hv.total < dealerHV.total) {
      p.bankroll -= p.bet;
    } else {
      // push
    }
  }

  broadcast();
}

io.on('connection', (socket) => {
  // Join table
  socket.on('join', (name) => {
    if (table.players.length >= MAX_PLAYERS) {
      socket.emit('errorMessage', `Table is full (max ${MAX_PLAYERS} players).`);
      return;
    }
    if (table.state !== 'waiting') {
      socket.emit('errorMessage', 'Please wait for the current round to finish.');
      return;
    }
    const player = {
      id: socket.id,
      name: name?.trim() || `Player-${String(table.players.length + 1)}`,
      hand: [],
      bet: BASE_BET,
      done: false,
      busted: false,
      blackjack: false,
      standing: false,
      bankroll: 100
    };
    table.players.push(player);
    socket.emit('joined', player);
    broadcast();
  });

  socket.on('start', () => {
    if (table.state !== 'waiting') return;
    if (!canStart()) {
      socket.emit('errorMessage', `Need ${MIN_PLAYERS}–${MAX_PLAYERS} players to start.`);
      return;
    }
    startRound();
  });

  socket.on('hit', () => {
    if (table.state !== 'playerTurn') return;
    const p = table.players[table.currentIdx];
    if (!p || p.id !== socket.id) return;
    dealOne(p.hand);
    const hv = handValue(p.hand);
    if (hv.total > 21) {
      p.busted = true;
      p.done = true;
      nextPlayer();
    } else {
      broadcast();
    }
  });

  socket.on('stand', () => {
    if (table.state !== 'playerTurn') return;
    const p = table.players[table.currentIdx];
    if (!p || p.id !== socket.id) return;
    p.standing = true;
    p.done = true;
    nextPlayer();
  });

  socket.on('newRound', () => {
    if (table.state !== 'settling') return;
    table.state = 'waiting';
    table.currentIdx = -1;
    table.dealer = { hand: [] };
    table.players.forEach(p => {
      p.hand = [];
      p.done = false;
      p.busted = false;
      p.blackjack = false;
      p.standing = false;
    });
    broadcast();
  });

  socket.on('disconnect', () => {
    const idx = table.players.findIndex(p => p.id === socket.id);
    if (idx !== -1) {
      table.players.splice(idx, 1);
      if (table.state === 'playerTurn') {
        if (idx === table.currentIdx) {
          table.currentIdx = table.currentIdx - 1;
          nextPlayer();
        } else if (idx < table.currentIdx) {
          table.currentIdx = Math.max(0, table.currentIdx - 1);
        }
      }
      if (table.players.length === 0) {
        table = {
          state: 'waiting',
          players: [],
          dealer: { hand: [] },
          deck: [],
          currentIdx: -1,
          round: 0
        };
      }
      broadcast();
    }
  });

  // initial snapshot (masked public)
  broadcast();
});

server.listen(PORT, () => {
  console.log(`Blackjack server running on http://localhost:${PORT}`);
});
