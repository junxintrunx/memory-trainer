// ===== STATE =====
const defaultState = {
  profile: {
    name: '',
    domain: '',
    anchorHabit: '',
    onboardingComplete: false
  },
  streak: {
    count: 0,
    lastDate: null,
    longestStreak: 0,
    history: {},
    freezeAvailable: false
  },
  cards: [],
  palace: {
    rooms: [],
    totalLoci: 0
  },
  stats: {
    totalSessions: 0,
    totalCardsReviewed: 0,
    cardsMastered: 0,
    retentionHistory: [],
    avgConfidence: 0
  },
  achievements: []
};

let state = JSON.parse(JSON.stringify(defaultState));

// Active session is kept separately — not persisted across page loads
let session = {
  active: false,
  phase: null,
  startTime: null,
  dueCards: [],
  newCardQueue: [],
  currentCardIndex: 0,
  revealed: false,
  sessionScores: [],
  timerInterval: null,
  newItemsAdded: 0,
  sessionRetention: null
};

// ===== PERSISTENCE =====
function save() {
  localStorage.setItem('memoryTrainer_v1', JSON.stringify(state));
}

function load() {
  const raw = localStorage.getItem('memoryTrainer_v1');
  if (raw) {
    try {
      const saved = JSON.parse(raw);
      state = Object.assign(JSON.parse(JSON.stringify(defaultState)), saved);
    } catch (e) {
      console.error('Failed to load saved state', e);
    }
  }
}

// ===== DATE HELPERS =====
function today() {
  return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('en-CA');
}

function daysBetween(a, b) {
  const da = new Date(a + 'T12:00:00');
  const db = new Date(b + 'T12:00:00');
  return Math.round((db - da) / 86400000);
}

function last28Days() {
  const days = [];
  for (let i = 27; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toLocaleDateString('en-CA'));
  }
  return days;
}

// ===== STREAK MANAGEMENT =====
function checkStreakIntegrity() {
  const t = today();
  const yesterday = addDays(t, -1);
  const twoDaysAgo = addDays(t, -2);

  // If streak > 0 but neither today nor yesterday was completed, reset
  if (state.streak.count > 0 && !state.streak.history[t] && !state.streak.history[yesterday]) {
    // Check if freeze applies
    if (state.streak.freezeAvailable && state.streak.history[twoDaysAgo]) {
      // Use freeze — yesterday is forgiven, streak intact
      state.streak.history[yesterday] = 'frozen';
      state.streak.freezeAvailable = false;
      save();
    } else {
      state.streak.count = 0;
      save();
    }
  }
}

function markSessionComplete() {
  const t = today();
  const yesterday = addDays(t, -1);

  if (state.streak.history[t] === true) return; // already counted today

  state.streak.history[t] = true;

  const yesterdayDone = state.streak.history[yesterday] === true || state.streak.history[yesterday] === 'frozen';

  if (yesterdayDone || state.streak.count === 0) {
    state.streak.count++;
  } else {
    state.streak.count = 1;
  }

  if (state.streak.count > state.streak.longestStreak) {
    state.streak.longestStreak = state.streak.count;
  }

  // Award streak freeze every 7 days
  if (state.streak.count % 7 === 0) {
    state.streak.freezeAvailable = true;
  }

  state.stats.totalSessions++;
  save();
}

// ===== SM-2 SPACED REPETITION =====
// Rating: 1=Blackout, 2=Hard, 3=Good, 4=Easy
function updateCard(card, rating) {
  const qualityMap = [0, 1, 3, 5]; // rating 1-4 maps to SM-2 quality 0-5
  const quality = qualityMap[rating - 1];

  if (quality >= 3) {
    if (card.repetitions === 0)      card.interval = 1;
    else if (card.repetitions === 1) card.interval = 3;
    else card.interval = Math.max(1, Math.round(card.interval * card.eF));
    card.repetitions++;
  } else {
    card.repetitions = 0;
    card.interval = 1;
  }

  card.eF = Math.max(1.3, card.eF + 0.1 - (4 - quality) * (0.08 + (4 - quality) * 0.02));
  card.nextReview = addDays(today(), card.interval);
  card.totalAttempts = (card.totalAttempts || 0) + 1;
  if (quality >= 3) card.correctAttempts = (card.correctAttempts || 0) + 1;
  card.mastered = card.interval >= 30;

  return card;
}

function getDueCards() {
  const t = today();
  return state.cards.filter(c => !c.nextReview || c.nextReview <= t);
}

function getNewCards(max = 5) {
  // Cards that have never been reviewed and are not already in the due queue
  const dueIds = new Set(getDueCards().map(c => c.id));
  return state.cards.filter(c => c.repetitions === 0 && !dueIds.has(c.id)).slice(0, max);
}

// ===== CARD MANAGEMENT =====
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function createCard(front, back) {
  return {
    id: generateId(),
    front: front.trim(),
    back: back.trim(),
    eF: 2.5,
    interval: 0,
    repetitions: 0,
    nextReview: today(),
    mastered: false,
    totalAttempts: 0,
    correctAttempts: 0,
    created: today()
  };
}

function addCard(front, back) {
  const card = createCard(front, back);
  state.cards.push(card);
  save();
  return card;
}

