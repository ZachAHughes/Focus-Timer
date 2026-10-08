'use strict';

const $ = (sel) => document.querySelector(sel);

const MODES = { focus: 'Focus', short: 'Short break', long: 'Long break' };
const SOUNDS = [
  ['off', 'Off'], ['rain', 'Rain'], ['waves', 'Waves'],
  ['brown', 'Brown noise'], ['pink', 'Pink noise'], ['white', 'White noise'],
];
const DEFAULTS = {
  focus: 25, short: 5, long: 15, longEvery: 4,
  autoBreak: true, autoFocus: false, ambientOnlyFocus: true, chime: true, notify: false,
  sound: 'off', volume: 0.5,
};
const HISTORY_DAYS = 90;

/* ---------- Storage ---------- */

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('focus.' + key); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('focus.' + key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

const settings = { ...DEFAULTS, ...store.get('settings', {}) };
const days = store.get('days', {});
const timer = store.get('timer', null) || { mode: 'focus', running: false, endAt: 0, remaining: settings.focus * 60, cycle: 0 };

const saveSettings = () => store.set('settings', settings);
const saveDays = () => store.set('days', days);
const saveTimer = () => store.set('timer', timer);

function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function today() {
  const key = dateKey();
  return (days[key] ||= { tasks: [], sessions: 0, focusMin: 0, activeId: null });
}
function pruneHistory() {
  const cutoff = dateKey(new Date(Date.now() - HISTORY_DAYS * 864e5));
  for (const key of Object.keys(days)) if (key < cutoff) delete days[key];
}

/* ---------- Audio: ambient soundscapes + chime, all synthesized ---------- */

const Sound = (() => {
  let ctx, master, current = null;
  const buffers = {};

  function init() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = settings.volume ** 2;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
  }

  function noise(kind) {
    if (buffers[kind]) return buffers[kind];
    const len = ctx.sampleRate * 8;
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      if (kind === 'white') {
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      } else if (kind === 'pink') {
        // Paul Kellet's refined pink noise filter
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < len; i++) {
          const w = Math.random() * 2 - 1;
          b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
          b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
          b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
          d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
          b6 = w * 0.115926;
        }
      } else {
        // Brown noise; remove drift so the loop point is seamless
        let last = 0;
        for (let i = 0; i < len; i++) {
          last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
          d[i] = last * 3.5;
        }
        const drift = (d[len - 1] - d[0]) / len;
        for (let i = 0; i < len; i++) d[i] -= drift * i;
      }
    }
    return (buffers[kind] = buf);
  }

  function build(kind, out, nodes) {
    const src = (type) => {
      const s = ctx.createBufferSource();
      s.buffer = noise(type); s.loop = true; s.start(); nodes.push(s);
      return s;
    };
    const filter = (type, freq) => {
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
      return f;
    };
    const gain = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const chain = (...ns) => ns.reduce((a, b) => a.connect(b));

    switch (kind) {
      case 'rain':
        chain(src('white'), filter('highpass', 600), filter('lowpass', 7000), gain(0.16), out);
        chain(src('pink'), filter('lowpass', 1200), gain(0.35), out);
        break;
      case 'waves': {
        const swell = gain(0.5);
        chain(src('brown'), filter('lowpass', 900), swell, out);
        const lfo = ctx.createOscillator(); lfo.frequency.value = 0.09;
        chain(lfo, gain(0.45), swell.gain);
        lfo.start(); nodes.push(lfo);
        break;
      }
      case 'brown': chain(src('brown'), gain(0.9), out); break;
      case 'pink': chain(src('pink'), gain(0.5), out); break;
      case 'white': chain(src('white'), gain(0.12), out); break;
    }
  }

  function play(kind) {
    if (current?.kind === kind) return;
    stop();
    if (kind === 'off') return;
    init();
    const bus = ctx.createGain();
    bus.gain.value = 0;
    bus.connect(master);
    const nodes = [];
    build(kind, bus, nodes);
    bus.gain.setTargetAtTime(1, ctx.currentTime, 0.5);
    current = { kind, bus, nodes };
  }

  function stop() {
    if (!current) return;
    const { bus, nodes } = current;
    current = null;
    bus.gain.setTargetAtTime(0, ctx.currentTime, 0.25);
    setTimeout(() => {
      nodes.forEach((n) => { try { n.stop(); } catch { /* already stopped */ } });
      bus.disconnect();
    }, 1500);
  }

  function setVolume(v) {
    if (master) master.gain.setTargetAtTime(v ** 2, ctx.currentTime, 0.05);
  }

  function sync() {
    const wanted = settings.sound !== 'off' &&
      (!settings.ambientOnlyFocus || (timer.running && timer.mode === 'focus'));
    wanted ? play(settings.sound) : stop();
  }

  function chime() {
    init();
    const t = ctx.currentTime;
    [[659.25, 0], [880, 0.22], [1318.5, 0.44]].forEach(([freq, dt]) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t + dt);
      g.gain.exponentialRampToValueAtTime(0.22, t + dt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 1.8);
      o.connect(g).connect(ctx.destination);
      o.start(t + dt); o.stop(t + dt + 1.9);
    });
  }

  // Browsers block audio until a user gesture; resume on the first one.
  const unlock = () => { if (ctx && ctx.state === 'suspended') ctx.resume(); };
  addEventListener('pointerdown', unlock);
  addEventListener('keydown', unlock);

  return { sync, setVolume, chime };
})();

