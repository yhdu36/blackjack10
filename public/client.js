const socket = io();

let me = null;
let snapshot = null;

const el = (sel) => document.querySelector(sel);

const joinBtn = el('#joinBtn');
const nameInput = el('#nameInput');
const help = el('#help');

const controls = el('#controls');
const startBtn = el('#startBtn');
const hitBtn = el('#hitBtn');
const standBtn = el('#standBtn');
const newRoundBtn = el('#newRoundBtn');

const statePill = el('#statePill');
const roundPill = el('#roundPill');
const bankrollPill = el('#bankrollPill');
const betPill = el('#betPill');
const shoePill = el('#shoePill');

const dealerHand = el('#dealer-hand');
const playersDiv = el('#players');

joinBtn.onclick = () => {
  socket.emit('join', nameInput.value.trim());
};

socket.on('joined', (player) => {
  me = player;
  el('#lobby').style.display = 'none';
  controls.style.display = 'block';
});

socket.on('errorMessage', (msg) => {
  help.textContent = msg;
});

socket.on('state', (s) => {
  snapshot = s;
  render();
});

startBtn.onclick = () => socket.emit('start');
hitBtn.onclick = () => socket.emit('hit');
standBtn.onclick = () => socket.emit('stand');
newRoundBtn.onclick = () => socket.emit('newRound');

function renderCard(c) {
  const span = document.createElement('span');
  span.className = 'cardchip';
  span.textContent = c.suit ? `${c.rank}${c.suit}` : c.rank;
  return span;
}

function render() {
  if (!snapshot) return;

  // Top status
  statePill.textContent = `State: ${snapshot.state}`;
  roundPill.textContent = `Round: ${snapshot.round}`;
  shoePill.textContent = `Shoe cards: ${typeof snapshot.deckCount === 'number' ? snapshot.deckCount : '—'}`;

  // Dealer
  dealerHand.innerHTML = '';
  snapshot.dealer.hand.forEach(c => dealerHand.appendChild(renderCard(c)));

  // Players
  playersDiv.innerHTML = '';
  snapshot.players.forEach((p, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'player';
    if (me && p.id === me.id) wrap.classList.add('me');

    const hv = handTotal(p.hand);
    const title = document.createElement('div');
    title.className = 'flex';
    const tag = (snapshot.state === 'playerTurn' && snapshot.currentIdx === idx) ? ' • <em>Acting</em>' : '';
    const status =
      p.blackjack ? 'Blackjack!' :
      p.busted ? 'Busted' :
      (p.hand.length ? `Total ${hv}` : '—');

    title.innerHTML = `<strong>${p.name}</strong> <span class="meta">Bet ${p.bet} • ${status}${tag}</span>`;
    wrap.appendChild(title);

    const handEl = document.createElement('div');
    handEl.className = 'hand';
    p.hand.forEach(c => handEl.appendChild(renderCard(c)));
    wrap.appendChild(handEl);

    const bank = document.createElement('div');
    bank.className = 'meta';
    bank.textContent = `Bankroll: ${typeof p.bankroll==='number' ? p.bankroll : '—'}`;
    wrap.appendChild(bank);

    playersDiv.appendChild(wrap);
  });

  // My info pills
  const meFull = snapshot.players.find(p => me && p.id === me.id);
  bankrollPill.textContent = `Bankroll: ${meFull ? meFull.bankroll : '—'}`;
  betPill.textContent = `Bet: ${meFull ? meFull.bet : '—'}`;

  // Buttons enable/disable
  const canStart = snapshot.state === 'waiting' && snapshot.players.length >= 1 && snapshot.players.length <= 10;
  startBtn.disabled = !canStart;

  const myTurn = (snapshot.state === 'playerTurn' && meFull && isMyTurn(meFull));
  hitBtn.disabled = !myTurn;
  standBtn.disabled = !myTurn;

  newRoundBtn.disabled = !(snapshot.state === 'settling');
}

function isMyTurn(meFull) {
  const idx = snapshot.players.findIndex(p => p.id === meFull.id);
  return idx === snapshot.currentIdx && !meFull.done && !meFull.blackjack && !meFull.busted;
}

function handTotal(hand) {
  let total = 0, aces = 0;
  hand.forEach(c => {
    const val = c.rank === 'A' ? 11 :
      (['K','Q','J'].includes(c.rank) ? 10 :
        (c.rank === '❓' || c.rank === '■' ? 0 : parseInt(c.rank,10)));
    total += val;
    if (c.rank === 'A') aces++;
  });
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}
