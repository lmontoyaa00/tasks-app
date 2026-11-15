import {
  buildView, parseMinutes, isPriority, cleanTitle, colorFor, fmtMinutes, fmtDate,
  ymd, addDays, dueDay, toDue, sortLists, VIEWS,
} from './logic.js';

const CFG = window.TASKS_CONFIG || {};
const DEMO = new URLSearchParams(location.search).has('demo');
const SCOPE = 'https://www.googleapis.com/auth/tasks';
const BASE = 'https://tasks.googleapis.com/tasks/v1';
const LS = { token: 'gt.token', cache: 'gt.cache', ui: 'gt.ui' };
const REFRESH_MS = 90_000;
const VIEW_TITLES = { today: 'Hoy y atrasadas', week: 'Próximos 7 días', subjects: 'Por asignatura', nodate: 'Sin fecha' };

const $ = s => document.querySelector(s);
const linkify = s => esc(s).replace(/https?:\/\/[^\s<]+/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const readJSON = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin espacio */ } };
const todayStr = () => ymd(new Date());

const state = { lists: [], tasks: [], at: 0, loaded: false };
const ui = Object.assign({ view: 'today', onlyPriority: false, collapsed: [], lastList: '' }, readJSON(LS.ui) || {});
if (!VIEWS.includes(ui.view)) ui.view = 'today';
let selected = null;
let loading = false, again = false, mutating = 0, epoch = 0, lastRefresh = 0;
let demo = null;

/* ---------- Autenticación (Google Identity Services, modelo de token) ---------- */

class AuthError extends Error {}

let gisPromise = null;
function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  gisPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = resolve;
    s.onerror = () => { gisPromise = null; reject(new Error('No se pudo cargar el acceso de Google. ¿Hay conexión?')); };
    document.head.append(s);
  });
  return gisPromise;
}

const auth = {
  pending: null,
  token() {
    const t = readJSON(LS.token);
    return t && t.exp > Date.now() + 15_000 ? t : null;
  },
  msLeft() {
    const t = readJSON(LS.token);
    return t ? t.exp - Date.now() : null;
  },
  clear() { localStorage.removeItem(LS.token); },
  request() {
    this.pending ||= loadGis().then(() => new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: CFG.clientId,
        scope: SCOPE,
        prompt: '',
        callback: r => {
          if (r.error) return reject(new Error(r.error_description || r.error));
          if (!google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE)) {
            return reject(new Error('Falta el permiso de Google Tasks: vuelve a entrar y marca la casilla.'));
          }
          writeJSON(LS.token, { access_token: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 });
          resolve();
        },
        error_callback: e => reject(new Error(
          e.type === 'popup_failed_to_open' ? 'El navegador bloqueó la ventana de Google. Permite las ventanas emergentes para este sitio.'
            : e.type === 'popup_closed' ? 'Se cerró la ventana de Google antes de terminar.'
              : (e.message || 'No se pudo iniciar sesión.'))),
      });
      client.requestAccessToken();
    })).finally(() => { this.pending = null; });
    return this.pending;
  },
};

// El modelo de token no tiene refresco silencioso: el token dura ~1 h y renovarlo abre
// un popup, que el navegador solo permite tras un gesto. Aprovechamos un clic o tecla
// del usuario cuando al token le quedan menos de 10 minutos.
let renewTried = 0;
function maybeRenew(ev) {
  if (DEMO || !CFG.clientId) return;
  if (ev.type === 'keydown' && (ev.target.closest?.('input, select, textarea') || ev.key === 'Escape')) return;
  const left = auth.msLeft();
  if (left === null || left > 10 * 60_000 || Date.now() - renewTried < 120_000) return;
  renewTried = Date.now();
  auth.request().then(() => { hideBanner(); refresh(); }).catch(() => {});
}

/* ---------- API ---------- */

