'use strict';

// ---------------------------------------------------------------- utilities
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
};
const LETTERS = 'ABCDEFGH';

function fmtClock(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function fmtMinSec(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
}
function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined,
    { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function paperName(a) {
  if (a.mode === 'drill') return a.label || 'Custom drill';
  const y = a.year === 'specimen' ? 'Specimen' : a.year;
  return `${y} · Paper ${a.paper}`;
}
function pct(x) { return `${Math.round(x * 100)}%`; }

function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

function beep(kind) {
  if (!State.settings.sound) return;
  try {
    const ctx = beep._ctx || (beep._ctx = new AudioContext());
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.frequency.value = kind === 'end' ? 320 : 660;
    gain.gain.value = 0.05;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + (kind === 'end' ? 0.5 : 0.16));
  } catch { /* audio unavailable */ }
}

// ---------------------------------------------------------------- state
const State = {
  catalog: null,
  settings: {},
  view: 'home',
  params: {},
  exam: null,      // live exam controller
};

function applyTheme() {
  document.documentElement.dataset.theme = State.settings.darkMode ? 'dark' : 'light';
}

async function go(view, params = {}) {
  if (State.exam && view !== 'exam' && view !== 'break') State.exam.teardown();
  State.view = view;
  State.params = params;
  await render();
}

// ---------------------------------------------------------------- shell
function shell(active, ...content) {
  const nav = [
    ['home', 'Practise'],
    ['coach', 'Coach'],
    ['plan', 'Plan'],
    ['history', 'History'],
    ['dashboard', 'Progress'],
    ['revisit', 'Revisit list'],
    ['settings', 'Settings'],
  ];
  return el('div', { class: 'shell' },
    el('header', { class: 'topbar' },
      el('div', { class: 'brand' }, 'TMUA Simulator', el('small', {}, '2016–2023 · offline')),
      el('nav', { class: 'nav' },
        nav.map(([id, label]) =>
          el('button', { class: id === active ? 'active' : '', onclick: () => go(id) }, label))),
      el('div', { class: 'spacer' }),
      el('span', { class: 'tiny muted' }, `${State.catalog.counts.questions} questions bundled`)),
    el('main', { class: 'page' + (active === 'dashboard' || active === 'history' ? ' wide' : '') },
      ...content));
}

// ---------------------------------------------------------------- home
async function viewHome() {
  const resumable = await api.attempt.resumable();
  const papers = State.catalog.papers;
  const years = [...new Set(papers.map(p => p.year))];
  const mins = Math.max(1, Math.floor(State.settings.baseMinutes * (1 + State.settings.extraTimePercent / 100)));

  const yearSel = el('select', {}, years.map(y =>
    el('option', { value: y }, y === 'specimen' ? 'Specimen' : y)));
  const paperSel = el('select', {},
    el('option', { value: '1' }, 'Paper 1'), el('option', { value: '2' }, 'Paper 2'));

  // Starting something new never destroys an in-progress attempt — it stays
  // resumable — but say so rather than letting it look lost.
  const confirmOverExisting = () => {
    if (!resumable.length) return true;
    return confirm(
      `You have ${resumable.length} attempt${resumable.length === 1 ? '' : 's'} still in progress. ` +
      `Starting a new one keeps ${resumable.length === 1 ? 'it' : 'them'} — you can resume from Practise or History. Continue?`);
  };

  const startPaper = async (untimed) => {
    if (!confirmOverExisting()) return;
    const a = await api.attempt.start({
      mode: untimed ? 'untimed' : 'paper',
      year: yearSel.value, paper: Number(paperSel.value), untimed,
    });
    go('exam', { attemptId: a.id });
  };

  const startMock = async () => {
    if (!confirmOverExisting()) return;
    const year = yearSel.value;
    const group = `mock-${year}-${Date.now()}`;
    const a = await api.attempt.start({ mode: 'mock', year, paper: 1, mockGroup: group });
    go('exam', { attemptId: a.id });
  };

  const status = await statusBar();

  return shell('home',
    status,
    el('h1', {}, 'Practise'),
    resumable.length ? el('div', { class: 'card', style: 'margin-bottom:16px' },
      el('h2', {}, 'Resume in progress'),
      el('p', { class: 'small muted' },
        'These attempts were interrupted. Reopening restores the exact question and the time you had left.'),
      resumable.map(a => el('div', { class: 'row', style: 'justify-content:space-between;padding:8px 0;border-top:1px solid var(--line)' },
        el('div', {},
          el('div', {}, el('strong', {}, paperName(a)), a.mode === 'mock' ? el('span', { class: 'pill', style: 'margin-left:8px' }, 'Full mock') : null),
          el('div', { class: 'tiny muted' },
            `Question ${a.currentIndex + 1} of ${a.questions.length}`,
            a.remainingSec !== null ? ` · ${fmtClock(a.remainingSec)} left` : ' · untimed',
            ` · started ${fmtDate(a.startedAt)}`)),
        el('div', { class: 'row' },
          el('button', { class: 'btn small', onclick: () => go('exam', { attemptId: a.id }) }, 'Resume'),
          el('button', {
            class: 'btn ghost small', onclick: async () => {
              if (!confirm('Abandon this attempt? It will be kept in history as abandoned.')) return;
              await api.attempt.abandon(a.id); render();
            }
          }, 'Abandon'))))) : null,

    el('div', { class: 'grid cols-2' },
      el('div', { class: 'card' },
        el('h2', {}, 'Single paper'),
        el('p', { class: 'small muted' }, `One paper, ${mins}:00 on the clock.`),
        el('div', { class: 'row' }, yearSel, paperSel),
        el('div', { class: 'row', style: 'margin-top:14px' },
          el('button', { class: 'btn', onclick: () => startPaper(false) }, `Start timed (${mins}:00)`),
          el('button', { class: 'btn ghost', onclick: () => startPaper(true) }, 'Untimed practice'))),

      el('div', { class: 'card' },
        el('h2', {}, 'Full mock'),
        el('p', { class: 'small muted' },
          `Paper 1 (${mins}:00), then a ${State.settings.breakMinutes}:00 break, then Paper 2 (${mins}:00). Separate timers.`),
        el('button', { class: 'btn', onclick: startMock }, 'Start full mock'),
        el('div', { class: 'tiny muted', style: 'margin-top:10px' },
          'Uses the year selected on the left.')),

      el('div', { class: 'card' },
        el('h2', {}, 'Custom drill'),
        el('p', { class: 'small muted' },
          'Build a set from questions you got wrong, flagged, or by topic, year and paper.'),
        el('button', { class: 'btn ghost', onclick: () => go('drill') }, 'Build a drill')),

      el('div', { class: 'card' },
        el('h2', {}, 'Papers available'),
        el('div', { class: 'small muted', style: 'margin-bottom:8px' },
          '8 years plus the specimen paper — 360 questions with official worked solutions.'),
        el('div', { class: 'row tiny' }, papers.map(p =>
          el('span', { class: 'pill' }, `${p.year === 'specimen' ? 'Spec' : p.year} P${p.paper}`))))));
}

// ---------------------------------------------------------------- drill builder
async function viewDrill() {
  const tax = State.catalog.taxonomy;
  const years = [...new Set(State.catalog.papers.map(p => p.year))];
  const state = { source: 'all', topics: [], years: [], papers: [], shuffle: true, limit: 20 };
  const preview = el('div', { class: 'small muted' }, 'Choose filters to see how many questions match.');

  const refresh = async () => {
    const res = await api.drill.build({ ...state, limit: null });
    preview.textContent = `${res.available} question${res.available === 1 ? '' : 's'} match.`;
    startBtn.disabled = res.available === 0;
    state._available = res.available;
  };

  const sourceSel = el('select', { onchange: e => { state.source = e.target.value; refresh(); } },
    el('option', { value: 'all' }, 'All questions'),
    el('option', { value: 'wrong' }, 'Questions I got wrong'),
    el('option', { value: 'flagged' }, 'Questions I flagged'),
    el('option', { value: 'revisit' }, 'My revisit list'));

  const topicBoxes = Object.entries(tax).map(([id, label]) =>
    el('label', { class: 'checkline' },
      el('input', {
        type: 'checkbox', onchange: e => {
          if (e.target.checked) state.topics.push(id);
          else state.topics = state.topics.filter(t => t !== id);
          refresh();
        }
      }), label));

  const yearBoxes = years.map(y =>
    el('label', { class: 'checkline' },
      el('input', {
        type: 'checkbox', onchange: e => {
          if (e.target.checked) state.years.push(y);
          else state.years = state.years.filter(v => v !== y);
          refresh();
        }
      }), y === 'specimen' ? 'Specimen' : y));

  const paperBoxes = [1, 2].map(p =>
    el('label', { class: 'checkline' },
      el('input', {
        type: 'checkbox', onchange: e => {
          if (e.target.checked) state.papers.push(p);
          else state.papers = state.papers.filter(v => v !== p);
          refresh();
        }
      }), `Paper ${p}`));

  const limitInput = el('input', {
    type: 'number', min: '1', max: '100', value: '20',
    onchange: e => { state.limit = Number(e.target.value) || null; }
  });
  const shuffleBox = el('input', {
    type: 'checkbox', checked: true,
    onchange: e => { state.shuffle = e.target.checked; }
  });
  const timedBox = el('input', { type: 'checkbox' });

  const startBtn = el('button', {
    class: 'btn', disabled: true, onclick: async () => {
      const res = await api.drill.build(state);
      if (!res.ids.length) return toast('No questions match those filters');
      const a = await api.attempt.start({
        mode: 'drill', questionIds: res.ids, untimed: !timedBox.checked,
        label: `Drill · ${res.ids.length} questions`,
      });
      go('exam', { attemptId: a.id });
    }
  }, 'Start drill');

  refresh();

  return shell('home',
    el('h1', {}, 'Custom drill'),
    el('div', { class: 'grid cols-3' },
      el('div', { class: 'card' }, el('h3', {}, 'Source'), sourceSel,
        el('div', { style: 'margin-top:14px' }, el('h3', {}, 'Paper'), paperBoxes)),
      el('div', { class: 'card' }, el('h3', {}, 'Topics'), topicBoxes),
      el('div', { class: 'card' }, el('h3', {}, 'Years'), yearBoxes)),
    el('div', { class: 'card', style: 'margin-top:16px' },
      el('div', { class: 'row' },
        el('label', { class: 'field' }, 'Max questions', limitInput),
        el('label', { class: 'checkline', style: 'margin-top:18px' }, shuffleBox, 'Shuffle'),
        el('label', { class: 'checkline', style: 'margin-top:18px' }, timedBox, 'Timed')),
      el('div', { style: 'margin-top:12px' }, preview),
      el('div', { class: 'row', style: 'margin-top:14px' },
        startBtn, el('button', { class: 'btn ghost', onclick: () => go('home') }, 'Cancel'))));
}

// ---------------------------------------------------------------- exam
class Exam {
  constructor(attempt) {
    this.a = attempt;
    this.index = Math.min(attempt.currentIndex || 0, attempt.questions.length - 1);
    this.allowed = attempt.allowedSec;              // null = untimed
    this.timerHidden = Boolean(State.settings.hideTimer);
    this.warned = new Set();
    this.finished = false;
    this.onKey = this.onKey.bind(this);

    // Wall-clock timing. Elapsed is derived from timestamps, never accumulated
    // from ticks: a throttled window, a suspended renderer or a sleeping
    // machine must not hand back exam time.
    this.baseElapsed = attempt.elapsedSec || 0;
    this.sessionStart = Date.now();
    this.qWallStart = Date.now();
  }

  get elapsed() {
    return this.baseElapsed + Math.max(0, Date.now() - this.sessionStart) / 1000;
  }
  get remaining() { return this.allowed === null ? null : Math.max(0, this.allowed - this.elapsed); }
  get q() { return this.a.questions[this.index]; }

  mount(root) {
    this.root = root;
    document.addEventListener('keydown', this.onKey);
    this.interval = setInterval(() => this.tick(), 250);
    // 1s heartbeat: a crash can cost at most one interval of recorded time,
    // and it always rounds in the candidate's favour (time is given back).
    this.heartbeat = setInterval(() => this.persist(), 1000);
    this.renderAll();
  }

  teardown() {
    clearInterval(this.interval);
    clearInterval(this.heartbeat);
    document.removeEventListener('keydown', this.onKey);
    if (!this.finished) this.persist();
    State.exam = null;
  }

  tick() {
    if (this.finished) return;
    if (this.allowed !== null) {
      const r = this.remaining;
      for (const mark of [900, 300, 60]) {
        if (r <= mark && !this.warned.has(mark)) {
          this.warned.add(mark);
          if (r > 0) { toast(`${mark / 60} minute${mark === 60 ? '' : 's'} remaining`, 3200); beep('warn'); }
        }
      }
      if (r <= 0) return this.finish('timeout');
    }
    this.paintTimer();
  }

  // seconds spent on the current question since the last persist, wall-clock
  takeQuestionDelta() {
    const now = Date.now();
    const delta = Math.max(0, now - this.qWallStart) / 1000;
    this.qWallStart = now;
    return delta;
  }

  async persist() {
    if (this.finished) return;
    const delta = this.takeQuestionDelta();
    try {
      await api.attempt.heartbeat({
        attemptId: this.a.id, elapsedSec: this.elapsed, currentIndex: this.index,
        questionTime: { position: this.q.position, delta },
      });
    } catch (e) { console.error('heartbeat failed', e); }
  }

  async goTo(i) {
    if (i < 0 || i >= this.a.questions.length || i === this.index) return;
    await this.persist();
    this.index = i;
    this.renderAll();
    await this.persist();
  }

  async select(letter) {
    if (this.finished) return;
    const q = this.q;
    q.selected = q.selected === letter ? null : letter;
    await api.attempt.answer({
      attemptId: this.a.id, position: q.position, selected: q.selected,
    });
    this.paintOptions();
    this.paintNav();
  }

  async setConfidence(level) {
    const q = this.q;
    q.confidence = q.confidence === level ? null : level;
    await api.attempt.confidence({ attemptId: this.a.id, position: q.position, confidence: q.confidence });
    this.paintConfidence();
  }

  async toggleFlag() {
    const q = this.q;
    q.flagged = !q.flagged;
    await api.attempt.flag({ attemptId: this.a.id, position: q.position, flagged: q.flagged });
    this.paintNav();
    this.paintFlagBtn();
  }

  onKey(e) {
    if (this.finished) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') return;
    const k = e.key.toUpperCase();
    if (LETTERS.includes(k) && k !== 'F') {
      const idx = LETTERS.indexOf(k);
      if (idx < this.q.question.options) { e.preventDefault(); this.select(k); }
      return;
    }
    if (k === 'F') { e.preventDefault(); this.toggleFlag(); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); this.goTo(this.index - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); this.goTo(this.index + 1); }
  }

  async finish(reason) {
    if (this.finished) return;
    this.finished = true;
    clearInterval(this.interval);
    clearInterval(this.heartbeat);
    if (reason === 'timeout') { beep('end'); toast('Time is up — paper submitted', 4000); }
    const delta = this.takeQuestionDelta();
    try {
      await api.attempt.heartbeat({
        attemptId: this.a.id, elapsedSec: this.elapsed, currentIndex: this.index,
        questionTime: { position: this.q.position, delta },
      });
    } catch { /* fall through to finish anyway */ }
    const done = await api.attempt.finish({
      attemptId: this.a.id, reason, elapsedSec: this.elapsed,
    });
    this.teardown();
    if (done.mode === 'mock' && done.paper === 1) go('break', { attempt: done });
    else go('results', { attemptId: done.id });
  }

  // ---- painting
  paintTimer() {
    if (!this.timerEl) return;
    if (this.allowed === null) { this.timerEl.textContent = 'Untimed'; return; }
    if (this.timerHidden) {
      this.timerEl.textContent = 'Timer hidden';
      this.timerEl.className = 'timer hidden-time';
      return;
    }
    const r = this.remaining;
    this.timerEl.textContent = fmtClock(r);
    this.timerEl.className = 'timer' + (r <= 60 ? ' danger' : r <= 300 ? ' warn' : '');
  }

  paintOptions() {
    const q = this.q;
    [...this.optionsEl.children].forEach((node, i) => {
      node.classList.toggle('selected', q.selected === LETTERS[i]);
    });
  }

  paintConfidence() {
    const q = this.q;
    this.confEls.forEach(([level, btn]) => {
      btn.className = 'btn small ' + (q.confidence === level ? '' : 'ghost');
    });
  }

  paintFlagBtn() {
    this.flagBtn.className = 'btn small ' + (this.q.flagged ? '' : 'ghost');
    this.flagBtn.textContent = this.q.flagged ? '⚑ Flagged' : '⚑ Flag for review';
  }

  paintNav() {
    [...this.navEl.children].forEach((btn, i) => {
      const q = this.a.questions[i];
      btn.className = [
        q.selected ? 'answered' : '',
        q.flagged ? 'flagged' : '',
        i === this.index ? 'current' : '',
      ].filter(Boolean).join(' ');
    });
    const answered = this.a.questions.filter(q => q.selected).length;
    this.progressEl.textContent = `${answered} of ${this.a.questions.length} answered`;
  }

  renderAll() {
    const q = this.q;
    const total = this.a.questions.length;

    this.timerEl = el('div', { class: 'timer' });
    this.progressEl = el('span', { class: 'small muted' });
    this.flagBtn = el('button', { class: 'btn ghost small', onclick: () => this.toggleFlag() });

    this.optionsEl = el('div', { class: 'options row-letters' },
      LETTERS.slice(0, q.question.options).split('').map(L =>
        el('button', {
          class: 'opt', title: `Select option ${L}`, onclick: () => this.select(L)
        }, el('span', { class: 'letter' }, L))));

    this.confEls = [['sure', null], ['unsure', null]].map(([level]) => {
      const btn = el('button', {
        class: 'btn ghost small', onclick: () => this.setConfidence(level)
      }, level === 'sure' ? '✓ Sure' : '? Unsure');
      return [level, btn];
    });

    const notepad = el('textarea', {
      rows: '4', placeholder: 'Working / scratch notes for this question…',
      onchange: e => api.attempt.notepad({
        attemptId: this.a.id, position: q.position, text: e.target.value
      }),
    });
    notepad.value = q.notepad || '';

    this.navEl = el('div', { class: 'navgrid' },
      this.a.questions.map((_, i) => el('button', { onclick: () => this.goTo(i) }, i + 1)));

    const body = el('div', { class: 'exam-body' },
      el('div', { class: 'qpane' },
        el('div', { class: 'qcard' },
          el('img', { class: 'qimage', src: q.question.image, alt: `Question ${this.index + 1}` })),
        el('div', { class: 'qcard' },
          el('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:10px' },
            el('h3', { style: 'margin:0' }, 'Your answer'),
            el('div', { class: 'row' },
              el('span', { class: 'tiny muted' }, 'Confidence:'),
              this.confEls.map(([, b]) => b))),
          this.optionsEl),
        el('details', { class: 'qcard' },
          el('summary', {}, 'Scratch notepad'), notepad)),

      el('aside', { class: 'side' },
        el('div', { class: 'card' },
          el('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:8px' },
            el('strong', {}, `Question ${this.index + 1}`),
            el('span', { class: 'tiny muted' }, `of ${total}`)),
          this.navEl,
          el('div', { class: 'legend', style: 'margin-top:12px' },
            el('span', { class: 'l-ans' }, 'Answered'),
            el('span', { class: 'l-flag' }, 'Flagged'))),
        el('div', { class: 'card' },
          this.flagBtn,
          el('div', { class: 'row', style: 'margin-top:10px' },
            el('button', { class: 'btn ghost small', onclick: () => this.goTo(this.index - 1) }, '← Prev'),
            el('button', { class: 'btn ghost small', onclick: () => this.goTo(this.index + 1) }, 'Next →')),
          el('div', { class: 'tiny muted', style: 'margin-top:12px' },
            el('span', { class: 'kbd' }, 'A–H'), ' answer · ',
            el('span', { class: 'kbd' }, '← →'), ' move · ',
            el('span', { class: 'kbd' }, 'F'), ' flag')),
        el('div', { class: 'card' },
          el('button', {
            class: 'btn', style: 'width:100%', onclick: () => {
              const blanks = this.a.questions
                .map((x, i) => (x.selected ? null : i + 1))
                .filter(Boolean);
              const msg = blanks.length
                ? `${blanks.length} question${blanks.length === 1 ? '' : 's'} still blank: `
                  + `${blanks.join(', ')}.\n\nThere is no negative marking - guess before you `
                  + `submit rather than leaving them empty.\n\nSubmit anyway?`
                : 'Submit this paper?';
              if (confirm(msg)) this.finish('submitted');
            }
          }, 'Submit paper'))));

    const bar = el('div', { class: 'exam-bar' },
      this.timerEl,
      this.allowed !== null ? el('button', {
        class: 'btn ghost small', onclick: () => {
          this.timerHidden = !this.timerHidden; this.paintTimer();
        }
      }, 'Hide/show') : null,
      el('div', { class: 'spacer' }),
      el('strong', {}, paperName(this.a)),
      this.a.mode === 'mock' ? el('span', { class: 'pill' }, 'Full mock') : null,
      this.progressEl);

    this.root.replaceChildren(el('div', { class: 'exam' }, bar, body));
    this.paintTimer(); this.paintOptions(); this.paintNav();
    this.paintFlagBtn(); this.paintConfidence();
  }
}