function importCards(text) {
  const added = [];

  // Format: Q: ... \n A: ...
  const qaPairs = text.split(/\n(?=Q:)/i);
  for (const block of qaPairs) {
    const qMatch = block.match(/^Q:\s*(.+?)(?=\nA:)/is);
    const aMatch = block.match(/A:\s*(.+)$/is);
    if (qMatch && aMatch) {
      added.push(addCard(qMatch[1].trim(), aMatch[1].trim()));
      continue;
    }

    // Format: front,back (CSV)
    const csvMatch = block.match(/^([^,\n]+),(.+)$/m);
    if (csvMatch) {
      added.push(addCard(csvMatch[1].trim(), csvMatch[2].trim()));
    }
  }

  save();
  return added.length;
}

function deleteCard(id) {
  state.cards = state.cards.filter(c => c.id !== id);
  save();
}

// ===== SESSION LOGIC =====
function startSession() {
  checkStreakIntegrity();

  // Separate truly-new (never seen) from cards due for spaced review
  const allDue = getDueCards();
  const neverSeen = allDue.filter(c => c.repetitions === 0).slice(0, 5);
  const forReview = allDue.filter(c => c.repetitions > 0).slice(0, 15);
  // If nothing due for review, pull up to 5 new cards to start
  const newOnes = forReview.length === 0 && neverSeen.length === 0 ? getNewCards(5) : neverSeen;

  session = {
    active: true,
    phase: forReview.length > 0 ? 'recall' : 'new',
    startTime: Date.now(),
    dueCards: forReview,
    newCardQueue: newOnes,
    currentCardIndex: 0,
    revealed: false,
    sessionScores: [],
    timerInterval: null,
    newItemsAdded: 0,
    sessionRetention: null
  };

  render('session');
}

function endSession() {
  if (session.timerInterval) clearInterval(session.timerInterval);

  // Calculate retention rate
  const scores = session.sessionScores;
  const good = scores.filter(s => s.rating >= 3).length;
  const rate = scores.length > 0 ? Math.round((good / scores.length) * 100) : null;
  session.sessionRetention = rate;

  if (rate !== null) {
    state.stats.retentionHistory.push({ date: today(), rate });
    if (state.stats.retentionHistory.length > 30) {
      state.stats.retentionHistory = state.stats.retentionHistory.slice(-30);
    }
  }

  state.stats.totalCardsReviewed += scores.length;
  state.stats.cardsMastered = state.cards.filter(c => c.mastered).length;

  markSessionComplete();
  session.active = false;
  render('close');
}

function rateCard(rating) {
  const allCards = [...session.dueCards, ...session.newCardQueue];
  if (session.currentCardIndex >= allCards.length) return;

  const card = allCards[session.currentCardIndex];
  const cardInState = state.cards.find(c => c.id === card.id);
  if (cardInState) updateCard(cardInState, rating);

  session.sessionScores.push({ cardId: card.id, rating, attempt: session.userAttempt || '' });
  session.currentCardIndex++;
  session.revealed = false;
  session.studied = false;
  session.userAttempt = '';

  // Check if we've gone through all due cards — transition to new material
  if (session.currentCardIndex === session.dueCards.length && session.newCardQueue.length > 0) {
    session.phase = 'new';
  }

  if (session.currentCardIndex >= allCards.length) {
    endSession();
    return;
  }

  save();
  render('session');
}

function submitAttempt() {
  const el = document.getElementById('attempt-input');
  session.userAttempt = el ? el.value.trim() : '';
  session.revealed = true;
  render('session');
}

function revealCard() {
  session.revealed = true;
  render('session');
}

function skipToNewMaterial() {
  session.phase = 'new';
  session.currentCardIndex = session.dueCards.length;
  session.revealed = false;
  if (session.currentCardIndex >= session.dueCards.length + session.newCardQueue.length) {
    endSession();
  } else {
    render('session');
  }
}

function skipToEnd() {
  endSession();
}

// ===== ACHIEVEMENTS =====
const ACHIEVEMENTS = [
  { id: 'first_rep',      icon: '🎯', name: 'First Rep',      desc: 'Complete your first session',      check: () => state.stats.totalSessions >= 1 },
  { id: 'week_strong',    icon: '🔥', name: 'Week Strong',    desc: '7-day streak',                     check: () => state.streak.longestStreak >= 7 },
  { id: 'iron_mind',      icon: '🧱', name: 'Iron Mind',      desc: '30-day streak',                    check: () => state.streak.longestStreak >= 30 },
  { id: 'scholar',        icon: '📚', name: 'Scholar',        desc: '50 cards mastered',                check: () => state.stats.cardsMastered >= 50 },
  { id: 'palace_builder', icon: '🏛', name: 'Palace Builder', desc: 'Memory palace with 20+ loci',      check: () => state.palace.totalLoci >= 20 }
];

function checkAchievements() {
  let newUnlocks = [];
  for (const ach of ACHIEVEMENTS) {
    if (!state.achievements.includes(ach.id) && ach.check()) {
      state.achievements.push(ach.id);
      newUnlocks.push(ach);
    }
  }
  if (newUnlocks.length) save();
  return newUnlocks;
}

