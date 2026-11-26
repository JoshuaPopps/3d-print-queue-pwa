/* 3D Print Queue PWA — the things waiting for the printer, in order.
 *
 * No build step, no dependencies, no account, no server. Jobs live
 * in this device's localStorage and move as one plain JSON file.
 *
 * Bikes live in the SHARED Pocket Garage roster (the "pocket-garage-
 * bikes" key, via the vendored bike-profile.js — the same b1/b2/b3
 * roster the other apps use). This app never invents a second bike
 * model: a job points at a roster key, or at "" for a general job
 * that belongs to no bike in particular (shop stock, a tool for the
 * bench). Add a bike here and it is added to the shared roster;
 * there is no delete-bike here in v1 — roster management belongs to
 * the landing dashboard (Phase 2), so a bike you mistype is removed
 * there, not here.
 *
 * User-entered figures only, stated plainly wherever a number
 * appears: every file name, printer, material, print time, and cost
 * is one the rider typed in. Nothing is invented, and no print time
 * or cost is ever estimated — the slicer says how long a print
 * takes, not this app. A job with no time entered has no time in
 * the totals; a job with no cost entered has no cost in the totals.
 * Print time is stored in minutes (parsed from what the rider typed
 * — "2h 30m", "150", "2.5h" all mean the same 150 minutes) and
 * shown back as hours and minutes. Cost is per job, typed in.
 */
'use strict';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */
var STORAGE_KEY = 'print-queue-v1';
var VERSION = 1;

/* The only statuses the queue knows. A job is queued until it starts,
 * printing while it runs, done when it comes off the bed, failed when
 * it doesn't — and a failed or done job can go back in the queue. */
var STATUSES = ['queued', 'printing', 'done', 'failed'];
var STATUS_LABELS = { queued: 'Queued', printing: 'Printing', done: 'Done', failed: 'Failed' };
/* Queue order: what is printing now first, then the queue in priority
 * order, then the ones that need attention, then the finished ones. */
var STATUS_RANK = { printing: 0, queued: 1, failed: 2, done: 3 };
var PRIORITIES = ['Low', 'Normal', 'High'];
var PRIORITY_RANK = { High: 0, Normal: 1, Low: 2 };

/* Printer suggestions for the form's datalist — suggestions only.
 * A rider can type any printer; the list just saves typing. These
 * are the printers in the garage. */
var PRINTER_SUGGESTIONS = ['Bambu P2S', 'Ender 3 V2', 'Elegoo Mars'];
/* Material suggestions — suggestions only, same deal. */
var MATERIAL_SUGGESTIONS = ['ASA', 'Nylon-carbon', 'PLA', 'PETG', 'Resin'];

/* ------------------------------------------------------------------ */
/* Small pure helpers                                                  */
/* ------------------------------------------------------------------ */
function round2(x) { return Math.round(x * 100) / 100; }