async function viewExam() {
  const attempt = await api.attempt.get(State.params.attemptId);
  if (attempt.status === 'completed') return go('results', { attemptId: attempt.id });
  const root = el('div');
  State.exam = new Exam(attempt);
  queueMicrotask(() => State.exam.mount(root));
  return root;
}

// ---------------------------------------------------------------- break
function viewBreak() {
  const done = State.params.attempt;
  const total = (State.settings.breakMinutes || 15) * 60;
  let left = total;
  const count = el('div', { class: 'count' }, fmtClock(left));

  const startPaper2 = async () => {
    clearInterval(timer);
    const a = await api.attempt.start({
      mode: 'mock', year: done.year, paper: 2, mockGroup: done.mockGroup,
    });
    go('exam', { attemptId: a.id });
  };

  const timer = setInterval(() => {
    left -= 1;
    count.textContent = fmtClock(left);
    if (left <= 0) { clearInterval(timer); startPaper2(); }
  }, 1000);

  return el('div', { class: 'break' },
    el('div', {},
      el('h1', {}, 'Break'),
      el('p', { class: 'muted' }, `Paper 1 complete — ${done.scoreRaw}/${done.questions.length} raw. Paper 2 starts when the break ends.`),
      count,
      el('div', { class: 'row', style: 'justify-content:center' },
        el('button', { class: 'btn', onclick: startPaper2 }, 'Skip break — start Paper 2'),
        el('button', {
          class: 'btn ghost', onclick: () => {
            clearInterval(timer); go('results', { attemptId: done.id });
          }
        }, 'View Paper 1 results'))));
}

