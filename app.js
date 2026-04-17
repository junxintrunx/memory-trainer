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
      // Migration: existing users without topic selection get a fresh start
      if (state.profile.onboardingComplete && !state.profile.topicsSelected) {
        state.profile.onboardingComplete = false;
        state.cards = [];
        state.stats = JSON.parse(JSON.stringify(defaultState.stats));
        state.streak = JSON.parse(JSON.stringify(defaultState.streak));
        state.achievements = [];
        save();
      }
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
  session.autoGrade = null;

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

// ===== AUTO-GRADING =====
const STOP_WORDS = new Set([
  'a','an','the','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','shall','should','may','might','can','could',
  'of','in','to','for','with','on','at','from','by','about','as','into','through',
  'during','before','after','above','below','between','under','again','further',
  'then','once','that','this','these','those','it','its','and','but','or','nor',
  'not','no','so','if','when','than','too','very','just','also','more','most',
  'other','some','such','only','same','how','what','which','who','whom','why',
  'where','here','there','each','every','all','both','few','many','much','own',
  'because','while','although','though','since','until','unless','however',
  'therefore','thus','hence','yet','still','already','often','never','always',
  'sometimes','usually','rather','quite','well','way','even','get','got','make',
  'made','like','use','used','one','two','three','first','new','know','think',
  'take','come','see','them','they','their','you','your','we','our','i','me','my',
  'he','she','him','her','his','us','up','out','over','down','off','back','work',
  'called','means','refers','known','term','thing','things','something','part',
  'form','type','types','based','using','without','within','along','across'
]);

// Number-word to digit mapping
const NUM_WORDS = {
  zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,
  ten:10,eleven:11,twelve:12,fifteen:15,twenty:20,thirty:30,fifty:50,hundred:100
};

// Abbreviation ↔ full form mapping (bidirectional matching)
const ABBREVIATIONS = {
  'gi':'glycemic index','gl':'glycemic load','bmi':'body mass index',
  'bmr':'basal metabolic rate','tdee':'total daily energy expenditure',
  'rda':'recommended daily allowance','hiit':'high intensity interval training',
  'liss':'low intensity steady state','hr':'heart rate','bp':'blood pressure',
  'cns':'central nervous system','pns':'peripheral nervous system',
  'rem':'rapid eye movement','ldl':'low density lipoprotein',
  'hdl':'high density lipoprotein','epa':'eicosapentaenoic acid',
  'dha':'docosahexaenoic acid','vo2':'oxygen consumption',
  'neat':'non exercise activity thermogenesis',
  'epoc':'excess post exercise oxygen consumption',
  'crp':'c reactive protein','hpa':'hypothalamic pituitary adrenal',
  'rom':'range of motion','rpe':'rate of perceived exertion',
  'amrap':'as many reps as possible','emom':'every minute on the minute',
  'doms':'delayed onset muscle soreness','mps':'muscle protein synthesis',
  'mpb':'muscle protein breakdown','rmr':'resting metabolic rate',
  'tef':'thermic effect of food','rhr':'resting heart rate',
  'hrv':'heart rate variability','mhr':'max heart rate',
  'eer':'estimated energy requirement','dri':'dietary reference intake',
  'ai':'adequate intake','ul':'tolerable upper intake level',
  'gerd':'gastroesophageal reflux disease','ibs':'irritable bowel syndrome',
  'sibo':'small intestinal bacterial overgrowth',
  'fodmap':'fermentable oligosaccharides disaccharides monosaccharides and polyols'
};
// Reverse map: full-form word → [abbreviation, ...]
const WORD_TO_ABBR = {};
for (const [abbr, full] of Object.entries(ABBREVIATIONS)) {
  for (const w of full.split(' ')) {
    if (STOP_WORDS.has(w)) continue;
    if (!WORD_TO_ABBR[w]) WORD_TO_ABBR[w] = [];
    if (!WORD_TO_ABBR[w].includes(abbr)) WORD_TO_ABBR[w].push(abbr);
  }
}

// Low-weight modifier words: common qualifiers that don't test domain knowledge
const LOW_WEIGHT_WORDS = new Set([
  'actual','actually','standard','specific','specifically',
  'particular','particularly','typical','typically',
  'general','generally','normal','normally','regular','regularly',
  'common','commonly','basically','essentially','primarily',
  'mainly','simply','directly','effectively','overall',
  'certain','meaning','example','especially','often',
  'small','large','high','low','good','bad','best','worst',
  'long','short','early','late','fast','slow','found','given'
]);

