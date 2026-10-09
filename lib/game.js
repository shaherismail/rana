/**
 * Game engine for the classroom quiz (Who Wants to be a Millionaire style).
 * Pure logic — no DOM. index.html drives this and renders the results.
 *
 * Difficulty ladder: 15 levels. Questions are pulled from the selected
 * lesson sorted easiest-first. If a lesson has fewer than 15 questions,
 * the ladder repeats from the start (never runs out mid-lesson).
 */

export const TOTAL_LEVELS = 15;

/** Classic "safe haven" milestones — prize money is banked here. */
export const MILESTONES = [5, 10];

/** Prize ladder in points (not currency — it's a kids' classroom game). */
export const PRIZE_LADDER = [
  100, 200, 300, 500, 1000,   // 1-5
  2000, 4000, 8000, 16000, 32000, // 6-10
  64000, 125000, 250000, 500000, 1000000, // 11-15
];

export const OPTION_LETTERS = ['A', 'B', 'C', 'D'];

/**
 * Build a game session.
 * @param {object} opts
 * @param {Array} opts.questions  Questions for the lesson (any count).
 * @param {'solo'|'teams'} opts.mode
 * @param {number} opts.timerSeconds  0 = timer disabled.
 */
export function createGame({ questions, mode = 'solo', timerSeconds = 0 }) {
  if (!questions || !questions.length) {
    throw new Error('لا توجد أسئلة في هذا الدرس. أضف أسئلة من لوحة التحكم أولًا.');
  }

  // Repeat the lesson list to fill all 15 levels if needed.
  const ladder = [];
  for (let i = 0; i < TOTAL_LEVELS; i++) {
    ladder.push(questions[i % questions.length]);
  }

  const state = {
    mode,
    timerSeconds,
    ladder,
    level: 0,          // 0-based index into ladder
    activeTeam: 0,     // 0 = blue, 1 = red (teams mode)
    teams: [
      { name: 'الفريق الأزرق', color: 'blue', score: 0, emoji: '🔵', reached: 0 },
      { name: 'الفريق الأحمر', color: 'red', score: 0, emoji: '🔴', reached: 0 },
    ],
    score: 0,          // solo mode
    reachedLevel: 0,
    lifelines: {
      fiftyFifty: true,
      audiencePoll: true,
    },
    eliminated: [],    // options removed by 50:50 on current question
    pollResult: null,
    lockedAnswer: null,
    answered: false,
    isOver: false,
    errors: [],        // wrong-answer log for analytics
  };

  return state;
}

export function currentQuestion(state) {
  return state.ladder[state.level];
}

export function currentPrize(state) {
  return PRIZE_LADDER[state.level] ?? 0;
}

/** Highest banked milestone at or below the given level index. */
export function bankedPrize(levelIndex) {
  let banked = 0;
  for (const m of MILESTONES) {
    if (levelIndex + 1 >= m) banked = PRIZE_LADDER[m - 1];
  }
  return banked;
}

/* ------------------------------------------------------------------ */
/* Lifelines                                                           */
/* ------------------------------------------------------------------ */

/**
 * 50:50 — remove two wrong options. Returns the letters to keep.
 * Mutates state.eliminated.
 */
export function useFiftyFifty(state) {
  if (!state.lifelines.fiftyFifty || state.answered) return null;
  state.lifelines.fiftyFifty = false;

  const q = currentQuestion(state);
  const correct = q.correct_option;
  const wrong = OPTION_LETTERS.filter((l) => l !== correct);
  // Shuffle and drop two of the three wrong options.
  for (let i = wrong.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [wrong[i], wrong[j]] = [wrong[j], wrong[i]];
  }
  state.eliminated = wrong.slice(0, 2);
  return state.eliminated;
}

/**
 * Audience poll — the teacher counts raised hands and enters percentages.
 * @param {number[]} percents  Four numbers 0-100 for A,B,C,D.
 */
export function useAudiencePoll(state, percents) {
  if (!state.lifelines.audiencePoll || state.answered) return null;
  state.lifelines.audiencePoll = false;
  state.pollResult = percents.slice(0, 4).map((p) => Math.max(0, Math.min(100, Number(p) || 0)));
  return state.pollResult;
}

/* ------------------------------------------------------------------ */
/* Answer flow                                                         */
/* ------------------------------------------------------------------ */

/**
 * Lock in an answer and evaluate it.
 * @param {string} letter  A/B/C/D
 * @returns {object} { correct, prize, banked, isOver }
 */
export function lockAnswer(state, letter) {
  if (state.answered || state.isOver) return null;
  const q = currentQuestion(state);
  state.lockedAnswer = letter;
  state.answered = true;

  const correct = letter === q.correct_option;
  let isOver = false;

  if (correct) {
    state.score = currentPrize(state);
    state.reachedLevel = state.level;
    state.teams[state.activeTeam].reached = state.level;
    state.teams[state.activeTeam].score = currentPrize(state);

    // Advance after a short delay (the UI handles the pacing).
    if (state.level + 1 >= TOTAL_LEVELS) {
      isOver = true; // beat the ladder!
    }
  } else {
    state.errors.push({
      question_id: q.id,
      grade: q.grade,
      unit: q.unit,
      picked_option: letter,
      correct_option: q.correct_option,
      at: new Date().toISOString(),
    });
    // Wrong answer ends the turn; the other team gets the board (teams mode),
    // or the game ends (solo mode).
    if (state.mode === 'solo') {
      isOver = true;
    } else {
      // Switch teams and step back one level so the new team faces a question.
      state.activeTeam = 1 - state.activeTeam;
      if (state.level > 0) state.level -= 1;
      resetForNextQuestion(state);
    }
  }

  return {
    correct,
    prize: correct ? currentPrize(state) : 0,
    banked: bankedPrize(state.reachedLevel),
    isOver,
  };
}

/** Clear per-question state for the next question. */
function resetForNextQuestion(state) {
  state.eliminated = [];
  state.pollResult = null;
  state.lockedAnswer = null;
  state.answered = false;
}

/**
 * Move to the next question after a correct answer.
 * Returns true if the game continues.
 */
export function nextQuestion(state) {
  if (state.isOver) return false;
  if (state.level + 1 >= TOTAL_LEVELS) {
    state.isOver = true;
    return false;
  }
  state.level += 1;
  resetForNextQuestion(state);
  return true;
}

/** The other team takes the board without the current team losing (walk-away). */
export function switchTeam(state) {
  if (state.mode !== 'teams' || state.isOver) return false;
  state.activeTeam = 1 - state.activeTeam;
  resetForNextQuestion(state);
  return true;
}

/** End the game and return final results. */
export function endGame(state) {
  state.isOver = true;
  if (state.mode === 'solo') {
    return { winner: null, soloScore: bankedPrize(state.reachedLevel), errors: state.errors };
  }
  const [blue, red] = state.teams;
  let winner = null;
  if (blue.score > red.score) winner = blue;
  else if (red.score > blue.score) winner = red;
  return { winner, soloScore: 0, errors: state.errors };
}