// ===== IDENTITY MESSAGES =====
function getIdentityMessage(streak, retention) {
  if (streak === 1) return "Day one. You started. That already puts you ahead of most men.";
  if (streak === 7) return "One week in. You're not someone who quit. You're someone who shows up.";
  if (streak === 14) return "Two weeks. This is becoming who you are.";
  if (streak === 21) return "21 days. The research says habits form here. You're proving it.";
  if (streak === 30) return "30 days. You have built something real. Your mind is sharper than it was a month ago.";
  if (streak % 10 === 0) return `Day ${streak}. Most men never get here. You did.`;
  if (retention !== null && retention >= 90) return "You showed up again today. And you're sharp. That's who you are.";
  if (retention !== null && retention >= 70) return "Good session. The reps compound. Keep going.";
  if (retention !== null && retention < 60) return "Working memory gets stronger through the struggle, not around it. Come back tomorrow.";
  return "You showed up again today. That's who you are.";
}

// ===== RENDER ENGINE =====
let currentView = 'home';

function render(view) {
  if (view) currentView = view;
  const app = document.getElementById('app');

  if (!state.profile.onboardingComplete) {
    app.innerHTML = renderOnboarding();
    return;
  }

  app.innerHTML = '';

  if (currentView === 'session') {
    app.innerHTML = renderSession();
  } else if (currentView === 'close') {
    app.innerHTML = renderClose();
  } else if (currentView === 'cards') {
    app.innerHTML = renderNav() + renderCardManager();
  } else if (currentView === 'palace') {
    app.innerHTML = renderNav() + renderPalace();
  } else {
    app.innerHTML = renderNav() + renderHome();
  }
}

// ===== STARTER DECK =====
// 30 cards drawn from memory science research. Loaded on first run.
const STARTER_DECK = [
  // How memory works
  ["What are the three stages of memory?", "Acquisition (taking in information), Consolidation (stabilizing memory traces during sleep), and Recall (retrieving stored information)."],
  ["Why is sleep non-negotiable for memory?", "Sleep is when consolidation happens. Without it, neural traces from the day's learning are not stabilized. Missed sleep cannot be fully recovered on later nights."],
  ["What does the hippocampus do?", "It consolidates short-term memories into long-term storage, primarily during sleep. Damage here prevents new long-term memories from forming."],
  ["What is the Ebbinghaus Forgetting Curve?", "Without review, most new information is lost within 24-48 hours. Memory decays exponentially unless deliberately reviewed."],
  ["How does exercise affect memory?", "Moderate-intensity exercise (60-85% max heart rate) stimulates neuroplasticity and supports memory function. Consistency matters more than session length — 2-4x per week for 8-24 weeks minimum."],

  // Spaced repetition
  ["What is spaced repetition?", "Distributing retrieval practice over gradually increasing intervals so that each review happens at the optimal moment — just before forgetting. Proven to be the most effective long-term retention strategy."],
  ["What is the optimal spaced repetition interval sequence?", "First review: 1 day. Second: 3 days. Third: 7 days. Fourth: 14 days. Fifth: 30 days. Intervals expand as retention strengthens."],
  ["What is the spacing effect?", "Memory is significantly stronger when study sessions are spaced over time rather than massed together (cramming). Coined by Ebbinghaus in 1885, confirmed by hundreds of studies since."],

  // Active recall
  ["What is active recall?", "Actively struggling to retrieve information WITHOUT looking at the source. The act of retrieval itself strengthens the neural memory trace."],
  ["What is the 'illusion of competence'?", "Passive review (rereading, highlighting, watching) makes material feel familiar without actually being retained. You feel like you know it, but can't produce it."],
  ["What does meta-analysis say about practice testing vs. other study methods?", "Practice testing is rated 'high utility' — vastly superior to concept mapping, elaborative interrogation, and rereading. The testing effect is one of the most replicated findings in cognitive psychology."],
  ["What is the testing effect?", "The act of retrieving information from memory actually alters and strengthens the memory trace itself. Being tested is not just measurement — it is learning."],

  // Method of Loci
  ["What is the Method of Loci (Memory Palace)?", "An ancient spatial mnemonic technique: you anchor vivid mental images of information to specific locations along a familiar physical route. Used by memory champions worldwide."],
  ["What cognitive mechanisms make the Memory Palace work?", "Dual coding (pairing visual imagery with verbal/factual information), the self-reference effect (placing yourself in the scene), and elaborative processing (creating meaningful associations)."],
  ["What is the 'Dr. Faust effect' in memory palace use?", "Overloading a single locus with too much data causes memory traces to bleed together. Leave mental 'white space' between loci."],
  ["What types of information is the Memory Palace best suited for?", "Sequential information, lists, narratives, names and faces — anything that benefits from spatial ordering and vivid imagery."],

  // Working memory
  ["What is working memory?", "The active mental workspace for holding and manipulating information in real time. Think of it as your mental RAM. Limited capacity — typically 4-7 chunks."],
  ["What does Dual N-Back training reliably improve?", "Working memory capacity and attentional control (effect size SMD 0.18-0.37). Claims of boosted general IQ were overstated — those studies used passive control groups."],

  // Deliberate practice
  ["What separates deliberate practice from naive practice?", "Deliberate practice: individualized training designed by a coach or system, operating in the zone of proximal development, with immediate feedback targeting specific weaknesses. Naive practice: routine activity with no targeted goals."],
  ["What is the zone of proximal development?", "The space between what you can do without help and what you can't yet do at all. Effective training always operates here — challenging but not overwhelming."],
  ["Why does intense focus matter for memory encoding?", "Deliberate practice requires intense concentration. Even elite performers max out at 4-5 hours/day. For a busy dad, 5 minutes of genuine focus beats 30 minutes of distracted review."],

  // Cognitive load
  ["What is extraneous cognitive load?", "Mental strain caused by poor design — unnecessary complexity, split attention, or redundant information. It consumes working memory without building knowledge. Minimize it."],
  ["What is germane cognitive load?", "The productive mental effort required to build new mental schemas. This is the work that creates actual learning. Maximize it."],
  ["What is the split-attention effect?", "When related information is separated on the page or screen, the brain must mentally integrate them, increasing cognitive load. Keep related information physically integrated."],
  ["What is dual coding theory?", "Combining verbal and visual information slightly expands working memory capacity and significantly improves retention. Words + images are encoded through separate channels, reinforcing each other."],

  // Habit formation
  ["What is the Fogg Behavior Model?", "B = MAP. A behavior occurs only when Motivation, Ability, and a Prompt converge simultaneously. When a habit fails, increase Ability (simplify the task) rather than chasing higher motivation."],
  ["What is habit stacking?", "Pairing a new behavior with an existing automatic habit. 'After I pour my morning coffee, I open the memory trainer.' The existing habit becomes the cue."],
  ["What is the Atomic Habits loop?", "Cue (make it obvious) → Craving (make it attractive) → Response (make it easy) → Reward (make it satisfying). Lasting habits require engineering all four stages."],
  ["What does identity have to do with habit change?", "Lasting change requires a shift in how you see yourself, not just what you do. 'I am someone who trains my mind daily' is more durable than any motivation strategy."],

  // Gamification
  ["What is 'motivational crowding out' in gamification?", "Heavy reliance on external rewards (badges, points, leaderboards) eventually destroys intrinsic motivation. Once the rewards stop, the behavior stops. Gamify the core activity itself, not wrappers around it."],
  ["What triggers a flow state?", "Flow (Csikszentmihalyi) is triggered when challenge level perfectly matches current skill level. Too easy = boredom. Too hard = anxiety. The sweet spot produces intense focus and loss of self-consciousness."],
];

