// Lógica pura (sin DOM): fechas, duraciones, colores y construcción de vistas.

export const SUBJECT_COLORS = {
  BDA: '#89b4fa', COP: '#fab387', CPA: '#a6e3a1', DBD: '#f9e2af',
  FSO: '#94e2d5', MNE: '#f5c2e7', SIE: '#89dceb', SIN: '#eba0ac',
  SIO: '#b4befe', TFG: '#f2cdcd', TSR: '#74c7ec',
};
const MAIN_COLOR = '#cba6f7';
const EXTRA_COLORS = ['#f5e0dc', '#bac2de', '#9399b2', '#a6adc8'];

export function colorFor(list) {
  if (!list) return MAIN_COLOR;
  const code = ((list.title || '').trim().toUpperCase().match(/^[A-ZÑ0-9]+/) || [''])[0];
  if (SUBJECT_COLORS[code]) return SUBJECT_COLORS[code];
  if (list.main) return MAIN_COLOR;
  let h = 0;
  for (const ch of list.title || '') h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return EXTRA_COLORS[h % EXTRA_COLORS.length];
}

// «(45 min)», «(1 h)», «(1h 30 min)», «(1,5 h)», «(90m)»
const DURATION = /\(\s*(?:(\d+(?:[.,]\d+)?)\s*h(?:oras?|rs?)?\.?\s*(?:(\d+)\s*(?:min(?:utos?)?|m)?\.?)?|(\d+)\s*(?:min(?:utos?)?|m)\.?)\s*\)/i;

export function parseMinutes(title) {
  const m = DURATION.exec(title || '');
  if (!m) return 0;
  if (m[3]) return Number(m[3]);
  return Math.round(Number(m[1].replace(',', '.')) * 60) + Number(m[2] || 0);
}

export const isPriority = title => (title || '').includes('⚡');

export function cleanTitle(title) {
  return (title || '').replace(DURATION, ' ').replace(/⚡️?/g, ' ').replace(/\s+/g, ' ').trim();
}

export function fmtMinutes(min) {
  if (!min) return '';
  const h = Math.floor(min / 60), m = min % 60;
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}

const pad = n => String(n).padStart(2, '0');
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = toDate(s); d.setDate(d.getDate() + n); return ymd(d); };
export const diffDays = (a, b) => {
  const [ay, am, ad] = a.split('-').map(Number), [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86400000);
};
// La API guarda solo la fecha (la hora se descarta): usamos los 10 primeros caracteres.
export const dueDay = task => (task.due ? task.due.slice(0, 10) : null);
export const toDue = day => `${day}T00:00:00.000Z`;

export function fmtDate(day, today) {
  const n = diffDays(day, today);
  if (n === 0) return 'Hoy';
  if (n === 1) return 'Mañana';
  if (n === -1) return 'Ayer';
  const opts = { day: 'numeric', month: 'short' };
  if (n > 1 && n < 7) opts.weekday = 'short';
  if (day.slice(0, 4) !== today.slice(0, 4)) opts.year = 'numeric';
  return toDate(day).toLocaleDateString('es-ES', opts).replace(',', '');
}

export function fmtDayHeading(day, today) {
  const long = toDate(day).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'short' }).replace(',', '');
  const n = diffDays(day, today);
  const text = n === 0 ? `Hoy · ${long}` : n === 1 ? `Mañana · ${long}` : long;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Lista principal primero; el resto por orden alfabético.
export function sortLists(lists, mainId) {
  const main = lists.find(l => l.id === mainId) || lists[0];
  return lists
    .map(l => ({ ...l, main: l === main }))
    .sort((a, b) => (b.main - a.main) || a.title.localeCompare(b.title, 'es'));
}

const byPos = (a, b) => {
  const x = a.position || '', y = b.position || '';
  return x < y ? -1 : x > y ? 1 : 0;
};

export const VIEWS = ['today', 'week', 'subjects', 'nodate'];

/**
 * Devuelve { groups, count, minutes }.
 * Cada grupo: { key, title, listId?, overdue?, minutes, rows }.
 * Cada fila: { task, children, parentTitle? }.
 */
export function buildView(view, tasks, lists, today, opts = {}) {
  const listIdx = new Map(lists.map((l, i) => [l.id, i]));
  const byId = new Map(tasks.map(t => [t.id, t]));
  const kids = new Map();
  const tops = [];
  for (const t of tasks) {
    if (t.parent && byId.has(t.parent)) {
      if (!kids.has(t.parent)) kids.set(t.parent, []);
      kids.get(t.parent).push(t);
    } else tops.push(t);
  }
  for (const k of kids.values()) k.sort(byPos);

  const end = addDays(today, 6);
  const match = t => {
    const d = dueDay(t);
    if (view === 'today') return !!d && d <= today;
    if (view === 'week') return !!d && d >= today && d <= end;
    if (view === 'nodate') return !d;
    return true;
  };
  const pr = !!opts.onlyPriority;

  const rows = [];
  for (const t of tops) {
    const ch = kids.get(t.id) || [];
    const tp = isPriority(t.title);
    if (match(t)) {
      if (pr && !tp && !ch.some(c => isPriority(c.title))) continue;
      rows.push({ task: t, children: pr && !tp ? ch.filter(c => isPriority(c.title)) : ch });
    } else if (view !== 'nodate') {
      // Subtarea con fecha propia cuyo padre no entra en la vista: va suelta.
      for (const c of ch) {
        if (match(c) && (!pr || tp || isPriority(c.title))) rows.push({ task: c, children: [], parentTitle: t.title });
      }
    }
  }

  const cmpList = (a, b) => (listIdx.get(a.task.listId) - listIdx.get(b.task.listId)) || byPos(a.task, b.task);
  const cmpDue = (a, b) => {
    const x = dueDay(a.task), y = dueDay(b.task);
    return x < y ? -1 : x > y ? 1 : cmpList(a, b);
  };

  let groups = [];
  if (view === 'today') {
    groups = [
      { key: 'overdue', title: 'Atrasadas', overdue: true, rows: rows.filter(r => dueDay(r.task) < today).sort(cmpDue) },
      { key: 'today', title: 'Hoy', rows: rows.filter(r => dueDay(r.task) === today).sort(cmpList) },
    ];
  } else if (view === 'week') {
    for (let i = 0; i < 7; i++) {
      const day = addDays(today, i);
      groups.push({ key: day, title: fmtDayHeading(day, today), rows: rows.filter(r => dueDay(r.task) === day).sort(cmpList) });
    }
  } else {
    groups = lists.map(l => ({
      key: l.id, title: l.title, listId: l.id,
      rows: rows.filter(r => r.task.listId === l.id).sort(view === 'subjects' ? byPosRow : cmpList),
    }));
  }
  groups = groups.filter(g => g.rows.length);
  for (const g of groups) g.minutes = g.rows.reduce((s, r) => s + rowMinutes(r), 0);
  return {
    groups,
    count: groups.reduce((s, g) => s + g.rows.length, 0),
    minutes: groups.reduce((s, g) => s + g.minutes, 0),
  };
}

const byPosRow = (a, b) => byPos(a.task, b.task);

// Minutos de una fila: los del propio título o, si no tiene, la suma de sus subtareas.
export function rowMinutes(row) {
  return parseMinutes(row.task.title) || (row.children || []).reduce((s, c) => s + parseMinutes(c.title), 0);
}
