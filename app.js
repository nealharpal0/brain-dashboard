// app.js — laadt de vault uit GitHub, bouwt het model en vult de panelen.
import { BrainScene } from './scene.js';
import * as P from './parse.js';

const DEFAULT_REPO = 'nealharpal0/second-brain';
const BRANCH = 'main';
const OBSIDIAN_VAULT = 'Second Brain';
const REFRESH_MS = 2 * 60 * 1000;
const PRIORITIES_FILE = 'wiki/ik/prioriteiten-en-doelen.md';

const URGENCY = {
  late:  { color: '#FF7A7A', label: 'te laat' },
  soon:  { color: '#F4C25B', label: 'binnenkort' },
  later: { color: '#E8ECF7', label: 'later' },
  none:  { color: '#8C97B5', label: 'zonder datum' },
};
const QUESTION_COLOR = '#F2A7D8';

const $ = (s, el = document) => el.querySelector(s);
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del: k => { try { localStorage.removeItem(k); } catch { /* niets */ } },
};

const state = {
  token: store.get('brain.token') || '',
  repo: store.get('brain.repo') || DEFAULT_REPO,
  sha: null,
  commitDate: null,
  files: null,
  inbox: [],
  model: null,
  hidden: new Set(),
  openLog: new Set(),
  logLimit: 25,
  tab: 'todo',
  replay: null,
};

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const scene = new BrainScene($('#stage'), {
  labelLayer: $('#labels'),
  reducedMotion,
  onHover: showTooltip,
  onSelect: (node, task) => (task ? selectTask(task) : showCard(node)),
});

function updateInsets() {
  if (window.matchMedia('(max-width: 899px)').matches) { scene.setInsets({}); return; }
  const l = $('#claude').getBoundingClientRect();
  const r = $('#todo').getBoundingClientRect();
  const top = $('.top').getBoundingClientRect();
  const dock = $('.dock').getBoundingClientRect();
  document.documentElement.style.setProperty('--dock-h', `${Math.round(window.innerHeight - dock.top)}px`);
  scene.setInsets({ left: l.right, right: window.innerWidth - r.left, top: top.bottom, bottom: window.innerHeight - dock.top });
}
window.addEventListener('resize', updateInsets);
updateInsets();

// ---------- hulpjes ----------

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Veilige inline-markdown: eerst alles escapen, daarna alleen eigen tags toevoegen. */
function md(text) {
  let s = esc(String(text).replace(/\\\|/g, '|'));
  s = s.replace(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_, t, a) =>
    `<button type="button" class="wl" data-link="${t}">${a || t.split('#')[0].split('/').pop()}</button>`);
  s = s.replace(/!?\[([^\]]*)\]\([^)]+\)/g, '$1');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*/g, '$1<em>$2</em>');
  return s;
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

