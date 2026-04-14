// exercises.js
// Phase 2+ exercise modules. Currently provides Memory Palace guided prompts
// and visualization helpers. Future: Name/Face module, Dual N-Back.

// ===== MEMORY PALACE GUIDED VISUALIZATION =====

const VISUALIZATION_PROMPTS = [
  "Close your eyes. Walk to your locus. See the space clearly — the light, the texture, the smell. Now place your item there. Make it enormous. Make it ridiculous. See it moving.",
  "Place your item at the locus, but give it a sound. What does it sound like? The stranger the better. Your brain remembers strange.",
  "Your item is at the locus. Now make it interact with the space — it's knocking things over, glowing, talking. The more action, the stronger the memory trace.",
  "See yourself in the scene. You're standing next to your item. You reach out and touch it. What does it feel like? Texture matters.",
  "Your item is at the locus. Now zoom out — see the whole room with the item in it. Then zoom back in. Drill the location into your mind.",
  "Give your item a color that doesn't belong. A bright purple version of whatever it is. Color contrast forces the brain to encode it differently.",
  "Your item at the locus is doing something completely absurd. It's singing, spinning, or interacting with you directly. Lean into the absurdity — that's the point.",
];

function getVisualizationPrompt() {
  return VISUALIZATION_PROMPTS[Math.floor(Math.random() * VISUALIZATION_PROMPTS.length)];
}

// ===== IDENTITY MESSAGES (extended set) =====
// Used by app.js getIdentityMessage — extended version

const IDENTITY_MESSAGES_BY_STREAK = {
  1:  "Day one. You started. That already puts you ahead of most men.",
  2:  "Day two. You came back. That's the harder part.",
  3:  "Three days in a row. You're building something.",
  5:  "Five days. The habit is forming. Keep the chain going.",
  7:  "One week. You're not someone who quit. You're someone who shows up.",
  10: "Ten days. This is not a phase. This is becoming a practice.",
  14: "Two weeks. This is becoming who you are.",
  21: "21 days. The research says habits form here. You're proving it.",
  30: "30 days. You have built something real. Your mind is sharper than it was a month ago.",
  60: "60 days. Two months of daily reps. Most men will never understand what that takes.",
  90: "90 days. You've trained your mind for a quarter year. That's rare. That's you."
};

const IDENTITY_MESSAGES_BY_RETENTION = {
  high:   "You showed up again today. And you're sharp. That's who you are.",
  medium: "Good session. The reps compound. Keep going.",
  low:    "Working memory gets stronger through the struggle, not around it. Come back tomorrow.",
  none:   "You showed up again today. That's who you are."
};

// Expose a getter for app.js to use
function getIdentityMessageExtended(streak, retention) {
  // Check milestone streaks first
  for (const day of [90, 60, 30, 21, 14, 10, 7, 5, 3, 2, 1]) {
    if (streak === day && IDENTITY_MESSAGES_BY_STREAK[day]) {
      return IDENTITY_MESSAGES_BY_STREAK[day];
    }
  }

  if (streak > 0 && streak % 10 === 0) {
    return `Day ${streak}. Most men never get here. You did.`;
  }

  if (retention === null || retention === undefined) return IDENTITY_MESSAGES_BY_RETENTION.none;
  if (retention >= 90) return IDENTITY_MESSAGES_BY_RETENTION.high;
  if (retention >= 65) return IDENTITY_MESSAGES_BY_RETENTION.medium;
  return IDENTITY_MESSAGES_BY_RETENTION.low;
}

// Override app.js getIdentityMessage with the extended version
// This runs after app.js is loaded, so we redefine it here
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    // exercises.js loaded before app.js finishes — safe to override after DOM ready
  });
}

// Make available globally
window.getVisualizationPrompt = getVisualizationPrompt;
window.getIdentityMessageExtended = getIdentityMessageExtended;

// ===== PALACE REVIEW EXERCISE =====
// Called during session if user has palace rooms with assigned items

function buildPalaceReviewQuiz(rooms) {
  const pairs = [];
  for (const room of rooms) {
    for (let i = 0; i < room.loci.length; i++) {
      const locus = room.loci[i];
      if (locus.item && locus.item.trim()) {
        pairs.push({
          room: room.name,
          locusIndex: i + 1,
          description: locus.description,
          item: locus.item
        });
      }
    }
  }
  // Shuffle
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }
  return pairs.slice(0, 5); // max 5 per session
}

window.buildPalaceReviewQuiz = buildPalaceReviewQuiz;

// ===== FUTURE: NAME & FACE MODULE (Phase 2) =====
// Structure for when this is built out:
//
// function renderNameFaceExercise(pair) {
//   // pair = { name, feature, link }
//   // Show name + distinctive feature
//   // User creates visual link (e.g., "Marcus → mark on cheek")
//   // Test: show feature description, user recalls name
// }

// ===== FUTURE: DUAL N-BACK MODULE (Phase 3, unlocks at 30-day streak) =====
// Structure:
//
// const NBACK_GRID_SIZE = 9; // 3x3
// let nbackN = 2;
// let nbackHistory = [];
// let nbackHits = 0, nbackMisses = 0, nbackFalseAlarms = 0;
//
// function startNBack() { ... }
// function nbackTick() { ... }  // show next position every 3s
// function nbackRespond() { ... } // user says "match"
// function nbackScore() { return dPrime(hits, misses, falseAlarms, total); }
// function dPrime(hits, misses, fa, total) { ... } // signal detection metric
