// Candidate tunes for review. Each: bpm, character, lead/harmony/bass/drums.
export const CANDIDATES = {

/* ==================== HOME / OVERWORLD ==================== */

'home-a': {
  scene: 'Home', name: 'Morning Road', bpm: 118,
  blurb: 'Skipping dotted rhythm, a hook that answers itself, bouncing octave bass. The "setting out on a bright day" one.',
  lead: { duty: 0.5, gain: 0.16, pattern: `
    g4:3 a4:1 c5:4 e5:3 d5:1 c5:4   d5:3 e5:1 g5:4 e5:6 -:2
    f5:3 e5:1 d5:4 c5:3 d5:1 e5:4   d5:8 g4:2 a4:2 b4:4
    c5:3 d5:1 e5:4 g5:3 a5:1 g5:4   e5:3 d5:1 c5:4 d5:6 -:2
    e5:3 f5:1 g5:4 a5:3 g5:1 e5:4   c5:12 g4:2 a4:2` },
  harmony: { duty: 0.25, gain: 0.07, pattern: `
    e4:8 g4:8   f4:8 g4:8   a4:8 g4:8   f4:8 e4:8
    e4:8 c5:8   g4:8 f4:8   g4:8 c5:8   e4:12 d4:4` },
  bass: { gain: 0.22, pattern: `
    c2:2 c3:2 c2:2 c3:2 g2:2 g3:2 g2:2 g3:2   f2:2 f3:2 f2:2 f3:2 g2:2 g3:2 g2:2 g3:2
    a2:2 a3:2 a2:2 a3:2 f2:2 f3:2 f2:2 f3:2   d2:2 d3:2 d2:2 d3:2 g2:2 g3:2 g2:2 g3:2
    c2:2 c3:2 c2:2 c3:2 a2:2 a3:2 a2:2 a3:2   f2:2 f3:2 f2:2 f3:2 g2:2 g3:2 g2:2 g3:2
    c2:2 c3:2 c2:2 c3:2 f2:2 f3:2 f2:2 f3:2   g2:2 g3:2 g2:2 g3:2 c2:4 c3:4` },
  drums: { gain: 0.11, pattern: ('k:2 h:2 s:2 h:2 k:2 h:2 s:2 h:2 '.repeat(8)).trim() },
},

'home-b': {
  scene: 'Home', name: 'Paper Lanterns', bpm: 96,
  blurb: 'Japanese pentatonic (yo scale), swaying and unhurried, with a music-box lead over a soft heartbeat bass. The most "relaxing" option.',
  lead: { duty: 0.5, gain: 0.15, pattern: `
    d5:4 e5:2 g5:2 a5:6 g5:2   e5:4 d5:4 b4:8
    d5:2 e5:2 g5:4 a5:4 b5:4   a5:6 g5:2 e5:8
    g5:4 a5:2 b5:2 d6:6 b5:2   a5:4 g5:4 e5:8
    d5:2 e5:2 g5:4 e5:4 d5:4   b4:8 d5:4 e5:4` },
  harmony: { duty: 0.25, gain: 0.065, pattern: `
    g4:8 b4:8   a4:8 g4:8   b4:8 d5:8   e5:8 d5:8
    b4:8 d5:8   a4:8 g4:8   g4:8 a4:8   b4:8 b4:8` },
  bass: { gain: 0.2, pattern: `
    g2:6 g2:2 d3:8   e2:6 e2:2 b2:8   g2:6 g2:2 d3:8   a2:6 a2:2 e3:8
    b2:6 b2:2 f#3:8   e2:6 e2:2 b2:8   g2:6 g2:2 a2:8   b2:8 b2:8` },
  drums: { gain: 0.07, pattern: ('h:4 -:4 h:4 h:4 '.repeat(8)).trim() },
},

'home-c': {
  scene: 'Home', name: 'The Long Way Round', bpm: 132,
  blurb: 'Brisker and more wistful: a descending hook, a countermelody that argues with it, and a walking bass. Feels like travelling somewhere.',
  lead: { duty: 0.5, gain: 0.16, pattern: `
    c6:4 b5:2 a5:2 g5:4 e5:4   f5:4 e5:2 d5:2 c5:8
    a5:4 g5:2 f5:2 e5:4 c5:4   d5:4 e5:4 g5:8
    c6:4 b5:2 a5:2 g5:4 a5:4   f5:4 g5:2 a5:2 c6:8
    b5:4 a5:2 g5:2 e5:4 d5:4   c5:12 -:4` },
  harmony: { duty: 0.25, gain: 0.075, pattern: `
    e5:4 g5:4 c5:8   a4:4 c5:4 e5:8   c5:4 e5:4 g4:8   b4:4 c5:4 e5:8
    e5:4 d5:4 e5:8   c5:4 e5:4 f5:8   d5:4 f5:4 e5:8   e5:12 -:4` },
  bass: { gain: 0.23, pattern: `
    c3:4 g2:4 a2:4 e2:4   f2:4 c3:4 g2:4 g2:4
    a2:4 e3:4 f2:4 c3:4   g2:4 d3:4 g2:4 b2:4
    c3:4 g2:4 a2:4 e3:4   f2:4 a2:4 c3:4 c3:4
    g2:4 b2:4 d3:4 g2:4   c3:8 g2:4 c3:4` },
  drums: { gain: 0.12, pattern: ('k:2 h:2 s:2 h:2 k:2 k:2 s:2 h:2 '.repeat(8)).trim() },
},

/* ==================== ENCOUNTERS ==================== */

'encounter-a': {
  scene: 'Encounters', name: 'Wild Kanji', bpm: 148,
  blurb: 'Syncopated minor hook with a chromatic bass walk. Urgent without being stressful; the closest in spirit to a battle theme.',
  lead: { duty: 0.25, gain: 0.15, pattern: `
    a5:3 a5:1 e5:2 a5:2 c6:4 b5:4   a5:3 g5:1 e5:2 d5:2 e5:8
    g5:3 g5:1 d5:2 g5:2 b5:4 a5:4   g5:3 f5:1 d5:2 c5:2 d5:8
    a5:3 a5:1 e5:2 a5:2 c6:4 e6:4   d6:3 c6:1 b5:2 a5:2 b5:8
    f5:4 g5:4 a5:4 c6:4   b5:4 a5:4 e5:8` },
  harmony: { duty: 0.5, gain: 0.06, pattern: `
    a4:4 c5:4 e5:4 c5:4   a4:4 b4:4 e5:8
    g4:4 b4:4 d5:4 b4:4   g4:4 a4:4 d5:8
    a4:4 c5:4 e5:4 a5:4   f5:4 e5:4 g5:8
    f4:4 a4:4 c5:4 e5:4   d5:4 c5:4 b4:8` },
  bass: { gain: 0.24, pattern: `
    a2:2 a2:2 a2:2 e3:2 a2:2 a2:2 g#2:2 g2:2   f#2:2 f#2:2 f2:2 f2:2 e2:2 e2:2 e2:2 e2:2
    g2:2 g2:2 g2:2 d3:2 g2:2 g2:2 f#2:2 f2:2   e2:2 e2:2 eb2:2 d2:2 d2:2 d2:2 d2:2 d2:2
    a2:2 a2:2 a2:2 e3:2 a2:2 a2:2 c3:2 e3:2   f2:2 f2:2 f2:2 c3:2 g2:2 g2:2 g2:2 g2:2
    f2:2 f2:2 f2:2 c3:2 f2:2 f2:2 f2:2 f2:2   e2:2 e2:2 e2:2 b2:2 a2:4 a2:4` },
  drums: { gain: 0.14, pattern: ('k:2 h:2 s:2 h:2 k:2 k:2 s:2 h:2 '.repeat(8)).trim() },
},

'encounter-b': {
  scene: 'Encounters', name: 'Face to Face', bpm: 134,
  blurb: 'Call and response: the lead asks a phrase, the harmony answers it. Marching, confident, a bit playful. Less frantic than Wild Kanji.',
  lead: { duty: 0.5, gain: 0.15, pattern: `
    e5:2 e5:2 g5:4 e5:4 -:4   -:8 a5:2 a5:2 c6:4
    d5:2 d5:2 f5:4 d5:4 -:4   -:8 g5:2 g5:2 b5:4
    e5:2 e5:2 g5:4 c6:4 b5:4   a5:4 g5:4 e5:4 d5:4
    c5:2 d5:2 e5:4 g5:4 a5:4   g5:6 e5:2 a4:8` },
  harmony: { duty: 0.25, gain: 0.09, pattern: `
    -:8 a4:2 a4:2 c5:4   e5:2 e5:2 c5:4 a4:8
    -:8 g4:2 g4:2 b4:4   d5:2 d5:2 b4:4 g4:8
    c5:4 c5:4 e5:4 e5:4   f5:4 e5:4 c5:4 b4:4
    a4:4 b4:4 c5:4 e5:4   d5:6 c5:2 a4:8` },
  bass: { gain: 0.23, pattern: `
    a2:4 a2:4 e3:4 a2:4   f2:4 f2:4 c3:4 f2:4
    g2:4 g2:4 d3:4 g2:4   e2:4 e2:4 b2:4 e2:4
    a2:4 e3:4 a2:4 e3:4   f2:4 c3:4 f2:4 c3:4
    a2:4 e3:4 f2:4 c3:4   g2:4 d3:4 a2:8` },
  drums: { gain: 0.13, pattern: ('k:4 h:2 h:2 s:4 h:2 k:2 '.repeat(8)).trim() },
},

/* ==================== NEW SIGHTINGS (LESSONS) ==================== */

'sighting-a': {
  scene: 'New sightings', name: 'First Light', bpm: 104,
  blurb: 'Curious and open: rising phrases that keep discovering something, warm sustained harmony. Calm but not sleepy.',
  lead: { duty: 0.5, gain: 0.14, pattern: `
    f4:4 a4:4 c5:4 f5:4   e5:6 c5:2 a4:8
    g4:4 bb4:4 d5:4 g5:4   f5:6 d5:2 bb4:8
    a4:4 c5:4 f5:4 a5:4   g5:4 f5:4 e5:8
    d5:4 c5:4 bb4:4 a4:4   f4:12 -:4` },
  harmony: { duty: 0.25, gain: 0.07, pattern: `
    c4:8 f4:8   g4:8 a4:8   bb3:8 d4:8   a3:8 c4:8
    f4:8 a4:8   c5:8 bb4:8   a4:8 g4:8   f4:12 -:4` },
  bass: { gain: 0.2, pattern: `
    f2:8 c3:8   a2:8 f2:8   bb1:8 f2:8   c2:8 g2:8
    f2:8 c3:8   d2:8 a2:8   bb1:8 c2:8   f2:12 -:4` },
  drums: { gain: 0.06, pattern: ('h:8 h:4 h:4 '.repeat(8)).trim() },
},

'sighting-b': {
  scene: 'New sightings', name: 'Field Notes', bpm: 112,
  blurb: 'A light waltz in three. Music-box lead, plucked bass. Distinctly different in feel from everything else in the app.',
  lead: { duty: 0.5, gain: 0.14, pattern: `
    c5:6 e5:3 g5:3 e5:6   d5:6 f5:3 a5:3 f5:6
    e5:6 g5:3 c6:3 g5:6   a5:9 g5:3 e5:6
    c5:6 e5:3 g5:3 c6:6   b5:6 a5:3 g5:3 e5:6
    f5:6 e5:3 d5:3 c5:6   c5:12 -:6` },
  harmony: { duty: 0.25, gain: 0.06, pattern: `
    e4:18 f4:18   g4:18 a4:18
    e4:18 g4:18   a4:18 g4:18` },
  bass: { gain: 0.21, pattern: `
    c3:6 g3:6 e3:6   d3:6 a3:6 f3:6   c3:6 g3:6 e3:6   f3:6 c3:6 a2:6
    c3:6 g3:6 e3:6   e3:6 b3:6 g3:6   f3:6 c3:6 a2:6   c3:12 g2:6` },
  drums: { gain: 0.07, pattern: ('k:6 h:6 h:6 '.repeat(8)).trim() },
},

/* ==================== QUIZ ==================== */

'quiz-a': {
  scene: 'Quiz', name: 'Think Fast', bpm: 150,
  blurb: 'A ticking pulse under a short, nagging two-bar hook that loops tightly. Keeps you moving without being a battle theme.',
  lead: { duty: 0.25, gain: 0.14, pattern: `
    e5:2 -:2 e5:2 g5:2 a5:4 g5:4   e5:2 -:2 d5:2 e5:2 g5:8
    d5:2 -:2 d5:2 f5:2 g5:4 f5:4   d5:2 -:2 c5:2 d5:2 e5:8
    e5:2 -:2 g5:2 a5:2 c6:4 b5:4   a5:2 -:2 g5:2 e5:2 d5:8
    c5:2 d5:2 e5:2 g5:2 a5:4 g5:4   e5:8 -:8` },
  harmony: { duty: 0.5, gain: 0.055, pattern: `
    a4:4 c5:4 a4:4 c5:4   b4:4 d5:4 b4:4 d5:4
    g4:4 b4:4 g4:4 b4:4   a4:4 c5:4 a4:4 c5:4
    c5:4 e5:4 c5:4 e5:4   d5:4 b4:4 g4:4 b4:4
    a4:4 c5:4 e5:4 c5:4   a4:8 -:8` },
  bass: { gain: 0.22, pattern: `
    a2:2 -:2 a2:2 -:2 a2:2 -:2 e3:2 -:2   g2:2 -:2 g2:2 -:2 g2:2 -:2 d3:2 -:2
    e2:2 -:2 e2:2 -:2 e2:2 -:2 b2:2 -:2   f2:2 -:2 f2:2 -:2 f2:2 -:2 c3:2 -:2
    a2:2 -:2 a2:2 -:2 c3:2 -:2 e3:2 -:2   g2:2 -:2 g2:2 -:2 b2:2 -:2 d3:2 -:2
    f2:2 -:2 f2:2 -:2 c3:2 -:2 c3:2 -:2   a2:8 -:8` },
  drums: { gain: 0.1, pattern: ('h:2 h:2 h:2 h:2 h:2 h:2 s:2 h:2 '.repeat(8)).trim() },
},

'quiz-b': {
  scene: 'Quiz', name: 'Steady Hand', bpm: 120,
  blurb: 'Quieter and more focused: a low, rolling bass with a sparse lead that leaves gaps to think in. Background music that stays out of the way.',
  lead: { duty: 0.5, gain: 0.11, pattern: `
    a4:4 c5:4 -:8   b4:4 d5:4 -:8
    c5:4 e5:4 -:8   d5:6 c5:2 -:8
    e5:4 d5:4 c5:4 a4:4   b4:4 c5:4 -:8
    a4:4 g4:4 e4:4 g4:4   a4:8 -:8` },
  harmony: { duty: 0.25, gain: 0.05, pattern: `
    e4:16   d4:16   g4:16   f4:16
    e4:16   e4:16   c4:16   a3:16` },
  bass: { gain: 0.22, pattern: `
    a2:4 e3:4 a2:4 e3:4   g2:4 d3:4 g2:4 d3:4
    c3:4 g3:4 c3:4 g3:4   f2:4 c3:4 f2:4 c3:4
    a2:4 e3:4 a2:4 e3:4   e2:4 b2:4 e2:4 b2:4
    f2:4 c3:4 f2:4 c3:4   a2:8 e2:8` },
  drums: { gain: 0.06, pattern: ('h:4 h:4 h:4 h:4 '.repeat(8)).trim() },
},

/* ==================== DEX ==================== */

'dex-a': {
  scene: 'Kanjidex', name: 'Collector', bpm: 92,
  blurb: 'Slow and proud: a broad melody over big sustained chords, like leafing through something you have built. Has an actual tune, unlike the current one.',
  lead: { duty: 0.5, gain: 0.13, pattern: `
    d5:6 f#5:2 a5:8   b5:6 a5:2 f#5:8
    e5:6 g5:2 b5:8   a5:12 -:4
    d6:6 c#6:2 b5:8   a5:6 f#5:2 e5:8
    g5:4 f#5:4 e5:4 d5:4   d5:12 -:4` },
  harmony: { duty: 0.25, gain: 0.06, pattern: `
    d4:16   b3:16   e4:16   a3:16
    d4:16   f#4:16   g4:16   d4:16` },
  bass: { gain: 0.2, pattern: `
    d2:8 a2:8   b1:8 f#2:8   e2:8 b2:8   a1:8 e2:8
    d2:8 a2:8   d2:8 f#2:8   g1:8 d2:8   d2:12 -:4` },
  drums: { gain: 0.05, pattern: ('h:8 -:4 h:4 '.repeat(8)).trim() },
},

'dex-b': {
  scene: 'Kanjidex', name: 'Quiet Shelf', bpm: 76,
  blurb: 'Barely there: two voices drifting, almost no percussion. For browsing without being sung at.',
  lead: { duty: 0.5, gain: 0.1, pattern: `
    a4:8 c5:8   d5:8 e5:8   g5:6 e5:2 d5:8   c5:16
    e5:8 d5:8   c5:8 a4:8   g4:6 a4:2 c5:8   a4:16` },
  harmony: { duty: 0.25, gain: 0.05, pattern: `
    -:16   a4:8 g4:8   -:16   e4:16
    -:16   g4:8 e4:8   -:16   a4:16` },
  bass: { gain: 0.17, pattern: `
    a2:16   f2:16   c3:16   e2:16
    a2:16   f2:16   g2:16   a2:16` },
  drums: { gain: 0.04, pattern: ('h:16 '.repeat(8)).trim() },
},

/* ==================== EVOLUTION (one-shot) ==================== */

'evolution-a': {
  scene: 'Evolution', name: 'Becoming', bpm: 128, once: true,
  blurb: 'Tension then release: a rising chromatic climb that stalls, then bursts into a major fanfare. Built to sit under the flashing glyph.',
  lead: { duty: 0.25, gain: 0.16, pattern: `
    c5:2 c#5:2 d5:2 d#5:2 e5:2 f5:2 f#5:2 g5:2
    g#5:2 a5:2 a#5:2 b5:2 c6:4 -:4
    g5:2 c6:2 e6:4 d6:2 c6:6   g6:8 e6:4 c6:4` },
  harmony: { duty: 0.5, gain: 0.08, pattern: `
    -:16   -:12 g5:4   e5:2 g5:2 c6:4 b5:2 g5:6   e6:8 c6:4 g5:4` },
  bass: { gain: 0.24, pattern: `
    c2:2 c2:2 c2:2 c2:2 c2:2 c2:2 c2:2 c2:2   g2:2 g2:2 g2:2 g2:2 g2:4 -:4
    c3:4 g2:4 c3:8   c3:8 c2:8` },
  drums: { gain: 0.13, pattern: `
    h:2 h:2 h:2 h:2 s:2 s:2 s:2 s:2   s:1 s:1 s:1 s:1 s:1 s:1 s:1 s:1 k:8
    k:2 h:2 s:2 h:2 k:2 s:2 k:2 h:2   k:4 s:4 k:4 k:4` },
},

'evolution-b': {
  scene: 'Evolution', name: 'Seal of Guru', bpm: 116, once: true,
  blurb: 'Shorter and grander: three hammer-blow chords then a bright resolve. Less build-up, more arrival.',
  lead: { duty: 0.5, gain: 0.17, pattern: `
    -:4 g5:2 -:2 g5:2 -:2 g5:4   c6:6 b5:2 c6:8
    e6:4 d6:4 c6:4 g5:4   c6:12 -:4` },
  harmony: { duty: 0.25, gain: 0.08, pattern: `
    -:4 e5:2 -:2 e5:2 -:2 e5:4   e5:6 d5:2 e5:8
    g5:4 f5:4 e5:4 c5:4   e5:12 -:4` },
  bass: { gain: 0.24, pattern: `
    -:4 c3:2 -:2 c3:2 -:2 c3:4   c3:8 g2:8
    c3:4 g2:4 c3:4 e3:4   c3:12 -:4` },
  drums: { gain: 0.14, pattern: `
    -:4 k:2 -:2 k:2 -:2 k:4   k:4 s:4 k:4 s:4
    k:2 h:2 s:2 h:2 k:2 s:2 k:2 h:2   k:4 s:4 k:8` },
},

/* ==================== SHINY (one-shot) ==================== */

'shiny-a': {
  scene: 'Shiny', name: 'Glint', bpm: 150, once: true,
  blurb: 'A quick upward glitter and a held sparkle. Short enough to fire the moment a shiny card appears.',
  lead: { duty: 0.5, gain: 0.15, pattern: `c6:1 e6:1 g6:1 c7:1 -:2 g6:2 c7:8` },
  harmony: { duty: 0.25, gain: 0.08, pattern: `e5:1 g5:1 c6:1 e6:1 -:2 c6:2 e6:8` },
  bass: { gain: 0.16, pattern: `c4:4 -:2 g3:2 c4:8` },
  drums: { gain: 0.09, pattern: `h:1 h:1 h:1 h:1 -:4 h:8` },
},

'shiny-b': {
  scene: 'Shiny', name: 'Treasure', bpm: 132, once: true,
  blurb: 'Longer: a glitter, a pause, then a little four-note "you found something" motif. More of a moment.',
  lead: { duty: 0.5, gain: 0.15, pattern: `g5:1 b5:1 d6:1 g6:1 -:4 b6:2 -:2 g6:2 e6:2 d6:2 g6:6 -:2` },
  harmony: { duty: 0.25, gain: 0.08, pattern: `d5:1 g5:1 b5:1 d6:1 -:4 g6:2 -:2 d6:2 b5:2 g5:2 b5:6 -:2` },
  bass: { gain: 0.18, pattern: `g3:4 -:4 g3:2 -:2 e3:4 g3:8 -:2` },
  drums: { gain: 0.1, pattern: `h:1 h:1 h:1 h:1 -:4 s:2 -:2 h:2 h:2 h:2 k:6 -:2` },
},

};