// ---------------------------------------------------------------- results
async function viewResults() {
  const a = await api.attempt.get(State.params.attemptId);
  const total = a.questions.length;
  const correct = a.questions.filter(q => q.correct).length;
  const unanswered = a.questions.filter(q => !q.selected).length;
  const timeUsed = a.elapsedSec;

  // per-topic breakdown for this attempt
  const topics = new Map();
  for (const q of a.questions) {
    for (const t of q.question.topics) {
      if (!topics.has(t)) topics.set(t, { seen: 0, correct: 0 });
      const s = topics.get(t); s.seen++; if (q.correct) s.correct++;
    }
  }
  const topicRows = [...topics.entries()]
    .map(([id, s]) => ({ id, label: State.catalog.taxonomy[id] || id, ...s, acc: s.correct / s.seen }))
    .sort((x, y) => x.acc - y.acc);

  let mockBox = null;
  if (a.mockGroup) {
    const sum = await api.mock.summary(a.mockGroup);
    if (sum && sum.papers.length === 2) {
      mockBox = el('div', { class: 'card' },
        el('h2', {}, 'Full mock result'),
        el('div', { class: 'row' },
          sum.papers.map(p => el('div', { class: 'stat', style: 'flex:1' },
            el('div', { class: 'label' }, `Paper ${p.paper}`),
            el('div', { class: 'value' }, `${p.raw}/${p.total}`),
            el('div', { class: 'small muted' }, p.scaled !== null ? `scaled ${p.scaled.toFixed(1)}` : 'no table'))),
          el('div', { class: 'stat', style: 'flex:1' },
            el('div', { class: 'label' }, 'Overall'),
            el('div', { class: 'value' }, sum.overallScaled !== null ? sum.overallScaled.toFixed(1) : `${sum.rawTotal}/40`),
            el('div', { class: 'small muted' }, `${sum.rawTotal}/40 raw`))));
    } else if (a.paper === 1) {
      mockBox = el('div', { class: 'banner info' },
        'Paper 1 done. Return to Practise to resume the mock with Paper 2.');
    }
  }

  return shell('history',
    el('div', { class: 'row', style: 'justify-content:space-between' },
      el('h1', {}, 'Results — ', paperName(a)),
      el('div', { class: 'row' },
        el('button', { class: 'btn', onclick: () => go('review', { attemptId: a.id }) }, 'Review every question'),
        el('button', { class: 'btn ghost', onclick: () => go('home') }, 'Done'),
        el('button', {
          class: 'btn ghost', style: 'color:var(--bad)',
          onclick: () => runDelete(a.id, { onDone: () => go('history') }),
        }, 'Delete this attempt'))),
    a.finishReason === 'timeout'
      ? el('div', { class: 'banner', style: 'margin-bottom:14px' },
        `Time expired — the paper was submitted automatically with ${unanswered} question${unanswered === 1 ? '' : 's'} unanswered.`)
      : null,
    mockBox ? el('div', { style: 'margin-bottom:16px' }, mockBox) : null,

    el('div', { class: 'grid cols-3', style: 'margin-bottom:18px' },
      el('div', { class: 'stat' },
        el('div', { class: 'label' }, 'Raw score'),
        el('div', { class: 'value' }, `${correct}/${total}`),
        el('div', { class: 'bar good', style: 'margin-top:8px' },
          el('i', { style: `width:${(correct / total) * 100}%` }))),
      el('div', { class: 'stat' },
        el('div', { class: 'label' }, 'Percentage'),
        el('div', { class: 'value' }, pct(correct / total))),
      el('div', { class: 'stat' },
        el('div', { class: 'label' }, 'Estimated TMUA score'),
        el('div', { class: 'value' }, a.scoreScaled !== null && a.scoreScaled !== undefined ? a.scoreScaled.toFixed(1) : '—'),
        el('div', { class: 'small muted' },
          a.scoreScaled !== null && a.scoreScaled !== undefined
            ? `official ${a.year} conversion` : 'no official table for this set')),
      el('div', { class: 'stat' },
        el('div', { class: 'label' }, 'Time used'),
        el('div', { class: 'value' }, fmtClock(timeUsed)),
        el('div', { class: 'small muted' },
          a.allowedSec ? `of ${fmtClock(a.allowedSec)}` : 'untimed')),
      el('div', { class: 'stat' },
        el('div', { class: 'label' }, 'Unanswered'),
        el('div', { class: 'value' }, String(unanswered))),
      el('div', { class: 'stat' },
        el('div', { class: 'label' }, 'Avg per question'),
        el('div', { class: 'value' }, fmtMinSec(timeUsed / total)))),

    el('div', { class: 'card' },
      el('h2', {}, 'By topic'),
      el('div', { class: 'table-scroll' },
        el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'Topic'), el('th', {}, 'Correct'), el('th', {}, 'Accuracy'), el('th', {}, ''))),
          el('tbody', {}, topicRows.map(r => el('tr', {},
            el('td', {}, r.label),
            el('td', { class: 'mono' }, `${r.correct}/${r.seen}`),
            el('td', { class: 'mono' }, pct(r.acc)),
            el('td', { style: 'width:35%' },
              el('div', { class: 'bar ' + (r.acc >= 0.7 ? 'good' : 'bad') },
                el('i', { style: `width:${r.acc * 100}%` })))))))))
  );
}

// ---------------------------------------------------------------- review
async function viewReview() {
  const a = await api.attempt.get(State.params.attemptId);
  const revisit = new Set((await api.revisit.list()).map(r => r.questionId));

  const item = (q) => {
    const correct = q.correct;
    const opts = el('div', { class: 'options row-letters', style: 'margin-top:10px' },
      LETTERS.slice(0, q.question.options).split('').map(L => {
        const isAnswer = L === q.question.answer;
        const isPicked = L === q.selected;
        return el('div', {
          class: 'opt ' + (isAnswer ? 'correct' : isPicked ? 'wrong' : '')
        }, el('span', { class: 'letter' }, L),
          el('span', { class: 'tag' },
            isAnswer && isPicked ? 'correct · yours'
              : isAnswer ? 'correct' : isPicked ? 'yours' : ' '));
      }));

    const revBtn = el('button', { class: 'btn ghost small' });
    const paintRev = () => {
      const on = revisit.has(q.question.id);
      revBtn.textContent = on ? '★ On revisit list' : '☆ Revisit later';
    };
    revBtn.onclick = async () => {
      if (revisit.has(q.question.id)) { await api.revisit.remove(q.question.id); revisit.delete(q.question.id); }
      else { await api.revisit.add({ questionId: q.question.id }); revisit.add(q.question.id); }
      paintRev();
    };
    paintRev();

    return el('div', { class: 'review-item' },
      el('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:10px' },
        el('div', { class: 'row' },
          el('strong', {}, `Question ${q.position + 1}`),
          el('span', { class: 'pill ' + (correct ? 'good' : 'bad') },
            correct ? 'Correct' : q.selected ? `Wrong — you chose ${q.selected}` : 'Not answered'),
          q.confidence ? el('span', { class: 'pill' },
            q.confidence === 'sure' ? 'Marked sure' : 'Marked unsure') : null,
          q.flagged ? el('span', { class: 'pill flag' }, 'Flagged') : null,
          el('span', { class: 'pill' }, fmtMinSec(q.timeSpent)),
          q.question.topics.map(t => el('span', { class: 'pill' }, State.catalog.taxonomy[t] || t))),
        revBtn),
      el('img', { class: 'qimage', src: q.question.image, loading: 'lazy', alt: '' }),
      opts,
      correct === false ? errorTagger(a.id, q) : null,
      q.notepad ? el('details', { style: 'margin-top:8px' },
        el('summary', {}, 'My working notes'), el('pre', { class: 'small' }, q.notepad)) : null,
      el('details', { style: 'margin-top:8px' },
        el('summary', {}, 'Official worked solution'),
        el('img', { class: 'solution-img', src: q.question.solution, loading: 'lazy', alt: '' })));
  };

  const listEl = el('div', { class: 'card' }, a.questions.map(item));
  const filterSel = el('select', {
    onchange: e => {
      const v = e.target.value;
      const rows = a.questions.filter(q =>
        v === 'all' ? true : v === 'wrong' ? !q.correct : v === 'flagged' ? q.flagged : !q.selected);
      listEl.replaceChildren(...rows.map(item));
    }
  },
    el('option', { value: 'all' }, 'All questions'),
    el('option', { value: 'wrong' }, 'Wrong only'),
    el('option', { value: 'flagged' }, 'Flagged only'),
    el('option', { value: 'unanswered' }, 'Unanswered only'));

  return shell('history',
    el('div', { class: 'row', style: 'justify-content:space-between' },
      el('h1', {}, 'Review — ', paperName(a)),
      el('div', { class: 'row' }, filterSel,
        el('button', { class: 'btn ghost', onclick: () => go('results', { attemptId: a.id }) }, 'Back to results'))),
    listEl);
}

// ---------------------------------------------------------------- history
async function viewHistory() {
  const rows = await api.history.list();
  const selected = new Set();
  const bar = el('div', { class: 'row', style: 'margin-bottom:12px' });
  const paintBar = () => {
    bar.replaceChildren(
      el('span', { class: 'small muted' },
        selected.size ? `${selected.size} selected` : 'Select attempts to delete'),
      selected.size ? el('button', {
        class: 'btn danger small',
        onclick: () => runDelete([...selected], { onDone: () => render() }),
      }, `Delete ${selected.size} selected`) : null,
      selected.size ? el('button', {
        class: 'btn ghost small', onclick: () => { selected.clear(); render(); },
      }, 'Clear selection') : null);
  };
  paintBar();

  if (!rows.length) {
    return shell('history', el('h1', {}, 'History'),
      el('div', { class: 'card muted' }, 'No attempts yet. Start a paper from Practise.'));
  }
  return shell('history',
    el('h1', {}, 'History'),
    bar,
    el('div', { class: 'card table-scroll' },
      el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, ''),
          el('th', {}, 'Paper'), el('th', {}, 'Mode'), el('th', {}, 'When'),
          el('th', {}, 'Score'), el('th', {}, 'Scaled'), el('th', {}, 'Time'),
          el('th', {}, 'Status'), el('th', {}, ''))),
        el('tbody', {}, rows.map(a => el('tr', {},
          el('td', {}, el('input', {
            type: 'checkbox', class: 'sel-attempt', 'data-id': String(a.id),
            onchange: e => {
              if (e.target.checked) selected.add(a.id); else selected.delete(a.id);
              paintBar();
            },
          })),
          el('td', {}, paperName(a)),
          el('td', { class: 'small muted' }, a.mode),
          el('td', { class: 'small' }, fmtDate(a.completedAt || a.startedAt)),
          el('td', { class: 'mono' }, a.scoreRaw === null ? '—' : `${a.scoreRaw}/${a.total}`),
          el('td', { class: 'mono' }, a.scoreScaled === null || a.scoreScaled === undefined ? '—' : a.scoreScaled.toFixed(1)),
          el('td', { class: 'mono small' }, fmtClock(a.elapsedSec)),
          el('td', {}, el('span', {
            class: 'pill ' + (a.status === 'completed' ? 'good' : a.status === 'in_progress' ? 'warn' : '')
          }, a.finishReason === 'timeout' ? 'timed out' : a.status.replace('_', ' '))),
          el('td', {}, el('div', { class: 'row' },
            a.status === 'completed'
              ? el('button', { class: 'btn ghost small', onclick: () => go('results', { attemptId: a.id }) }, 'Open')
              : a.status === 'in_progress'
                ? el('button', { class: 'btn small', onclick: () => go('exam', { attemptId: a.id }) }, 'Resume')
                : null,
            a.status === 'completed'
              ? el('button', { class: 'btn ghost small', onclick: () => go('review', { attemptId: a.id }) }, 'Review')
              : null,
            a.mockGroup
              ? el('button', {
                class: 'btn ghost small', title: 'Delete both papers of this mock',
                onclick: async () => {
                  const all = rows.filter(r => r.mockGroup === a.mockGroup).map(r => r.id);
                  runDelete(all, { onDone: () => render() });
                },
              }, 'Delete mock')
              : null,
            el('button', {
              class: 'btn ghost small',
              onclick: () => runDelete(a.id, { onDone: () => render() }),
            }, 'Delete')))))))));
}

