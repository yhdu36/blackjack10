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
const SHOE_DECKS = 6;         // 6-deck shoe; reshuffle between rounds only
const DEFAULT_BANKROLL = 100; // default starting bankroll
const BASE_BET = 10;          // default bet

// states: waiting | dealing | playersAct | dealerTurn | settling
let table = {
  state: 'waiting',
  players: [],      // {id, name, hand:[], bet, done, busted, blackjack, standing, bankroll, outcome, ready}
  dealer: { hand: [] },
  deck: [],
  round: 0,
  dealerTotal: null,
  dealerBust: false
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
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function handValue(hand) {
  let total = 0, aces = 0;
  for (const c of hand) {
    total += c.value;
    if (c.rank === 'A') aces++;
  }
  let softAces = aces;
  while (total > 21 && softAces > 0) { total -= 10; softAces--; }
  const isSoft = softAces > 0; // at least one Ace still 11
  return { total, isSoft };
}

function dealOne(to) {
  if (table.deck.length === 0) return; // no reshuffle mid-hand
  to.push(table.deck.pop());
}

function clampInt(n, min, max) {
  const x = Number.isFinite(+n) ? Math.floor(+n) : NaN;
  if (!Number.isFinite(x)) return null;
  return Math.min(Math.max(x, min), max);
}

// ----- View (masking + derived fields) -----
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
      bankroll: p.bankroll,
      outcome: p.outcome || null,
      ready: !!p.ready
    };
    if (revealAll) return { ...base, hand: p.hand };
    if (p.id === playerId) return { ...base, hand: p.hand };
    if (p.hand.length >= 2) return { ...base, hand: [p.hand[0], { rank: '■', suit: '', value: 0 }] };
    return { ...base, hand: p.hand };
  });

  return {
    state: table.state,
    players: playersView,
    dealer: { hand: dealerHand },
    deckCount: table.deck.length,
    round: table.round,
    dealerTotal: dealerVisible ? table.dealerTotal : null,
    dealerBust: dealerVisible ? table.dealerBust : false
  };
}

function broadcast() {
  const revealAll = (table.state === 'settling');
  io.emit('state', makeViewFor(null, revealAll)); // public snapshot
  if (!revealAll) {
    for (const p of table.players) {
      io.to(p.id).emit('state', makeViewFor(p.id, false)); // personalized during round
    }
  }
}

function canStart() {
  return table.players.length >= MIN_PLAYERS && table.players.length <= MAX_PLAYERS;
}

function everyoneReady() {
  return canStart() && table.players.every(p => p.ready === true);
}

function resetRound() {
  table.deck = createDeck(SHOE_DECKS);
  table.dealer = { hand: [] };
  table.dealerTotal = null;
  table.dealerBust = false;
  table.players.forEach(p => {
    p.hand = [];
    p.done = false;
    p.busted = false;
    p.blackjack = false;
    p.standing = false;
    p.outcome = null;
    // keep bankroll/bet, clamp and ensure bet<=bankroll
    if (typeof p.bankroll !== 'number' || p.bankroll < 1) p.bankroll = DEFAULT_BANKROLL;
    if (typeof p.bet !== 'number' || p.bet < 1) p.bet = BASE_BET;
    if (p.bet > p.bankroll) p.bet = p.bankroll;
  });
}

function maybeAdvanceToDealer() {
  if (table.state !== 'playersAct') return;

  const allLocked =
    table.players.length === 0 ||
    table.players.every(p => p.blackjack || p.done || p.busted);

  if (allLocked) {
    table.state = 'dealerTurn';
    broadcast();          // refresh before dealer plays
    dealerPlayThenSettle();
  } else {
    broadcast();          // still in playersAct—show bust/stand immediately
  }
}