function loadStarterDeck() {
  const existing = new Set(state.cards.map(c => c.front));
  for (const [front, back] of STARTER_DECK) {
    if (!existing.has(front)) {
      state.cards.push(createCard(front, back));
    }
  }
  save();
}

// ===== ONBOARDING =====
function renderOnboarding() {
  return `
    <div class="page fade-in">
      <div class="onboarding-logo">
        <span class="logo-mark">🧠</span>
        <h1>Memory Trainer</h1>
        <p class="mt-8">5 minutes a day. Sharper mind. Every day.</p>
      </div>
      <div class="card">
        <p class="text-sm text-muted mb-16">30 science-backed training cards are loaded and ready. Just enter your name and start.</p>
        <div class="form-group">
          <label>What's your name?</label>
          <input type="text" id="ob-name" placeholder="Nathaniel" />
        </div>
        <button class="btn btn-primary btn-full btn-lg" onclick="finishOnboarding()">Start Training</button>
      </div>
    </div>`;
}

function finishOnboarding() {
  const nameEl = document.getElementById('ob-name');
  const name = nameEl ? nameEl.value.trim() : '';
  state.profile.name = name || 'Athlete';
  state.profile.onboardingComplete = true;
  loadStarterDeck();
  save();
  render('home');
}

// ===== HOME SCREEN =====
function renderHome() {
  checkStreakIntegrity();
  const unlocks = checkAchievements();
  const due = getDueCards().length;
  const newAvail = getNewCards(5).length;
  const totalNew = state.cards.filter(c => c.repetitions === 0).length;
  const todayDone = state.streak.history[today()] === true;

  const retentionLast = state.stats.retentionHistory.slice(-1)[0];
  const retentionDisplay = retentionLast ? `${retentionLast.rate}%` : '--';

  return `
    <div class="page fade-in">
      <div class="streak-hero card">
        <div class="streak-number">${state.streak.count}</div>
        <div class="streak-label">Day Streak</div>
        ${state.streak.freezeAvailable ? '<span class="streak-freeze-badge">Streak Freeze Ready</span>' : ''}
        ${todayDone ? '<div class="pill pill-green mt-8">Session complete today</div>' : ''}
      </div>

      <div class="row mt-8 gap-8">
        <div class="stat-chip green">
          <span class="value">${retentionDisplay}</span>
          <span class="label">Retention</span>
        </div>
        <div class="stat-chip accent">
          <span class="value">${state.stats.cardsMastered}</span>
          <span class="label">Mastered</span>
        </div>
        <div class="stat-chip yellow">
          <span class="value">${state.streak.longestStreak}</span>
          <span class="label">Best Streak</span>
        </div>
      </div>

      <div class="card mt-16">
        <div class="text-muted text-sm mb-16">
          ${due > 0
            ? `<strong class="text-accent">${due}</strong> cards due for review`
            : totalNew > 0
              ? `<strong class="text-green">${Math.min(totalNew, 5)}</strong> new cards ready to learn`
              : 'You\'re fully caught up. Add new cards in the Cards tab.'}
        </div>
        <button class="btn btn-primary btn-full btn-lg" onclick="startSession()" ${due === 0 && totalNew === 0 ? 'disabled' : ''}>
          ${todayDone ? 'Train Again' : state.stats.totalSessions === 0 ? 'Start Your First Session' : 'Start Today\'s Session'}
        </button>
      </div>

      ${renderRetentionChart()}
      ${renderCalendarGrid()}
      ${renderAchievements()}
    </div>`;
}