// ---------------------------------------------------------------- dashboard
async function viewDashboard() {
  const d = await api.analytics.dashboard();
  const s = d.summary;

  if (!s.completedCount) {
    return shell('dashboard', el('h1', {}, 'Progress'),
      el('div', { class: 'card muted' }, 'Complete a paper to unlock analytics.'));
  }

  const maxScore = 20;
  const trend = el('div', { class: 'trend' },
    s.trend.slice(-24).map(t => el('div', {
      class: 'col' + (t.paper === 2 ? ' p2' : ''),
      title: `${t.year || 'drill'} P${t.paper || '-'} — ${t.raw}/${t.total} on ${fmtDate(t.at)}`
    },
      el('i', { style: `height:${(t.raw / (t.total || maxScore)) * 100}%` }),
      el('span', { class: 'tiny mono muted' }, String(t.raw)))));

  const p1 = s.byPaperType[1], p2 = s.byPaperType[2];
  const avg = (b) => b.n ? (b.raw / b.n) : null;

  const weakBox = d.weaknesses.length
    ? d.weaknesses.map(w => el('div', { class: 'card' },
      el('div', { class: 'row', style: 'justify-content:space-between' },
        el('h3', { style: 'margin:0' }, w.label),
        el('span', { class: 'pill bad' }, `${pct(w.accuracy)} · ${w.correct}/${w.seen}`)),
      el('div', { class: 'bar bad', style: 'margin:8px 0 12px' }, el('i', { style: `width:${w.accuracy * 100}%` })),
      el('p', { class: 'small' }, el('strong', {}, 'Revise: '), w.advice.revise),
      el('p', { class: 'small' }, el('strong', {}, 'Drill: '), w.advice.drill),
      el('button', {
        class: 'btn small', onclick: async () => {
          const res = await api.drill.build({ source: 'all', topics: [w.topic], shuffle: true, limit: 20 });
          if (!res.ids.length) return toast('No questions available');
          const a = await api.attempt.start({
            mode: 'drill', questionIds: res.ids, untimed: true, label: `Drill · ${w.label}`,
          });
          go('exam', { attemptId: a.id });
        }
      }, `Drill ${w.label}`)))
    : [el('div', { class: 'card muted' }, 'No topic is below 70% with enough attempts yet.')];

  const conf = d.confidence;
  const pacing = d.pacing;

  return shell('dashboard',
    el('h1', {}, 'Progress'),
    el('div', { class: 'grid cols-3', style: 'margin-bottom:18px' },
      el('div', { class: 'stat' },
        el('div', { class: 'label' }, 'Papers completed'), el('div', { class: 'value' }, String(s.completedCount))),
      el('div', { class: 'stat' },
        el('div', { class: 'label' }, 'Paper 1 average'),
        el('div', { class: 'value' }, avg(p1) === null ? '—' : avg(p1).toFixed(1)),
        el('div', { class: 'small muted' }, `${p1.n} attempt${p1.n === 1 ? '' : 's'}`)),
      el('div', { class: 'stat' },
        el('div', { class: 'label' }, 'Paper 2 average'),
        el('div', { class: 'value' }, avg(p2) === null ? '—' : avg(p2).toFixed(1)),
        el('div', { class: 'small muted' }, `${p2.n} attempt${p2.n === 1 ? '' : 's'}`)),
      el('div', { class: 'stat' },
        el('div', { class: 'label' }, 'Weekly streak'),
        el('div', { class: 'value' }, `${d.study.streak}w`)),
      el('div', { class: 'stat' },
        el('div', { class: 'label' }, 'Avg per question'),
        el('div', { class: 'value' }, fmtMinSec(pacing.avgSecPerQuestion))),
      el('div', { class: 'stat' },
        el('div', { class: 'label' }, 'Unanswered at timeout'),
        el('div', { class: 'value' }, String(pacing.unansweredAtTimeout)))),

    el('div', { class: 'grid cols-2' },
      el('div', { class: 'card' },
        el('h2', {}, 'Score trend'),
        el('div', { class: 'small muted' }, 'Raw score per completed paper (blue = Paper 1, purple = Paper 2).'),
        trend),
      el('div', { class: 'card' },
        el('h2', {}, 'Pacing'),
        pacing.note ? el('div', { class: 'banner', style: 'margin-bottom:10px' }, pacing.note) : null,
        el('table', {},
          el('thead', {}, el('tr', {}, el('th', {}, 'Questions'), el('th', {}, 'Accuracy'), el('th', {}, 'Seen'))),
          el('tbody', {}, pacing.buckets.map(b => el('tr', {},
            el('td', {}, `Q${b.from}–${b.to}`),
            el('td', { class: 'mono' }, b.accuracy === null ? '—' : pct(b.accuracy)),
            el('td', { class: 'mono muted' }, String(b.seen)))))),
        pacing.overruns.length ? el('details', { style: 'margin-top:10px' },
          el('summary', {}, 'Slowest questions'),
          el('table', {}, el('tbody', {}, pacing.overruns.slice(0, 8).map(o => el('tr', {},
            el('td', { class: 'small' }, `${o.year} P${o.paper} Q${o.number}`),
            el('td', { class: 'mono small' }, fmtMinSec(o.time)),
            el('td', {}, el('span', { class: 'pill ' + (o.correct ? 'good' : 'bad') }, o.correct ? '✓' : '✗'))))))) : null)),

    el('h2', { style: 'margin:22px 0 10px' }, 'Weakest topics — and how to fix them'),
    el('div', { class: 'grid cols-2' }, weakBox),

    el('h2', { style: 'margin:22px 0 10px' }, 'All topics'),
    el('div', { class: 'card table-scroll' },
      el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, 'Topic'), el('th', {}, 'Accuracy'), el('th', {}, 'Correct'), el('th', {}, ''), el('th', {}, ''))),
        el('tbody', {}, d.topics.map(t => el('tr', {},
          el('td', {}, t.label),
          el('td', { class: 'mono' }, pct(t.accuracy)),
          el('td', { class: 'mono muted' }, `${t.correct}/${t.seen}`),
          el('td', { style: 'width:30%' },
            el('div', { class: 'bar ' + (t.accuracy >= 0.7 ? 'good' : 'bad') },
              el('i', { style: `width:${t.accuracy * 100}%` }))),
          el('td', {}, el('button', {
            class: 'btn ghost small', onclick: async () => {
              const res = await api.drill.build({ source: 'all', topics: [t.topic], shuffle: true, limit: 20 });
              const a = await api.attempt.start({
                mode: 'drill', questionIds: res.ids, untimed: true, label: `Drill · ${t.label}`,
              });
              go('exam', { attemptId: a.id });
            }
          }, 'Drill'))))))),

    el('div', { class: 'grid cols-2', style: 'margin-top:18px' },
      el('div', { class: 'card' },
        el('h2', {}, 'Confidence'),
        el('table', {}, el('tbody', {},
          el('tr', {}, el('td', {}, 'Sure and right'), el('td', { class: 'mono' }, String(conf.sureRight))),
          el('tr', {}, el('td', {}, el('strong', {}, 'Sure but wrong')), el('td', { class: 'mono' }, String(conf.sureWrong))),
          el('tr', {}, el('td', {}, 'Unsure but right'), el('td', { class: 'mono' }, String(conf.unsureRight))),
          el('tr', {}, el('td', {}, 'Unsure and wrong'), el('td', { class: 'mono' }, String(conf.unsureWrong))),
          el('tr', {}, el('td', { class: 'muted' }, 'Not marked'), el('td', { class: 'mono muted' }, String(conf.unmarked))))),
        conf.sureWrong > 0 ? el('p', { class: 'small', style: 'margin-top:10px' },
          `${conf.sureWrong} question${conf.sureWrong === 1 ? ' was' : 's were'} answered confidently but wrongly — those are misconceptions worth reviewing first.`) : null),

      el('div', { class: 'card' },
        el('h2', {}, 'Papers not yet attempted'),
        s.notDone.length
          ? el('div', { class: 'row' }, s.notDone.map(p =>
            el('button', {
              class: 'btn ghost small', onclick: async () => {
                const a = await api.attempt.start({ mode: 'paper', year: p.year, paper: p.paper });
                go('exam', { attemptId: a.id });
              }
            }, `${p.year === 'specimen' ? 'Specimen' : p.year} P${p.paper}`)))
          : el('div', { class: 'muted small' }, 'Every paper has been attempted at least once.'))),

    el('h2', { style: 'margin:22px 0 10px' }, 'Wrong-answer log'),
    wrongLogCard(d.wrong));
}

// Wrong-answer log with topic / paper / year filters.
function wrongLogCard(wrong) {
  const topics = [...new Set(wrong.flatMap(w => w.topics))]
    .sort((a, b) => (State.catalog.taxonomy[a] || a).localeCompare(State.catalog.taxonomy[b] || b));
  const years = [...new Set(wrong.map(w => w.year))].sort();
  const filters = { topic: 'all', paper: 'all', year: 'all' };

  const body = el('tbody');
  const countEl = el('span', { class: 'small muted' });

  const apply = () => {
    const rows = wrong.filter(w =>
      (filters.topic === 'all' || w.topics.includes(filters.topic)) &&
      (filters.paper === 'all' || String(w.paper) === filters.paper) &&
      (filters.year === 'all' || w.year === filters.year));
    countEl.textContent = `${rows.length} of ${wrong.length} shown`;
    body.replaceChildren(...rows.slice(0, 200).map(w => el('tr', { class: 'wrong-row' },
      el('td', {}, `${w.year === 'specimen' ? 'Spec' : w.year} P${w.paper} Q${w.number}`),
      el('td', { class: 'small muted' }, w.topics.map(t => State.catalog.taxonomy[t] || t).join(', ')),
      el('td', { class: 'mono' }, w.unanswered ? '—' : w.selected),
      el('td', { class: 'mono' }, w.answer),
      el('td', { class: 'mono small' }, fmtMinSec(w.time)),
      el('td', { class: 'small muted' }, fmtDate(w.at)),
      el('td', {}, el('button', {
        class: 'btn ghost small',
        onclick: () => go('review', { attemptId: w.attemptId })
      }, 'Review')))));
  };

  const sel = (id, label, values, render) => el('select', {
    id, onchange: e => { filters[label] = e.target.value; apply(); }
  }, el('option', { value: 'all' }, `All ${label}s`),
    values.map(v => el('option', { value: String(v) }, render(v))));

  if (!wrong.length) {
    return el('div', { class: 'card muted' }, 'No wrong answers recorded.');
  }
  apply();
  return el('div', { class: 'card' },
    el('div', { class: 'row', style: 'margin-bottom:10px' },
      sel('filter-topic', 'topic', topics, t => State.catalog.taxonomy[t] || t),
      sel('filter-paper', 'paper', [1, 2], p => `Paper ${p}`),
      sel('filter-year', 'year', years, y => (y === 'specimen' ? 'Specimen' : y)),
      el('div', { class: 'spacer' }), countEl),
    el('div', { class: 'table-scroll' },
      el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, 'Question'), el('th', {}, 'Topics'), el('th', {}, 'You'), el('th', {}, 'Answer'),
          el('th', {}, 'Time'), el('th', {}, 'When'), el('th', {}, ''))),
        body)));
}

