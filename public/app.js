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

  const startPaper = async (untimed) => {
    const a = await api.attempt.start({
      mode: untimed ? 'untimed' : 'paper',
      year: yearSel.value, paper: Number(paperSel.value), untimed,
    });
    go('exam', { attemptId: a.id });
  };

  const startMock = async () => {
    const year = yearSel.value;
    const group = `mock-${year}-${Date.now()}`;
    const a = await api.attempt.start({ mode: 'mock', year, paper: 1, mockGroup: group });
    go('exam', { attemptId: a.id });
  };

  return shell('home',
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
    this.elapsed = attempt.elapsedSec || 0;
    this.allowed = attempt.allowedSec;              // null = untimed
    this.timerHidden = Boolean(State.settings.hideTimer);
    this.warned = new Set();
    this.finished = false;
    this.lastTick = performance.now();
    this.qStart = performance.now();
    this.pendingQTime = 0;
    this.onKey = this.onKey.bind(this);
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
    const now = performance.now();
    const dt = (now - this.lastTick) / 1000;
    this.lastTick = now;
    if (this.finished) return;
    this.elapsed += dt;
    this.pendingQTime += dt;
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

  async persist() {
    if (this.finished) return;
    const delta = this.pendingQTime;
    this.pendingQTime = 0;
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
    const delta = this.pendingQTime; this.pendingQTime = 0;
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
              const unanswered = this.a.questions.filter(x => !x.selected).length;
              const msg = unanswered
                ? `${unanswered} question${unanswered === 1 ? '' : 's'} unanswered. Submit anyway?`
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
        el('button', { class: 'btn ghost', onclick: () => go('home') }, 'Done'))),
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
  if (!rows.length) {
    return shell('history', el('h1', {}, 'History'),
      el('div', { class: 'card muted' }, 'No attempts yet. Start a paper from Practise.'));
  }
  return shell('history',
    el('h1', {}, 'History'),
    el('div', { class: 'card table-scroll' },
      el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, 'Paper'), el('th', {}, 'Mode'), el('th', {}, 'When'),
          el('th', {}, 'Score'), el('th', {}, 'Scaled'), el('th', {}, 'Time'),
          el('th', {}, 'Status'), el('th', {}, ''))),
        el('tbody', {}, rows.map(a => el('tr', {},
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
              : null))))))));
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
    el('div', { class: 'card table-scroll' },
      d.wrong.length ? el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, 'Question'), el('th', {}, 'Topics'), el('th', {}, 'You'), el('th', {}, 'Answer'),
          el('th', {}, 'Time'), el('th', {}, 'When'), el('th', {}, ''))),
        el('tbody', {}, d.wrong.slice(0, 100).map(w => el('tr', {},
          el('td', {}, `${w.year === 'specimen' ? 'Spec' : w.year} P${w.paper} Q${w.number}`),
          el('td', { class: 'small muted' }, w.topics.map(t => State.catalog.taxonomy[t] || t).join(', ')),
          el('td', { class: 'mono' }, w.unanswered ? '—' : w.selected),
          el('td', { class: 'mono' }, w.answer),
          el('td', { class: 'mono small' }, fmtMinSec(w.time)),
          el('td', { class: 'small muted' }, fmtDate(w.at)),
          el('td', {}, el('button', {
            class: 'btn ghost small',
            onclick: () => go('review', { attemptId: w.attemptId })
          }, 'Review'))))))
        : el('div', { class: 'muted' }, 'No wrong answers recorded.')));
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
          'This app makes no network requests. All questions, solutions and score conversions are bundled inside it.'))));
}

// ---------------------------------------------------------------- router
const VIEWS = {
  home: viewHome, drill: viewDrill, exam: viewExam, break: viewBreak,
  results: viewResults, review: viewReview, history: viewHistory,
  dashboard: viewDashboard, revisit: viewRevisit, settings: viewSettings,
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