/* ---------- Timer ---------- */

const duration = (mode = timer.mode) => settings[mode] * 60;
const remainingNow = () =>
  timer.running ? Math.max(0, Math.ceil((timer.endAt - Date.now()) / 1000)) : timer.remaining;

let endTimeout;
function scheduleEnd() {
  // One-shot timeout so the end fires on time even when interval timers are throttled in background tabs.
  clearTimeout(endTimeout);
  if (timer.running) endTimeout = setTimeout(tick, Math.max(0, timer.endAt - Date.now()) + 30);
}

function start() {
  if (timer.running) return;
  timer.running = true;
  timer.endAt = Date.now() + timer.remaining * 1000;
  changed();
}

function pause() {
  if (!timer.running) return;
  timer.remaining = remainingNow();
  timer.running = false;
  changed();
}

function reset() {
  timer.running = false;
  timer.remaining = duration();
  changed();
}

function setMode(mode, autostart = false) {
  timer.mode = mode;
  timer.running = false;
  timer.remaining = duration(mode);
  autostart ? start() : changed();
}

function changed() {
  saveTimer();
  scheduleEnd();
  Sound.sync();
  render();
}

function finish(completed, { quiet = false } = {}) {
  const was = timer.mode;
  let next = 'focus';
  if (was === 'focus') {
    if (completed) {
      const day = today();
      day.sessions++;
      day.focusMin += settings.focus;
      const active = day.tasks.find((t) => t.id === day.activeId && !t.done);
      if (active) active.pomos++;
      saveDays();
      renderTasks();
      timer.cycle++;
    }
    next = completed && timer.cycle % settings.longEvery === 0 ? 'long' : 'short';
  } else if (was === 'long') {
    timer.cycle = 0;
  }

  if (completed && !quiet) {
    if (settings.chime) Sound.chime();
    notify(was, next);
  }
  const auto = completed && !quiet && (next === 'focus' ? settings.autoFocus : settings.autoBreak);
  setMode(next, auto);
}

function tick() {
  if (!timer.running) return;
  const r = remainingNow();
  if (r <= 0) finish(true);
  else renderTime(r);
}

function notify(was, next) {
  if (!settings.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  const title = was === 'focus' ? 'Focus session complete' : 'Break is over';
  const body = next === 'focus' ? 'Ready for the next focus session.' : `Time for a ${MODES[next].toLowerCase()}.`;
  const opts = { body, icon: 'icon.svg', tag: 'focus-timer' };
  try { new Notification(title, opts); }
  catch { navigator.serviceWorker?.ready.then((reg) => reg.showNotification(title, opts)); }
}

/* ---------- Rendering ---------- */

const progress = $('#progress');
const CIRC = 2 * Math.PI * progress.r.baseVal.value;
progress.style.strokeDasharray = CIRC;

function fmtClock(sec) {
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}
function fmtMinutes(min) {
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
}

function renderTime(r = remainingNow()) {
  const clock = fmtClock(r);
  $('#time').textContent = clock;
  const frac = Math.min(1, r / duration());
  progress.style.strokeDashoffset = CIRC * (1 - frac);
  document.title = timer.running ? `${clock} · ${MODES[timer.mode]}` : 'Focus';
}

function render() {
  document.body.dataset.mode = timer.mode;
  document.querySelectorAll('.modes button').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.mode === timer.mode));
  });

  const paused = !timer.running && timer.remaining < duration();
  $('#startBtn').textContent = timer.running ? 'Pause' : paused ? 'Resume' : 'Start';

  $('#label').textContent = timer.mode === 'focus'
    ? `Session ${(timer.cycle % settings.longEvery) + 1} of ${settings.longEvery}`
    : timer.mode === 'short' ? 'Take a breather' : 'Long break — step away';

  renderCurrent();
  renderTime();
}