// ---------------------------------------------------------------- revisit
async function viewRevisit() {
  const rows = await api.revisit.list();
  const startDrill = async () => {
    const res = await api.drill.build({ source: 'revisit', shuffle: false, limit: null });
    if (!res.ids.length) return toast('Revisit list is empty');
    const a = await api.attempt.start({
      mode: 'drill', questionIds: res.ids, untimed: true, label: 'Drill · revisit list',
    });
    go('exam', { attemptId: a.id });
  };

  return shell('revisit',
    el('div', { class: 'row', style: 'justify-content:space-between' },
      el('h1', {}, 'Revisit list'),
      rows.length ? el('button', { class: 'btn', onclick: startDrill }, 'Redo all as a drill') : null),
    rows.length
      ? el('div', { class: 'card table-scroll' },
        el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'Question'), el('th', {}, 'Topics'), el('th', {}, 'Added'), el('th', {}, ''))),
          el('tbody', {}, rows.map(r => el('tr', {},
            el('td', {}, `${r.year === 'specimen' ? 'Specimen' : r.year} Paper ${r.paper} Q${r.number}`),
            el('td', { class: 'small muted' }, r.topics.map(t => State.catalog.taxonomy[t] || t).join(', ')),
            el('td', { class: 'small muted' }, fmtDate(r.addedAt)),
            el('td', {}, el('button', {
              class: 'btn ghost small', onclick: async () => {
                await api.revisit.remove(r.questionId); render();
              }
            }, 'Remove')))))))
      : el('div', { class: 'card muted' },
        'Nothing here yet. While reviewing a paper, mark questions “Revisit later” and they will collect here.'));
}

// ---------------------------------------------------------------- settings
async function viewSettings() {
  const s = State.settings;
  const archives = await api.archive.list();
  const years = [...new Set(State.catalog.papers.map(p => p.year))];

  const targetInput = el('input', { type: 'number', min: '1', max: '9', step: '0.1',
    value: String(s.targetScore ?? 7) });
  const examInput = el('input', { type: 'date', value: s.examDate || '2026-10-12' });
  const accessBox = el('input', { type: 'checkbox', ...(s.accessArranged ? { checked: true } : {}) });
  const bookedBox = el('input', { type: 'checkbox', ...(s.examBooked ? { checked: true } : {}) });
  const archiveName = el('input', { type: 'text', placeholder: 'e.g. pre-September run' });
  const pdfYear = el('select', {}, years.map(y =>
    el('option', { value: y }, y === 'specimen' ? 'Specimen' : y)));
  const pdfPaper = el('select', {},
    el('option', { value: '1' }, 'Paper 1'), el('option', { value: '2' }, 'Paper 2'));
  const sheetBox = el('input', { type: 'checkbox' });
  const msBox = el('input', { type: 'checkbox' });

  const saveExam = async () => {
    try {
      State.settings = await api.settings.set({
        targetScore: targetInput.valueAsNumber,
        examDate: examInput.value,
        accessArranged: accessBox.checked,
        examBooked: bookedBox.checked,
      });
      toast('Exam settings saved');
    } catch (e) { toast(e.message); }
  };
  const totalMins = () => Math.max(1, Math.floor(base.valueAsNumber * (1 + extra.valueAsNumber / 100)));
  const preview = el('strong', {});

  const base = el('input', { type: 'number', min: '1', max: '300', value: String(s.baseMinutes) });
  const extra = el('input', { type: 'number', min: '0', max: '200', value: String(s.extraTimePercent) });
  const brk = el('input', { type: 'number', min: '0', max: '60', value: String(s.breakMinutes) });
  const hide = el('input', { type: 'checkbox', ...(s.hideTimer ? { checked: true } : {}) });
  const dark = el('input', { type: 'checkbox', ...(s.darkMode ? { checked: true } : {}) });
  const snd = el('input', { type: 'checkbox', ...(s.sound ? { checked: true } : {}) });

  const paint = () => { preview.textContent = `${totalMins()}:00 per paper`; };
  base.oninput = extra.oninput = paint;
  paint();

  const save = async () => {
    State.settings = await api.settings.set({
      baseMinutes: base.valueAsNumber,
      extraTimePercent: extra.valueAsNumber,
      breakMinutes: brk.valueAsNumber,
      hideTimer: hide.checked,
      darkMode: dark.checked,
      sound: snd.checked,
    });
    applyTheme();
    toast('Settings saved');
  };

  return shell('settings',
    el('h1', {}, 'Settings'),
    el('div', { class: 'grid cols-2' },
      el('div', { class: 'card' },
        el('h2', {}, 'Timing'),
        el('div', { class: 'row' },
          el('label', { class: 'field' }, 'Base minutes per paper', base),
          el('label', { class: 'field' }, 'Extra time %', extra),
          el('label', { class: 'field' }, 'Break minutes (mock)', brk)),
        el('p', { class: 'small', style: 'margin-top:12px' }, 'Each paper will run for ', preview, '.'),
        el('label', { class: 'checkline' }, hide, 'Hide the timer by default'),
        el('label', { class: 'checkline' }, snd, 'Sound on warnings'),
        el('label', { class: 'checkline' }, dark, 'Dark mode'),
        el('button', { class: 'btn', style: 'margin-top:14px', onclick: save }, 'Save settings')),

      el('div', { class: 'card' },
        el('h2', {}, 'Exam & target'),
        el('div', { class: 'row' },
          el('label', { class: 'field' }, 'Target score (1.0-9.0)', targetInput),
          el('label', { class: 'field' }, 'Your booked exam date', examInput)),
        el('p', { class: 'tiny muted', style: 'margin-top:8px' },
          'October 2026 sitting runs 12-16 October. Until you enter your booked date the '
          + 'countdown uses 12 October 2026.'),
        el('div', { style: 'margin-top:10px' },
          el('label', { class: 'checkline' }, accessBox,
            'Access arrangements applied for (25% extra time) - deadline 14 Sep 2026, 6pm'),
          el('label', { class: 'checkline' }, bookedBox,
            'Test booked at a Pearson centre - deadline 28 Sep 2026, 6pm')),
        el('button', { class: 'btn', style: 'margin-top:14px', onclick: saveExam }, 'Save exam settings')),

      el('div', { class: 'card' },
        el('h2', {}, 'Print a paper'),
        el('p', { class: 'small muted' },
          'Export a clean printable PDF with room for working. The questions-only version '
          + 'contains no answers.'),
        el('div', { class: 'row' }, pdfYear, pdfPaper),
        el('div', { style: 'margin-top:8px' },
          el('label', { class: 'checkline' }, sheetBox, 'Include an answer sheet'),
          el('label', { class: 'checkline' }, msBox, 'Include the mark scheme (separate pages)')),
        el('button', {
          class: 'btn ghost', style: 'margin-top:12px', onclick: async () => {
            const r = await api.pdf.paper({
              year: pdfYear.value, paper: Number(pdfPaper.value),
              includeAnswerSheet: sheetBox.checked, includeMarkScheme: msBox.checked,
            });
            if (!r.canceled) toast(`Exported (${Math.round(r.bytes / 1024)} KB)`);
          }
        }, 'Export paper as PDF')),

      el('div', { class: 'card' },
        el('h2', {}, 'Archives'),
        el('p', { class: 'small muted' },
          'Archiving moves your completed attempts out of the active dashboard so a fresh run '
          + 'starts clean. Nothing is deleted - archives stay browsable and restorable, and a '
          + 'backup is taken first.'),
        el('div', { class: 'row' }, archiveName,
          el('button', {
            class: 'btn', onclick: async () => {
              const name = archiveName.value.trim();
              if (!name) return toast('Give the archive a name');
              if (!confirm(`Archive all completed attempts as "${name}"? `
                + 'Your active analytics will start fresh. Nothing is deleted.')) return;
              const r = await api.archive.create({ name });
              toast(`Archived ${r.moved} attempt(s)`); render();
            }
          }, 'Archive current run')),
        el('p', { class: 'tiny muted', style: 'margin-top:12px' },
          'Archiving is the non-destructive option. To remove data permanently, use '
          + 'Delete all history below — that cannot be undone.'),
        archives.length
          ? el('table', { style: 'margin-top:12px' }, el('tbody', {}, archives.map(a => el('tr', {},
            el('td', {}, a.name),
            el('td', { class: 'mono small' }, `${a.attempts} attempts`),
            el('td', { class: 'small muted' }, fmtDate(a.created_at)),
            el('td', {}, el('button', {
              class: 'btn ghost small', onclick: async () => {
                if (!confirm(`Restore "${a.name}" back into your active history?`)) return;
                const r = await api.archive.restore(a.id);
                toast(`Restored ${r.restored} attempt(s)`); render();
              }
            }, 'Restore')))))) 
          : el('p', { class: 'tiny muted', style: 'margin-top:10px' }, 'No archives yet.')),

      el('div', { class: 'card' },
        el('h2', {}, 'Your data'),
        el('p', { class: 'small muted' },
          'Everything is stored locally in a single SQLite file. A timestamped backup is taken on every launch (last 20 kept).'),
        el('div', { class: 'small mono', style: 'word-break:break-all;padding:8px;background:var(--panel-2);border-radius:8px' },
          State.catalog.dbPath),
        el('div', { class: 'row', style: 'margin-top:12px' },
          el('button', { class: 'btn ghost small', onclick: () => api.data.reveal() }, 'Show in Finder'),
          el('button', {
            class: 'btn ghost small', onclick: async () => {
              const r = await api.data.export();
              if (!r.canceled) toast(`Exported ${r.attempts} attempts`);
            }
          }, 'Export history (JSON)'),
          el('button', {
            class: 'btn ghost small', onclick: async () => {
              if (!confirm('Importing replaces your current history. Continue?')) return;
              const r = await api.data.import();
              if (!r.canceled) { toast(`Imported ${r.attempts} attempts`); render(); }
            }
          }, 'Import history')),
        el('p', { class: 'tiny muted', style: 'margin-top:14px' },
          'This app makes no network requests. All questions, solutions and score conversions are bundled inside it.'),
        el('button', { class: 'btn ghost small', style: 'margin-top:10px',
          onclick: () => go('about') }, 'About & format note')),

      el('div', { class: 'card', style: 'border-color:var(--bad)' },
        el('h2', {}, 'Delete all history'),
        el('p', { class: 'small muted' },
          'Removes every attempt, answer, review-queue item, archive and study-plan edit. '
          + 'Your papers, question images and settings stay. A backup is taken first, but '
          + 'this is not undoable from inside the app.'),
        el('p', { class: 'small' },
          el('strong', {}, 'If you only want a clean slate, archive instead — it keeps everything and is reversible.')),
        el('button', {
          class: 'btn danger', onclick: async () => {
            const word = prompt('This permanently deletes all your history.\n\nType DELETE ALL to confirm.');
            if (String(word || '').trim().toUpperCase() !== 'DELETE ALL') {
              return toast('Not deleted — confirmation did not match');
            }
            try {
              const r = await api.del.allHistory({ confirm: word });
              toast(`Deleted ${r.removed} attempt(s)`);
              go('home');
            } catch (e) { toast(e.message); }
          }
        }, 'Delete all history'))));
}

