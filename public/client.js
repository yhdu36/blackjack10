const socket = io();

let me = null;
let snapshot = null;

const el = (sel) => document.querySelector(sel);

// Lobby
const joinBtn = el('#joinBtn');
const nameInput = el('#nameInput');
const bankrollInput = el('#bankrollInput');
const betInput = el('#betInput');
const help = el('#help');

// Controls
const controls = el('#controls');
const startBtn = el('#startBtn'); // "Ready / 准备"
const hitBtn = el('#hitBtn');
const standBtn = el('#standBtn');
const newRoundBtn = el('#newRoundBtn');
const updateBetBtn = el('#updateBetBtn');
const updateBankrollBtn = el('#updateBankrollBtn');
const allInBetBtn = el('#allInBetBtn');
const editBet = el('#editBet');
const editBankroll = el('#editBankroll');

// Pills
const statePill = el('#statePill');
const roundPill = el('#roundPill');
const bankrollPill = el('#bankrollPill');
const betPill = el('#betPill');
const shoePill = el('#shoePill');

// Dealer UI
const dealerHand = el('#dealer-hand');
const dealerTotalEl = el('#dealer-total');
const dealerStatus = el('#dealer-status');

// Players container
const playersDiv = el('#players');

// ---- Lobby join ----
joinBtn.onclick = () => {
  const name = nameInput.value.trim();
  const bankrollVal = parseInt(bankrollInput.value, 10);
  const betVal = parseInt(betInput.value, 10);

  const payload = {
    name,
    bankroll: Number.isFinite(bankrollVal) && bankrollVal > 0 ? bankrollVal : undefined,
    bet: Number.isFinite(betVal) && betVal > 0 ? betVal : undefined
  };
  socket.emit('join', payload);
};

socket.on('joined', (player) => {
  me = player;
  el('#lobby').style.display = 'none';
  controls.style.display = 'block';
  editBankroll.value = player.bankroll ?? '';
  editBet.value = player.bet ?? '';
  help.textContent = 'Press Ready when finished editing / 编辑完点击“准备”';
});

socket.on('errorMessage', (msg) => {
  help.textContent = msg;
});

// ---- State & Buttons ----
socket.on('state', (s) => {
  snapshot = s;
  render();
});

startBtn.onclick = () => {
  startBtn.disabled = true;
  startBtn.textContent = 'Ready ✓ / 已准备';
  socket.emit('ready');
};

hitBtn.onclick = () => socket.emit('hit');
standBtn.onclick = () => socket.emit('stand');
newRoundBtn.onclick = () => socket.emit('newRound');

updateBetBtn.onclick = () => {
  const val = parseInt(editBet.value, 10);
  if (!Number.isFinite(val) || val < 1) {
    help.textContent = 'Enter a valid bet (>=1). / 请输入有效下注（≥1）。';
    return;
  }
  socket.emit('setBet', val);
};
updateBankrollBtn.onclick = () => {
  const val = parseInt(editBankroll.value, 10);
  if (!Number.isFinite(val) || val < 1) {
    help.textContent = 'Enter a valid bankroll (>=1). / 请输入有效资金（≥1）。';
    return;
  }
  socket.emit('setBankroll', val);
};
allInBetBtn.onclick = () => socket.emit('allIn');

// ---- Card renderer (PNG) ----
function renderCard(c) {
  const img = document.createElement('img');
  img.className = 'cardimg';

  // Masked cards (dealer hole or other players' hole)
  if (c.rank === '❓' || c.rank === '■') {
    img.src = '/cards/back.png';
    img.alt = 'Card back';
    return img;
  }

  const suitMap = { '♠':'S', '♥':'H', '♦':'D', '♣':'C' };
  const s = suitMap[c.suit] || 'S';
  const r = c.rank; // 'A','2'..'10','J','Q','K'
  img.src = `/cards/${r}${s}.png`;
  img.alt = `${r}${s}`;
  return img;
}