// Normalize text for grading: lowercase, expand number words, collapse hyphens/ranges
function normalizeForGrading(text) {
  let t = text.toLowerCase().replace(/[^a-z0-9\s.%-]/g, ' ');
  // Expand number words to digits ("two" → "2")
  t = t.replace(/\b[a-z]+\b/g, w => NUM_WORDS[w] !== undefined ? String(NUM_WORDS[w]) : w);
  // Collapse "X to Y" into "X-Y" so ranges match ("2 to 4" → "2-4")
  t = t.replace(/(\d+)\s+to\s+(\d+)/g, '$1-$2');
  // Collapse "X times" or "Xx" frequency notation ("4 times" → "4x")
  t = t.replace(/(\d+)\s*times/g, '$1x');
  return t;
}

// Lightweight stemmer: strip common suffixes to match verb/noun forms
function stem(word) {
  if (word.length <= 3) return word;
  return word
    .replace(/(ating|tion|sion|ment|ness|ance|ence|ity|ous|ive|ful|less|ally|ably|ibly)$/, '')
    .replace(/(ates|ting|ing|ted|ed|es|er|ly|al|s)$/, '')
    || word;
}

function extractKeyTerms(text) {
  const normalized = normalizeForGrading(text);
  const words = normalized
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));

  // Also extract meaningful multi-word phrases (2-word combos)
  const allWords = normalized.split(/\s+/).filter(w => w.length > 1);
  const phrases = [];
  for (let i = 0; i < allWords.length - 1; i++) {
    if (!STOP_WORDS.has(allWords[i]) && !STOP_WORDS.has(allWords[i + 1])) {
      phrases.push(allWords[i] + ' ' + allWords[i + 1]);
    }
  }

  return { words: [...new Set(words)], phrases: [...new Set(phrases)] };
}

// Check if a keyword appears in the user text (with stemming + synonym fallback)
function keywordMatch(userText, userStems, keyword, userWords) {
  // Direct substring match (handles multi-char tokens, numbers, ranges)
  if (userText.includes(keyword)) return true;
  // Stem-based match
  const kwStem = stem(keyword);
  if (kwStem.length > 2 && userStems.has(kwStem)) return true;
  // Abbreviation → full form: keyword is an abbreviation, check if user wrote it out
  if (ABBREVIATIONS[keyword] && userText.includes(ABBREVIATIONS[keyword])) return true;
  // Full form → abbreviation: keyword is part of a full form, check if user used the abbreviation
  if (WORD_TO_ABBR[keyword]) {
    for (const abbr of WORD_TO_ABBR[keyword]) {
      if (userWords.has(abbr)) return true;
    }
  }
  return false;
}

function gradeAttempt(attempt, correctAnswer) {
  if (!attempt || attempt.trim().length === 0) return { rating: 1, pct: 0, matched: [], missed: [] };

  const answer = extractKeyTerms(correctAnswer);
  const userNorm = normalizeForGrading(attempt);

  // Pre-compute stems and word set for fast lookup
  const userTokens = userNorm.split(/\s+/).filter(w => w.length > 1);
  const userStems = new Set(userTokens.map(w => stem(w)));
  const userWords = new Set(userTokens);

  // Check which key terms the user hit
  const matched = [];
  const missed = [];

  for (const word of answer.words) {
    if (keywordMatch(userNorm, userStems, word, userWords)) {
      matched.push(word);
    } else {
      missed.push(word);
    }
  }

  // Concept grouping: when two adjacent keywords form a phrase in the answer
  // and the user hit one but missed the other, give partial credit for the miss
  const matchedSet = new Set(matched);
  const conceptRecovered = new Set();
  for (const phrase of answer.phrases) {
    const [w1, w2] = phrase.split(' ');
    if (matchedSet.has(w1) && !matchedSet.has(w2) && !conceptRecovered.has(w2)) {
      conceptRecovered.add(w2);
    } else if (matchedSet.has(w2) && !matchedSet.has(w1) && !conceptRecovered.has(w1)) {
      conceptRecovered.add(w1);
    }
  }

  // Phrase bonus for exact multi-word matches
  let phraseBonus = 0;
  for (const phrase of answer.phrases) {
    if (userNorm.includes(phrase)) phraseBonus += 0.5;
  }

  // Weighted scoring: low-weight modifiers count less, concept-recovered get partial credit
  const weight = (w) => LOW_WEIGHT_WORDS.has(w) ? 0.3 : 1.0;
  let totalWeight = 0;
  let earnedWeight = 0;

  for (const word of answer.words) {
    const w = weight(word);
    totalWeight += w;
    if (matchedSet.has(word)) {
      earnedWeight += w;
    } else if (conceptRecovered.has(word)) {
      earnedWeight += w * 0.5;
    }
  }
  earnedWeight += phraseBonus;

  if (totalWeight === 0) return { rating: 3, pct: 100, matched, missed };

  const rawPct = (earnedWeight / totalWeight) * 100;
  const pct = Math.min(100, Math.round(rawPct));

  let rating;
  if (pct >= 80)      rating = 4; // Easy — nailed it
  else if (pct >= 55)  rating = 3; // Good — got the gist
  else if (pct >= 25)  rating = 2; // Hard — partially right
  else                 rating = 1; // Blackout — missed it

  return { rating, pct, matched, missed };
}