function startRound() {
  table.round += 1;
  table.state = 'dealing';
  resetRound();

  // Initial deal
  for (let i = 0; i < 2; i++) {
    for (const p of table.players) dealOne(p.hand);
    dealOne(table.dealer.hand);
  }

  // Naturals
  for (const p of table.players) {
    const hv = handValue(p.hand);
    p.blackjack = (p.hand.length === 2 && hv.total === 21);
  }

  const allBJ = table.players.length > 0 && table.players.every(p => p.blackjack);
  if (allBJ) {
    table.state = 'dealerTurn';
    dealerPlayThenSettle();
  } else {
    table.state = 'playersAct'; // simultaneous actions
    broadcast();
  }
}

function dealerPlayThenSettle() {
  const tallyDealer = () => {
    const hv = handValue(table.dealer.hand);
    table.dealerTotal = hv.total;
    table.dealerBust = hv.total > 21;
    return hv;
  };

  // Reveal hole card to everyone
  broadcast();

  while (true) {
    const hv = tallyDealer();
    if (hv.total < 17) { dealOne(table.dealer.hand); continue; }
    if (hv.total === 17 && hv.isSoft === true) { break; } // stand on soft 17
    break;
  }
  tallyDealer();

  table.state = 'settling';

  const dealerHV = handValue(table.dealer.hand);
  const dealerBust = dealerHV.total > 21;
  const dealerBJ = (table.dealer.hand.length === 2 && dealerHV.total === 21);

  for (const p of table.players) {
    const hv = handValue(p.hand);
    if (p.blackjack) {
      if (dealerBJ) {
        p.outcome = 'Push';
      } else {
        p.outcome = 'Blackjack (3:2)';
        p.bankroll += Math.floor(p.bet * 1.5);
      }
      continue;
    }
    if (p.busted) {
      p.bankroll -= p.bet;
      p.outcome = 'Bust';
      continue;
    }
    if (dealerBust) {
      p.bankroll += p.bet;
      p.outcome = 'Win';
      continue;
    }
    if (hv.total > dealerHV.total) {
      p.bankroll += p.bet;
      p.outcome = 'Win';
    } else if (hv.total < dealerHV.total) {
      p.bankroll -= p.bet;
      p.outcome = 'Lose';
    } else {
      p.outcome = 'Push';
    }
  }

  broadcast();
}

function tryStartIfEveryoneReady() {
  if (table.state === 'waiting' && everyoneReady()) {
    startRound();
  } else {
    broadcast();
  }
}

