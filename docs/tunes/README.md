# Candidate tunes

Not wired into the app. `candidates.mjs` holds fifteen candidate tunes in the
same pattern format as `app/music.js`; `cabinet.html` is a self-contained
player that lets them be heard and compared against the tunes currently in
the app.

Validate lengths before adding any of them to `app/music.js`:

```bash
node -e "import('./docs/tunes/candidates.mjs').then(async m => {
  const { parsePattern, patternLength } = await import('./app/music.js');
  for (const [k, t] of Object.entries(m.CANDIDATES)) {
    const lens = ['lead','harmony','bass','drums'].map(c => patternLength(parsePattern(t[c].pattern)));
    console.log(new Set(lens).size === 1 ? 'ok  ' : 'BAD ', k, lens.join(' '));
  }})"
```
