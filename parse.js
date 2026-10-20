// parse.js — zet de markdown uit de vault om in data voor het dashboard.
// Puur JavaScript zonder browser-API's, zodat het ook in Node getest kan worden.

export const CLUSTERS = {
  fluks:          { label: 'Fluks',        color: '#69B2E3' },
  kemeling:       { label: 'Kemeling',     color: '#5CD6A8' },
  ecommerce:      { label: 'Pootjespret',  color: '#F0A35E' },
  youtube:        { label: 'YouTube',      color: '#F07379' },
  studie:         { label: 'Studie',       color: '#B9A4FF' },
  ik:             { label: 'Ik',           color: '#F4D47C' },
  'second-brain': { label: 'Second Brain', color: '#A9B6CF' },
};

export const ACTIONS = {
  update: { label: 'bijgewerkt',    color: '#7FC8F0' },
  query:  { label: 'vraag',         color: '#E8ECF7' },
  ingest: { label: 'bron verwerkt', color: '#6EE0B0' },
  setup:  { label: 'ingericht',     color: '#C3A8FF' },
  lint:   { label: 'controle',      color: '#F4D47C' },
};

const ISO = /\d{4}-\d{2}-\d{2}/;

// ---------- algemeen ----------

export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { data: {}, body: text };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].replace(/\s+#\s.*$/, '').trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      v = v.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      v = v.replace(/^["']|["']$/g, '');
    }
    data[kv[1]] = v;
  }
  return { data, body: text.slice(m[0].length) };
}

/** Markdown-opmaak weghalen voor platte tekst. */
export function plain(md) {
  return String(md)
    .replace(/\\\|/g, '|')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, (_, t) => t.split('#')[0].split('/').pop())
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const LINK_RE = /\[\[([^\]]+?)\]\]/g;

/** Alle wikilink-doelen in een stuk tekst, zonder alias of kopje. */
export function extractLinks(md) {
  const out = [];
  for (const m of String(md).matchAll(LINK_RE)) {
    const t = m[1].replace(/\\\|/g, '|').split('|')[0].split('#')[0].trim().replace(/\\+$/, '');
    if (t) out.push(t);
  }
  return out;
}

/** Zoekt bij een wikilink de pagina, zoals Obsidian dat doet (pad, of kortste pad dat erop eindigt). */
export function makeResolver(ids) {
  const set = new Set(ids);
  const cache = new Map();
  const shortest = list => list.sort((a, b) => a.length - b.length)[0] || null;
  return target => {
    if (cache.has(target)) return cache.get(target);
    const t = target.replace(/\.md$/i, '').replace(/^\/+/, '');
    let hit = null;
    if (set.has(t)) hit = t;
    else if (set.has('wiki/' + t)) hit = 'wiki/' + t;
    else {
      hit = shortest(ids.filter(p => p.endsWith('/' + t)));
      if (!hit) {
        const tl = t.toLowerCase();
        hit = shortest(ids.filter(p => p.toLowerCase() === tl || p.toLowerCase().endsWith('/' + tl)));
      }
    }
    cache.set(target, hit);
    return hit;
  };
}

export function clusterOf(id, fm) {
  const tags = Array.isArray(fm.tags) ? fm.tags : [];
  if (id.startsWith('wiki/concepts/bedrijfskunde') || tags.includes('studie')) return 'studie';
  if (id.startsWith('wiki/ik/') || fm.type === 'ik') return 'ik';
  return CLUSTERS[fm.gebied] ? fm.gebied : 'second-brain';
}

export function toDate(iso, time) {
  if (!iso || !ISO.test(iso)) return null;
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const [h, mi] = (time || '00:00').split(':').map(Number);
  return new Date(y, m - 1, d, h || 0, mi || 0);
}