async function api(method, path, body) {
  if (DEMO) {
    const r = demo.handle(method, path, body);
    if (r.status >= 400) throw new Error(r.body?.error?.message || `Error ${r.status}`);
    return structuredClone(r.body);
  }
  const t = auth.token();
  if (!t) throw new AuthError('Sesión caducada');
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${t.access_token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { auth.clear(); throw new AuthError('Sesión caducada'); }
  if (!res.ok) {
    let msg = `Error ${res.status}`;
    try { msg = (await res.json()).error?.message || msg; } catch { /* cuerpo no JSON */ }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

async function allPages(path) {
  const items = [];
  let pageToken = '';
  do {
    const r = await api('GET', path + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''));
    items.push(...(r.items || []));
    pageToken = r.nextPageToken || '';
  } while (pageToken);
  return items;
}

const taskPath = t => `/lists/${encodeURIComponent(t.listId)}/tasks/${encodeURIComponent(t.id)}`;
const norm = (t, listId) => ({ id: t.id, listId, title: t.title || '', notes: t.notes || '', due: t.due, parent: t.parent, position: t.position || '', status: t.status });

async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

async function refresh(manual = false) {
  if (loading) return;
  if (!DEMO && !auth.token()) { showExpired(); return; }
  loading = true; again = false;
  const startEpoch = epoch;
  $('#refreshBtn').classList.add('loading');
  try {
    const [rawLists, def] = await Promise.all([
      allPages('/users/@me/lists?maxResults=100'),
      api('GET', '/users/@me/lists/@default').catch(e => { if (e instanceof AuthError) throw e; return null; }),
    ]);
    const lists = sortLists(rawLists.map(l => ({ id: l.id, title: l.title || '(sin nombre)' })), def?.id);
    const perList = await Promise.all(lists.map(l =>
      allPages(`/lists/${encodeURIComponent(l.id)}/tasks?maxResults=100&showCompleted=false`)
        .then(items => items.map(t => norm(t, l.id)))));
    if (startEpoch !== epoch || mutating) { again = true; return; } // hubo cambios locales mientras tanto
    state.lists = lists;
    state.tasks = perList.flat().filter(t => t.status !== 'completed' && t.title.trim());
    state.at = Date.now();
    state.loaded = true;
    lastRefresh = Date.now();
    if (!DEMO) writeJSON(LS.cache, { lists: state.lists, tasks: state.tasks, at: state.at });
    hideBanner();
    render();
  } catch (e) {
    if (e instanceof AuthError) showExpired();
    else if (manual || !state.loaded) toast(`No se pudo actualizar: ${e.message}`, { error: true });
    setStatus(true);
  } finally {
    loading = false;
    $('#refreshBtn').classList.remove('loading');
    if (again) setTimeout(refresh, 400);
  }
}

// Ejecuta un cambio remoto ya aplicado en local; si falla, avisa y vuelve a cargar del servidor.
async function mutate(fn) {
  mutating++; epoch++;
  let ok = true;
  try { await fn(); } catch (e) {
    ok = false;
    state.tasks = state.tasks.filter(t => !t.pending);
    if (e instanceof AuthError) { showExpired(); toast('Sesión caducada: el cambio no se guardó.', { error: true }); }
    else toast(`No se pudo guardar: ${e.message}`, { error: true });
  } finally {
    mutating--;
    if (!ok) { render(); refresh(); }
  }
  return ok;
}

/* ---------- Acciones ---------- */

const taskById = id => state.tasks.find(t => t.id === id);

function completeTask(id) {
  const task = taskById(id);
  if (!task || task.pending) return;
  const kids = state.tasks.filter(t => t.parent === id && t.listId === task.listId);
  const gone = new Set([id, ...kids.map(k => k.id)]);
  const next = neighbourOf(id);
  state.tasks = state.tasks.filter(t => !gone.has(t.id));
  selected = next;
  render();
  const set = status => async () => {
    // Al completar: primero las subtareas; al deshacer: primero el padre.
    const order = status === 'completed' ? [kids, [task]] : [[task], kids];
    for (const batch of order) await pool(batch, 4, t => api('PATCH', taskPath(t), { status }));
  };
  mutate(set('completed'));
  const extra = kids.length ? ` (+${kids.length} subtarea${kids.length > 1 ? 's' : ''})` : '';
  toast(`Completada: ${cleanTitle(task.title) || task.title}${extra}`, {
    action: 'Deshacer',
    onAction: async () => { await mutate(set('needsAction')); refresh(); },
  });
}

function setDue(id, day) {
  const task = taskById(id);
  if (!task || (dueDay(task) || '') === (day || '')) return;
  task.due = day ? toDue(day) : undefined;
  render();
  mutate(() => api('PATCH', taskPath(task), { due: day ? toDue(day) : null }));
}

function moveOverdueToToday() {
  const today = todayStr();
  const overdue = state.tasks.filter(t => dueDay(t) && dueDay(t) < today && !t.pending);
  if (!overdue.length) return;
  if (!confirm(`¿Pasar ${overdue.length} tarea${overdue.length > 1 ? 's' : ''} atrasada${overdue.length > 1 ? 's' : ''} a hoy?`)) return;
  for (const t of overdue) t.due = toDue(today);
  render();
  mutate(() => pool(overdue, 4, t => api('PATCH', taskPath(t), { due: toDue(today) })))
    .then(ok => ok && toast(`${overdue.length} tarea${overdue.length > 1 ? 's' : ''} pasada${overdue.length > 1 ? 's' : ''} a hoy`));
}

function addTask(title, listId, day) {
  const temp = { id: `tmp-${Date.now()}`, listId, title, due: day ? toDue(day) : undefined, position: '', status: 'needsAction', pending: true };
  state.tasks.push(temp);
  render();
  mutate(async () => {
    const r = await api('POST', `/lists/${encodeURIComponent(listId)}/tasks`, { title, ...(day ? { due: toDue(day) } : {}) });
    Object.assign(temp, norm(r, listId));
    delete temp.pending;
    render();
  });
}

function toggleCollapsed(key) {
  const i = ui.collapsed.indexOf(key);
  if (i >= 0) ui.collapsed.splice(i, 1); else ui.collapsed.push(key);
  saveUi(); render();
}

function setView(view) {
  ui.view = view; saveUi();
  if (!$('#addTitle').value) {
    if (view === 'today') $('#addDate').value = todayStr();
    else if (view !== 'week') $('#addDate').value = '';
  }
  selected = null;
  render();
  window.scrollTo(0, 0);
}

function saveUi() {
  // Olvida plegados de tareas que ya no existen para que no crezca sin fin.
  if (state.loaded) {
    const ids = new Set(state.tasks.map(t => t.id));
    ui.collapsed = ui.collapsed.filter(k => k.startsWith('g:') || ids.has(k));
  }
  writeJSON(LS.ui, ui);
}

/* ---------- Pintado ---------- */

function rowHtml(row, today, sub) {
  const t = row.task, ch = row.children || [];
  const list = state.lists.find(l => l.id === t.listId);
  const color = colorFor(list);
  const day = dueDay(t);
  const mins = parseMinutes(t.title);
  const collapsed = ui.collapsed.includes(t.id);
  const title = cleanTitle(t.title) || t.title;
  const dateCls = !day ? 'none' : day < today ? 'overdue' : '';
  return `<div class="item">
    <div class="task${sub ? ' sub' : ''}${t.pending ? ' pending' : ''}${t.id === selected ? ' sel' : ''}" data-id="${esc(t.id)}">
      ${ch.length
    ? `<button class="chev${collapsed ? '' : ' open'}" data-act="toggle" aria-expanded="${!collapsed}" aria-label="Plegar o desplegar subtareas">›</button>`
    : '<span class="chev"></span>'}
      <button class="check" data-act="done" style="--c:${color}" aria-label="Completar: ${esc(title)}"></button>
      <div class="body">
        <div class="title">${row.parentTitle ? `<span class="crumb">${esc(cleanTitle(row.parentTitle))} ›</span> ` : ''}${esc(title)}</div>
        <div class="meta">
          ${isPriority(t.title) ? '<span class="chip bolt" title="Prioridad">⚡</span>' : ''}
          ${mins ? `<span class="chip">${fmtMinutes(mins)}</span>` : ''}
          ${t.notes ? '<span class="chip note" title="Tiene descripción">≡</span>' : ''}
          ${ch.length && collapsed ? `<span class="chip">${ch.length} subtarea${ch.length > 1 ? 's' : ''}</span>` : ''}
          <button class="chip date ${dateCls}" data-act="date" title="Cambiar fecha (d)">${day ? esc(fmtDate(day, today)) : '+ fecha'}</button>
          ${sub ? '' : `<span class="tag" style="--c:${color}">${esc(list?.title || '')}</span>`}
        </div>
        ${t.notes ? `<div class="notes">${linkify(t.notes.trim())}</div>` : ''}
      </div>
    </div>
    ${ch.length && !collapsed ? `<div class="children">${ch.map(c => rowHtml({ task: c }, today, true)).join('')}</div>` : ''}
  </div>`;
}

function render() {
  const today = todayStr();
  const opts = { onlyPriority: ui.onlyPriority };
  const v = buildView(ui.view, state.tasks, state.lists, today, opts);

  for (const b of document.querySelectorAll('#nav [data-view]')) {
    const name = b.dataset.view;
    b.classList.toggle('on', name === ui.view);
    b.querySelector('.count').textContent = (name === ui.view ? v : buildView(name, state.tasks, state.lists, today, opts)).count || '';
  }
  $('#viewTitle').textContent = VIEW_TITLES[ui.view];
  $('#summary').textContent = state.loaded
    ? [`${v.count} tarea${v.count === 1 ? '' : 's'}`, fmtMinutes(v.minutes), ui.onlyPriority ? 'solo ⚡' : ''].filter(Boolean).join(' · ')
    : '';
  $('#filterBtn').setAttribute('aria-pressed', String(ui.onlyPriority));
  const overdue = state.tasks.filter(t => dueDay(t) && dueDay(t) < today).length;
  const mv = $('#moveOverdue');
  mv.hidden = ui.view !== 'today' || !overdue;
  mv.textContent = `Atrasadas → hoy (${overdue})`;

  const sel = $('#addList');
  const sig = state.lists.map(l => l.id + l.title).join('|');
  if (sel.dataset.sig !== sig) {
    const keep = sel.value || ui.lastList;
    sel.innerHTML = state.lists.map(l => `<option value="${esc(l.id)}">${esc(l.title)}</option>`).join('');
    sel.dataset.sig = sig;
    if (state.lists.some(l => l.id === keep)) sel.value = keep;
  }

  $('#list').innerHTML = v.groups.length ? v.groups.map(g => {
    const key = `g:${ui.view}:${g.key}`;
    const collapsed = ui.collapsed.includes(key);
    const color = g.listId ? colorFor(state.lists.find(l => l.id === g.listId)) : g.overdue ? 'var(--red)' : '';
    return `<section class="group">
      <h2 class="ghead" data-group="${esc(key)}"${color ? ` style="--c:${color}"` : ''}>
        <span class="chev${collapsed ? '' : ' open'}">›</span>
        <span>${esc(g.title)}</span><span class="gcount">${g.rows.length}</span>
        ${g.minutes ? `<span class="gmin" title="Tiempo total estimado">${fmtMinutes(g.minutes)}</span>` : ''}
      </h2>
      ${collapsed ? '' : g.rows.map(r => rowHtml(r, today, false)).join('')}
    </section>`;
  }).join('') : `<p class="empty">${!state.loaded ? 'Cargando…' : ui.onlyPriority ? 'Ninguna tarea ⚡ en esta vista.' : 'Nada pendiente por aquí.'}</p>`;
  setStatus(false);
}

function setStatus(failed) {
  const at = state.at ? new Date(state.at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : '';
  $('#status').textContent = !at ? '' : failed ? `Sin conexión con Google · datos de las ${at}` : `Actualizado a las ${at}`;
}

function showBanner(html) { const b = $('#banner'); b.innerHTML = html; b.hidden = false; }
function hideBanner() { if (!DEMO) $('#banner').hidden = true; }
function showExpired() {
  if (!state.loaded) return showLogin('Tu sesión de Google ha caducado.');
  showBanner('<span>La sesión de Google ha caducado (dura 1 hora).</span><button data-act="relogin">Reconectar</button>');
}

let toastTimer = 0;
function toast(msg, { action, onAction, error } = {}) {
  const el = $('#toast');
  el.className = error ? 'error' : '';
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
  el.hidden = false;
  if (action) el.querySelector('button').onclick = () => { el.hidden = true; onAction(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 7000 : 4000);
}

/* ---------- Selección y teclado ---------- */

const taskEls = () => [...document.querySelectorAll('#list .task:not(.pending)')];

function select(id, scroll) {
  selected = id;
  for (const el of document.querySelectorAll('#list .task.sel')) el.classList.remove('sel');
  const el = id && document.querySelector(`#list .task[data-id="${CSS.escape(id)}"]`);
  if (el) { el.classList.add('sel'); if (scroll) el.scrollIntoView({ block: 'nearest' }); }
}

function move(delta) {
  const els = taskEls();
  if (!els.length) return;
  const i = els.findIndex(e => e.dataset.id === selected);
  const j = i < 0 ? (delta > 0 ? 0 : els.length - 1) : Math.max(0, Math.min(els.length - 1, i + delta));
  select(els[j].dataset.id, true);
}

// Tarea que queda seleccionada tras completar `id`: la siguiente fuera de su bloque, o la anterior.
function neighbourOf(id) {
  const els = taskEls();
  const i = els.findIndex(e => e.dataset.id === id);
  if (i < 0) return selected === id ? null : selected;
  const item = els[i].closest('.item');
  const after = els.slice(i + 1).find(e => !item.contains(e));
  return (after || els[i - 1])?.dataset.id || null;
}

/* ---------- Diálogo de fecha ---------- */

let dateTarget = null;
function openDateDialog(id) {
  const t = taskById(id);
  if (!t || t.pending) return;
  dateTarget = id;
  const today = todayStr();
  const dow = new Date().getDay();
  const quick = [
    ['Hoy', today], ['Mañana', addDays(today, 1)],
    ['Próximo lunes', addDays(today, ((8 - dow) % 7) || 7)], ['En una semana', addDays(today, 7)],
    ['Quitar fecha', ''],
  ];
  $('#dateTask').textContent = cleanTitle(t.title) || t.title;
  $('#dateQuick').innerHTML = quick.map(([label, d]) => `<button type="button" data-day="${d}">${label}</button>`).join('');
  $('#dateInput').value = dueDay(t) || '';
  $('#dateDlg').showModal();
}
function closeDateDialog(day) {
  $('#dateDlg').close();
  if (day !== undefined && dateTarget) setDue(dateTarget, day);
  dateTarget = null;
}

/* ---------- Eventos ---------- */

function bind() {
  $('#nav').addEventListener('click', e => {
    const b = e.target.closest('[data-view]');
    if (b) setView(b.dataset.view);
  });

  $('#list').addEventListener('click', e => {
    const head = e.target.closest('.ghead');
    if (head) return toggleCollapsed(head.dataset.group);
    const el = e.target.closest('.task');
    if (!el) return;
    const id = el.dataset.id;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'done') return completeTask(id);
    // Pulsar una tarea la enfoca y muestra su descripción; pulsarla otra vez la cierra.
    if (!act && id === selected) { if (!e.target.closest('.notes')) select(null); return; }
    select(id);
    if (act === 'toggle') toggleCollapsed(id);
    else if (act === 'date') openDateDialog(id);
  });

  $('#add').addEventListener('submit', e => {
    e.preventDefault();
    const title = $('#addTitle').value.trim();
    const listId = $('#addList').value;
    if (!title || !listId) return;
    ui.lastList = listId; saveUi();
    addTask(title, listId, $('#addDate').value);
    $('#addTitle').value = '';
    $('#add').classList.remove('filled');
    $('#addTitle').focus();
  });
  $('#addTitle').addEventListener('input', e => $('#add').classList.toggle('filled', !!e.target.value));

  $('#filterBtn').onclick = () => { ui.onlyPriority = !ui.onlyPriority; saveUi(); render(); };
  $('#refreshBtn').onclick = () => refresh(true);
  $('#moveOverdue').onclick = moveOverdueToToday;
  $('#logoutBtn').onclick = () => {
    if (DEMO) { location.href = location.pathname; return; }
    if (!confirm('¿Cerrar sesión en este dispositivo?')) return;
    auth.clear(); localStorage.removeItem(LS.cache);
    location.reload();
  };
  $('#loginBtn').onclick = login;
  $('#banner').addEventListener('click', e => { if (e.target.dataset.act === 'relogin') login(); });

  $('#dateQuick').addEventListener('click', e => { const b = e.target.closest('[data-day]'); if (b) closeDateDialog(b.dataset.day); });
  $('#dateSave').onclick = () => closeDateDialog($('#dateInput').value);
  $('#dateCancel').onclick = () => closeDateDialog();
  $('#dateInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); closeDateDialog($('#dateInput').value); } });
  $('#dateDlg').addEventListener('click', e => { if (e.target === e.currentTarget) closeDateDialog(); });

  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || $('#app').hidden || $('#dateDlg').open) return;
    if (e.target.closest('input, select, textarea')) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const handlers = {
      n: () => { $('#addTitle').focus(); window.scrollTo(0, 0); },
      j: () => move(1), ArrowDown: () => move(1),
      k: () => move(-1), ArrowUp: () => move(-1),
      x: () => selected && completeTask(selected),
      Escape: () => select(null),
      r: () => refresh(true),
      f: () => $('#filterBtn').click(),
      d: () => selected && openDateDialog(selected),
      Enter: () => {
        const el = selected && document.querySelector(`#list .task[data-id="${CSS.escape(selected)}"] .chev[data-act]`);
        if (el) toggleCollapsed(selected);
      },
      1: () => setView('today'), 2: () => setView('week'), 3: () => setView('subjects'), 4: () => setView('nodate'),
    };
    if (handlers[k] && !(k === 'Enter' && e.target.closest('button'))) { e.preventDefault(); handlers[k](); }
  });

  document.addEventListener('pointerdown', maybeRenew, true);
  document.addEventListener('keydown', maybeRenew, true);

  const onReturn = () => { if (!document.hidden && !$('#app').hidden && Date.now() - lastRefresh > 5000) refresh(); };
  document.addEventListener('visibilitychange', onReturn);
  window.addEventListener('focus', onReturn);
  window.addEventListener('online', onReturn);
  setInterval(() => { if (!document.hidden && !$('#app').hidden) refresh(); }, REFRESH_MS);
}

/* ---------- Arranque ---------- */

function showLogin(msg) {
  $('#app').hidden = true;
  $('#login').hidden = false;
  if (msg) $('#loginMsg').textContent = msg;
}
function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  if (ui.view === 'today') $('#addDate').value = todayStr();
  render();
}

async function login() {
  $('#loginErr').textContent = '';
  try {
    await auth.request();
    hideBanner();
    showApp();
    refresh(true);
  } catch (e) {
    $('#loginErr').textContent = e.message;
    if (!$('#app').hidden) toast(e.message, { error: true });
  }
}

async function start() {
  bind();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (DEMO) {
    const { createDemoBackend } = await import('./demo.js');
    demo = createDemoBackend(todayStr());
    showApp();
    showBanner('<span>Modo demo: datos de ejemplo, nada se guarda.</span>');
    return refresh();
  }
  if (!CFG.clientId) {
    showLogin('Falta configurar el ID de cliente de Google en config.js.');
    $('#loginBtn').hidden = true;
    return;
  }
  loadGis().catch(() => {});
  const cache = readJSON(LS.cache);
  if (cache?.lists && cache?.tasks) Object.assign(state, cache, { loaded: true });
  if (auth.token()) { showApp(); refresh(); }
  else if (state.loaded) { showApp(); showExpired(); }
  else showLogin();
}

start();