function isDateISO(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function todayISO() {
  var d = new Date();
  var m = '' + (d.getMonth() + 1);
  var day = '' + d.getDate();
  return d.getFullYear() + '-' + (m.length < 2 ? '0' + m : m) + '-' + (day.length < 2 ? '0' + day : day);
}

function fmtMoney(x) {
  if (x === null || x === undefined) return '—';
  return '$' + (Math.round(x * 100) / 100).toFixed(2);
}

/* Print time: the rider types what the slicer said — "2h 30m", "150",
 * "2.5h", "45m" — and this turns it into minutes. Blank means the
 * time is unknown (null), not zero. Anything else refuses with a
 * plain message naming the accepted forms. */
function parsePrintTime(s) {
  if (s === '' || s === null || s === undefined) return null;
  var t = String(s).trim().toLowerCase().replace(/\s+/g, '');
  if (!t) return null;
  var m;
  /* Plain minutes: "150". */
  if (/^\d+(\.\d+)?$/.test(t)) {
    m = Math.round(Number(t));
  } else if ((m = /^(\d+(?:\.\d+)?)h(?:(\d+(?:\.\d+)?)m?)?$/.exec(t))) {
    /* Hours, with optional minutes: "2h", "2h30m", "2.5h". */
    var mins = Math.round(Number(m[1]) * 60);
    if (m[2] !== undefined) mins += Math.round(Number(m[2]));
    m = mins;
  } else if ((m = /^(\d+(?:\.\d+)?)m$/.exec(t))) {
    /* Minutes with the unit: "45m". */
    m = Math.round(Number(m[1]));
  } else {
    throw new Error('print time must look like "2h 30m", "150" (minutes), "2.5h", or "45m" — or be left blank');
  }
  if (m <= 0) throw new Error('print time must be more than 0, or left blank');
  return m;
}

/* Minutes back to words: 150 -> "2h 30m", 45 -> "45m", 60 -> "1h". */
function fmtMinutes(mins) {
  if (mins === null || mins === undefined) return '—';
  var h = Math.floor(mins / 60);
  var m = mins % 60;
  if (h === 0) return m + 'm';
  if (m === 0) return h + 'h';
  return h + 'h ' + m + 'm';
}

function slugify(name) {
  var s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'bike';
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* A file source that looks like a web address renders as a link;
 * anything else (a local file name, a model number) is plain text. */
function isHttpUrl(s) {
  return /^https?:\/\//i.test(String(s || '').trim());
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */
function emptyStore() {
  return { version: VERSION, jobs: [] };
}

/* A job, validated. Throws with a plain message on bad input.
 * name is required (a job with no name is unfindable). file_source,
 * printer, and material are free text, trimmed, and may be blank —
 * blank means not decided yet, never a guess. status is one of the
 * four labels, defaulting to 'queued'; priority is Low/Normal/High,
 * defaulting to 'Normal'. print_time_minutes comes from
 * parsePrintTime: blank means unknown (null), never 0. cost is per
 * job, optional: blank means unknown, and the job carries no cost
 * in the totals. bike_key is '' for a general job, or a roster key.
 * date_added defaults to today when not given. */
function validateJobFields(j) {
  if (!j || typeof j !== 'object') throw new Error('job must be an object');
  var name = typeof j.name === 'string' ? j.name.trim() : '';
  if (!name) throw new Error('job needs a name');
  if (typeof j.bike_key !== 'string') throw new Error('job needs a bike (or none)');
  var status = typeof j.status === 'string' ? j.status : 'queued';
  if (STATUSES.indexOf(status) < 0) status = 'queued';
  var priority = typeof j.priority === 'string' ? j.priority : 'Normal';
  if (PRIORITIES.indexOf(priority) < 0) priority = 'Normal';
  var minutes;
  if (j.hasOwnProperty('print_time')) {
    /* The form (and any caller passing a typed time) speaks in
     * slicer words — "2h 30m" — and that wins over a stored number,
     * so editing a job's time actually changes it. Blank clears it
     * back to unknown. */
    minutes = parsePrintTime(j.print_time);
  } else if (j.print_time_minutes !== undefined && j.print_time_minutes !== null && j.print_time_minutes !== '') {
    if (typeof j.print_time_minutes === 'number') {
      minutes = Math.round(j.print_time_minutes);
      if (minutes <= 0) throw new Error('print time must be more than 0, or left blank');
    } else {
      minutes = parsePrintTime(j.print_time_minutes);
    }
  } else {
    minutes = null;
  }
  var cost = null;
  if (j.cost !== '' && j.cost !== null && j.cost !== undefined) {
    cost = Number(j.cost);
    if (isNaN(cost) || cost < 0) throw new Error('cost must be $0 or more, or left blank');
    cost = round2(cost);
  }
  var date = j.date_added;
  if (date === '' || date === null || date === undefined) date = todayISO();
  if (!isDateISO(date)) throw new Error('date added must be a real date (YYYY-MM-DD)');
  return {
    bike_key: j.bike_key,
    name: name,
    file_source: typeof j.file_source === 'string' ? j.file_source.trim() : '',
    printer: typeof j.printer === 'string' ? j.printer.trim() : '',
    material: typeof j.material === 'string' ? j.material.trim() : '',
    status: status,
    priority: priority,
    print_time_minutes: minutes,
    cost: cost,
    date_added: date,
    notes: typeof j.notes === 'string' ? j.notes : ''
  };
}

function nextJobId(store) {
  var max = 0;
  store.jobs.forEach(function (j) {
    var m = /^j(\d+)$/.exec(j.id || '');
    if (m && +m[1] > max) max = +m[1];
  });
  return 'j' + (max + 1);
}

function addJob(store, fields) {
  var j = validateJobFields(fields);
  j.id = nextJobId(store);
  store.jobs.push(j);
  return j;
}

function updateJob(store, id, fields) {
  for (var i = 0; i < store.jobs.length; i++) {
    if (store.jobs[i].id === id) {
      var merged = validateJobFields(Object.assign({}, store.jobs[i], fields));
      merged.id = id;
      store.jobs[i] = merged;
      return merged;
    }
  }
  return null;
}

function deleteJob(store, id) {
  for (var i = 0; i < store.jobs.length; i++) {
    if (store.jobs[i].id === id) { store.jobs.splice(i, 1); return true; }
  }
  return false;
}

function getJob(store, id) {
  for (var i = 0; i < store.jobs.length; i++) {
    if (store.jobs[i].id === id) return store.jobs[i];
  }
  return null;
}

/* One status step, the garage shortcut: queued -> printing, printing
 * -> done (or failed), done/failed -> queued again. Anything else
 * (an unknown id, or a step that isn't in the list) leaves the job
 * alone and says so. */
var NEXT_STATUS = { queued: 'printing', printing: 'done', done: 'queued', failed: 'queued' };
function advanceJob(store, id) {
  var j = getJob(store, id);
  if (!j) return null;
  j.status = NEXT_STATUS[j.status] || 'queued';
  return j;
}
function failJob(store, id) {
  var j = getJob(store, id);
  if (!j) return null;
  j.status = 'failed';
  return j;
}

/* Same bike + same name + same file source: the same job typed
 * twice. The sample loader uses this so tapping "Load example data"
 * twice never doubles the queue. */
function hasJob(store, bikeKey, name, fileSource) {
  var n = String(name || '').trim().toLowerCase();
  var f = String(fileSource || '').trim().toLowerCase();
  return store.jobs.some(function (j) {
    return j.bike_key === bikeKey &&
      String(j.name).trim().toLowerCase() === n &&
      String(j.file_source || '').trim().toLowerCase() === f;
  });
}

/* ------------------------------------------------------------------ */
/* Search / filter / sort                                              */
/* ------------------------------------------------------------------ */
/* filters: { bikeKey: '' | 'general' | 'b1'..., status: '' | one of
 * STATUSES, query: string }. bikeKey '' means all bikes (general
 * jobs included); 'general' means general jobs only. query matches
 * name or file source, case-insensitive, substring. Results come
 * back in queue order: printing first, then queued by priority,
 * then failed, then done; within that, oldest first. */
function compareJobs(a, b) {
  var r = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (r !== 0) return r;
  r = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (r !== 0) return r;
  if (a.date_added !== b.date_added) return a.date_added < b.date_added ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

function filterJobs(store, filters) {
  filters = filters || {};
  var q = String(filters.query || '').trim().toLowerCase();
  var bk = filters.bikeKey === undefined ? '' : filters.bikeKey;
  var st = filters.status === undefined ? '' : filters.status;
  return store.jobs.filter(function (j) {
    if (bk === 'general') { if (j.bike_key !== '') return false; }
    else if (bk) { if (j.bike_key !== bk) return false; }
    if (st && j.status !== st) return false;
    if (q) {
      var hay = (j.name + ' ' + (j.file_source || '')).toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  }).sort(compareJobs);
}

/* ------------------------------------------------------------------ */
/* Totals — the queue at a glance                                      */
/* ------------------------------------------------------------------ */
/* Time and cost count only the jobs that have them: a job with no
 * time entered has no time in the totals, and a job with no cost
 * entered has no cost — the summary says how many are unknown
 * instead of guessing. byStatus counts every job once. */
function queueStats(store, bikeKey) {
  var jobs = bikeKey === undefined || bikeKey === '' || bikeKey === null
    ? store.jobs
    : (bikeKey === 'general'
      ? store.jobs.filter(function (j) { return j.bike_key === ''; })
      : store.jobs.filter(function (j) { return j.bike_key === bikeKey; }));
  var stats = {
    bike_key: bikeKey === undefined ? '' : bikeKey,
    jobs: jobs.length,
    byStatus: { queued: 0, printing: 0, done: 0, failed: 0 },
    queuedMinutes: 0, queuedUnknownTime: 0,
    queuedCost: 0, queuedUnpriced: 0,
    totalCost: 0, totalUnpriced: 0
  };
  jobs.forEach(function (j) {
    stats.byStatus[j.status]++;
    if (j.status === 'queued') {
      if (j.print_time_minutes !== null && j.print_time_minutes !== undefined) {
        stats.queuedMinutes += j.print_time_minutes;
      } else {
        stats.queuedUnknownTime++;
      }
      if (j.cost !== null && j.cost !== undefined) {
        stats.queuedCost = round2(stats.queuedCost + j.cost);
      } else {
        stats.queuedUnpriced++;
      }
    }
    if (j.cost !== null && j.cost !== undefined) {
      stats.totalCost = round2(stats.totalCost + j.cost);
    } else {
      stats.totalUnpriced++;
    }
  });
  return stats;
}

function allQueueStats(store) {
  return queueStats(store, '');
}

/* ------------------------------------------------------------------ */
/* Import / export                                                     */
/* ------------------------------------------------------------------ */
function validateImport(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('import must be a JSON object');
  if (!Array.isArray(data.jobs)) throw new Error('import needs a jobs array');
  var out = emptyStore();
  data.jobs.forEach(function (raw) {
    if (!raw || typeof raw !== 'object') throw new Error('each job must be an object');
    var j = validateJobFields(raw);
    /* Ids are re-minted on import in sequence, so a file that was
     * edited by hand with duplicate or missing ids still loads. */
    j.id = nextJobId(out);
    out.jobs.push(j);
  });
  return out;
}

function bikeJobsExport(store, bikeKey) {
  var stats = queueStats(store, bikeKey);
  var list = (bikeKey === 'general'
    ? store.jobs.filter(function (j) { return j.bike_key === ''; })
    : store.jobs.filter(function (j) { return j.bike_key === bikeKey; }))
    .slice().sort(compareJobs);
  return {
    app: 'print-queue', version: VERSION, bike_key: bikeKey,
    exported: todayISO(), stats: stats,
    jobs: list.map(function (j) {
      return {
        id: j.id, bike_key: bikeKey, name: j.name, file_source: j.file_source,
        printer: j.printer, material: j.material,
        status: j.status, priority: j.priority,
        print_time_minutes: j.print_time_minutes,
        /* The display string is null (not "—") when the time is
         * unknown, so a re-import of this export parses cleanly. */
        print_time: (j.print_time_minutes === null || j.print_time_minutes === undefined) ? null : fmtMinutes(j.print_time_minutes),
        cost: j.cost, date_added: j.date_added, notes: j.notes
      };
    })
  };
}

function bikeJobsText(store, bikeKey, bikeName) {
  var exp = bikeJobsExport(store, bikeKey);
  var s = exp.stats;
  var lines = [];
  lines.push('3D print queue — ' + (bikeName || bikeKey));
  lines.push('Exported ' + exp.exported);
  lines.push('');
  lines.push(s.jobs + ' jobs — ' + s.byStatus.queued + ' queued, ' +
    s.byStatus.printing + ' printing, ' + s.byStatus.done + ' done, ' +
    s.byStatus.failed + ' failed');
  lines.push('Queued work: ' + fmtMinutes(s.queuedMinutes) +
    (s.queuedUnknownTime ? ' (' + s.queuedUnknownTime + ' job' + (s.queuedUnknownTime === 1 ? '' : 's') + ' without a time)' : '') +
    ' — cost ' + fmtMoney(s.queuedCost) +
    (s.queuedUnpriced ? ' (' + s.queuedUnpriced + ' without a price)' : ''));
  lines.push('');
  exp.jobs.forEach(function (j) {
    lines.push(j.name +
      ' [' + STATUS_LABELS[j.status] + ' · ' + j.priority + ']' +
      (j.file_source ? ' — ' + j.file_source : '') +
      (j.printer ? ' — ' + j.printer : '') +
      (j.material ? ' — ' + j.material : '') +
      ' — time ' + fmtMinutes(j.print_time_minutes) +
      ' — cost ' + fmtMoney(j.cost) +
      (j.notes ? ' — ' + j.notes : ''));
  });
  lines.push('');
  lines.push('Every file name, printer, material, print time, and cost here is one the rider typed in. ' +
    'A job with no time or cost entered has none in the totals — nothing is estimated.');
  return lines.join('\n') + '\n';
}

function exportFilename(bikeName, ext) {
  return 'print-queue-' + slugify(bikeName) + '-jobs.' + ext;
}

/* ------------------------------------------------------------------ */
/* Sample data — example jobs only. The console insert, the pill
 * organizer holder, and the aux fan diffuser are real jobs from the
 * garage (the insert's test print came out too big; the holder is
 * waiting on ruler measurements; the diffuser is MakerWorld
 * 1916762) — the times and costs on them are example figures, and
 * the other three rows are example jobs outright. Every sample row
 * is labeled example data in the UI, and the totals are computed by
 * the same code the app runs on real jobs.                     */
/* ------------------------------------------------------------------ */
function sampleStore() {
  var s = emptyStore();
  var rows = [
    { bike_key: 'b1', name: 'Challenger console insert', file_source: 'console-insert-v3.stl', printer: 'Bambu P2S', material: 'ASA', status: 'queued', priority: 'High', print_time_minutes: 200, cost: 4.50, date_added: '2026-11-20', notes: 'Test print came out too big — rescale from bin measurements before reprinting.' },
    { bike_key: 'b1', name: 'Pill organizer holder', file_source: 'pill-holder.stl', printer: 'Bambu P2S', material: 'ASA', status: 'queued', priority: 'Normal', print_time_minutes: null, cost: null, date_added: '2026-11-21', notes: 'Awaiting ruler measurements before slicing.' },
    { bike_key: 'b2', name: 'Aux fan diffuser (right side)', file_source: 'MakerWorld 1916762', printer: 'Bambu P2S', material: 'ASA', status: 'queued', priority: 'Normal', print_time_minutes: 70, cost: 1.80, date_added: '2026-11-22', notes: '' },
    { bike_key: '', name: 'Tool drawer dividers', file_source: 'drawer-dividers.stl', printer: 'Bambu P2S', material: 'PLA', status: 'done', priority: 'Low', print_time_minutes: 105, cost: 2.10, date_added: '2026-11-15', notes: '' },
    { bike_key: 'b2', name: 'Cable clips', file_source: 'cable-clips.stl', printer: 'Ender 3 V2', material: 'PLA', status: 'printing', priority: 'Normal', print_time_minutes: 45, cost: 0.75, date_added: '2026-11-24', notes: '' },
    { bike_key: '', name: 'Resin test print', file_source: 'test-print.stl', printer: 'Elegoo Mars', material: 'Resin', status: 'failed', priority: 'Low', print_time_minutes: 30, cost: 1.25, date_added: '2026-11-23', notes: 'Supports failed — re-slice with heavier supports.' }
  ];
  rows.forEach(function (r) { addJob(s, r); });
  return s;
}

/* ------------------------------------------------------------------ */
/* DOM layer — browser only. The pure logic above runs in Node tests. */
/* ------------------------------------------------------------------ */
if (typeof document !== 'undefined') {
  var BikeProfile = (typeof window !== 'undefined' && window.PG_BikeProfile) ? window.PG_BikeProfile : null;
  var SWUpdate = (typeof window !== 'undefined' && window.PG_SWUpdate) ? window.PG_SWUpdate : null;

  var storage = (function () {
    try {
      if (typeof localStorage !== 'undefined') { localStorage.getItem('__print_queue_probe__'); return localStorage; }
    } catch (e) { /* private mode / blocked storage: memory only */ }
    var mem = {};
    return {
      getItem: function (k) { return mem.hasOwnProperty(k) ? mem[k] : null; },
      setItem: function (k, v) { mem[k] = String(v); },
      removeItem: function (k) { delete mem[k]; }
    };
  })();

  var profile = BikeProfile ? BikeProfile.create(storage) : null;
  var store = emptyStore();
  var editingId = null;

  function loadStore() {
    try {
      var raw = storage.getItem(STORAGE_KEY);
      if (raw) store = validateImport(JSON.parse(raw));
    } catch (e) { store = emptyStore(); }
  }
  function saveStore() {
    try { storage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch (e) { /* quota: keep the in-memory copy */ }
  }

  function bikes() {
    if (!profile) return [];
    try { return profile.listBikes(); } catch (e) { return []; }
  }
  function bikeName(key) {
    if (key === '' || key === null || key === undefined) return 'General (no bike)';
    var b = null;
    try { b = profile ? profile.getBike(key) : null; } catch (e) { b = null; }
    return b ? b.name : key;
  }

  function el(id) { return document.getElementById(id); }
  function toast(msg) {
    var t = el('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(function () { t.classList.remove('show'); }, 2600);
  }
  function download(name, text, type) {
    var blob = new Blob([text], { type: type || 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function fillBikeSelects() {
    var queueSel = el('queue-bike');
    if (queueSel) {
      var keep = queueSel.value;
      queueSel.innerHTML = '<option value="">All bikes</option><option value="general">General (no bike) only</option>' +
        bikes().map(function (b) {
          return '<option value="' + escapeHtml(b.key) + '">' + escapeHtml(b.name) + '</option>';
        }).join('');
      if (keep) queueSel.value = keep;
    }
    var formSel = el('j-bike');
    if (formSel) {
      var keepF = formSel.value;
      formSel.innerHTML = '<option value="">General (no bike)</option>' +
        bikes().map(function (b) {
          return '<option value="' + escapeHtml(b.key) + '">' + escapeHtml(b.name) + '</option>';
        }).join('');
      if (keepF) formSel.value = keepF;
    }
    var summarySel = el('summary-bike');
    if (summarySel) {
      var keepS = summarySel.value;
      summarySel.innerHTML = '<option value="">All bikes</option><option value="general">General (no bike)</option>' +
        bikes().map(function (b) {
          return '<option value="' + escapeHtml(b.key) + '">' + escapeHtml(b.name) + '</option>';
        }).join('');
      if (keepS) summarySel.value = keepS;
    }
    var exportSel = el('export-bike');
    if (exportSel) {
      var keepE = exportSel.value;
      exportSel.innerHTML = '<option value="general">General (no bike)</option>' +
        bikes().map(function (b) {
          return '<option value="' + escapeHtml(b.key) + '">' + escapeHtml(b.name) + '</option>';
        }).join('');
      if (keepE) exportSel.value = keepE;
    }
  }

  function statusBadge(status) {
    return '<span class="badge st-' + status + '">' + STATUS_LABELS[status] + '</span>';
  }

  function renderQueue() {
    var bk = el('queue-bike').value;
    var st = el('queue-status').value;
    var q = el('queue-search').value;
    var rows = filterJobs(store, { bikeKey: bk, status: st, query: q });
    var html = '';
    if (!store.jobs.length) {
      html = '<p class="muted">Nothing in the queue yet. Add the first job below — a name is all it takes, the rest is optional.</p>';
    } else if (!rows.length) {
      html = '<p class="muted">Nothing matches that search. Clear the search or the filters and the queue comes back.</p>';
    } else {
      html = '<table><thead><tr><th>Job</th><th>Bike</th><th>Printer / material</th><th class="num">Time</th><th class="num">Cost</th><th></th></tr></thead><tbody>';
      rows.forEach(function (j) {
        var file = '';
        if (j.file_source) {
          file = isHttpUrl(j.file_source)
            ? '<br><a href="' + escapeHtml(j.file_source) + '" target="_blank" rel="noopener">' + escapeHtml(j.file_source) + '</a>'
            : '<br><span class="muted">' + escapeHtml(j.file_source) + '</span>';
        }
        var step = '';
        if (j.status === 'queued') step = '<button class="mini primary" data-step="' + j.id + '">Start print</button> ';
        else if (j.status === 'printing') step = '<button class="mini primary" data-step="' + j.id + '">Mark done</button> <button class="mini danger" data-fail="' + j.id + '">Mark failed</button> ';
        else step = '<button class="mini" data-step="' + j.id + '">Requeue</button> ';
        html += '<tr><td><b>' + escapeHtml(j.name) + '</b> ' + statusBadge(j.status) +
          '<br><span class="badge">' + escapeHtml(j.priority) + '</span>' +
          file +
          (j.notes ? '<br><span class="muted">' + escapeHtml(j.notes) + '</span>' : '') +
          '</td><td>' + escapeHtml(bikeName(j.bike_key)) + '</td>' +
          '<td>' + escapeHtml(j.printer || '—') + (j.material ? '<br><span class="muted">' + escapeHtml(j.material) + '</span>' : '') + '</td>' +
          '<td class="num">' + fmtMinutes(j.print_time_minutes) + '</td>' +
          '<td class="num">' + fmtMoney(j.cost) + '</td>' +
          '<td>' + step +
          '<button class="mini" data-edit="' + j.id + '">Edit</button> ' +
          '<button class="mini danger" data-del="' + j.id + '">Delete</button></td></tr>';
      });
      html += '</tbody></table>';
      var st2 = queueStats(store, bk === 'general' ? 'general' : (bk || ''));
      var unknownBits = [];
      if (st2.queuedUnknownTime) unknownBits.push(st2.queuedUnknownTime + ' without a time');
      if (st2.queuedUnpriced) unknownBits.push(st2.queuedUnpriced + ' without a price');
      html += '<p class="muted">' + rows.length + ' job' + (rows.length === 1 ? '' : 's') + ' shown — ' +
        st2.byStatus.queued + ' queued: ' + fmtMinutes(st2.queuedMinutes) + ', ' + fmtMoney(st2.queuedCost) +
        (unknownBits.length ? ' (' + unknownBits.join(', ') + ')' : '') + ' — ' +
        st2.byStatus.printing + ' printing, ' + st2.byStatus.done + ' done, ' + st2.byStatus.failed + ' failed.</p>';
    }
    el('jobs-list').innerHTML = html;
    el('jobs-list').querySelectorAll('[data-del]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (deleteJob(store, btn.getAttribute('data-del'))) { saveStore(); renderAll(); toast('Job deleted.'); }
      });
    });
    el('jobs-list').querySelectorAll('[data-edit]').forEach(function (btn) {
      btn.addEventListener('click', function () { startEdit(btn.getAttribute('data-edit')); });
    });
    el('jobs-list').querySelectorAll('[data-step]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var j = advanceJob(store, btn.getAttribute('data-step'));
        if (j) { saveStore(); renderAll(); toast(j.name + ' — ' + STATUS_LABELS[j.status] + '.'); }
      });
    });
    el('jobs-list').querySelectorAll('[data-fail]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var j = failJob(store, btn.getAttribute('data-fail'));
        if (j) { saveStore(); renderAll(); toast(j.name + ' — Failed.'); }
      });
    });
  }

  function renderSummary() {
    var key = el('summary-bike').value;
    var html = '';
    var showCard = function (label, s) {
      var h = '<div class="card"><h3>' + escapeHtml(label) + '</h3>' +
        '<p>' + s.jobs + ' job' + (s.jobs === 1 ? '' : 's') + ' — ' +
        s.byStatus.queued + ' queued, ' + s.byStatus.printing + ' printing, ' +
        s.byStatus.done + ' done, ' + s.byStatus.failed + ' failed</p>' +
        '<p>Queued work: ' + fmtMinutes(s.queuedMinutes) +
        (s.queuedUnknownTime ? ' (' + s.queuedUnknownTime + ' job' + (s.queuedUnknownTime === 1 ? '' : 's') + ' without a time)' : '') +
        ' — cost ' + fmtMoney(s.queuedCost) +
        (s.queuedUnpriced ? ' (' + s.queuedUnpriced + ' without a price)' : '') + '</p>' +
        '<p class="muted">All jobs cost ' + fmtMoney(s.totalCost) +
        (s.totalUnpriced ? ' (' + s.totalUnpriced + ' without a price)' : '') + '</p>';
      return h + '</div>';
    };
    if (!key) {
      html += showCard('All bikes', allQueueStats(store));
      bikes().forEach(function (b) {
        var s = queueStats(store, b.key);
        if (!s.jobs) return;
        html += showCard(b.name, s);
      });
      var g = queueStats(store, 'general');
      if (g.jobs) html += showCard('General (no bike)', g);
      if (!allQueueStats(store).jobs) html += '<p class="muted">No jobs yet. Add one on the Queue tab and the numbers start here.</p>';
    } else if (key === 'general') {
      html += showCard('General (no bike)', queueStats(store, 'general'));
    } else {
      html += showCard(bikeName(key), queueStats(store, key));
    }
    el('summary-cards').innerHTML = html;
  }

  function renderBikes() {
    var list = bikes();
    var html = '';
    if (!list.length) {
      html = '<p class="muted">No bikes yet. The shared roster starts with the 1995 Fat Boy, the 1990 Softail, and the 1947 Knucklehead — add yours below.</p>';
    } else {
      html = '<ul class="bike-list">';
      list.forEach(function (b) {
        var s = queueStats(store, b.key);
        html += '<li><b>' + escapeHtml(b.name) + '</b>' +
          (b.year ? ' (' + escapeHtml(String(b.year)) + ')' : '') +
          (b.model ? ' — ' + escapeHtml(b.model) : '') +
          '<br><span class="muted">' + s.jobs + ' job' + (s.jobs === 1 ? '' : 's') +
          (s.jobs ? ' — ' + s.byStatus.queued + ' queued, ' + s.byStatus.printing + ' printing' : '') + '</span></li>';
      });
      html += '</ul>';
    }
    el('bikes-list').innerHTML = html;
  }

  function renderData() {
    var total = allQueueStats(store);
    el('data-counts').textContent = total.jobs + ' jobs — ' +
      total.byStatus.queued + ' queued, ' + total.byStatus.printing + ' printing, ' +
      total.byStatus.done + ' done, ' + total.byStatus.failed + ' failed — ' +
      bikes().length + ' bikes on the shared roster.';
  }

  function renderAll() {
    fillBikeSelects();
    renderQueue();
    renderSummary();
    renderBikes();
    renderData();
  }

  function showView(name) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.toggle('active', v.id === 'view-' + name); });
    document.querySelectorAll('.navbtn').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-view') === name); });
  }

  function resetForm() {
    editingId = null;
    el('job-form').reset();
    el('j-date').value = todayISO();
    el('j-status').value = 'queued';
    el('j-priority').value = 'Normal';
    el('job-submit').textContent = 'Add job';
    el('job-cancel').style.display = 'none';
    el('form-heading').textContent = 'Add a job';
  }

  function startEdit(id) {
    var j = getJob(store, id);
    if (!j) return;
    editingId = id;
    el('j-name').value = j.name;
    el('j-file').value = j.file_source || '';
    el('j-bike').value = j.bike_key || '';
    el('j-printer').value = j.printer || '';
    el('j-material').value = j.material || '';
    el('j-status').value = j.status;
    el('j-priority').value = j.priority;
    el('j-time').value = (j.print_time_minutes === null || j.print_time_minutes === undefined) ? '' : fmtMinutes(j.print_time_minutes);
    el('j-cost').value = (j.cost === null || j.cost === undefined) ? '' : j.cost;
    el('j-date').value = j.date_added;
    el('j-notes').value = j.notes || '';
    el('job-submit').textContent = 'Save changes';
    el('job-cancel').style.display = '';
    el('form-heading').textContent = 'Edit job';
    document.getElementById('view-queue').scrollIntoView();
    el('j-name').focus();
  }

  document.querySelectorAll('.navbtn').forEach(function (b) {
    b.addEventListener('click', function () { showView(b.getAttribute('data-view')); });
  });

  el('queue-bike').addEventListener('change', renderQueue);
  el('queue-status').addEventListener('change', renderQueue);
  el('queue-search').addEventListener('input', renderQueue);

  el('job-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var fields = {
      bike_key: el('j-bike').value,
      name: el('j-name').value,
      file_source: el('j-file').value,
      printer: el('j-printer').value,
      material: el('j-material').value,
      status: el('j-status').value,
      priority: el('j-priority').value,
      print_time: el('j-time').value,
      cost: el('j-cost').value,
      date_added: el('j-date').value,
      notes: el('j-notes').value
    };
    try {
      if (editingId) {
        updateJob(store, editingId, fields);
        toast('Job updated.');
      } else {
        var j = addJob(store, fields);
        toast('Job added — ' + j.name + '.');
      }
      saveStore();
      resetForm();
      renderAll();
    } catch (err) { toast(err.message); }
  });
  el('job-cancel').addEventListener('click', function () { resetForm(); });

  el('bike-form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!profile) { toast('Bike roster unavailable on this device.'); return; }
    var name = el('bike-name').value.trim();
    if (!name) { toast('Give the bike a name.'); return; }
    var year = el('bike-year').value.trim();
    var key = profile.addBike({
      name: name,
      year: year ? parseInt(year, 10) : null,
      model: el('bike-model').value.trim(),
      carb: '',
      notes: el('bike-notes').value.trim()
    });
    el('bike-form').reset();
    renderAll();
    toast('Bike added to the shared roster (' + key + ').');
  });

  el('export-btn').addEventListener('click', function () {
    download('print-queue-backup.json', JSON.stringify(store, null, 2));
    toast('Backup downloaded.');
  });
  el('copy-export-btn').addEventListener('click', function () {
    var done = function () { toast('Backup copied.'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(JSON.stringify(store, null, 2)).then(done, function () { toast('Copy failed — use Download instead.'); });
    } else { toast('Clipboard unavailable — use Download instead.'); }
  });
  el('export-json-btn').addEventListener('click', function () {
    var key = el('export-bike').value;
    download(exportFilename(bikeName(key), 'json'), JSON.stringify(bikeJobsExport(store, key), null, 2));
  });
  el('export-text-btn').addEventListener('click', function () {
    var key = el('export-bike').value;
    download(exportFilename(bikeName(key), 'txt'), bikeJobsText(store, key, bikeName(key)), 'text/plain');
  });
  el('copy-text-btn').addEventListener('click', function () {
    var key = el('export-bike').value;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(bikeJobsText(store, key, bikeName(key))).then(function () { toast('Copied.'); }, function () { toast('Copy failed — use Download instead.'); });
    } else { toast('Clipboard unavailable — use Download instead.'); }
  });
  el('import-btn').addEventListener('click', function () {
    var file = el('import-file').files && el('import-file').files[0];
    var text = el('import-text').value.trim();
    var apply = function (raw) {
      try {
        var next = validateImport(JSON.parse(raw));
        store = next;
        saveStore();
        renderAll();
        toast('Imported ' + next.jobs.length + ' jobs. (Replaces the old queue.)');
      } catch (err) { toast('Import failed: ' + err.message); }
    };
    if (file) {
      var reader = new FileReader();
      reader.onload = function () { apply(String(reader.result)); };
      reader.readAsText(file);
    } else if (text) {
      apply(text);
    } else {
      toast('Pick a file or paste JSON first.');
    }
  });
  el('sample-btn').addEventListener('click', function () {
    var sample = sampleStore();
    var added = 0;
    sample.jobs.forEach(function (j) {
      if (hasJob(store, j.bike_key, j.name, j.file_source)) return; /* already there: tapping twice never doubles the queue */
      try { addJob(store, j); added++; } catch (e) { /* a sample row that collides with existing data is skipped, not forced */ }
    });
    saveStore();
    renderAll();
    toast(added ? 'Example jobs loaded in the queue.' : 'Example jobs are already in the queue.');
  });
  el('clear-btn').addEventListener('click', function () {
    if (!window.confirm('Delete all print-queue jobs? The shared bike roster is NOT touched — only this app\u2019s jobs go.')) return;
    store = emptyStore();
    saveStore();
    resetForm();
    renderAll();
    toast('Print queue cleared. Bikes are untouched.');
  });

  loadStore();
  el('j-date').value = todayISO();
  renderAll();
  if (SWUpdate) SWUpdate.init({ container: document.body });
}