// ---------------------------------------------------------------- router
const VIEWS = {
  home: viewHome, drill: viewDrill, exam: viewExam, break: viewBreak,
  results: viewResults, review: viewReview, history: viewHistory,
  dashboard: viewDashboard, revisit: viewRevisit, settings: viewSettings,
  coach: viewCoach, plan: viewPlan, offline: viewOffline, about: viewAbout,
};

async function render() {
  const root = $('#app');
  try {
    const node = await VIEWS[State.view]();
    root.className = '';
    root.replaceChildren(node);
    window.scrollTo(0, 0);
  } catch (err) {
    console.error(err);
    root.className = '';
    root.replaceChildren(el('div', { class: 'page' },
      el('div', { class: 'card' },
        el('h2', {}, 'Something went wrong'),
        el('pre', { class: 'small' }, String(err && err.message || err)),
        el('button', { class: 'btn', onclick: () => go('home') }, 'Back to Practise'))));
  }
}

(async function boot() {
  State.catalog = await api.catalog();
  State.settings = State.catalog.settings;
  applyTheme();
  await go('home');
  window.__ready = true;
})();

// ================================================================ Study Coach

function scoreState(predicted, target) {
  if (predicted === null || predicted === undefined) return 'unknown';
  if (predicted >= target) return 'ontrack';
  if (predicted >= target - 0.5) return 'close';
  return 'offtrack';
}

// Always-visible countdown + predicted-score strip on the home screen.
async function statusBar() {
  const ov = await api.coach.overview({});
  const cd = ov.countdown;
  const pred = ov.prediction;
  const likely = pred.ready && pred.overall ? pred.overall.mostLikely : null;
  const state = scoreState(likely, cd.target);
  const gap = likely === null ? null : Math.round((cd.target - likely) * 10) / 10;

  const warnings = cd.deadlines.filter(d => d.warn && !d.passed);
  const missed = cd.deadlines.filter(d => d.passed && !d.done);

  const next = ov.checklist[0] || null;

  return el('div', { class: `statusbar state-${state}` },
    el('div', { class: 'sb-block' },
      el('div', { class: 'sb-label' }, cd.isPast ? 'Exam was' : 'Exam in'),
      el('div', { class: 'sb-value mono' }, cd.daysLabel),
      el('div', { class: 'sb-sub' },
        cd.isPast ? cd.examDate
          : `${cd.weeks} week${cd.weeks === 1 ? '' : 's'} · ${cd.examDate}`)),

    el('div', { class: 'sb-block' },
      el('div', { class: 'sb-label' }, 'Papers left'),
      el('div', { class: 'sb-value mono' }, `${ov.corePapersLeft} of ${ov.totalCorePapers}`),
      el('div', { class: 'sb-sub' }, 'undone')),

    el('div', { class: 'sb-block grow' },
      el('div', { class: 'sb-label' }, 'Predicted score'),
      pred.ready && likely !== null
        ? el('div', {},
          el('div', { class: 'sb-value mono' },
            `${likely.toFixed(1)} → target ${cd.target.toFixed(1)}`,
            el('span', { class: `pill ${state === 'ontrack' ? 'good' : state === 'close' ? 'warn' : 'bad'}`,
              style: 'margin-left:10px' },
              state === 'ontrack' ? 'on track' : state === 'close' ? 'close' : 'off track')),
          el('div', { class: 'sb-sub' },
            gap > 0 ? `gap ${gap.toFixed(1)} · range ${pred.overall.low.toFixed(1)}–${pred.overall.high.toFixed(1)}`
              : `range ${pred.overall.low.toFixed(1)}–${pred.overall.high.toFixed(1)}`))
        : el('div', {},
          el('div', { class: 'sb-value mono' }, '—'),
          el('div', { class: 'sb-sub' }, pred.message || 'need more data'))),

    el('div', { class: 'sb-block' },
      next
        ? el('button', {
          class: 'btn', onclick: () => runChecklistAction(next)
        }, 'Next: ' + shortTitle(next.title))
        : el('button', { class: 'btn ghost', onclick: () => go('coach') }, 'Open coach')),

    (warnings.length || missed.length)
      ? el('div', { class: 'sb-warnings' },
        warnings.map(d => el('div', { class: 'banner' },
          `${d.label}: ${d.days} day${d.days === 1 ? '' : 's'} left — not yet ticked off. `,
          el('button', {
            class: 'btn small', style: 'margin-left:8px', onclick: () => go('settings')
          }, 'Mark done'))),
        missed.map(d => el('div', { class: 'banner' },
          `${d.label}: deadline passed and still not ticked off.`)))
      : null);
}

function shortTitle(t) {
  return t.length > 42 ? t.slice(0, 40).trim() + '…' : t;
}

async function runChecklistAction(item) {
  const a = item.action || {};
  try {
    if (a.type === 'drill') {
      let ids = a.questionIds;
      if (!ids) {
        const res = await api.drill.build({
          source: 'all', topics: a.topics || [], shuffle: true, limit: 20,
        });
        ids = res.ids;
      }
      if (!ids.length) return toast('No questions available for that drill');
      const at = await api.attempt.start({
        mode: 'drill', questionIds: ids, untimed: a.untimed !== false,
        label: a.label || 'Drill',
      });
      await api.coach.complete({ itemKey: item.key, title: item.title, kind: item.kind });
      return go('exam', { attemptId: at.id });
    }
    if (a.type === 'review') {
      const sess = await api.review.session({ cap: a.cap });
      if (!sess.ids.length) return toast('Nothing due for review right now');
      const at = await api.attempt.start({
        mode: 'drill', questionIds: sess.ids, untimed: true,
        label: `Review · ${sess.ids.length} due`,
      });
      await api.coach.complete({ itemKey: item.key, title: item.title, kind: item.kind });
      return go('exam', { attemptId: at.id });
    }
    if (a.type === 'paper') {
      const at = await api.attempt.start({ mode: 'paper', year: a.year, paper: a.paper });
      await api.coach.complete({ itemKey: item.key, title: item.title, kind: item.kind });
      return go('exam', { attemptId: at.id });
    }
    if (a.type === 'mock') {
      const group = `mock-${a.year}-${Date.now()}`;
      const at = await api.attempt.start({ mode: 'mock', year: a.year, paper: 1, mockGroup: group });
      await api.coach.complete({ itemKey: item.key, title: item.title, kind: item.kind });
      return go('exam', { attemptId: at.id });
    }
    if (a.type === 'offline-entry') return go('offline');
    return go('home');
  } catch (err) {
    toast(err.message);
  }
}