function addDays(iso, n) {
  const d = toDate(iso);
  d.setDate(d.getDate() + n);
  const p = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- pagina's en verbindingen ----------

/**
 * files: { 'wiki/concepts/x.md': '...', 'hubs/Home.md': '...' }
 * Geeft pagina's en (ongerichte, unieke) verbindingen terug.
 */
export function buildGraph(files) {
  const pagePaths = Object.keys(files).filter(p => /^(wiki|hubs)\/.+\.md$/.test(p));
  const ids = pagePaths.map(p => p.replace(/\.md$/, ''));
  const resolve = makeResolver(ids);
  const pages = new Map();

  for (const path of pagePaths) {
    const id = path.replace(/\.md$/, '');
    const { data: fm, body } = parseFrontmatter(files[path]);
    const h1 = body.match(/^#\s+(.+)$/m);
    const quote = body.split(/\r?\n/).find(l => /^>\s+(?!\[!)\S/.test(l));
    const links = [...new Set(extractLinks(files[path]).map(resolve).filter(x => x && x !== id))];
    pages.set(id, {
      id, path,
      title: h1 ? plain(h1[1]) : id.split('/').pop(),
      summary: quote ? plain(quote.replace(/^>\s*/, '')).slice(0, 260) : '',
      type: fm.type || '',
      gebied: fm.gebied || '',
      cluster: clusterOf(id, fm),
      updated: typeof fm.updated === 'string' && ISO.test(fm.updated) ? fm.updated : '',
      isHub: fm.type === 'hub' || id.startsWith('hubs/'),
      links,
      degree: 0,
    });
  }

  const seen = new Set();
  const edges = [];
  for (const p of pages.values()) {
    for (const q of p.links) {
      const key = p.id < q ? p.id + '\n' + q : q + '\n' + p.id;
      if (seen.has(key) || !pages.has(q)) continue;
      seen.add(key);
      edges.push([p.id, q]);
      p.degree++; pages.get(q).degree++;
    }
  }
  return { pages, edges, resolve };
}

// ---------- log.md: wat Claude deed ----------

const LOG_HEAD = /^## \[(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?\]\s*([\w-]+)\s*\|\s*(.+?)\s*$/;

export function parseLog(text, resolve) {
  const entries = [];
  let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    const h = line.match(LOG_HEAD);
    if (h) {
      cur = { date: h[1], time: h[2] || '', action: h[3].toLowerCase(), title: h[4], bullets: [], pages: [] };
      entries.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/^#{1,2}\s/.test(line)) { cur = null; continue; }
    const b = line.match(/^\s*[-*]\s+(.*)$/);
    if (b) cur.bullets.push(b[1]);
    else if (line.trim() && cur.bullets.length) cur.bullets[cur.bullets.length - 1] += ' ' + line.trim();
  }
  entries.forEach((e, i) => {
    e.index = i;
    e.at = toDate(e.date, e.time);
    const targets = extractLinks(e.title + '\n' + e.bullets.join('\n'));
    e.pages = resolve ? [...new Set(targets.map(resolve).filter(Boolean))] : [];
  });
  return entries;
}

// ---------- Checklist.md: wat Neal moet doen ----------

const DAYS = 'maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag|ma|di|wo|do|vr|za|zo';
const DUE_RE = new RegExp(`(vóór|voor|uiterlijk|deadline:?|tot|rond|week van|\\b(?:${DAYS})\\.?)\\s*\\**\\s*(\\d{4}-\\d{2}-\\d{2})`, 'gi');

/** Zoekt een deadline in actietekst. Data in *(gesprek …)*-herkomst tellen niet mee. */
export function findDue(text) {
  const t = String(text).replace(/\*\([^)]*\)\*/g, ' ');
  let best = null;
  for (const m of t.matchAll(DUE_RE)) {
    const kw = m[1].toLowerCase();
    const date = kw === 'week van' ? addDays(m[2], 6) : m[2];
    const kind = kw === 'week van' ? 'week' : kw === 'rond' ? 'rond' : 'voor';
    if (!best || date < best.date) best = { date, kind, from: m[2] };
  }
  return best;
}

export function parseChecklist(text, resolve) {
  const res = { questions: [], groups: [], doneCount: 0 };
  const parts = String(text).split(/^## /m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const head = part.slice(0, nl < 0 ? undefined : nl);
    const body = nl < 0 ? '' : part.slice(nl + 1);
    const lines = body.split(/\r?\n/);
    if (/afgerond/i.test(head)) {
      res.doneCount = lines.filter(l => /^\s*- \[[xX]\]/.test(l)).length;
    } else if (/vragen/i.test(head)) {
      parseQuestions(lines, res.questions, resolve);
    } else if (/acties|openstaand/i.test(head)) {
      parseActions(lines, res.groups, resolve);
    }
  }
  return res;
}

function linkTargets(text, resolve) {
  return resolve ? [...new Set(extractLinks(text).map(resolve).filter(Boolean))] : [];
}

function parseQuestions(lines, out, resolve) {
  let q = null;
  const finish = () => {
    if (!q) return;
    const lead = q.text.match(/^\*\*(.+?)\*\*\s*/);
    q.title = lead ? plain(lead[1]).replace(/[:：]\s*$/, '') : plain(q.text).slice(0, 80);
    q.body = lead ? q.text.slice(lead[0].length) : q.text;
    q.open = !q.answer.trim();
    q.pages = linkTargets(q.text, resolve);
    q.due = findDue(q.text);
    out.push(q);
  };
  for (const line of lines) {
    if (/^- /.test(line)) { finish(); q = { text: line.slice(2).trim(), answer: '' }; continue; }
    if (!q || !line.trim()) continue;
    const a = line.match(/\*\*Antwoord:\*\*\s*(.*)$/);
    if (a) q.answer = a[1];
    else q.text += ' ' + line.trim();
  }
  finish();
}

function parseActions(lines, groups, resolve) {
  let group = null;
  let top = null;
  const ensureGroup = () => {
    if (!group) { group = { name: 'Overig', pages: [], items: [] }; groups.push(group); }
    return group;
  };
  for (const line of lines) {
    const head = line.match(/^\*\*(.+?)\*\*(.*)$/);
    if (head) {
      group = { name: plain(head[1]), pages: linkTargets(head[2], resolve), items: [] };
      groups.push(group);
      top = null;
      continue;
    }
    const item = line.match(/^(\s*)- \[([ xX])\]\s+(.*)$/);
    if (item) {
      const node = { text: item[3], done: item[2] !== ' ', due: findDue(item[3]), pages: linkTargets(item[3], resolve), children: [], notes: [] };
      if (item[1].length === 0 || !top) { top = node; ensureGroup().items.push(node); }
      else top.children.push(node);
      continue;
    }
    const note = line.match(/^\s+- (.*)$/);
    if (note && top) top.notes.push(note[1]);
  }
  for (const g of groups) {
    for (const it of g.items) {
      const open = it.children.filter(c => !c.done);
      it.stepsTotal = it.children.length;
      it.stepsDone = it.children.length - open.length;
      // deadline van de actie zelf, anders de vroegste van een open stap
      const dues = [it.due, ...open.map(c => c.due)].filter(Boolean);
      it.effectiveDue = dues.sort((a, b) => a.date.localeCompare(b.date))[0] || null;
      if (!it.pages.length) it.pages = g.pages.slice();
    }
  }
}

// ---------- overige ----------

/** Volgorde uit wiki/ik/prioriteiten-en-doelen.md, sectie "Prioriteiten (in volgorde)". */
export function parsePriorities(text) {
  if (!text) return [];
  const m = String(text).match(/^## Prioriteiten \(in volgorde\)[^\n]*\n([\s\S]*?)(?=\n## |(?![\s\S]))/m);
  if (!m) return [];
  const out = [];
  for (const line of m[1].split(/\r?\n/)) {
    const li = line.match(/^\s*\d+\.\s+(.*)$/);
    if (!li) continue;
    const bold = li[1].match(/\*\*(.+?)\*\*/);
    const note = li[1].replace(/\*\*(.+?)\*\*/, '').match(/\(([^)]*)\)/);
    out.push({ name: plain(bold ? bold[1] : li[1]), note: note ? plain(note[1]) : '', links: extractLinks(li[1]) });
  }
  return out;
}

/** Tijden van de cloud-routine "Inbox verwerken" uit CLAUDE.md, bijv. "12:30, 17:30, 21:30 zomertijd; in de wintertijd een uur eerder". */
export function parseInboxSchedule(claudeMd) {
  if (!claudeMd) return null;
  for (const m of String(claudeMd).matchAll(/Inbox verwerken[^\n(]*\(([^)]*)\)/gi)) {
    if (!/zomertijd/i.test(m[1])) continue;
    const summer = m[1].split(/zomertijd/i)[0].match(/\d{1,2}:\d{2}/g) || [];
    if (!summer.length) continue;
    const winterShift = /wintertijd een uur eerder/i.test(m[1]) ? -60 : 0;
    return { summer, winterShift };
  }
  return null;
}