function renderRetentionChart() {
  if (state.stats.retentionHistory.length < 2) return '';
  const recent = state.stats.retentionHistory.slice(-14);
  const max = Math.max(...recent.map(r => r.rate), 1);
  const bars = recent.map(r => {
    const h = Math.round((r.rate / max) * 100);
    return `<div class="chart-bar" style="height:${h}%" title="${r.date}: ${r.rate}%"></div>`;
  }).join('');
  return `
    <div class="card mt-8">
      <div class="text-xs text-muted mb-8">Retention Rate (last ${recent.length} sessions)</div>
      <div class="chart-container">${bars}</div>
    </div>`;
}

function renderCalendarGrid() {
  const days = last28Days();
  const t = today();
  const cells = days.map(d => {
    const done = state.streak.history[d] === true || state.streak.history[d] === 'frozen';
    const isToday = d === t;
    const isFuture = d > t;
    let cls = 'cal-day';
    if (done) cls += ' done';
    if (isToday) cls += ' today';
    if (isFuture) cls += ' future';
    return `<div class="${cls}" title="${d}"></div>`;
  }).join('');
  return `
    <div class="card mt-8">
      <div class="text-xs text-muted mb-8">Last 28 days</div>
      <div class="calendar-grid">${cells}</div>
    </div>`;
}

function renderAchievements() {
  const badges = ACHIEVEMENTS.map(ach => {
    const unlocked = state.achievements.includes(ach.id);
    return `
      <div class="badge ${unlocked ? 'unlocked' : 'locked'}" title="${ach.desc}">
        <span class="badge-icon">${ach.icon}</span>
        <span class="badge-name">${ach.name}</span>
      </div>`;
  }).join('');
  return `
    <div class="card mt-8">
      <div class="text-xs text-muted mb-12">Achievements</div>
      <div class="achievements-row">${badges}</div>
    </div>`;
}

