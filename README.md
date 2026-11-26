# 3d-print-queue-pwa

A queue of things to print — as a phone app you install from the
browser. No app store, no account, no server.

Every job with its file, printer, material, status, priority, print
time, and cost. Queued first by what is printing, then by priority;
one tap moves a job through the queue.

> All bikes, names, times, and costs below are examples only.

## What it does

- **Queue tab** — every job in queue order (printing first, then
  queued by priority then oldest, then failed, then done), with
  search (name or file source), a bike filter, and a status filter.
  Each row shows the job, its bike, printer / material, print time,
  cost, and status, with one-tap status buttons (Start print, Mark
  done, Mark failed, Requeue) plus Edit and Delete. The add form
  takes a name as the only required field — file source, bike,
  printer, material, status, priority, print time, cost, date, and
  notes are all optional. The same form edits: tap Edit on a row and
  it fills in, with a Cancel edit button.
- **Summary tab** — per-bike totals and all-bikes totals: jobs by
  status, queued time, and queued cost, plus how many queued jobs
  have no time or no cost entered.
- **Bikes tab** — the shared Pocket Garage roster (b1/b2/b3: 1995 Fat
  Boy, 1990 Softail, 1947 Knucklehead), with an add-a-bike form.
  Bikes live in the shared `pocket-garage-bikes` key via the vendored
  `bike-profile.js` — the same roster the other apps use, no second
  bike model. There is no delete-bike here: roster management belongs
  to the landing dashboard (Phase 2), so a mistyped bike is removed
  there, not here.
- **Data tab** — export the whole queue as JSON, export one bike as
  JSON or readable text, import (replaces the queue), load example
  data, and delete all jobs. Delete clears this app's jobs only —
  the shared bike roster is not touched.

## The honesty rule (read this before trusting a number)

Every file name, printer, material, print time, and cost on screen
is one you typed in, or computed from numbers you typed in by the
formulas printed right next to them. Nothing is invented: no print
time or cost is ever estimated — the slicer says how long a print
takes, not this app.

- Print time is typed as the slicer gave it — "2h 30m", "150"
  (minutes), "2.5h", or "45m" — and shown back as hours and minutes.
  A job with no time entered has no time in the totals; the summary
  says how many jobs are without a time instead of guessing.
- A job with no cost entered has no cost in the totals. The summary
  says how many jobs are unpriced instead of guessing.
- A job can belong to a bike or to no bike at all ("General (no
  bike)" — shop stock, a tool for the bench). General jobs show in
  their own totals and in the all-bikes view.

## Files

- `index.html` — the four tabs (Queue / Summary / Bikes / Data).
- `app.js` — pure logic (Node-testable) + the DOM layer. No build
  step, no dependencies.
- `styles.css` — 1990 Treatment (live dyno `styles.css` is the
  reference): gloss tank black #070709, chrome, purple #9d6bff,
  UnifrakturCook headings, Archivo Narrow body. Buttons have no hover
  transform — the house hover shift breaks Playwright stability
  checks and sticks after a tap on touch (AGENTS.md, Nov 24, 2026).
- `sw.js` — app-shell cache `print-queue-v1`; every file `index.html`
  loads is precached. `sw-update.js` is the shared update-button
  module (vendored verbatim, md5 `dca37625a13049e7eb021d5a25c649d3`).
- `bike-profile.js` — the shared bike roster module (vendored
  verbatim, md5 `c618323a4b8ed7f37004260a044503ce`).
- `manifest.webmanifest`, `icons/` — PWA install files. Icons are
  Pillow-drawn from `make_icons.py` (chrome isometric cube, purple
  layer line, PRINT label — the 512 icon was read back and reads
  clearly as a cube).
- `test.js` — Node suite, 127 checks. `test_ui.py` — Playwright UI
  smoke (see TESTING.md).

## Publish

New repo (the connector cannot create repos — that happens in the
browser at publish time), GitHub Pages enabled in Settings → Pages
(it is off by default on a new repo and the site 404s without it),
then a landing card for the print queue. Push paths (every file the
live `sw.js` precaches or `index.html` loads — the standing lesson):
all files in this directory except `make_icons.py`, `test.js`,
`test_ui.py`, and `TESTING.md`.