// ----- Socket handlers -----
io.on('connection', (socket) => {
  // Join with optional name/bankroll/bet
  socket.on('join', (payload) => {
    if (table.players.length >= MAX_PLAYERS) {
      socket.emit('errorMessage', `Table is full (max ${MAX_PLAYERS} players).`);
      return;
    }
    if (table.state !== 'waiting') {
      socket.emit('errorMessage', 'Please wait for the current round to finish.');
      return;
    }

    let name = typeof payload === 'object' ? payload?.name : payload;
    let bankrollIn = typeof payload === 'object' ? payload?.bankroll : undefined;
    let betIn = typeof payload === 'object' ? payload?.bet : undefined;

    let bankroll = clampInt(bankrollIn ?? DEFAULT_BANKROLL, 1, 1_000_000);
    if (bankroll == null) bankroll = DEFAULT_BANKROLL;

    let bet = clampInt(betIn ?? BASE_BET, 1, bankroll);
    if (bet == null) bet = Math.min(BASE_BET, bankroll);

    const player = {
      id: socket.id,
      name: String(name ?? '').trim() || `Player-${String(table.players.length + 1)}`,
      hand: [],
      bet,
      done: false,
      busted: false,
      blackjack: false,
      standing: false,
      bankroll,
      outcome: null,
      ready: false
    };
    table.players.push(player);
    socket.emit('joined', player);
    broadcast();
  });

  // Ready confirmation (single click to set true)
  socket.on('ready', () => {
    if (table.state !== 'waiting') return;
    const p = table.players.find(pl => pl.id === socket.id);
    if (!p) return;

    // Ensure valid before ready
    if (p.bet < 1) p.bet = 1;
    if (p.bet > p.bankroll) p.bet = p.bankroll;

    p.ready = true;
    tryStartIfEveryoneReady();
  });

  // Edit bet/bankroll only while waiting; editing un-readies the player
  socket.on('setBet', (betVal) => {
    if (table.state !== 'waiting') return;
    const p = table.players.find(pl => pl.id === socket.id);
    if (!p) return;
    const bet = clampInt(betVal, 1, p.bankroll);
    if (bet == null) {
      socket.emit('errorMessage', 'Invalid bet. Enter a positive integer not exceeding your bankroll.');
      return;
    }
    p.bet = bet;
    p.ready = false; // editing cancels ready
    broadcast();
  });

  socket.on('setBankroll', (rollVal) => {
    if (table.state !== 'waiting') return;
    const p = table.players.find(pl => pl.id === socket.id);
    if (!p) return;
    const roll = clampInt(rollVal, 1, 1_000_000);
    if (roll == null) {
      socket.emit('errorMessage', 'Invalid bankroll. Enter a positive integer.');
      return;
    }
    p.bankroll = roll;
    if (p.bet > p.bankroll) p.bet = p.bankroll;
    p.ready = false; // editing cancels ready
    broadcast();
  });

  // All-in sets bet = bankroll (waiting only)
  socket.on('allIn', () => {
    if (table.state !== 'waiting') return;
    const p = table.players.find(pl => pl.id === socket.id);
    if (!p) return;
    p.bet = Math.max(1, p.bankroll);
    p.ready = false; // change requires ready again
    broadcast();
  });

  // Simultaneous actions
  socket.on('hit', () => {
    if (table.state !== 'playersAct') return;
    const p = table.players.find(pp => pp.id === socket.id);
    if (!p || p.done || p.busted || p.blackjack) return;

    dealOne(p.hand);
    const hv = handValue(p.hand);
    if (hv.total > 21) {
      p.busted = true;
      p.done = true;
      broadcast();          // show bust immediately
      maybeAdvanceToDealer();
    } else {
      broadcast();
    }
  });

  socket.on('stand', () => {
    if (table.state !== 'playersAct') return;
    const p = table.players.find(pp => pp.id === socket.id);
    if (!p || p.done || p.busted || p.blackjack) return;

    p.standing = true;
    p.done = true;
    broadcast();            // reflect stand instantly
    maybeAdvanceToDealer();
  });

  // Begin next round (back to waiting; everyone un-ready)
  socket.on('newRound', () => {
    if (table.state !== 'settling') return;
    table.state = 'waiting';
    table.dealer = { hand: [] };
    table.dealerTotal = null;
    table.dealerBust = false;
    table.players.forEach(p => {
      p.hand = [];
      p.done = false;
      p.busted = false;
      p.blackjack = false;
      p.standing = false;
      p.outcome = null;
      if (p.bet < 1) p.bet = 1;
      if (p.bet > p.bankroll) p.bet = p.bankroll;
      p.ready = false; // new round: must press Ready again
    });
    broadcast();
  });

  socket.on('disconnect', () => {
    const idx = table.players.findIndex(p => p.id === socket.id);
    if (idx !== -1) {
      table.players.splice(idx, 1);
      if (table.players.length === 0) {
        table = {
          state: 'waiting',
          players: [],
          dealer: { hand: [] },
          deck: [],
          round: 0,
          dealerTotal: null,
          dealerBust: false
        };
      } else if (table.state === 'playersAct') {
        maybeAdvanceToDealer();
      } else if (table.state === 'waiting') {
        // if someone leaves in waiting, just re-check readiness
        tryStartIfEveryoneReady();
      }
      broadcast();
    }
  });

  broadcast();
});

server.listen(PORT, () => {
  console.log(`Blackjack server running on http://localhost:${PORT}`);
});