async function viewCoach() {
  const ov = await api.coach.overview({});
  const diag = await api.coach.diagnostics({});
  const doneHistory = await api.coach.history();
  const pred = ov.prediction;
  const cd = ov.countdown;

  const kindPill = {
    retry: 'flag', study: '', habit: 'warn', paper: 'good', consolidate: '',
  };

  const predictionCard = el('div', { class: 'card' },
    el('h2', {}, 'Predicted score'),
    !pred.ready
      ? el('div', {},
        el('p', { class: 'small' }, pred.message),
        el('p', { class: 'tiny muted' },
          `A prediction from fewer than ${pred.minPapers} papers would be noise, not information.`))
      : el('div', {},
        el('div', { class: 'grid cols-3' },
          el('div', { class: 'stat' },
            el('div', { class: 'label' }, 'Overall, most likely'),
            el('div', { class: 'value' }, pred.overall.mostLikely.toFixed(1)),
            el('div', { class: 'small muted' },
              `range ${pred.overall.low.toFixed(1)} – ${pred.overall.high.toFixed(1)}`)),
          el('div', { class: 'stat' },
            el('div', { class: 'label' }, 'Paper 1'),
            el('div', { class: 'value' },
              pred.perPaper[1] ? pred.perPaper[1].scaled.toFixed(1) : '—'),
            el('div', { class: 'small muted' },
              pred.perPaper[1] ? `${pred.perPaper[1].predictedRaw} raw · ${pred.perPaper[1].attempts} attempts` : 'none sat')),
          el('div', { class: 'stat' },
            el('div', { class: 'label' }, 'Paper 2'),
            el('div', { class: 'value' },
              pred.perPaper[2] ? pred.perPaper[2].scaled.toFixed(1) : '—'),
            el('div', { class: 'small muted' },
              pred.perPaper[2] ? `${pred.perPaper[2].predictedRaw} raw · ${pred.perPaper[2].attempts} attempts` : 'none sat'))),
        el('p', { class: 'small', style: 'margin-top:12px' },
          `Based on your last ${Math.min(pred.papers, 6)} papers, weighted towards recent results. `,
          `Confidence: ${pred.confidence} (${pred.papers} papers).`,
          pred.anyEstimated
            ? ' Some papers have no official conversion table, so their scaled values are estimated from the published years.'
            : ''),
        pred.trajectory
          ? el('div', { class: 'banner ' + (pred.trajectory.reachesTarget ? 'info' : ''), style: 'margin-top:10px' },
            pred.trajectory.reachesTarget
              ? `At your current rate (${pred.trajectory.perWeek >= 0 ? '+' : ''}${pred.trajectory.perWeek}/week) you reach about ${pred.trajectory.projected.toFixed(1)} by ${cd.examDate} — at or above your ${cd.target.toFixed(1)} target.`
              : `At your current rate (${pred.trajectory.perWeek >= 0 ? '+' : ''}${pred.trajectory.perWeek}/week) you reach about ${pred.trajectory.projected.toFixed(1)} by ${cd.examDate}. You need ${pred.trajectory.shortfall.toFixed(1)} more than that trend gives you.`)
          : null,
        pred.gap && pred.gap.totalMarksShort > 0
          ? el('div', { style: 'margin-top:12px' },
            el('h3', {}, `Closing the gap to ${cd.target.toFixed(1)}`),
            el('p', { class: 'small' },
              `You need roughly `,
              el('strong', {}, `${pred.gap.totalMarksShort} more raw marks`),
              ` across the two papers`,
              pred.gap.byPaper[1] && pred.gap.byPaper[1].marksShort
                ? ` (Paper 1: ${pred.gap.byPaper[1].marksShort}` : '',
              pred.gap.byPaper[2] && pred.gap.byPaper[2].marksShort
                ? `, Paper 2: ${pred.gap.byPaper[2].marksShort})` : ')'),
            pred.gap.recoverable.length
              ? el('p', { class: 'small' },
                `About ${pred.gap.recoverableTotal} of those marks are realistically available in `,
                el('strong', {}, pred.gap.recoverable.map(r => r.label).join(', ')),
                ' — lifting each to 80% accuracy.')
              : null)
          : null));

  const checklistCard = el('div', {},
    el('div', { class: 'row', style: 'justify-content:space-between;align-items:baseline' },
      el('h2', {}, 'Do this next'),
      el('span', { class: 'pill' }, `Phase: ${ov.phase.label}`)),
    el('p', { class: 'small muted' }, ov.phase.blurb),
    el('div', { class: 'grid cols-2' },
      ov.checklist.map(item => el('div', { class: 'card coach-item' },
        el('div', { class: 'row', style: 'justify-content:space-between;align-items:flex-start' },
          el('h3', { style: 'margin:0' }, item.title),
          el('span', { class: 'pill ' + (kindPill[item.kind] || '') }, item.kind)),
        el('p', { class: 'small', style: 'margin-top:8px' },
          el('strong', {}, 'Why: '), item.why),
        item.how ? el('p', { class: 'small' }, el('strong', {}, 'How: '), item.how) : null,
        el('div', { class: 'row', style: 'margin-top:10px' },
          item.minutes > 0
            ? el('span', { class: 'pill' }, item.minutes >= 60
              ? `${Math.round(item.minutes / 60 * 10) / 10} h`
              : `${item.minutes} min`)
            : null,
          el('div', { class: 'spacer' }),
          el('button', {
            class: 'btn ghost small', onclick: async () => {
              await api.coach.complete({
                itemKey: item.key, title: item.title, kind: item.kind, dismissed: true,
              });
              toast('Dismissed for a week'); render();
            }
          }, 'Dismiss'),
          el('button', {
            class: 'btn small', onclick: () => runChecklistAction(item)
          }, 'Start')))),
    ),
    ov.suppressed
      ? el('p', { class: 'tiny muted' }, `${ov.suppressed} lower-priority item(s) hidden to keep this list short.`)
      : null);

  const topicRows = diag.topics.map(t => el('tr', {},
    el('td', {}, t.label),
    el('td', { class: 'mono' }, `${t.correct}/${t.seen}`),
    el('td', { class: 'mono' }, t.enoughData ? pct(t.accuracy) : '—'),
    el('td', { class: 'mono' }, t.questionsPerPaper),
    el('td', { class: 'mono' },
      t.enoughData
        ? el('strong', {}, String(t.expectedMarksLost))
        : el('span', { class: 'tiny muted' }, `need ${t.needMore} more`)),
    el('td', {}, el('span', {
      class: 'pill ' + (t.trend === 'improving' ? 'good' : t.trend === 'regressing' ? 'bad' : '')
    }, t.trend)),
    el('td', {}, el('button', {
      class: 'btn ghost small', onclick: () => runChecklistAction({
        key: `manual-${t.topic}`, title: `Drill ${t.label}`, kind: 'retry',
        action: { type: 'drill', topics: [t.topic], untimed: true, label: `Drill · ${t.label}` },
      })
    }, 'Drill'))));

  const err = diag.errors;
  const errorCard = el('div', { class: 'card' },
    el('h2', {}, 'Why you lose marks'),
    err.tagged < 5
      ? el('p', { class: 'small muted' },
        `Only ${err.tagged} wrong answer(s) tagged so far. Tag them in Review — the fix for careless slips is nothing like the fix for a conceptual gap.`)
      : el('div', {},
        el('table', {}, el('tbody', {},
          Object.entries(err.counts).filter(([, n]) => n > 0).map(([k, n]) => el('tr', {},
            el('td', {}, err.labels[k]),
            el('td', { class: 'mono' }, String(n)),
            el('td', { style: 'width:45%' },
              el('div', { class: 'bar' }, el('i', { style: `width:${(n / err.tagged) * 100}%` }))))))),
        el('p', { class: 'small', style: 'margin-top:8px' },
          `${err.tagged} tagged, ${err.untagged} still untagged.`)),
    el('div', { class: 'row', style: 'margin-top:10px' },
      el('button', {
        class: 'btn ghost small', onclick: async () => {
          const rows = await api.history.list();
          const done = rows.find(r => r.status === 'completed');
          if (!done) return toast('No completed attempt to tag yet');
          go('review', { attemptId: done.id });
        }
      }, 'Tag wrong answers in Review')));

  const g = diag.guessing;
  const ch = diag.changes;
  const habitsCard = el('div', { class: 'card' },
    el('h2', {}, 'Exam habits'),
    el('table', {}, el('tbody', {},
      el('tr', {},
        el('td', {}, 'Blank at submit'),
        el('td', { class: 'mono' }, String(g.blanks)),
        el('td', { class: 'small muted' },
          g.blanks ? `≈ ${g.marksThrownAway} marks thrown away — there is no negative marking`
            : 'nothing left blank')),
      el('tr', {},
        el('td', {}, 'Accuracy when sure'),
        el('td', { class: 'mono' }, g.sureAccuracy === null ? '—' : pct(g.sureAccuracy)),
        el('td', { class: 'small muted' },
          g.sureWrong ? `${g.sureWrong} confident but wrong — misconceptions` : '')),
      el('tr', {},
        el('td', {}, 'Accuracy when unsure'),
        el('td', { class: 'mono' }, g.unsureAccuracy === null ? '—' : pct(g.unsureAccuracy)),
        el('td', { class: 'small muted' },
          g.unsureVerdict === 'trust'
            ? `Well above the ${pct(g.randomRate)} random rate — your educated guesses are worth making`
            : g.unsureVerdict === 'eliminate'
              ? `Near the ${pct(g.randomRate)} random rate — work on elimination technique`
              : 'need more marked answers')),
      el('tr', {},
        el('td', {}, 'Answers changed'),
        el('td', { class: 'mono' }, String(ch.total)),
        el('td', { class: 'small muted' },
          ch.enoughData
            ? `${ch.helped} helped, ${ch.hurt} hurt, ${ch.neutral} neutral — net ${ch.net >= 0 ? '+' : ''}${ch.net} marks`
            : `need ${ch.minSample}+ changes before this means anything`)))));

  const doneCard = doneHistory.length
    ? el('div', { class: 'card' },
      el('h2', {}, 'Recently completed'),
      el('table', {}, el('tbody', {}, doneHistory.slice(0, 12).map(d => el('tr', {},
        el('td', { class: 'small' }, d.title),
        el('td', {}, el('span', { class: 'pill ' + (d.dismissed ? '' : 'good') },
          d.dismissed ? 'dismissed' : 'done')),
        el('td', { class: 'small muted' }, fmtDate(d.completed_at)))))))
    : null;

  return shell('coach',
    el('h1', {}, 'Coach'),
    checklistCard,
    el('div', { style: 'margin-top:18px' }, predictionCard),
    el('h2', { style: 'margin:22px 0 10px' }, 'Where the marks go'),
    el('p', { class: 'small muted' },
      `Ranked by expected marks lost per paper — accuracy × how often the topic actually appears. `
      + `A topic needs ${diag.minSample} attempted questions before it can be called a weakness.`),
    el('div', { class: 'card table-scroll' },
      el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, 'Topic'), el('th', {}, 'Correct'), el('th', {}, 'Accuracy'),
          el('th', {}, 'Per paper'), el('th', {}, 'Marks lost'), el('th', {}, 'Trend'), el('th', {}, ''))),
        el('tbody', {}, topicRows))),
    el('div', { class: 'grid cols-2', style: 'margin-top:18px' }, errorCard, habitsCard),
    diag.split.weaker
      ? el('div', { class: 'banner', style: 'margin-top:16px' },
        `Paper ${diag.split.weaker} is dragging your total down: `
        + `Paper 1 averages ${diag.split.paper1.avgScaled ?? '—'}, Paper 2 ${diag.split.paper2.avgScaled ?? '—'} `
        + `(gap ${diag.split.gap}). Weight your practice towards Paper ${diag.split.weaker}.`)
      : null,
    doneCard ? el('div', { style: 'margin-top:18px' }, doneCard) : null);
}

async function viewPlan() {
  const plan = await api.coach.plan({});
  const review = await api.review.summary();

  if (!plan.weeks.length) {
    return shell('plan', el('h1', {}, 'Study plan'),
      el('div', { class: 'card muted' }, plan.note || 'Nothing to plan.'));
  }

  const tax = State.catalog.taxonomy;
  const label = (k) => (k.startsWith('specimen') ? k.replace('specimen', 'Spec') : k);

  // ---- editing a single week ----
  const editWeek = (w) => {
    const chosen = new Set(w.papers.map(p => p.key));
    const chosenTopics = new Set(w.topics.map(t => t.topic));

    const paperBox = el('div', { class: 'row' });
    const paintPapers = () => {
      paperBox.replaceChildren(...plan.allPapers.map(p => el('button', {
        class: 'chip' + (chosen.has(p.key) ? ' on' : '') + (p.sat ? ' sat' : ''),
        title: p.sat ? 'You have already sat this one' : '',
        onclick: () => {
          if (chosen.has(p.key)) chosen.delete(p.key); else chosen.add(p.key);
          paintPapers();
        },
      }, label(p.key))));
    };
    paintPapers();

    const topicBox = el('div', { class: 'row' },
      Object.entries(tax).map(([id, name]) => {
        const b = el('button', {
          class: 'chip' + (chosenTopics.has(id) ? ' on' : ''),
          onclick: () => {
            if (chosenTopics.has(id)) chosenTopics.delete(id); else chosenTopics.add(id);
            b.classList.toggle('on', chosenTopics.has(id));
          },
        }, name);
        return b;
      }));

    const noteInput = el('input', { type: 'text', placeholder: 'Note for this week (optional)' });
    noteInput.value = w.note || '';

    const panel = el('div', { class: 'card week-editor' },
      el('h3', {}, `Week ${w.index} — from ${w.startsOn}`),
      el('div', { class: 'tiny muted', style: 'margin-bottom:6px' }, 'Papers this week'),
      paperBox,
      el('div', { class: 'tiny muted', style: 'margin:12px 0 6px' }, 'Topic focus'),
      topicBox,
      el('div', { style: 'margin-top:12px' }, noteInput),
      el('div', { class: 'row', style: 'margin-top:14px' },
        el('button', {
          class: 'btn', onclick: async () => {
            try {
              await api.coach.setWeek({
                weekStart: w.startsOn,
                papers: [...chosen],
                topics: [...chosenTopics],
                note: noteInput.value.trim() || null,
              });
              toast('Week updated');
              render();
            } catch (e) { toast(e.message); }
          }
        }, 'Save week'),
        w.edited ? el('button', {
          class: 'btn ghost', onclick: async () => {
            await api.coach.resetWeek(w.startsOn);
            toast('Week reset to the suggested plan');
            render();
          }
        }, 'Reset to suggested') : null,
        el('button', { class: 'btn ghost', onclick: () => render() }, 'Cancel')));
    return panel;
  };

  const rows = [];
  for (const w of plan.weeks) {
    const editing = State.params.editWeek === w.startsOn;
    rows.push(el('tr', { class: w.edited ? 'edited-week' : '' },
      el('td', { class: 'mono' }, String(w.index),
        w.edited ? el('span', { class: 'pill', style: 'margin-left:6px' }, 'edited') : null),
      el('td', { class: 'small' }, w.startsOn),
      el('td', {}, el('span', { class: 'pill ' + (w.isMockWeek ? 'warn' : '') }, w.phase)),
      el('td', { class: 'small' },
        w.papers.length
          ? w.papers.map(p => el('span', { class: 'pill', style: 'margin-right:4px' }, label(p.key)))
          : el('span', { class: 'muted' }, w.isMockWeek ? 'review + re-sits' : '—')),
      el('td', { class: 'small muted' },
        w.topics.length ? w.topics.map(t => t.label).join(' · ')
          : (w.isMockWeek ? 'consolidation only — no new topics' : '—'),
        w.note ? el('div', { class: 'tiny', style: 'margin-top:4px;font-style:italic' }, w.note) : null),
      el('td', {}, el('button', {
        class: 'btn ghost small',
        onclick: () => go('plan', { editWeek: editing ? null : w.startsOn }),
      }, editing ? 'Close' : 'Edit'))));
    if (editing) {
      rows.push(el('tr', {}, el('td', { colspan: '6' }, editWeek(w))));
    }
  }

  return shell('plan',
    el('div', { class: 'row', style: 'justify-content:space-between' },
      el('h1', {}, 'Study plan'),
      plan.editedWeeks
        ? el('button', {
          class: 'btn ghost small', onclick: async () => {
            if (!confirm('Discard all your edits and go back to the suggested plan?')) return;
            await api.coach.resetWeek(null);
            toast('Plan reset'); render();
          }
        }, `Reset all edits (${plan.editedWeeks})`)
        : null),
    el('p', { class: 'small muted' },
      `${plan.countdown.days} days to ${plan.countdown.examDate}. `
      + `${plan.unseen} unseen paper(s), about ${plan.papersPerWeek} per week, `
      + `with ${plan.reserved.length} held back as clean mocks for the final fortnight`
      + (plan.reserved.length ? ` (${plan.reserved.map(label).join(', ')})` : '') + '. '
      + 'Press Edit on any week to move papers around — your changes stick as the plan recalculates.'),
    review.due
      ? el('div', { class: 'banner info', style: 'margin-bottom:12px' },
        `${review.due} question(s) due for review today — fit these in around the papers below.`)
      : null,
    plan.unscheduled.length
      ? el('div', { class: 'banner', style: 'margin-bottom:12px' },
        `Not currently scheduled anywhere: ${plan.unscheduled.map(label).join(', ')}. `
        + 'Add them to a week, or reset your edits.')
      : null,
    plan.note ? el('div', { class: 'banner', style: 'margin-bottom:12px' }, plan.note) : null,
    el('div', { class: 'card table-scroll' },
      el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, 'Week'), el('th', {}, 'From'), el('th', {}, 'Phase'),
          el('th', {}, 'Papers'), el('th', {}, 'Topic focus'), el('th', {}, ''))),
        el('tbody', {}, rows))));
}