// ===== SESSION SCREEN =====
function renderSession() {
  const allCards = [...session.dueCards, ...session.newCardQueue];
  const total = allCards.length;
  const idx = session.currentCardIndex;
  const progress = total > 0 ? Math.round((idx / total) * 100) : 0;
  const elapsed = Math.floor((Date.now() - session.startTime) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  const phaseLabel = session.phase === 'new' ? 'New Material' : 'Review';
  const card = allCards[idx];

  if (!card) {
    endSession();
    return '';
  }

  const isNew = session.phase === 'new' || session.newCardQueue.find(c => c.id === card.id);

  return `
    <div style="width:100%;max-width:600px;padding-top:16px;" class="fade-in">
      <div class="session-header">
        <div>
          <div class="phase-label"><span>${phaseLabel}</span></div>
          <div class="text-xs text-muted mt-4">Card ${idx + 1} of ${total}</div>
        </div>
        <div class="timer-display">${mm}:${ss}</div>
        <button class="btn btn-ghost btn-sm" onclick="skipToEnd()">End Session</button>
      </div>

      <div class="progress-bar-track mb-16">
        <div class="progress-bar-fill ${session.phase === 'new' ? 'green' : ''}" style="width:${progress}%"></div>
      </div>

      ${isNew ? renderNewMaterialCard(card) : renderRecallCard(card)}

      ${idx < session.dueCards.length - 1 && session.phase === 'recall' ? `
        <div class="text-center mt-16">
          <button class="btn btn-ghost btn-sm" onclick="skipToNewMaterial()">Skip to New Material</button>
        </div>` : ''}
    </div>`;
}

function renderRecallCard(card) {
  if (!session.revealed) {
    return `
      <div class="flashcard-container">
        <div class="flashcard">
          <span class="card-label">Recall</span>
          <div class="card-text">${escHtml(card.front)}</div>
        </div>
      </div>
      <div class="form-group mt-16">
        <label>Type your answer</label>
        <textarea id="attempt-input" placeholder="What do you remember?" rows="3" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();submitAttempt();}"></textarea>
      </div>
      <button class="btn btn-primary btn-full" onclick="submitAttempt()">Submit Answer</button>
      <button class="btn btn-ghost btn-full mt-8 text-sm" onclick="submitAttempt()">I'm blank... show me</button>`;
  }

  const attempt = session.userAttempt || '';
  return `
    <div class="flashcard-container">
      <div class="flashcard">
        <span class="card-label">Compare</span>
        <div class="card-text">${escHtml(card.front)}</div>
        ${attempt ? `
          <div class="attempt-section">
            <div class="attempt-label">Your answer:</div>
            <div class="attempt-text">${escHtml(attempt)}</div>
          </div>` : '<div class="attempt-section"><div class="attempt-label">You left it blank.</div></div>'}
        <div class="card-answer">
          <div class="answer-label">Correct answer:</div>
          ${escHtml(card.back)}
        </div>
      </div>
    </div>
    <p class="text-center text-muted text-sm mt-8">Now that you can compare, how did you do?</p>
    <div class="rating-grid">
      <button class="rating-btn blackout" onclick="rateCard(1)">Blackout<br><span style="font-size:0.7em;opacity:0.8">Totally wrong</span></button>
      <button class="rating-btn hard"     onclick="rateCard(2)">Hard<br><span style="font-size:0.7em;opacity:0.8">Partially right</span></button>
      <button class="rating-btn good"     onclick="rateCard(3)">Good<br><span style="font-size:0.7em;opacity:0.8">Got the gist</span></button>
      <button class="rating-btn easy"     onclick="rateCard(4)">Easy<br><span style="font-size:0.7em;opacity:0.8">Nailed it</span></button>
    </div>`;
}

function renderNewMaterialCard(card) {
  // Phase 1: Study the material
  if (!session.studied) {
    return `
      <div class="flashcard-container">
        <div class="flashcard">
          <span class="card-label">New Material — Study</span>
          <div class="card-text">${escHtml(card.front)}</div>
          <div class="card-answer" style="color: var(--text);">${escHtml(card.back)}</div>
        </div>
      </div>
      <p class="text-center text-muted text-sm mt-8">Read and absorb this. When you're ready, you'll type it back from memory.</p>
      <button class="btn btn-primary btn-full mt-12" onclick="session.studied=true;render('session')">I've Got It — Test Me</button>`;
  }

  // Phase 2: Type from memory
  if (!session.revealed) {
    return `
      <div class="flashcard-container">
        <div class="flashcard">
          <span class="card-label">New Material — Retrieve</span>
          <div class="card-text">${escHtml(card.front)}</div>
        </div>
      </div>
      <div class="form-group mt-16">
        <label>Type what you remember</label>
        <textarea id="attempt-input" placeholder="What do you remember?" rows="3" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();submitAttempt();}"></textarea>
      </div>
      <button class="btn btn-primary btn-full" onclick="submitAttempt()">Submit Answer</button>
      <button class="btn btn-ghost btn-full mt-8 text-sm" onclick="submitAttempt()">I'm blank... show me</button>`;
  }

  // Phase 3: Compare and rate
  const attempt = session.userAttempt || '';
  return `
    <div class="flashcard-container">
      <div class="flashcard">
        <span class="card-label">Compare</span>
        <div class="card-text">${escHtml(card.front)}</div>
        ${attempt ? `
          <div class="attempt-section">
            <div class="attempt-label">Your answer:</div>
            <div class="attempt-text">${escHtml(attempt)}</div>
          </div>` : '<div class="attempt-section"><div class="attempt-label">You left it blank.</div></div>'}
        <div class="card-answer">
          <div class="answer-label">Correct answer:</div>
          ${escHtml(card.back)}
        </div>
      </div>
    </div>
    <p class="text-center text-muted text-sm mt-8">How close were you?</p>
    <div class="rating-grid">
      <button class="rating-btn blackout" onclick="rateCard(1)">Blackout<br><span style="font-size:0.7em;opacity:0.8">Totally wrong</span></button>
      <button class="rating-btn hard"     onclick="rateCard(2)">Hard<br><span style="font-size:0.7em;opacity:0.8">Partially right</span></button>
      <button class="rating-btn good"     onclick="rateCard(3)">Good<br><span style="font-size:0.7em;opacity:0.8">Got the gist</span></button>
      <button class="rating-btn easy"     onclick="rateCard(4)">Easy<br><span style="font-size:0.7em;opacity:0.8">Nailed it</span></button>
    </div>`;
}

// ===== SESSION CLOSE =====
function renderClose() {
  const scores = session.sessionScores;
  const rate = session.sessionRetention;
  const reviewed = scores.length;
  const newUnlocks = checkAchievements();
  const msg = getIdentityMessage(state.streak.count, rate);
  const tomorrow = getDueCards().length; // after updates

  return `
    <div class="page fade-in">
      <div class="card session-close">
        <div style="font-size:2.5rem;">✅</div>
        <h2 class="mt-12">Session Complete</h2>

        <div class="row mt-24 gap-8">
          <div class="stat-chip green">
            <span class="value">${rate !== null ? rate + '%' : '--'}</span>
            <span class="label">Retention</span>
          </div>
          <div class="stat-chip accent">
            <span class="value">${reviewed}</span>
            <span class="label">Reviewed</span>
          </div>
          <div class="stat-chip yellow">
            <span class="value">${state.streak.count}</span>
            <span class="label">Day Streak</span>
          </div>
        </div>

        <div class="identity-message mt-24">"${msg}"</div>

        ${state.stats.cardsMastered > 0 ? `<p class="text-sm text-muted mt-8">Cards Mastered: <strong class="text-green">${state.stats.cardsMastered}</strong></p>` : ''}

        ${tomorrow > 0 ? `<p class="text-sm text-muted mt-8">Tomorrow: <strong>${tomorrow}</strong> cards due for review.</p>` : '<p class="text-sm text-muted mt-8">You\'re caught up. Add new cards to keep growing.</p>'}

        ${newUnlocks.length ? `
          <div class="mt-16">
            <p class="text-sm text-yellow">Achievement Unlocked!</p>
            <div class="achievements-row mt-8">
              ${newUnlocks.map(a => `<div class="badge unlocked"><span class="badge-icon">${a.icon}</span><span class="badge-name">${a.name}</span></div>`).join('')}
            </div>
          </div>` : ''}

        ${state.streak.freezeAvailable ? '<p class="pill pill-accent mt-16">Streak Freeze earned — one missed day won\'t break your streak</p>' : ''}
      </div>

      <button class="btn btn-primary btn-full mt-8" onclick="render(\'home\')">Back to Home</button>
    </div>`;
}

// ===== CARD MANAGER =====
function renderCardManager() {
  const due = getDueCards();
  const cards = state.cards.slice().sort((a, b) => (a.nextReview || '').localeCompare(b.nextReview || ''));

  return `
    <div class="page fade-in">
      <div class="row space-between mb-16">
        <h2>My Cards</h2>
        <button class="btn btn-primary btn-sm" onclick="showAddCardModal()">+ Add Card</button>
      </div>

      <div class="card mb-16">
        <button class="btn btn-ghost btn-full" onclick="showImportModal()">Import Cards (paste Q/A or CSV)</button>
      </div>

      ${cards.length === 0 ? '<div class="card text-center text-muted">No cards yet. Add your first card above.</div>' : ''}

      ${cards.map(c => `
        <div class="card mb-8">
          <div class="row space-between">
            <div style="flex:1">
              <p class="text-sm" style="color:var(--text);font-weight:600;">${escHtml(c.front)}</p>
              <p class="text-sm text-muted mt-4">${escHtml(c.back)}</p>
            </div>
            <button class="btn btn-ghost btn-sm" onclick="deleteCard('${c.id}');render('cards')" style="color:var(--red);margin-left:8px;">Delete</button>
          </div>
          <div class="row mt-8 gap-8">
            ${c.mastered ? '<span class="pill pill-green">Mastered</span>' : ''}
            ${due.find(d => d.id === c.id) ? '<span class="pill pill-yellow">Due today</span>' : ''}
            <span class="text-xs text-muted">Next: ${c.nextReview || 'today'} &middot; Reps: ${c.repetitions}</span>
          </div>
        </div>`).join('')}
    </div>`;
}

// ===== MEMORY PALACE =====
function renderPalace() {
  return `
    <div class="page fade-in">
      <div class="row space-between mb-16">
        <h2>Memory Palace</h2>
        <button class="btn btn-primary btn-sm" onclick="showAddRoomModal()">+ Add Room</button>
      </div>

      <div class="card mb-16" style="border-left: 3px solid var(--accent);">
        <p class="text-sm" style="color:var(--text);">Pick a familiar place, like your home. Each room holds a set of "loci" (locations). You mentally place vivid images at each locus to anchor information.</p>
      </div>

      <div class="row gap-8 mb-16">
        <div class="stat-chip accent">
          <span class="value">${state.palace.rooms.length}</span>
          <span class="label">Rooms</span>
        </div>
        <div class="stat-chip green">
          <span class="value">${state.palace.totalLoci}</span>
          <span class="label">Total Loci</span>
        </div>
      </div>

      ${state.palace.rooms.length === 0 ? '<div class="card text-center text-muted">No rooms yet. Add your first room to start building your palace.</div>' : ''}

      ${state.palace.rooms.map((room, ri) => `
        <div class="palace-room">
          <div class="row space-between">
            <h3>${escHtml(room.name)}</h3>
            <div class="row gap-8">
              <button class="btn btn-ghost btn-sm" onclick="showAddLocusModal(${ri})">+ Locus</button>
              <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteRoom(${ri})">Delete</button>
            </div>
          </div>
          ${room.loci.length === 0 ? '<p class="text-sm text-muted mt-8">No loci yet. Add a location in this room.</p>' : `
          <ul class="loci-list">
            ${room.loci.map((locus, li) => `
              <li class="loci-item">
                <span class="loci-number">${li + 1}</span>
                <span class="loci-desc">${escHtml(locus.description)}</span>
                <span>${locus.item ? escHtml(locus.item) : '<em style="color:var(--border)">empty</em>'}</span>
                <button class="btn btn-ghost btn-sm" onclick="promptAssignItem(${ri}, ${li})" style="padding:4px 8px;font-size:0.7rem;">Assign</button>
              </li>`).join('')}
          </ul>`}
        </div>`).join('')}
    </div>`;
}

// Palace actions
function deleteRoom(ri) {
  const lociCount = state.palace.rooms[ri].loci.length;
  state.palace.rooms.splice(ri, 1);
  state.palace.totalLoci = state.palace.rooms.reduce((sum, r) => sum + r.loci.length, 0);
  save();
  render('palace');
}

function promptAssignItem(ri, li) {
  const item = prompt('What item/concept is placed here?');
  if (item === null) return;
  state.palace.rooms[ri].loci[li].item = item.trim();
  save();
  render('palace');
}

// ===== MODALS =====
function showModal(html) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'modal-overlay';
  overlay.innerHTML = `<div class="modal">${html}</div>`;
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
  document.body.appendChild(overlay);
}