if (typeof module !== 'undefined' && module.exports) {
  var BikeProfileModule = null;
  try { BikeProfileModule = require('./bike-profile.js'); } catch (e) { BikeProfileModule = null; }
  module.exports = {
    STORAGE_KEY: STORAGE_KEY, VERSION: VERSION,
    STATUSES: STATUSES, STATUS_LABELS: STATUS_LABELS, STATUS_RANK: STATUS_RANK,
    PRIORITIES: PRIORITIES, PRIORITY_RANK: PRIORITY_RANK,
    PRINTER_SUGGESTIONS: PRINTER_SUGGESTIONS, MATERIAL_SUGGESTIONS: MATERIAL_SUGGESTIONS,
    round2: round2, isDateISO: isDateISO, todayISO: todayISO,
    fmtMoney: fmtMoney, parsePrintTime: parsePrintTime, fmtMinutes: fmtMinutes,
    slugify: slugify, escapeHtml: escapeHtml, isHttpUrl: isHttpUrl,
    emptyStore: emptyStore, validateJobFields: validateJobFields,
    nextJobId: nextJobId, addJob: addJob, updateJob: updateJob,
    deleteJob: deleteJob, getJob: getJob, advanceJob: advanceJob, failJob: failJob,
    hasJob: hasJob, compareJobs: compareJobs, filterJobs: filterJobs,
    queueStats: queueStats, allQueueStats: allQueueStats,
    validateImport: validateImport,
    bikeJobsExport: bikeJobsExport, bikeJobsText: bikeJobsText,
    exportFilename: exportFilename, sampleStore: sampleStore,
    BikeProfile: BikeProfileModule
  };
}