// ---------------------------------------------------------- offline entry
async function viewOffline() {
  const years = [...new Set(State.catalog.papers.map(p => p.year))];
  const yearSel = el('select', {}, years.map(y =>
    el('option', { value: y }, y === 'specimen' ? 'Specimen' : y)));
  const paperSel = el('select', {},
    el('option', { value: '1' }, 'Paper 1'), el('option', { value: '2' }, 'Paper 2'));
  const minutesInput = el('input', { type: 'number', min: '1', max: '600', value: '93' });
  const dateInput = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });

  const inputs = [];
  const grid = el('div', { class: 'answer-entry' },
    Array.from({ length: 20 }, (_, i) => {
      const inp = el('input', {
        type: 'text', maxlength: '1', class: 'ans-box',
        oninput: e => {
          e.target.value = e.target.value.toUpperCase().replace(/[^A-H]/g, '');
          if (e.target.value && inputs[i + 1]) inputs[i + 1].focus();
        },
      });
      inputs.push(inp);
      return el('label', { class: 'ans-cell' }, el('span', { class: 'tiny muted' }, String(i + 1)), inp);
    }));

  const submit = async () => {
    const answers = inputs.map(i => (i.value ? i.value : null));
    const filled = answers.filter(Boolean).length;
    if (!filled) return toast('Enter at least one answer');
    if (filled < 20 && !confirm(`${20 - filled} question(s) left blank. Record anyway?`)) return;
    try {
      const res = await api.offline.record({
        year: yearSel.value, paper: Number(paperSel.value), answers,
        minutes: minutesInput.valueAsNumber, when: dateInput.value,
      });
      toast(`Recorded — ${res.scoreRaw}/20`);
      go('results', { attemptId: res.id });
    } catch (e) { toast(e.message); }
  };

  return shell('home',
    el('h1', {}, 'Enter answers from paper'),
    el('p', { class: 'small muted' },
      'Sat a paper on printed sheets? Type your answers here and it counts towards your history, '
      + 'analytics and predicted score, tagged as an offline attempt.'),
    el('div', { class: 'card' },
      el('div', { class: 'row' },
        el('label', { class: 'field' }, 'Paper', el('div', { class: 'row' }, yearSel, paperSel)),
        el('label', { class: 'field' }, 'Minutes taken', minutesInput),
        el('label', { class: 'field' }, 'Date sat', dateInput)),
      el('h3', { style: 'margin-top:16px' }, 'Your answers'),
      el('p', { class: 'tiny muted' }, 'Leave a box empty for a question you did not answer.'),
      grid,
      el('div', { class: 'row', style: 'margin-top:16px' },
        el('button', { class: 'btn', onclick: submit }, 'Record this attempt'),
        el('button', { class: 'btn ghost', onclick: () => go('home') }, 'Cancel'))));
}

// ---------------------------------------------------------- about
async function viewAbout() {
  return shell('settings',
    el('h1', {}, 'About'),
    el('div', { class: 'card' },
      el('h2', {}, 'Papers in this app'),
      el('p', {},
        'Every paper bundled here is from the ',
        el('strong', {}, 'Cambridge Assessment era, 2016–2023'),
        '. UAT-UK took over the TMUA in 2024 and the format and specification shifted slightly.'),
      el('p', { class: 'small' },
        'The maths being tested is the same, and these papers remain the best practice material '
        + 'available in volume. But before exam day you should sit at least one recent '
        + 'specimen or practice paper from the current provider so the layout on the day is not a '
        + 'surprise. The Coach adds this as a checklist item in your final month.'),
      el('p', { class: 'small muted' },
        'This app makes no network requests, so that download is something you do yourself. '
        + 'Once you have sat it on paper, record it with "Enter answers from paper" so it counts '
        + 'towards your analytics and predicted score.'),
      el('div', { class: 'row', style: 'margin-top:12px' },
        el('button', { class: 'btn ghost', onclick: () => go('offline') }, 'Enter answers from paper'),
        el('button', { class: 'btn ghost', onclick: () => go('settings') }, 'Back to settings'))),
    el('div', { class: 'card', style: 'margin-top:16px' },
      el('h2', {}, 'Privacy'),
      el('p', { class: 'small' },
        'Everything stays on this machine. The app blocks all outbound network requests at the '
        + 'process level, and the only data stored is your own: attempts, answers, flags, notes, '
        + 'settings and the review queue.')));
}


// Tag why a question was lost. The suggestion comes from signals the app
// already has, so tagging is a confirmation rather than data entry.
const ERROR_LABELS = {
  conceptual: 'Conceptual gap',
  careless: 'Careless slip',
  misread: 'Misread it',
  time: 'Time / rushed',
  guess: 'Guessed blind',
};

function errorTagger(attemptId, q) {
  let current = q.errorType || null;
  const suggested = q.suggestedError || null;
  const row = el('div', { class: 'errtags' });
  const paint = () => {
    [...row.children].forEach(btn => {
      btn.className = btn.dataset.key === current ? 'on' : '';
      if (btn.dataset.key === suggested && !current) btn.classList.add('suggested');
    });
  };
  for (const [key, label] of Object.entries(ERROR_LABELS)) {
    row.append(el('button', {
      'data-key': key,
      onclick: async () => {
        current = current === key ? null : key;
        await api.coach.tagError({ attemptId, position: q.position, errorType: current });
        paint();
      },
    }, label));
  }
  paint();
  return el('div', { style: 'margin-top:10px' },
    el('div', { class: 'tiny muted' }, 'Why did you lose this one?'),
    row);
}


// ================================================================ deletion

function describeAttempt(a) {
  const y = a.year === 'specimen' ? 'Specimen' : a.year;
  const name = a.mode === 'drill' ? (a.label || 'Custom drill') : `${y} Paper ${a.paper}`;
  const score = a.scoreRaw === null || a.scoreRaw === undefined
    ? a.status : `${a.scoreRaw}/${a.total}`;
  return `${name} (${score}${a.completedAt ? `, sat ${new Date(a.completedAt).toLocaleDateString()}` : ''})`;
}

// Confirmation text built from real counts, never a generic warning.
function deleteMessage(pv) {
  const lines = [];
  if (pv.attempts.length === 1) {
    lines.push(`Delete ${describeAttempt(pv.attempts[0])}?`);
  } else {
    lines.push(`Delete ${pv.attempts.length} attempts?`);
    for (const a of pv.attempts.slice(0, 8)) lines.push(`  · ${describeAttempt(a)}`);
    if (pv.attempts.length > 8) lines.push(`  · …and ${pv.attempts.length - 8} more`);
  }
  lines.push('');
  const bits = [];
  if (pv.wrong) bits.push(`${pv.wrong} wrong answer${pv.wrong === 1 ? '' : 's'}`);
  if (pv.reviewRemoved) bits.push(`${pv.reviewRemoved} review-queue item${pv.reviewRemoved === 1 ? '' : 's'}`);
  if (pv.changes) bits.push(`${pv.changes} answer change${pv.changes === 1 ? '' : 's'}`);
  lines.push(bits.length
    ? `This also removes ${bits.join(', ')}, and will recompute your predicted score.`
    : 'This will recompute your predicted score.');
  if (pv.reviewRecomputed) {
    lines.push(`${pv.reviewRecomputed} review item(s) are also justified by other attempts and will be kept, rescheduled from what remains.`);
  }
  if (pv.remainingPapers < 3) {
    lines.push(`You would be left with ${pv.remainingPapers} completed paper(s), below the ${3} needed to predict a score.`);
  }
  lines.push('');
  lines.push('If you only want a clean slate, Archive in Settings keeps everything and is reversible.');
  return lines.join('\n');
}

// Soft-delete, show an undo toast, then commit when the window expires.
async function runDelete(ids, { onDone } = {}) {
  const list = Array.isArray(ids) ? ids : [ids];
  let pv;
  try { pv = await api.del.preview(list); } catch (e) { return toast(e.message); }
  if (!pv.attempts.length) return toast('Nothing to delete');

  if (!confirm(deleteMessage(pv))) return;

  let confirmWord = null;
  if (list.length > 1) {
    confirmWord = prompt(
      `This deletes ${list.length} attempts. Type DELETE to confirm.`);
    if (String(confirmWord || '').trim().toUpperCase() !== 'DELETE') {
      return toast('Not deleted — confirmation did not match');
    }
  }

  try {
    const res = await api.del.attempts({ ids: list, confirm: confirmWord });
    showUndo(res, onDone);
    if (onDone) onDone();
  } catch (e) { toast(e.message); }
}

let undoTimer = null;
function showUndo(res, onDone) {
  clearTimeout(undoTimer);
  const bar = $('#toast');
  bar.textContent = '';
  const seconds = Math.round((res.undoWindowMs || 30000) / 1000);
  const label = el('span', {},
    `Deleted ${res.softDeleted.length} attempt${res.softDeleted.length === 1 ? '' : 's'}. `);
  const undoBtn = el('button', {
    class: 'btn small', style: 'margin-left:10px',
    onclick: async () => {
      clearTimeout(undoTimer);
      await api.del.undo(res.softDeleted);
      bar.hidden = true;
      toast('Restored');
      if (onDone) onDone();
    },
  }, `Undo (${seconds}s)`);
  bar.replaceChildren(label, undoBtn);
  bar.hidden = false;

  undoTimer = setTimeout(async () => {
    try { await api.del.commit(res.softDeleted); } catch (e) { console.error(e); }
    bar.hidden = true;
  }, res.undoWindowMs || 30000);
}