function closeModal() {
  const el = document.getElementById('modal-overlay');
  if (el) el.remove();
}

function showAddCardModal() {
  showModal(`
    <h3 class="mb-16">Add a Card</h3>
    <div class="form-group">
      <label>Question / Cue (front)</label>
      <input type="text" id="m-front" placeholder="What is the spacing effect?" />
    </div>
    <div class="form-group">
      <label>Answer (back)</label>
      <textarea id="m-back" placeholder="Memory is stronger when study sessions are spaced over time rather than massed together."></textarea>
    </div>
    <div class="row gap-8">
      <button class="btn btn-ghost" style="flex:1" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" style="flex:2" onclick="submitAddCard()">Add Card</button>
    </div>`);
}

function submitAddCard() {
  const front = document.getElementById('m-front').value.trim();
  const back  = document.getElementById('m-back').value.trim();
  if (!front || !back) return;
  addCard(front, back);
  closeModal();
  // Re-render current view
  if (currentView === 'cards') render('cards');
  else render();
}

function showImportModal() {
  showModal(`
    <h3 class="mb-8">Import Cards</h3>
    <p class="text-sm text-muted mb-16">Paste cards in Q/A format or as front,back CSV.</p>
    <div class="form-group">
      <label>Q/A Format</label>
      <textarea id="m-import" placeholder="Q: What is active recall?&#10;A: Actively retrieving information without looking at the source.&#10;&#10;Q: What is the forgetting curve?&#10;A: Ebbinghaus found that memory decays exponentially without review." style="min-height:200px;"></textarea>
    </div>
    <div class="row gap-8">
      <button class="btn btn-ghost" style="flex:1" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" style="flex:2" onclick="submitImport()">Import</button>
    </div>`);
}