const dayMs = 86400000;
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function isoDay(d) { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function daysUntil(iso) { return Math.round((startOfDay(P.toDate(iso)) - startOfDay(new Date())) / dayMs); }

const fmtDay = new Intl.DateTimeFormat('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtDate = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
const fmtShort = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short' });

function dayLabel(iso) {
  const n = daysUntil(iso);
  if (n === 0) return 'Vandaag';
  if (n === -1) return 'Gisteren';
  const s = fmtDay.format(P.toDate(iso));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function relTime(date) {
  const min = Math.round((Date.now() - date.getTime()) / 60000);
  if (min < 1) return 'zojuist';
  if (min < 60) return `${min} min geleden`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} uur geleden`;
  const d = Math.round(h / 24);
  return d === 1 ? 'gisteren' : `${d} dagen geleden`;
}

function dueText(due) {
  if (!due) return '';
  const n = daysUntil(due.date);
  if (due.kind === 'week' && n >= 0 && n <= 6) return 'deze week';
  if (n < -1) return `${-n} dagen te laat`;
  if (n === -1) return 'gisteren';
  if (n === 0) return 'vandaag';
  if (n === 1) return 'morgen';
  if (due.kind === 'rond') return `rond ${fmtShort.format(P.toDate(due.date))}`;
  if (n <= 14) return `nog ${n} dagen`;
  return `voor ${fmtShort.format(P.toDate(due.date))}`;
}

function urgencyOf(due) {
  if (!due) return 'none';
  const n = daysUntil(due.date);
  if (n < 0) return 'late';
  if (n <= 7) return 'soon';
  return 'later';
}

/** "**Titel:** rest" → titel; anders de tekst tot de eerste haak of dubbele punt. */
function splitTitle(text) {
  const lead = text.match(/^\*\*(.+?)\*\*[:.]?\s*/);
  const tidy = t => t.replace(/[:.]$/, '').replace(/,?\s*(vóór|voor|tot|uiterlijk)\s+\d{4}-\d{2}-\d{2}\.?$/i, '');
  if (lead) return { title: tidy(P.plain(lead[1])), rest: text.slice(lead[0].length) };
  const p = P.plain(text);
  const cut = p.search(/\s\(|:\s|\.\s/);
  return cut > 12 && cut < 90 ? { title: p.slice(0, cut), rest: text } : { title: p.length > 90 ? p.slice(0, 88) + '…' : p, rest: text };
}

// ---------- GitHub ----------

class GhError extends Error {
  constructor(kind, msg) { super(msg || kind); this.kind = kind; }
}

async function gh(path, { raw = false } = {}) {
  let res;
  try {
    res = await fetch('https://api.github.com' + path, {
      headers: {
        Authorization: `Bearer ${state.token}`,
        Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      cache: 'no-store',
    });
  } catch {
    throw new GhError('network');
  }
  if (res.status === 401) throw new GhError('auth');
  if (res.status === 404) throw new GhError('notfound');
  if (res.status === 403 || res.status === 429) {
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = new Date(Number(res.headers.get('x-ratelimit-reset')) * 1000);
      throw new GhError('rate', reset.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }));
    }
    throw new GhError('forbidden');
  }
  if (!res.ok) throw new GhError('http', String(res.status));
  return raw ? res.text() : res.json();
}

function errorText(e) {
  switch (e.kind) {
    case 'auth': return 'GitHub accepteert deze token niet. Hij is verlopen, ingetrokken of niet volledig geplakt. Maak een nieuwe aan.';
    case 'notfound': return `De token kan ${state.repo} niet lezen. Kies bij "Repository access" deze repo en geef Contents leesrechten.`;
    case 'forbidden': return 'GitHub weigert de toegang. Geef de token bij Permissions de rechten Contents: Read-only.';
    case 'rate': return `Te veel verzoeken aan GitHub. Om ${e.message} kan het weer.`;
    case 'network': return 'Geen verbinding met GitHub. Controleer je internet en ververs.';
    default: return `GitHub gaf een fout (${e.message}). Ververs over een minuut.`;
  }
}

const wanted = p => /^(wiki|hubs)\/.+\.md$/.test(p) || p === 'Checklist.md' || p === 'log.md' || p === 'CLAUDE.md';

function readCache() {
  try { return JSON.parse(store.get('brain.blobs') || '{}'); } catch { return {}; }
}

async function pool(items, size, fn) {
  let i = 0;
  const run = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
}

/** Haalt de vault op. Geeft false terug als er niets veranderd is. */
async function loadVault(force = false) {
  const [owner, repo] = state.repo.split('/');
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const head = (await gh(`${base}/branches/${BRANCH}`)).commit;
  if (!force && head.sha === state.sha) return false;
  const tree = await gh(`${base}/git/trees/${head.sha}?recursive=1`);
  const blobs = tree.tree.filter(e => e.type === 'blob');
  const need = blobs.filter(e => wanted(e.path));
  const cache = readCache();
  const files = {};
  let done = 0;
  const todo = need.filter(e => cache[e.sha] == null).length;
  if (todo > 10) setStatus(`Je vault laden: 0 van ${todo} notities`);
  await pool(need, 8, async e => {
    if (cache[e.sha] != null) { files[e.path] = cache[e.sha]; return; }
    files[e.path] = await gh(`${base}/git/blobs/${e.sha}`, { raw: true });
    done++;
    if (todo > 10 && done % 5 === 0) setStatus(`Je vault laden: ${done} van ${todo} notities`);
  });
  const next = {};
  for (const e of need) next[e.sha] = files[e.path];
  if (!store.set('brain.blobs', JSON.stringify(next))) store.del('brain.blobs');

  state.sha = head.sha;
  state.commitDate = new Date(head.commit.committer.date);
  state.files = files;
  state.inbox = blobs.filter(e => /^inbox\/[^/]+\.md$/.test(e.path)).map(e => e.path);
  return true;
}

// ---------- model ----------

function buildModel(files) {
  const graph = P.buildGraph(files);
  const log = P.parseLog(files['log.md'] || '', graph.resolve);
  const checklist = P.parseChecklist(files['Checklist.md'] || '', graph.resolve);
  const prioText = files[PRIORITIES_FILE] || Object.values(files).find(t => /^## Prioriteiten \(in volgorde\)/m.test(t));
  const priorities = P.parsePriorities(prioText);
  const schedule = P.parseInboxSchedule(files['CLAUDE.md']);

  // activiteit: recente logregels wegen zwaarder
  const now = Date.now();
  const act = new Map();
  const lastAction = new Map();
  for (const e of log) {
    if (!e.at) continue;
    const age = (now - e.at.getTime()) / dayMs;
    if (age > 7 || age < -1) continue;
    const w = Math.exp(-Math.max(0, age) / 1.6);
    for (const id of e.pages) { act.set(id, (act.get(id) || 0) + w); lastAction.set(id, e.action); }
  }
  const maxAct = Math.max(1, ...act.values());

  const ids = [...graph.pages.keys()];
  const index = new Map(ids.map((id, i) => [id, i]));
  const clusters = {};
  const nodes = ids.map(id => {
    const p = graph.pages.get(id);
    const c = P.CLUSTERS[p.cluster];
    clusters[p.cluster] = clusters[p.cluster] || { ...c, count: 0 };
    clusters[p.cluster].count++;
    const a = (act.get(id) || 0) / maxAct;
    return {
      id, title: p.title, cluster: p.cluster, color: c.color, isHub: p.isHub,
      size: p.isHub ? 13 : 4.2 + Math.sqrt(p.degree) * 1.15 + a * 3,
      activity: a,
      actionColor: lastAction.has(id) ? (P.ACTIONS[lastAction.get(id)] || P.ACTIONS.update).color : null,
      page: p,
    };
  });
  const edges = graph.edges.map(([a, b]) => [index.get(a), index.get(b)]);

  // taken voor de baan rond de kaart
  const openItems = [];
  for (const g of checklist.groups) {
    for (const it of g.items) {
      if (it.done) continue;
      openItems.push({ ...it, group: g.name, ...splitTitle(it.text) });
    }
  }
  const openQuestions = checklist.questions.filter(q => q.open);
  const tasks = [
    ...openItems.map((it, k) => {
      const u = urgencyOf(it.effectiveDue);
      return { key: 'a' + k, kind: 'action', title: it.title, color: URGENCY[u].color, urgent: u === 'late' || u === 'soon', target: it.pages.length ? (index.get(it.pages[0]) ?? -1) : -1, item: it, urgency: u };
    }),
    ...openQuestions.map((q, k) => ({ key: 'q' + k, kind: 'question', title: q.title, color: QUESTION_COLOR, urgent: false, target: q.pages.length ? (index.get(q.pages[0]) ?? -1) : -1, item: q })),
  ];

  return { graph, log, checklist, priorities, schedule, nodes, edges, clusters, tasks, openItems, openQuestions, index };
}

// ---------- weergave ----------

function render() {
  const m = state.model;
  renderSync();
  renderClaude(m);
  renderTodo(m);
  renderLegend(m);
}

function renderSync() {
  $('#sync').textContent = state.commitDate ? `Laatste wijziging in je vault ${relTime(state.commitDate)}` : '';
  $('#sync').title = state.commitDate ? state.commitDate.toLocaleString('nl-NL') : '';
}

function nextInboxRun(schedule) {
  if (!schedule) return null;
  const now = new Date();
  const isDst = d => {
    const jan = new Date(d.getFullYear(), 0, 1).getTimezoneOffset();
    const jul = new Date(d.getFullYear(), 6, 1).getTimezoneOffset();
    return d.getTimezoneOffset() < Math.max(jan, jul);
  };
  for (let add = 0; add < 3; add++) {
    const day = startOfDay(new Date(now.getTime() + add * dayMs));
    for (const t of schedule.summer) {
      const [h, mi] = t.split(':').map(Number);
      const c = new Date(day);
      c.setHours(h, mi, 0, 0);
      if (!isDst(c)) c.setMinutes(c.getMinutes() + schedule.winterShift);
      if (c > now) return c;
    }
  }
  return null;
}

function renderClaude(m) {
  const box = $('#claude-body');
  box.textContent = '';
  const today = isoDay(new Date());
  const yesterday = isoDay(new Date(Date.now() - dayMs));
  const nToday = m.log.filter(e => e.date === today).length;
  const nYest = m.log.filter(e => e.date === yesterday).length;
  const last = m.log[m.log.length - 1];

  const summary = el('div', 'summary');
  const lines = [];
  lines.push(`<p class="lead">${nToday ? `Vandaag ${nToday} ${nToday === 1 ? 'actie' : 'acties'} in je vault` : 'Vandaag nog niets gedaan in je vault'}${nYest ? `, gisteren ${nYest}` : ''}.</p>`);
  if (last) lines.push(`<p class="muted">Laatst: ${esc(dayLabel(last.date).toLowerCase())}${last.time ? ' om ' + esc(last.time) : ''}, ${esc(P.plain(last.title))}.</p>`);
  const pending = state.inbox.length;
  const next = nextInboxRun(m.schedule);
  const at = next ? `${daysUntil(isoDay(next)) === 0 ? 'vandaag' : 'morgen'} om ${next.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}` : '';
  lines.push(pending
    ? `<p class="inbox inbox-waiting"><span class="dot"></span>${pending} ${pending === 1 ? 'memo wacht' : "memo's wachten"} in je inbox.${at ? ` Claude verwerkt ze ${esc(at)}.` : ''}</p>`
    : `<p class="inbox"><span class="dot"></span>Je inbox is leeg.${at ? ` Volgende ronde ${esc(at)}.` : ''}</p>`);
  summary.innerHTML = lines.join('');
  const key = el('p', 'tl-key');
  const used = [...new Set(m.log.slice(-state.logLimit).map(e => e.action))];
  key.innerHTML = used.map(k => P.ACTIONS[k] || { label: k, color: '#A9B6CF' }).map(a => `<span><i></i>${esc(a.label)}</span>`).join('');
  [...key.querySelectorAll('i')].forEach((dot, i) => { dot.style.background = (P.ACTIONS[used[i]] || { color: '#A9B6CF' }).color; });
  box.append(summary, activityBars(m.log), key);

  // tijdlijn, nieuwste eerst, per dag
  const list = el('ol', 'timeline');
  const shown = m.log.slice(-state.logLimit).reverse();
  let lastDay = null;
  for (const e of shown) {
    if (e.date !== lastDay) {
      lastDay = e.date;
      list.append(el('li', 'tl-day', esc(dayLabel(e.date))));
    }
    const a = P.ACTIONS[e.action] || { label: e.action, color: '#A9B6CF' };
    const li = el('li', 'tl-item' + (state.openLog.has(e.index) ? ' open' : ''));
    li.dataset.log = e.index;
    const btn = el('button', 'tl-head');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', state.openLog.has(e.index) ? 'true' : 'false');
    btn.innerHTML = `<span class="tl-dot"></span><span class="tl-time">${esc(e.time || '')}</span><span class="tl-title">${md(e.title)}</span>`;
    btn.title = a.label;
    btn.querySelector('.tl-dot').style.background = a.color;
    li.append(btn);
    if (state.openLog.has(e.index)) {
      const body = el('div', 'tl-body');
      body.innerHTML = `<ul>${e.bullets.map(b => `<li>${md(b)}</li>`).join('')}</ul>`;
      li.append(body);
    }
    list.append(li);
  }
  box.append(list);
  if (m.log.length > state.logLimit) {
    const more = el('button', 'more', `Toon ${Math.min(25, m.log.length - state.logLimit)} eerdere`);
    more.type = 'button';
    more.dataset.action = 'more-log';
    box.append(more);
  }
}

function activityBars(log) {
  const days = 14;
  const counts = new Map();
  for (const e of log) counts.set(e.date, (counts.get(e.date) || 0) + 1);
  const series = [];
  for (let k = days - 1; k >= 0; k--) {
    const d = new Date(Date.now() - k * dayMs);
    series.push({ iso: isoDay(d), n: counts.get(isoDay(d)) || 0, d });
  }
  const max = Math.max(1, ...series.map(s => s.n));
  const W = 300, H = 46, bw = W / days;
  const bars = series.map((s, i) => {
    const h = s.n ? Math.max(3, (s.n / max) * (H - 4)) : 1.5;
    const cls = i === days - 1 ? 'bar today' : s.n ? 'bar' : 'bar empty';
    return `<rect class="${cls}" x="${(i * bw + 2).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${(bw - 4).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5"><title>${esc(fmtDay.format(s.d))}: ${s.n} ${s.n === 1 ? 'actie' : 'acties'}</title></rect>`;
  }).join('');
  const wrap = el('figure', 'bars');
  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Acties van Claude per dag, afgelopen twee weken">${bars}</svg><figcaption><span>${esc(fmtShort.format(series[0].d))}</span><span>Acties per dag</span><span>vandaag</span></figcaption>`;
  return wrap;
}

function renderTodo(m) {
  const box = $('#todo-body');
  box.textContent = '';

  if (m.priorities.length) {
    const pr = el('div', 'compass');
    pr.innerHTML = `<h3>Jouw volgorde</h3><ol>${m.priorities.map(p => `<li title="${esc(p.note)}">${esc(p.name)}</li>`).join('')}</ol>`;
    box.append(pr);
  }

  // eerst dit: de drie dichtstbijzijnde deadlines
  const dated = m.openItems.filter(it => it.effectiveDue).sort((a, b) => a.effectiveDue.date.localeCompare(b.effectiveDue.date));
  if (dated.length) {
    const sec = el('section', 'first');
    sec.append(el('h3', null, 'Eerst dit'));
    const ol = el('ol', 'first-list');
    dated.slice(0, 3).forEach(it => ol.append(taskRow(it, { compact: true })));
    sec.append(ol);
    box.append(sec);
  }

  if (m.openQuestions.length) {
    const sec = el('section', 'questions');
    sec.append(el('h3', null, `Vragen voor jou <span class="count">${m.openQuestions.length}</span>`));
    const ul = el('ul', 'q-list');
    for (const q of m.openQuestions) {
      const li = el('li', 'q');
      li.innerHTML = `<details><summary><span class="q-mark" aria-hidden="true"></span>${esc(q.title)}</summary><div class="q-body">${md(q.body)}<p class="hint">Je antwoord zet je in Checklist.md, achter <strong>Antwoord:</strong>. Claude verwerkt het daarna.</p></div></details>`;
      if (q.pages[0]) li.dataset.page = q.pages[0];
      ul.append(li);
    }
    sec.append(ul);
    box.append(sec);
  }

  for (const g of m.checklist.groups) {
    const items = g.items.filter(it => !it.done);
    if (!items.length) continue;
    const sec = el('section', 'group');
    const node = g.pages[0] != null ? m.nodes[m.index.get(g.pages[0])] : null;
    const h = el('h3', null, esc(g.name));
    if (node) { const dot = el('span', 'gdot'); dot.style.background = node.color; h.prepend(dot); }
    sec.append(h);
    const ul = el('ul', 'task-list');
    items.forEach(it => ul.append(taskRow({ ...it, ...splitTitle(it.text) })));
    sec.append(ul);
    box.append(sec);
  }

  if (!m.openItems.length && !m.openQuestions.length) {
    box.append(el('p', 'empty', 'Niets open in je checklist. Nieuwe acties verschijnen hier zodra Claude ze in Checklist.md zet.'));
  }
  box.append(el('p', 'muted done-count', `${m.checklist.doneCount} acties afgerond`));
}

function taskRow(it, { compact = false } = {}) {
  const li = el('li', 'task' + (compact ? ' compact' : ''));
  const u = urgencyOf(it.effectiveDue);
  const due = it.effectiveDue ? `<span class="due due-${u}">${esc(dueText(it.effectiveDue))}</span>` : '';
  const steps = it.stepsTotal ? `<span class="steps">${it.stepsDone} van ${it.stepsTotal} stappen</span>` : '';
  const openSteps = it.children.filter(c => !c.done);
  const detail = compact ? '' :
    `<div class="task-detail">${it.rest && P.plain(it.rest) ? `<p>${md(it.rest)}</p>` : ''}${openSteps.length ? `<ul class="substeps">${openSteps.map(c => `<li>${md(c.text)}${c.due ? ` <span class="due due-${urgencyOf(c.due)}">${esc(dueText(c.due))}</span>` : ''}</li>`).join('')}</ul>` : ''}</div>`;
  const group = compact && it.group ? `<span class="tgroup">${esc(it.group)}</span>` : '';
  li.innerHTML = compact
    ? `<button type="button" class="task-head" data-action="focus-task"><span class="task-title">${esc(it.title)}</span>${group}${due}</button>`
    : `<details><summary><span class="task-title">${esc(it.title)}</span>${due}${steps}</summary>${detail}</details>`;
  const tick = el('span', 'tick');
  tick.style.borderColor = URGENCY[u].color;
  li.querySelector('summary, .task-head').prepend(tick);
  if (it.pages[0]) li.dataset.page = it.pages[0];
  return li;
}

function renderLegend(m) {
  requestAnimationFrame(updateInsets);
  const box = $('#legend');
  box.textContent = '';
  const keys = Object.keys(m.clusters).sort((a, b) => m.clusters[b].count - m.clusters[a].count);
  for (const k of keys) {
    const c = m.clusters[k];
    const b = el('button', 'chip' + (state.hidden.has(k) ? ' off' : ''));
    b.type = 'button';
    b.dataset.cluster = k;
    b.setAttribute('aria-pressed', state.hidden.has(k) ? 'false' : 'true');
    b.innerHTML = `<span class="sw"></span>${esc(c.label)} <span class="n">${c.count}</span>`;
    b.querySelector('.sw').style.background = c.color;
    b.title = state.hidden.has(k) ? `${c.label} tonen` : `${c.label} verbergen`;
    box.append(b);
  }
}

// ---------- kaartje, tooltip, focus ----------

function showTooltip(h) {
  const tip = $('#tooltip');
  if (!h) { tip.hidden = true; return; }
  if (h.kind === 'node') {
    const c = P.CLUSTERS[h.node.cluster];
    tip.innerHTML = `<strong>${esc(h.node.title)}</strong><span>${esc(c.label)}${h.node.activity > 0.05 ? ', recent bijgewerkt door Claude' : ''}</span>`;
  } else {
    const t = h.task;
    const label = t.kind === 'question' ? 'Vraag voor jou' : t.item.effectiveDue ? dueText(t.item.effectiveDue) : 'Actie zonder datum';
    tip.innerHTML = `<strong>${esc(t.title)}</strong><span>${esc(label.charAt(0).toUpperCase() + label.slice(1))}</span>`;
  }
  tip.hidden = false;
  const stage = $('#stage').getBoundingClientRect();
  const x = Math.min(Math.max(h.x, 12), stage.width - 12);
  tip.style.transform = `translate(${x.toFixed(0)}px, ${(h.y - 18).toFixed(0)}px) translate(-50%, -100%)`;
}

function showCard(node) {
  const card = $('#card');
  if (!node) { card.hidden = true; return; }
  const p = node.page;
  const c = P.CLUSTERS[p.cluster];
  const [owner, repo] = state.repo.split('/');
  const recent = state.model.log.filter(e => e.pages.includes(p.id)).slice(-3).reverse();
  card.innerHTML = `
    <button type="button" class="close" data-action="close-card" aria-label="Sluiten">×</button>
    <p class="card-kicker"><span class="sw"></span>${esc(c.label)}${p.updated ? `, bijgewerkt ${esc(fmtDate.format(P.toDate(p.updated)))}` : ''}</p>
    <h2>${esc(p.title)}</h2>
    ${p.summary ? `<p class="card-sum">${esc(p.summary)}</p>` : ''}
    ${recent.length ? `<ul class="card-log">${recent.map(e => `<li><span>${esc(fmtShort.format(e.at))}</span> ${esc(P.plain(e.title))}</li>`).join('')}</ul>` : ''}
    <p class="card-links">
      <a href="obsidian://open?vault=${encodeURIComponent(OBSIDIAN_VAULT)}&amp;file=${encodeURIComponent(p.id)}">Openen in Obsidian</a>
      <a href="https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/blob/${BRANCH}/${p.path.split('/').map(encodeURIComponent).join('/')}" target="_blank" rel="noopener noreferrer">Bekijken op GitHub</a>
      <span class="muted">${node.page.degree} verbindingen</span>
    </p>`;
  card.querySelector('.sw').style.background = c.color;
  card.hidden = false;
}

function focusPage(id) {
  const i = state.model && state.model.index.get(id);
  if (i == null) return;
  if (state.hidden.has(state.model.nodes[i].cluster)) {
    state.hidden.delete(state.model.nodes[i].cluster);
    scene.setHiddenClusters(state.hidden);
    renderLegend(state.model);
  }
  scene.select(i);
  if (window.matchMedia('(max-width: 899px)').matches) $('#stage').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
}

function selectTask(task) {
  if (task.target >= 0) focusPage(state.model.nodes[task.target].id);
  setTab('todo');
}

function setTab(tab) {
  state.tab = tab;
  document.body.dataset.tab = tab;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false');
}

// ---------- afspelen ----------

function toggleReplay() {
  if (state.replay) return stopReplay();
  const from = Date.now() - 7 * dayMs;
  const entries = state.model.log.filter(e => e.at && e.at.getTime() >= from && e.pages.length);
  if (!entries.length) { flashCaption('Geen activiteit van Claude in de afgelopen week.'); return; }
  scene.select(-1, { fly: false });
  scene.fitView();
  state.replay = { entries, k: 0, timer: null };
  $('#play').textContent = 'Stoppen';
  $('#play').setAttribute('aria-pressed', 'true');
  const stepMs = reducedMotion ? 1800 : 1150;
  const step = () => {
    const r = state.replay;
    if (!r) return;
    if (r.k >= r.entries.length) { stopReplay(); return; }
    const e = r.entries[r.k++];
    const a = P.ACTIONS[e.action] || P.ACTIONS.update;
    scene.burst(e.pages, a.color);
    const cap = $('#caption');
    cap.innerHTML = `<span class="cap-when">${esc(dayLabel(e.date))}${e.time ? ' ' + esc(e.time) : ''}</span><span class="cap-what">${esc(P.plain(e.title))}</span><span class="cap-n">${r.k} van ${r.entries.length}</span>`;
    cap.hidden = false;
    r.timer = setTimeout(step, stepMs);
  };
  step();
}

function stopReplay() {
  if (state.replay) clearTimeout(state.replay.timer);
  state.replay = null;
  $('#play').textContent = 'Speel de week af';
  $('#play').setAttribute('aria-pressed', 'false');
  setTimeout(() => { if (!state.replay) $('#caption').hidden = true; }, 1600);
}

let captionTimer;
function flashCaption(text) {
  const cap = $('#caption');
  cap.innerHTML = `<span class="cap-what">${esc(text)}</span>`;
  cap.hidden = false;
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => { cap.hidden = true; }, 2600);
}

// ---------- status en verbinden ----------

function setStatus(text) {
  const s = $('#status');
  s.textContent = text || '';
  s.hidden = !text;
}

function showError(e) {
  const bar = $('#error');
  bar.querySelector('p').textContent = errorText(e);
  bar.querySelector('button').hidden = !(e.kind === 'auth' || e.kind === 'notfound' || e.kind === 'forbidden');
  bar.hidden = false;
}

function showConnect(message) {
  const c = $('#connect');
  c.hidden = false;
  document.body.classList.add('connecting');
  $('#repo-input').value = state.repo;
  const m = $('#connect-msg');
  m.textContent = message || '';
  m.hidden = !message;
  setTimeout(() => $('#token-input').focus(), 50);
}

async function refresh(force = false) {
  if (!state.token) return;
  const btn = $('#refresh');
  btn.classList.add('spinning');
  try {
    const changed = await loadVault(force);
    $('#error').hidden = true;
    if (changed || !state.model) {
      state.model = buildModel(state.files);
      scene.setData(state.model);
      scene.setHiddenClusters(state.hidden);
      render();
    } else renderSync();
  } catch (e) {
    if (!state.model && (e.kind === 'auth' || e.kind === 'notfound' || e.kind === 'forbidden')) showConnect(errorText(e));
    else showError(e);
  } finally {
    setStatus('');
    btn.classList.remove('spinning');
  }
}

async function connect(ev) {
  ev.preventDefault();
  const token = $('#token-input').value.trim();
  const repo = $('#repo-input').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { showConnect('Vul de repo in als eigenaar/naam, bijvoorbeeld nealharpal0/second-brain.'); return; }
  if (!token) { showConnect('Plak eerst je token.'); return; }
  state.token = token;
  state.repo = repo;
  $('#connect-go').disabled = true;
  $('#connect-go').textContent = 'Verbinden…';
  try {
    await loadVault(true);
    store.set('brain.token', token);
    store.set('brain.repo', repo);
    $('#connect').hidden = true;
    document.body.classList.remove('connecting');
    state.model = buildModel(state.files);
    scene.setData(state.model);
    render();
  } catch (e) {
    state.token = '';
    showConnect(errorText(e));
  } finally {
    setStatus('');
    $('#connect-go').disabled = false;
    $('#connect-go').textContent = 'Verbinden';
  }
}

function forget() {
  store.del('brain.token');
  store.del('brain.blobs');
  store.del('brain.repo');
  location.reload();
}

// ---------- events ----------

document.addEventListener('click', e => {
  const t = e.target.closest('button, [data-page]');
  if (!t) return;
  if (t.matches('.wl')) {
    e.preventDefault();
    const id = state.model && state.model.graph.resolve(t.dataset.link);
    if (id) focusPage(id);
    return;
  }
  if (t.matches('.chip[data-cluster]')) {
    const k = t.dataset.cluster;
    state.hidden.has(k) ? state.hidden.delete(k) : state.hidden.add(k);
    scene.setHiddenClusters(state.hidden);
    renderLegend(state.model);
    return;
  }
  if (t.matches('.tl-head')) {
    const li = t.closest('.tl-item');
    const i = +li.dataset.log;
    const entry = state.model.log[i];
    if (state.openLog.has(i)) state.openLog.delete(i);
    else { state.openLog.add(i); scene.burst(entry.pages, (P.ACTIONS[entry.action] || P.ACTIONS.update).color); }
    renderClaude(state.model);
    return;
  }
  const action = t.dataset.action;
  if (action === 'more-log') { state.logLimit += 25; renderClaude(state.model); return; }
  if (action === 'close-card') { scene.select(-1, { fly: false }); return; }
  if (action === 'focus-task' || (t.dataset.page && e.target.closest('summary'))) {
    const page = t.closest('[data-page]');
    if (page) focusPage(page.dataset.page);
  }
});

$('#refresh').addEventListener('click', () => refresh(true));
$('#play').addEventListener('click', () => state.model && toggleReplay());
$('#fit').addEventListener('click', () => { scene.select(-1, { fly: false }); scene.fitView(); });
$('#connect-form').addEventListener('submit', connect);
$('#forget').addEventListener('click', forget);
$('#error-fix').addEventListener('click', () => { $('#error').hidden = true; showConnect(); });
$('#settings').addEventListener('click', () => {
  const menu = $('#menu');
  menu.hidden = !menu.hidden;
  $('#settings').setAttribute('aria-expanded', menu.hidden ? 'false' : 'true');
  $('#menu-repo').textContent = state.repo;
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { $('#menu').hidden = true; scene.select(-1, { fly: false }); }
});
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => setTab(b.dataset.tab));
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
setInterval(() => { if (state.model) renderSync(); }, 60000);

setTab('todo');
if (state.token) refresh(true);
else showConnect();