function render() {
  if (!snapshot) return;

  // Status
  const stateLabel = snapshot.state === 'playersAct' ? 'playersAct (simultaneous)' : snapshot.state;
  statePill.textContent = `State / 状态: ${stateLabel}`;
  roundPill.textContent = `Round / 回合: ${snapshot.round}`;
  shoePill.textContent = `Shoe cards / 鞋中余牌: ${typeof snapshot.deckCount === 'number' ? snapshot.deckCount : '—'}`;

  // Dealer
  dealerHand.innerHTML = '';
  snapshot.dealer.hand.forEach(c => dealerHand.appendChild(renderCard(c)));

  if (snapshot.dealerTotal != null) {
    dealerTotalEl.textContent = `Dealer total / 庄家点数: ${snapshot.dealerTotal}${snapshot.dealerBust ? ' (Bust / 爆牌)' : ''}`;
  } else {
    dealerTotalEl.textContent = 'Dealer total / 庄家点数: —';
  }

  // Dealer banner
  dealerStatus.innerHTML = '';
  const showDealerBanner = snapshot.state === 'dealerTurn' || snapshot.state === 'settling';
  if (showDealerBanner) {
    const dealerBJ = snapshot.dealer?.hand && snapshot.dealer.hand.length === 2 && snapshot.dealerTotal === 21;
    const anyPlayerBJ = snapshot.players?.some(p => p.blackjack);
    let cls = 'result-info';
    let label = snapshot.dealerTotal != null
      ? `Dealer stands at ${snapshot.dealerTotal} / 庄家停在 ${snapshot.dealerTotal}`
      : 'Dealer acts / 庄家行动';

    if (snapshot.dealerBust) {
      cls = 'result-lose';
      label = 'Dealer Bust / 庄家爆牌';
    } else if (dealerBJ && anyPlayerBJ) {
      cls = 'result-push';
      label = 'Push with player blackjack / 与玩家天生黑杰克平局';
    } else if (dealerBJ) {
      cls = 'result-blackjack';
      label = 'Dealer Blackjack / 庄家天生黑杰克';
    }

    const banner = document.createElement('div');
    banner.className = `result-banner ${cls}`;
    banner.innerHTML = `<span class="result-chip">Dealer / 庄家</span><span>${label}</span>`;
    dealerStatus.appendChild(banner);
  }

  // Players
  playersDiv.innerHTML = '';
  snapshot.players.forEach((p) => {
    const wrap = document.createElement('div');
    wrap.className = 'player';
    if (me && p.id === me.id) wrap.classList.add('me');

    const hv = handTotal(p.hand);
    const status =
      p.blackjack ? 'Blackjack!' :
      p.busted ? 'Busted' :
      (p.hand.length ? `Total ${hv}` : (p.ready ? 'Ready' : 'Not ready'));

    const title = document.createElement('div');
    title.className = 'flex';
    title.innerHTML = `<strong>${p.name}</strong> <span class="meta">Bet 下注 ${p.bet} • ${status}${p.ready && snapshot.state==='waiting' ? ' • ✅' : ''}</span>`;
    wrap.appendChild(title);

    const handEl = document.createElement('div');
    handEl.className = 'hand';
    p.hand.forEach(c => handEl.appendChild(renderCard(c)));
    wrap.appendChild(handEl);

    if (snapshot.state === 'settling' && p.outcome) {
      const banner = document.createElement('div');
      const { cssClass, label } = outcomeStyle(p.outcome);
      banner.className = `result-banner ${cssClass}`;
      banner.innerHTML = `
        <span class="result-chip">Result / 结果</span>
        <span>${label}</span>
      `;
      wrap.appendChild(banner);
    }

    const bank = document.createElement('div');
    bank.className = 'stat-badge';
    bank.textContent = `Bankroll / 资金: ${typeof p.bankroll==='number' ? p.bankroll : '—'}`;
    wrap.appendChild(bank);

    playersDiv.appendChild(wrap);
  });

  // My pills + editors
  const meFull = snapshot.players.find(p => me && p.id === me.id);
  bankrollPill.textContent = `Bankroll / 资金: ${meFull ? meFull.bankroll : '—'}`;
  betPill.textContent = `Bet / 下注: ${meFull ? meFull.bet : '—'}`;

  // Ready control
  const canReady = snapshot.state === 'waiting' && !!meFull && meFull.bet >= 1 && meFull.bet <= meFull.bankroll;
  if (canReady && !meFull.ready) {
    startBtn.disabled = false;
    startBtn.textContent = 'Ready / 准备';
  } else if (snapshot.state === 'waiting' && meFull?.ready) {
    startBtn.disabled = true;
    startBtn.textContent = 'Ready ✓ / 已准备';
  } else if (snapshot.state !== 'waiting') {
    startBtn.disabled = true;
    startBtn.textContent = 'Ready / 准备';
  }

  // Editability
  const canEdit = snapshot.state === 'waiting' && !!meFull && !meFull.ready;
  editBet.disabled = !canEdit;
  editBankroll.disabled = !canEdit;
  updateBetBtn.disabled = !canEdit;
  updateBankrollBtn.disabled = !canEdit;
  allInBetBtn.disabled = !canEdit;

  if (canEdit) {
    if (meFull && document.activeElement !== editBet) editBet.value = meFull.bet ?? '';
    if (meFull && document.activeElement !== editBankroll) editBankroll.value = meFull.bankroll ?? '';
  }

  // Action buttons
  const canAct = (snapshot.state === 'playersAct' && meFull && !meFull.done && !meFull.busted && !meFull.blackjack);
  hitBtn.disabled = !canAct;
  standBtn.disabled = !canAct;

  newRoundBtn.disabled = !(snapshot.state === 'settling');
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

function outcomeStyle(outcome) {
  const o = String(outcome).toLowerCase();
  if (o.includes('blackjack')) return { cssClass: 'result-blackjack', label: 'Blackjack (3:2) / 天生黑杰克' };
  if (o.includes('win'))       return { cssClass: 'result-win',       label: 'Win / 胜利' };
  if (o.includes('lose'))      return { cssClass: 'result-lose',      label: 'Lose / 失利' };
  if (o.includes('push'))      return { cssClass: 'result-push',      label: 'Push / 和局' };
  if (o.includes('bust'))      return { cssClass: 'result-bust',      label: 'Bust / 爆牌' };
  return { cssClass: 'result-info', label: outcome };
}

// ---- Preload PNGs to reduce flicker ----
(() => {
  const preload = [];
  ['S','H','D','C'].forEach(s=>{
    ['A','2','3','4','5','6','7','8','9','10','J','Q','K'].forEach(r=>{
      const i = new Image(); i.src = `/cards/${r}${s}.png`; preload.push(i);
    });
  });
  const back = new Image(); back.src = '/cards/back.png'; preload.push(back);
})();

// Make card height ≈ 2× the "Update Bet" button height
(function(){
  const btn = document.querySelector('#updateBetBtn');
  const set = () => {
    if (!btn) return;
    const h = btn.offsetHeight || 40;
    const root = document.documentElement;
    root.style.setProperty('--card-h-mobile', (h * 2) + 'px');
    root.style.setProperty('--card-h-desktop', (h * 2.2) + 'px'); // a tad larger on desktop
  };
  window.addEventListener('resize', set);
  set();
})();