function submitAttempt() {
  const el = document.getElementById('attempt-input');
  session.userAttempt = el ? el.value.trim() : '';

  // Auto-grade
  const allCards = [...session.dueCards, ...session.newCardQueue];
  const card = allCards[session.currentCardIndex];
  if (card) {
    session.autoGrade = gradeAttempt(session.userAttempt, card.back);
  }

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
// ===== TOPIC DECKS =====
// Each deck is sourced from NotebookLM research notebooks
const TOPIC_DECKS = {
  cognition: {
    name: 'Cognition & Memory Training',
    icon: '🧠',
    desc: 'Spaced repetition, deliberate practice, working memory, habit formation',
    cards: [
      ["What is the 'spacing effect' in cognitive psychology?", "Distributing learning across multiple time intervals significantly enhances long-term memory retention compared to massed learning or cramming."],
      ["How does retrieval practice differ from passive review?", "Passive review relies on familiarity memory, creating an illusion of mastery. Active retrieval practice strengthens recollective memory, creating deeper neural traces and improving long-term retention by 30-50%."],
      ["What does the Ebbinghaus forgetting curve illustrate?", "Memory retention drops rapidly over time following an exponential decay pattern unless information is actively retrieved and repeatedly reinforced."],
      ["What specific criteria distinguish deliberate practice from naive practice?", "Deliberate practice requires well-defined goals, intense concentration, and immediate informative feedback to successively refine performance. Naive practice is routine activity with no targeted goals."],
      ["Why is deliberate practice limited to 4-5 hours per day for elite performers?", "It requires such intense concentration and mental effort that it cannot be sustained indefinitely without extensive rest and recovery to maintain training quality."],
      ["How does deliberate practice structure the acquisition of complex skills?", "It breaks down a complex target skill into smaller, attainable sub-skills that can be practiced and refined in isolation before being integrated."],
      ["What cognitive mechanism is targeted by the dual n-back task?", "Dual n-back targets working memory by forcing the brain to simultaneously track, maintain, and update two independent streams of stimuli (visual and auditory) while managing interference."],
      ["Does dual n-back training significantly increase general fluid intelligence?", "No. When compared against active control groups, the far-transfer effect on general fluid intelligence drops to near zero. It reliably improves working memory and attentional control only."],
      ["What is d-prime and why is it the preferred metric for dual n-back?", "D-prime is a signal-detection metric that measures true working memory ability by distinguishing actual matches from non-matches, bypassing raw accuracy which can be skewed by guessing."],
      ["What is the optimal protocol for dual n-back training?", "20-25 minutes daily split into 4-5 shorter sessions, 4-5 days per week, for a minimum of 4 weeks."],
      ["What is the foundational mechanism of the Method of Loci?", "It leverages spatial memory by encoding information as vivid, exaggerated mental images and anchoring them along an ordered sequence of familiar physical locations."],
      ["How does the Method of Loci leverage context-dependent memory?", "Mentally navigating the familiar locations during recall systematically reinstates the original encoding context, which acts as a robust retrieval cue."],
      ["Which brain regions are predominantly activated when using the Method of Loci?", "It functionally reorganizes the brain to rely on posterior navigation networks, heavily activating the hippocampus, parahippocampus, and retrosplenial cortex."],
      ["What are the three types of cognitive load?", "Intrinsic load (inherent difficulty of the topic), extraneous load (unnecessary strain from poor instructional design), and germane load (productive effort required to build mental schemas)."],
      ["What is the 'worked example effect'?", "Novices learn better by studying step-by-step solved problems rather than solving them independently, because it reduces extraneous cognitive load on working memory."],
      ["What is the split-attention effect?", "Working memory is overloaded when a learner must simultaneously process and mentally integrate two physically separated sources of information, like a diagram and disconnected text."],
      ["What is the core formula of the Fogg Behavior Model?", "B = MAP. A behavior occurs only when Motivation, Ability, and a Prompt converge simultaneously. When a habit fails, increase Ability (simplify the task) rather than chasing motivation."],
      ["What are the three types of prompts in the Fogg Behavior Model?", "A Facilitator (high motivation, low ability), a Spark (high ability, low motivation), and a Signal (both motivation and ability are already high)."],
      ["What are the four stages of the Atomic Habits loop?", "Cue triggers a craving, which motivates a response, which yields a reward that satisfies the craving and reinforces the cue. Engineer all four stages for lasting habits."],
      ["What is habit stacking and why is it effective?", "Pairing a new desired behavior with a current automatic habit. It utilizes existing neural pathways to effectively bypass the need for high motivation."],
      ["What balance of conditions is required to achieve a flow state?", "A perfect balance between perceived task difficulty and individual skill level, along with clearly defined goals and immediate feedback."],
      ["How does a flow state physically alter brain function?", "The prefrontal cortex temporarily deactivates, a process called transient hypofrontality, causing loss of self-awareness and distorted sense of time while implicit brain systems take over."],
      ["Which brainwave patterns correlate with the flow state?", "Increased theta wave activity and moderate alpha wave activity, particularly in the frontal and central regions of the brain."],
      ["Which phase of memory processing occurs during sleep?", "Memory consolidation, where fragile neural traces acquired during the day are strengthened and stabilized into long-term storage."],
      ["How does sleep deprivation damage the brain's memory architecture?", "It dismantles neuronal connectivity by dramatically reducing dendritic spines and dendrite length in the CA1 region of the hippocampus."],
      ["What molecular pathway dismantles dendritic spines during sleep loss?", "Sleep deprivation elevates PDE4A5, suppressing the cAMP-PKA-LIMK signaling pathway. This increases cofilin activity, a protein that severs actin filaments in spines."],
      ["What is the optimal exercise intensity for improving cognitive function?", "Moderate-intensity exercise reaching 60-85% of maximum heart rate is consistently associated with the most significant cognitive benefits."],
      ["When evaluating exercise for cognitive health, what matters more than session length?", "Consistency and adherence over time. 30-minute sessions provide similar benefits to 60-minute sessions."],
      ["Which cognitive domain requires the longest exercise program to improve?", "Executive function requires long-term multi-component exercise interventions lasting 25 weeks or more, while global cognition improves with shorter programs."],
      ["According to Ericsson, what is the true source of 'innate talent' in elite performers?", "Exceptional characteristics are not from unique genetic talent but from physiological and anatomical adaptations caused by a minimum of 10 years of intense deliberate practice."],
    ]
  },
  regulation: {
    name: 'Blood Sugar & Regulation',
    icon: '🩸',
    desc: 'Glucose, insulin, mood, cognition, meal strategy',
    cards: [
      ["What two primary hormones from the pancreas regulate glucose homeostasis?", "Insulin and glucagon. Insulin promotes glucose uptake into tissues to lower blood sugar after a meal, while glucagon stimulates the liver to release stored glucose during a fasted state."],
      ["Which cells in the pancreas produce insulin and glucagon?", "Insulin is produced by beta cells (65-80% of pancreatic islet cells). Glucagon is secreted from alpha cells (15-20% of islet cells)."],
      ["How does the body defend against low blood sugar?", "Low glucose is a severe survival threat to the brain. The body uses glucagon to stimulate hepatic glucose production, and if blood sugar drops too quickly, it releases cortisol and adrenaline to force levels back up."],
      ["What is the main difference between Glycemic Index and Glycemic Load?", "GI measures how quickly a food raises blood sugar. GL integrates GI with the actual amount of carbohydrates in a specific portion, providing a more accurate real-world impact on blood sugar."],
      ["Why does watermelon have a high GI but a low GL?", "Watermelon has a high GI (74) because its sugars are rapidly absorbed, but a standard serving contains very little actual carbohydrate, so its glycemic load is only 4."],
      ["How does a high-glycemic load diet affect mood?", "High-GL diets are associated with 38% higher scores for depressive symptoms and 26% higher scores for fatigue and inertia compared to low-GL diets."],
      ["What is reactive hypoglycemia?", "A condition where blood sugar drops below normal levels after eating a meal, usually within a four-hour window, caused by an exaggerated second-phase insulin secretion."],
      ["What mechanism causes the blood sugar crash in reactive hypoglycemia?", "An exaggerated, delayed second-phase secretion of insulin overshoots and removes glucose from the blood too quickly, driving blood sugar down and causing a crash."],
      ["Can reactive hypoglycemia mimic other severe conditions?", "Yes. In extreme cases it can mimic a stroke or TIA in non-diabetic individuals, with symptoms like hemiparesis or difficulty speaking."],
      ["How does glycemic variability affect mood?", "Rapid fluctuations in blood sugar correlate strongly with negative affect, anxiety, and depression. Rapid spikes and drops trigger sympathetic overactivity, leading to restlessness and irritability."],
      ["What are the cognitive consequences of acute hypoglycemia?", "It starves the brain of its primary fuel, causing dizziness, confusion, brain fog, and impaired visual working memory. Severe drops can cause seizures or coma."],
      ["How does chronic hyperglycemia impact executive function?", "It drives neuroinflammation, oxidative stress, and structural damage to the blood-brain barrier, accelerating cognitive decline and impairing processing speed over time."],
      ["How does fructose metabolism differ from glucose in the brain?", "Fructose bypasses the main regulatory step of glycolysis (phosphofructokinase). In the hypothalamus, this unregulated metabolism can rapidly deplete ATP and falsely increase food intake."],
      ["How does fructose affect brain reward centers differently than glucose?", "Fructose causes significantly greater brain reactivity to food cues in the visual cortex and orbital frontal cortex, promoting hunger and desire for high-calorie foods."],
      ["Does fructose trigger the same satiety hormones as glucose?", "No. Fructose does not stimulate insulin or leptin to the same degree as glucose. Because both signal satiety, fructose acts as a much weaker suppressor of appetite."],
      ["What is the 'carbohydrates-last' meal sequencing strategy?", "Eating vegetables (fiber) and protein first, then waiting about 10 minutes before consuming carbohydrates during a meal."],
      ["How effective is changing food order for managing postprandial glucose?", "Consuming protein and vegetables before carbohydrates can reduce incremental postprandial glucose peaks by over 40%."],
      ["Why does eating protein and fiber before carbs stabilize blood sugar?", "Protein slows gastric emptying and blunts the insulin response, while fiber slows glucose absorption. This combination prevents rapid spikes and subsequent energy crashes."],
      ["Why is Alzheimer's sometimes called 'Type 3 Diabetes'?", "Alzheimer's is deeply linked to brain-specific insulin resistance, which impairs glucose metabolism, promotes amyloid-beta accumulation, and drives neurodegeneration."],
      ["How does insulin resistance affect amyloid-beta clearance?", "Hyperinsulinemia competitively inhibits insulin-degrading enzyme (IDE), which clears both insulin and amyloid-beta. This diverts IDE activity and favors plaque accumulation."],
      ["What role does GSK-3 beta play in insulin-resistant neurodegeneration?", "Insulin resistance removes inhibition of GSK-3 beta, which then abnormally phosphorylates tau proteins, forming neurofibrillary tangles and destabilizing the neuronal cytoskeleton."],
      ["Can restoring brain insulin signaling reverse early cognitive decline?", "Animal models and clinical trials suggest brain insulin resistance is reversible. Intranasal insulin has been shown to restore signaling, reduce amyloid burden, and improve memory recall."],
      ["How do CGMs benefit non-diabetic individuals?", "They provide real-time glycemic data to identify personal trigger foods and patterns that lead to energy crashes, optimizing diet and activity choices."],
      ["What have CGMs revealed about exercise timing?", "Personalizing exercise timing, such as walking right before an individual's specific postprandial glucose peak, significantly reduces glucose, insulin, and C-peptide levels."],
      ["What non-dietary factors elevate blood glucose in non-diabetics?", "Psychological stress and poor sleep quality can significantly elevate blood glucose levels even without any food intake."],
      ["How does dysglycemia cause 'glutamate dominance' in the brain?", "High-glucose environments and chronic stress disrupt the balance between inhibitory GABA and excitatory glutamate, leading to neurotoxic excess glutamate associated with anxiety and insomnia."],
      ["How does the brain's reward system adapt to rapid glucose spikes?", "Rapid spikes trigger dopamine release, reinforcing sugar cravings. Frequent spikes downregulate dopamine receptors, requiring more sugar for the same satisfaction."],
      ["How does brain insulin resistance affect dopamine?", "Central insulin resistance directly impairs dopamine turnover, decreasing reward processing and triggering compensatory overeating and anxiety."],
      ["How do sudden blood sugar drops affect stress hormones?", "A rapid drop triggers sympathetic release of adrenaline and cortisol to mobilize stored glucose. This surge directly causes anxiety, tremors, and agitation."],
      ["How can CGMs be used as a behavioral motivation tool?", "Seeing tangible, immediate data on how physical activity positively impacts physiology increases readiness and motivation to engage in behavior change."],
    ]
  },
  facebook: {
    name: 'Facebook & Organic Growth',
    icon: '📱',
    desc: 'Algorithm, reach, automation, monetization, 2026 rules',
    cards: [
      ["What is the highest-weighted engagement metric in the 2026 Facebook algorithm?", "The Private Share, when users send a post to friends via Messenger or WhatsApp. This signals high utility and trust, prompting the AI to recommend the post to a wider audience."],
      ["What is the '6-Hour Testing Window' in Facebook's algorithm?", "The first 6 hours after posting are critical for measuring interaction density. High interaction during this window can extend a post's organic lifespan for up to seven days."],
      ["How does the '9 to 12 Post Rule' affect content reach?", "Facebook scans an account's last 9 to 12 posts to assign a 'brand tag.' Posting about scattered, unrelated topics dilutes reach because the AI cannot accurately define the target audience."],
      ["How do follower limits differ between personal profiles and Professional Mode?", "Personal profiles are limited to 5,000 friends. Professional Mode removes this cap, allowing unlimited public followers while maintaining the traditional friend limit."],
      ["How do admin capabilities differ between Business Pages and Professional Mode?", "Business Pages support multiple administrative roles (editors, moderators). Professional Mode profiles are managed solely by the account owner with no role delegation."],
      ["How often can admins switch a Business Page's category designation?", "Meta allows switching between 'Business' and 'Creator' categories once every seven days."],
      ["What is the 'First 3 Seconds Rule' for organic video?", "Users decide whether to stay on a video in less than 3 seconds. A strong hook must be front-loaded to capture attention and ensure high video completion rates."],
      ["What is the optimal weekly posting frequency for organic reach?", "3 to 5 times per week. This maintains visibility without triggering algorithmic 'follower fatigue' from low-quality spam."],
      ["Why has the 'Comment-to-DM' strategy become essential for sharing links?", "Meta is testing limits restricting non-verified accounts to just two external links per month in captions. Marketers post without links, ask users to comment a keyword, then auto-DM the link."],
      ["What is ManyChat primarily used for in Facebook marketing?", "A visual flow builder that creates complex conversation paths for Business Pages, heavily used to trigger automated DM replies based on specific comment keywords and capture lead data."],
      ["What is the '24-hour standard messaging window' enforced by Meta?", "Businesses can reply freely within 24 hours of a user's last interaction. Messages outside this window require approved message tags or explicit opt-ins for marketing messages."],
      ["What compliance tag is needed for ManyChat DMs triggered by comments?", "The first automated message must be tagged as a 'Comment Reply' inside ManyChat. Without this tag, the automation risks violating Meta's 24-hour messaging rule."],
      ["What is the primary function of Meta Business Suite?", "A centralized front-end dashboard for day-to-day management: scheduling posts, managing unified inboxes across Facebook and Instagram, and viewing basic analytics."],
      ["What is the primary function of Meta Business Manager?", "Back-end administrative tool for large teams and agencies, used to manage multiple ad accounts, assign granular role-based permissions, and handle complex billing and integrations."],
      ["How do advertising capabilities differ between Business Suite and Business Manager?", "Business Suite only supports basic ad management like post boosting. Business Manager provides full Ads Manager access with custom audiences, A/B testing, and budget optimization."],
      ["How do engagement rates compare between Facebook Groups and Business Pages?", "Active private Groups frequently see 20%+ engagement rates. Public Business Pages typically average just 2-4%."],
      ["What is the core difference in content flow between a Page and a Group?", "A Page is a one-to-many broadcast tool for announcements. A Group is a many-to-many environment for community discussion and member-to-member interaction."],
      ["How does Facebook's algorithm distribute Group content vs Page content?", "Page content relies on AI-driven distribution based on engagement signals. Group content visibility is largely user-driven, depending on notification settings and peer engagement."],
      ["What is the Facebook Content Monetization Program?", "A consolidated earning system merging In-stream ads, Ads on Reels, and Performance Bonuses into one place, tracking earnings across Reels, long-form video, photos, and text posts."],
      ["What are the baseline requirements for Facebook video monetization in 2026?", "At least 10,000 followers, 5 active public posts or videos, and 600,000 minutes of watch time across all videos in the past 60 days."],
      ["What is the Creator Fast Track program?", "An initiative offering established creators from other platforms guaranteed monthly pay for three months, requiring at least 15 eligible original Reels per month on 10 separate days."],
      ["When is a reaction video classified as 'unoriginal' under Meta's 2026 rules?", "When the creator merely watches silently, reacts only with facial expressions, or narrates what is already visible. Original reaction videos must add fresh analysis or substantive commentary."],
      ["What are the penalties for repeatedly posting unoriginal content?", "Reduced reach across ALL posts (not just the unoriginal ones), loss of monetization eligibility, and classification as non-recommendable to new audiences."],
      ["How does Meta treat videos with watermarks from other platforms?", "Videos with visible TikTok or YouTube watermarks are explicitly flagged as unoriginal and deprioritized in feed and Reels recommendations."],
      ["How does browser fingerprinting trigger automation bans?", "Security algorithms collect hardware/software data to create a persistent digital identity. Multiple accounts sharing the same fingerprint get flagged and banned for multi-accounting."],
      ["How do human pattern triggers expose automated accounts?", "Sending the exact same number of requests daily or performing monotonous actions creates predictable patterns. Automation must randomize delays and mimic human browsing behaviors."],
      ["What are the risks of cheap VPNs or shared proxies for automation?", "They are associated with scraping bots, and if one user on a shared proxy is flagged for spam, all accounts on that IP neighborhood may be banned."],
      ["What is Manus AI's role within Meta Ads Manager?", "An autonomous partner that analyzes ad performance, profiles audiences, and shifts budgets from underperforming ads to winning campaigns, handling data extraction and report generation."],
      ["How does Manus AI integrate with WhatsApp Business?", "It connects directly to WhatsApp to automate lead interactions: checking calendars, pulling pricing documents, and drafting context-aware professional responses in seconds."],
      ["How is Manus AI paired with AdAmigo.ai?", "Manus provides strategy and data analysis but lacks creative generation. AdAmigo autonomously creates on-brand image and video ad variations based on Manus's strategic insights."],
    ]
  }
};

// Legacy: keep STARTER_DECK pointing to cognition for backwards compatibility
const STARTER_DECK = TOPIC_DECKS.cognition.cards;

function loadStarterDeck() {
  // Legacy: load cognition deck if no topic was chosen (existing users)
  loadDeck('cognition');
}

function loadDeck(deckId) {
  const deck = TOPIC_DECKS[deckId];
  if (!deck) return;
  const existing = new Set(state.cards.map(c => c.front));
  for (const [front, back] of deck.cards) {
    if (!existing.has(front)) {
      state.cards.push(createCard(front, back));
    }
  }
  save();
}

function loadSelectedDecks(deckIds) {
  for (const id of deckIds) {
    loadDeck(id);
  }
}

// ===== ONBOARDING =====
function renderOnboarding() {
  const deckOptions = Object.entries(TOPIC_DECKS).map(([id, deck]) => `
    <label class="deck-option" onclick="toggleDeck('${id}')">
      <input type="checkbox" id="deck-${id}" value="${id}" />
      <span class="deck-card">
        <span class="deck-icon">${deck.icon}</span>
        <span class="deck-info">
          <strong>${deck.name}</strong>
          <span class="text-sm text-muted">${deck.desc}</span>
          <span class="text-sm text-muted">${deck.cards.length} cards</span>
        </span>
      </span>
    </label>`).join('');

  return `
    <div class="page fade-in">
      <div class="onboarding-logo">
        <span class="logo-mark">🧠</span>
        <h1>Memory Trainer</h1>
        <p class="mt-8">5 minutes a day. Sharper mind. Every day.</p>
      </div>
      <div class="card">
        <div class="form-group">
          <label>What's your name?</label>
          <input type="text" id="ob-name" placeholder="Nathaniel" value="${state.profile.name || ''}" />
        </div>
        <div class="form-group">
          <label>Pick your topic${Object.keys(TOPIC_DECKS).length > 1 ? 's' : ''}</label>
          <p class="text-sm text-muted mb-8">Choose what you want to train on. You can add more later.</p>
          <div class="deck-picker">${deckOptions}</div>
        </div>
        <button class="btn btn-primary btn-full btn-lg" id="ob-start-btn" onclick="finishOnboarding()" disabled>Select a topic to start</button>
      </div>
    </div>`;
}

function toggleDeck(id) {
  // Update button state based on selections
  setTimeout(() => {
    const checked = document.querySelectorAll('.deck-picker input:checked');
    const btn = document.getElementById('ob-start-btn');
    if (btn) {
      btn.disabled = checked.length === 0;
      btn.textContent = checked.length > 0 ? 'Start Training' : 'Select a topic to start';
    }
  }, 0);
}

function finishOnboarding() {
  const nameEl = document.getElementById('ob-name');
  const name = nameEl ? nameEl.value.trim() : '';
  state.profile.name = name || 'Athlete';
  state.profile.onboardingComplete = true;
  state.profile.topicsSelected = true;

  // Load selected decks
  const checked = document.querySelectorAll('.deck-picker input:checked');
  const selectedIds = Array.from(checked).map(el => el.value);
  if (selectedIds.length > 0) {
    loadSelectedDecks(selectedIds);
  } else {
    loadStarterDeck(); // fallback
  }
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
  const grade = session.autoGrade || { rating: 1, pct: 0, matched: [], missed: [] };
  const ratingLabels = ['', 'Blackout', 'Hard', 'Good', 'Easy'];
  const ratingColors = ['', 'var(--red)', 'var(--yellow)', 'var(--green)', 'var(--accent)'];

  return `
    <div class="flashcard-container">
      <div class="flashcard">
        <span class="card-label">Results</span>
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

    <div class="grade-result mt-16">
      <div class="grade-score" style="border-color:${ratingColors[grade.rating]}">
        <span class="grade-pct" style="color:${ratingColors[grade.rating]}">${grade.pct}%</span>
        <span class="grade-label" style="color:${ratingColors[grade.rating]}">${ratingLabels[grade.rating]}</span>
      </div>
      ${grade.matched.length > 0 ? `<div class="grade-terms"><span class="grade-terms-label text-green">Hit:</span> ${grade.matched.map(w => `<span class="term-pill hit">${escHtml(w)}</span>`).join(' ')}</div>` : ''}
      ${grade.missed.length > 0 ? `<div class="grade-terms"><span class="grade-terms-label text-red">Missed:</span> ${grade.missed.map(w => `<span class="term-pill miss">${escHtml(w)}</span>`).join(' ')}</div>` : ''}
    </div>

    <button class="btn btn-primary btn-full mt-16" onclick="rateCard(${grade.rating})">Continue</button>
    <div class="override-row mt-8">
      <span class="text-xs text-muted">Override: </span>
      ${[1,2,3,4].filter(r => r !== grade.rating).map(r => `<button class="btn btn-ghost btn-sm" onclick="rateCard(${r})" style="color:${ratingColors[r]};padding:4px 10px;font-size:0.75rem;">${ratingLabels[r]}</button>`).join('')}
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

  // Phase 3: Auto-graded results
  const attempt = session.userAttempt || '';
  const grade = session.autoGrade || { rating: 1, pct: 0, matched: [], missed: [] };
  const ratingLabels = ['', 'Blackout', 'Hard', 'Good', 'Easy'];
  const ratingColors = ['', 'var(--red)', 'var(--yellow)', 'var(--green)', 'var(--accent)'];

  return `
    <div class="flashcard-container">
      <div class="flashcard">
        <span class="card-label">Results</span>
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

    <div class="grade-result mt-16">
      <div class="grade-score" style="border-color:${ratingColors[grade.rating]}">
        <span class="grade-pct" style="color:${ratingColors[grade.rating]}">${grade.pct}%</span>
        <span class="grade-label" style="color:${ratingColors[grade.rating]}">${ratingLabels[grade.rating]}</span>
      </div>
      ${grade.matched.length > 0 ? `<div class="grade-terms"><span class="grade-terms-label text-green">Hit:</span> ${grade.matched.map(w => `<span class="term-pill hit">${escHtml(w)}</span>`).join(' ')}</div>` : ''}
      ${grade.missed.length > 0 ? `<div class="grade-terms"><span class="grade-terms-label text-red">Missed:</span> ${grade.missed.map(w => `<span class="term-pill miss">${escHtml(w)}</span>`).join(' ')}</div>` : ''}
    </div>

    <button class="btn btn-primary btn-full mt-16" onclick="rateCard(${grade.rating})">Continue</button>
    <div class="override-row mt-8">
      <span class="text-xs text-muted">Override: </span>
      ${[1,2,3,4].filter(r => r !== grade.rating).map(r => `<button class="btn btn-ghost btn-sm" onclick="rateCard(${r})" style="color:${ratingColors[r]};padding:4px 10px;font-size:0.75rem;">${ratingLabels[r]}</button>`).join('')}
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
