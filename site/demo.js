// Backend falso en memoria con la misma forma que la Google Tasks API.
// Se usa con ?demo y en las pruebas automáticas. No depende del DOM.
import { addDays, toDue } from './logic.js';

export function createDemoBackend(today) {
  const names = ['Mis tareas', 'BDA', 'COP', 'CPA', 'DBD', 'FSO', 'MNE', 'SIE', 'SIN', 'SIO', 'TFG', 'TSR'];
  const lists = names.map((title, i) => ({ id: i ? `L-${title}` : 'L-main', title }));
  const tasks = [];
  let seq = 0;
  const add = (list, title, offset, parent) => {
    const id = `t${++seq}`;
    const t = { id, listId: list === 'main' ? 'L-main' : `L-${list}`, title, status: 'needsAction', position: String(1e6 + seq).padStart(20, '0') };
    if (offset !== null && offset !== undefined) t.due = toDue(addDays(today, offset));
    if (parent) t.parent = parent;
    tasks.push(t);
    return id;
  };

  add('main', 'Renovar abono transporte', -3);
  add('main', 'Comprar cartucho impresora (15 min)', 0);
  add('main', 'Pedir cita médico', null);
  const p1 = add('BDA', '⚡ Práctica 2: consultas SQL', -1);
  add('BDA', 'Ejercicios 1-4 (45 min)', null, p1);
  add('BDA', 'Ejercicios 5-8 (45 min)', null, p1);
  add('BDA', 'Memoria (30 min)', 2, p1);
  add('BDA', 'Repasar tema 3 (1 h)', 3);
  add('COP', 'Boletín de problemas 2 (1h 30 min)', 0);
  add('CPA', '⚡ Entrega OpenMP (2 h)', 0);
  add('CPA', 'Leer transparencias MPI (40 min)', 4);
  const p2 = add('DBD', 'Diseño conceptual del proyecto', 5);
  add('DBD', 'Diagrama ER (1 h)', 1, p2);
  add('DBD', 'Paso a relacional (45 min)', null, p2);
  add('FSO', 'Test autoevaluación tema 4 (20 min)', -2);
  add('MNE', 'Resumen capítulo 6 (50 min)', 1);
  add('SIE', 'Preparar exposición ⚡ (1,5 h)', 2);
  add('SIN', 'Práctica búsqueda A* (2 h)', 6);
  add('SIO', 'Caso de estudio ERP', null);
  const p3 = add('TFG', 'Capítulo 2: estado del arte', null);
  add('TFG', 'Buscar 10 referencias (1 h)', null, p3);
  add('TFG', '⚡ Escribir borrador (3 h)', null, p3);
  add('TFG', 'Reunión con el tutor (30 min)', 3);
  add('TSR', 'Laboratorio ZeroMQ (1 h 15 min)', 0);
  add('TSR', 'Cuestionario tema 5 (25 min)', 12);

  const json = (status, body) => ({ status, body });
  const pub = t => { const { listId, ...rest } = t; return rest; };

  function handle(method, pathWithQuery, body) {
    const [path, query = ''] = pathWithQuery.split('?');
    const q = new URLSearchParams(query);
    let m;
    if (method === 'GET' && path === '/users/@me/lists') return json(200, { items: lists });
    if (method === 'GET' && path === '/users/@me/lists/@default') return json(200, lists[0]);
    if ((m = path.match(/^\/lists\/([^/]+)\/tasks$/))) {
      const listId = decodeURIComponent(m[1]);
      if (!lists.some(l => l.id === listId)) return json(404, { error: { message: 'Lista no encontrada' } });
      if (method === 'GET') {
        const hideDone = q.get('showCompleted') === 'false';
        return json(200, { items: tasks.filter(t => t.listId === listId && !(hideDone && t.status === 'completed')).map(pub) });
      }
      if (method === 'POST') {
        const t = { id: `t${++seq}`, listId, status: 'needsAction', position: String(1e6 - seq).padStart(20, '0'), ...body }; // las nuevas van arriba
        if (q.get('parent')) t.parent = q.get('parent');
        tasks.push(t);
        return json(200, pub(t));
      }
    }
    if (method === 'PATCH' && (m = path.match(/^\/lists\/([^/]+)\/tasks\/([^/]+)$/))) {
      const t = tasks.find(x => x.listId === decodeURIComponent(m[1]) && x.id === decodeURIComponent(m[2]));
      if (!t) return json(404, { error: { message: 'Tarea no encontrada' } });
      for (const [k, v] of Object.entries(body || {})) {
        if (v === null) delete t[k]; else t[k] = v;
      }
      return json(200, pub(t));
    }
    return json(404, { error: { message: `Ruta no soportada: ${method} ${path}` } });
  }

  return { handle, lists, tasks };
}