function renderCurrent() {
  const el = $('#current');
  const day = today();
  const active = day.tasks.find((t) => t.id === day.activeId && !t.done);
  el.replaceChildren();
  if (timer.mode !== 'focus') return;
  if (active) {
    el.append('Working on ');
    const strong = document.createElement('strong');
    strong.textContent = active.text;
    el.append(strong);
  }
}

function renderSounds() {
  const wrap = $('#sounds');
  wrap.replaceChildren(...SOUNDS.map(([key, name]) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = name;
    b.dataset.sound = key;
    b.setAttribute('aria-pressed', String(settings.sound === key));
    return b;
  }));
  $('#volume').value = settings.volume;
  $('#ambientHint').hidden = !settings.ambientOnlyFocus || settings.sound === 'off';
}

function previousUnfinished() {
  const key = dateKey();
  const prev = Object.keys(days).filter((k) => k < key && days[k].tasks.length).sort().pop();
  if (!prev) return null;
  const tasks = days[prev].tasks.filter((t) => !t.done && !t.carried);
  return tasks.length ? { prev, tasks } : null;
}

function relativeDayName(key) {
  const yesterday = dateKey(new Date(Date.now() - 864e5));
  if (key === yesterday) return 'yesterday';
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function renderTasks() {
  const day = today();
  const list = $('#taskList');
  list.replaceChildren();

  for (const task of day.tasks) {
    const li = document.createElement('li');
    li.className = 'task' + (task.done ? ' done' : '') + (task.id === day.activeId && !task.done ? ' active' : '');
    li.dataset.id = task.id;

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = task.done;
    check.setAttribute('aria-label', `Mark "${task.text}" done`);

    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = task.text;

    const pomos = document.createElement('span');
    pomos.className = 'pomos';
    if (task.pomos) {
      pomos.textContent = task.pomos <= 5 ? '●'.repeat(task.pomos) : `● ×${task.pomos}`;
      pomos.title = `${task.pomos} focus session${task.pomos > 1 ? 's' : ''}`;
    }

    const del = document.createElement('button');
    del.className = 'del icon-btn';
    del.textContent = '×';
    del.setAttribute('aria-label', `Delete "${task.text}"`);

    li.append(check, text, pomos, del);
    list.append(li);
  }

  if (!day.tasks.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No tasks yet. What do you want to get done today?';
    list.append(p);
  }

  const s = day.sessions;
  $('#stats').textContent = s ? `${s} session${s > 1 ? 's' : ''} · ${fmtMinutes(day.focusMin)}` : '';

  const carry = previousUnfinished();
  const carryBtn = $('#carryBtn');
  carryBtn.hidden = !carry;
  if (carry) {
    const n = carry.tasks.length;
    carryBtn.textContent = `↪ Bring over ${n} unfinished task${n > 1 ? 's' : ''} from ${relativeDayName(carry.prev)}`;
  }

  $('#clearDone').hidden = !day.tasks.some((t) => t.done);
  renderCurrent();
}

/* ---------- Events ---------- */

$('#startBtn').addEventListener('click', () => (timer.running ? pause() : start()));
$('#resetBtn').addEventListener('click', reset);
$('#skipBtn').addEventListener('click', () => finish(false));

document.querySelector('.modes').addEventListener('click', (e) => {
  const mode = e.target.closest('button')?.dataset.mode;
  if (mode && mode !== timer.mode) setMode(mode);
});

$('#sounds').addEventListener('click', (e) => {
  const key = e.target.closest('.chip')?.dataset.sound;
  if (!key) return;
  settings.sound = key;
  saveSettings();
  renderSounds();
  Sound.sync();
});

$('#volume').addEventListener('input', (e) => {
  settings.volume = Number(e.target.value);
  Sound.setVolume(settings.volume);
  saveSettings();
});

$('#taskForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#taskInput');
  const text = input.value.trim();
  if (!text) return;
  const day = today();
  const task = { id: crypto.randomUUID?.() ?? String(Date.now() + Math.random()), text, done: false, pomos: 0 };
  day.tasks.push(task);
  if (!day.activeId || !day.tasks.some((t) => t.id === day.activeId && !t.done)) day.activeId = task.id;
  input.value = '';
  saveDays();
  renderTasks();
});