function submitImport() {
  const text = document.getElementById('m-import').value;
  const count = importCards(text);
  closeModal();
  alert(`${count} card${count !== 1 ? 's' : ''} imported.`);
  render('cards');
}

function showAddRoomModal() {
  showModal(`
    <h3 class="mb-16">Add a Room</h3>
    <div class="form-group">
      <label>Room Name</label>
      <input type="text" id="m-room" placeholder="Front Door, Living Room, Kitchen..." />
    </div>
    <div class="row gap-8">
      <button class="btn btn-ghost" style="flex:1" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" style="flex:2" onclick="submitAddRoom()">Add Room</button>
    </div>`);
}

function submitAddRoom() {
  const name = document.getElementById('m-room').value.trim();
  if (!name) return;
  state.palace.rooms.push({ name, loci: [] });
  save();
  closeModal();
  render('palace');
}

function showAddLocusModal(ri) {
  showModal(`
    <h3 class="mb-16">Add a Locus to "${escHtml(state.palace.rooms[ri].name)}"</h3>
    <div class="form-group">
      <label>Location Description</label>
      <input type="text" id="m-locus" placeholder="The red armchair in the corner" />
    </div>
    <div class="row gap-8">
      <button class="btn btn-ghost" style="flex:1" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" style="flex:2" onclick="submitAddLocus(${ri})">Add Locus</button>
    </div>`);
}

function submitAddLocus(ri) {
  const desc = document.getElementById('m-locus').value.trim();
  if (!desc) return;
  state.palace.rooms[ri].loci.push({ description: desc, item: '' });
  state.palace.totalLoci = state.palace.rooms.reduce((sum, r) => sum + r.loci.length, 0);
  save();
  closeModal();
  render('palace');
}

// ===== NAV =====
function renderNav() {
  const views = [
    { id: 'home',   icon: '🏠', label: 'Home' },
    { id: 'cards',  icon: '🗂', label: 'Cards' },
    { id: 'palace', icon: '🏛', label: 'Palace' }
  ];
  return `
    <div class="bottom-nav">
      ${views.map(v => `
        <button class="nav-item ${currentView === v.id ? 'active' : ''}" onclick="render('${v.id}')">
          <span class="icon">${v.icon}</span>
          <span>${v.label}</span>
        </button>`).join('')}
    </div>`;
}

// ===== UTILITIES =====
function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ===== INIT =====
function init() {
  load();
  checkStreakIntegrity();
  render('home');

  // Update timer display every second during active session
  setInterval(() => {
    if (session.active && currentView === 'session') {
      const timerEl = document.querySelector('.timer-display');
      if (timerEl) {
        const elapsed = Math.floor((Date.now() - session.startTime) / 1000);
        const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const ss = String(elapsed % 60).padStart(2, '0');
        timerEl.textContent = `${mm}:${ss}`;
      }
    }
  }, 1000);
}

window.addEventListener('DOMContentLoaded', init);