$('#taskList').addEventListener('click', (e) => {
  const li = e.target.closest('.task');
  if (!li) return;
  const day = today();
  const idx = day.tasks.findIndex((t) => t.id === li.dataset.id);
  const task = day.tasks[idx];
  if (!task) return;

  if (e.target.closest('.del')) {
    day.tasks.splice(idx, 1);
    if (day.activeId === task.id) day.activeId = null;
  } else if (e.target.matches('input[type="checkbox"]')) {
    task.done = e.target.checked;
    if (task.done && day.activeId === task.id) {
      day.activeId = day.tasks.find((t) => !t.done)?.id ?? null;
    }
  } else if (e.target.closest('.text') && !task.done) {
    day.activeId = day.activeId === task.id ? null : task.id;
  } else {
    return;
  }
  saveDays();
  renderTasks();
});

$('#carryBtn').addEventListener('click', () => {
  const carry = previousUnfinished();
  if (!carry) return;
  const day = today();
  for (const t of carry.tasks) {
    t.carried = true;
    day.tasks.push({ id: crypto.randomUUID?.() ?? String(Date.now() + Math.random()), text: t.text, done: false, pomos: 0 });
  }
  if (!day.activeId) day.activeId = day.tasks.find((t) => !t.done)?.id ?? null;
  saveDays();
  renderTasks();
});

$('#clearDone').addEventListener('click', () => {
  const day = today();
  day.tasks = day.tasks.filter((t) => !t.done);
  saveDays();
  renderTasks();
});

/* Settings */

const dialog = $('#settings');
const form = $('#settingsForm');

$('#settingsBtn').addEventListener('click', () => {
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') el.checked = settings[el.name];
    else el.value = settings[el.name];
  }
  if (!('Notification' in window)) form.elements.notify.disabled = true;
  dialog.showModal();
});

dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

form.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.name) return;
  const wasFresh = !timer.running && timer.remaining === duration();

  if (el.type === 'checkbox') {
    settings[el.name] = el.checked;
  } else {
    const v = Math.round(Number(el.value));
    if (!(v >= Number(el.min) && v <= Number(el.max))) return;
    settings[el.name] = v;
  }

  if (el.name === 'notify' && el.checked && Notification.permission !== 'granted') {
    Notification.requestPermission().then((perm) => {
      if (perm !== 'granted') { settings.notify = false; el.checked = false; saveSettings(); }
    });
  }
  if (el.name === timer.mode && wasFresh) timer.remaining = duration();

  saveSettings();
  renderSounds();
  changed();
});

/* Keyboard shortcuts */

addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || dialog.open) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  const key = e.key.toLowerCase();
  if (key === ' ') {
    if (e.target.closest?.('button')) return; // let Space activate the focused button
    e.preventDefault();
    timer.running ? pause() : start();
  } else if (key === 'r') reset();
  else if (key === 's') finish(false);
  else if (key === '1') setMode('focus');
  else if (key === '2') setMode('short');
  else if (key === '3') setMode('long');
});

/* ---------- Boot ---------- */

let shownDay = dateKey();
function checkDayRollover() {
  const key = dateKey();
  if (key !== shownDay) { shownDay = key; renderTasks(); }
}

setInterval(() => { tick(); checkDayRollover(); }, 250);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { tick(); checkDayRollover(); }
});

pruneHistory();
saveDays();
// A session that ended while the page was closed still counts, but don't chime or auto-start.
if (timer.running && remainingNow() <= 0) finish(true, { quiet: true });
renderSounds();
renderTasks();
render();
scheduleEnd();
Sound.sync();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
