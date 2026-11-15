import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMinutes, cleanTitle, isPriority, fmtMinutes, addDays, diffDays, fmtDate,
  buildView, sortLists, colorFor, toDue, SUBJECT_COLORS,
} from '../site/logic.js';
import { createDemoBackend } from '../site/demo.js';

const TODAY = '2026-11-15';

test('parseMinutes entiende los formatos habituales', () => {
  assert.equal(parseMinutes('Leer tema (45 min)'), 45);
  assert.equal(parseMinutes('X (45min)'), 45);
  assert.equal(parseMinutes('X (1 h)'), 60);
  assert.equal(parseMinutes('X (1h 30 min)'), 90);
  assert.equal(parseMinutes('X (1,5 h)'), 90);
  assert.equal(parseMinutes('X (2 horas)'), 120);
  assert.equal(parseMinutes('X (90m)'), 90);
  assert.equal(parseMinutes('Tema (2) sin duración'), 0);
  assert.equal(parseMinutes('Sin nada'), 0);
  assert.equal(parseMinutes(undefined), 0);
});

test('cleanTitle quita duración y rayo; isPriority lo detecta', () => {
  assert.equal(cleanTitle('⚡ Entrega OpenMP (2 h)'), 'Entrega OpenMP');
  assert.equal(cleanTitle('Preparar ⚡️ exposición (45 min)'), 'Preparar exposición');
  assert.equal(isPriority('⚡ a'), true);
  assert.equal(isPriority('a'), false);
});

test('formatos de minutos y fechas', () => {
  assert.equal(fmtMinutes(45), '45 min');
  assert.equal(fmtMinutes(60), '1 h');
  assert.equal(fmtMinutes(135), '2 h 15 min');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(diffDays('2026-11-18', TODAY), 3);
  assert.equal(fmtDate(TODAY, TODAY), 'Hoy');
  assert.equal(fmtDate('2026-11-16', TODAY), 'Mañana');
  assert.equal(fmtDate('2026-11-14', TODAY), 'Ayer');
});

test('colores fijos por asignatura y lista principal primero', () => {
  const lists = sortLists([{ id: 'b', title: 'TSR' }, { id: 'm', title: 'Mis tareas' }, { id: 'a', title: 'BDA' }], 'm');
  assert.deepEqual(lists.map(l => l.title), ['Mis tareas', 'BDA', 'TSR']);
  assert.equal(colorFor(lists[1]), SUBJECT_COLORS.BDA);
  assert.equal(colorFor({ title: 'bda - Bases de datos' }), SUBJECT_COLORS.BDA);
  assert.equal(colorFor(lists[0]), '#cba6f7');
  assert.equal(new Set(Object.values(SUBJECT_COLORS)).size, 11);
});

const lists = [{ id: 'M', title: 'Mis tareas', main: true }, { id: 'A', title: 'BDA' }];
const T = (id, title, off, extra = {}) => ({
  id, listId: 'A', title, position: id, status: 'needsAction',
  due: off === null ? undefined : toDue(addDays(TODAY, off)), ...extra,
});

test('vista Hoy: separa atrasadas y hoy, suma minutos', () => {
  const tasks = [T('1', 'a (30 min)', -2), T('2', 'b (45 min)', 0), T('3', 'c (1 h)', 0), T('4', 'd', 1), T('5', 'e', null)];
  const v = buildView('today', tasks, lists, TODAY);
  assert.deepEqual(v.groups.map(g => g.key), ['overdue', 'today']);
  assert.equal(v.groups[0].rows.length, 1);
  assert.equal(v.groups[0].minutes, 30);
  assert.equal(v.groups[1].minutes, 105);
  assert.equal(v.count, 3);
});

test('vista 7 días: de hoy a hoy+6, un grupo por día con total', () => {
  const tasks = [T('1', 'a', -1), T('2', 'b (20 min)', 0), T('3', 'c (40 min)', 6), T('4', 'd', 7), T('5', 'e (10 min)', 6)];
  const v = buildView('week', tasks, lists, TODAY);
  assert.deepEqual(v.groups.map(g => g.key), [TODAY, '2026-11-21']);
  assert.equal(v.groups[1].minutes, 50);
});

test('subtareas: anidadas bajo el padre, sueltas si solo ellas entran en la vista', () => {
  const tasks = [
    T('p', 'Padre', 5),
    T('c1', 'Hija hoy (30 min)', 0, { parent: 'p' }),
    T('c2', 'Hija sin fecha (15 min)', null, { parent: 'p' }),
  ];
  const today = buildView('today', tasks, lists, TODAY);
  assert.equal(today.count, 1);
  assert.equal(today.groups[0].rows[0].task.id, 'c1');
  assert.equal(today.groups[0].rows[0].parentTitle, 'Padre');

  const subj = buildView('subjects', tasks, lists, TODAY);
  assert.equal(subj.count, 1);
  assert.deepEqual(subj.groups[0].rows[0].children.map(c => c.id), ['c1', 'c2']);
  assert.equal(subj.groups[0].minutes, 45); // el padre no tiene duración: suma las hijas

  // Una subtarea sin fecha de un padre con fecha no aparece en «Sin fecha».
  assert.equal(buildView('nodate', tasks, lists, TODAY).count, 0);
});

test('minutos: si el padre tiene duración no se suman las hijas', () => {
  const tasks = [T('p', 'Padre (2 h)', 0), T('c', 'Hija (30 min)', null, { parent: 'p' })];
  assert.equal(buildView('today', tasks, lists, TODAY).minutes, 120);
});

test('filtro ⚡', () => {
  const tasks = [
    T('1', '⚡ urgente', 0), T('2', 'normal', 0),
    T('p', 'Padre', 0), T('c1', '⚡ hija', null, { parent: 'p' }), T('c2', 'otra', null, { parent: 'p' }),
  ];
  const v = buildView('today', tasks, lists, TODAY, { onlyPriority: true });
  assert.deepEqual(v.groups[0].rows.map(r => r.task.id), ['1', 'p']);
  assert.deepEqual(v.groups[0].rows[1].children.map(c => c.id), ['c1']);
});

test('backend demo: listar, crear, completar y cambiar fecha', () => {
  const be = createDemoBackend(TODAY);
  assert.equal(be.handle('GET', '/users/@me/lists?maxResults=100').body.items.length, 12);
  const created = be.handle('POST', '/lists/L-BDA/tasks', { title: 'nueva', due: toDue(TODAY) }).body;
  assert.equal(created.title, 'nueva');
  be.handle('PATCH', `/lists/L-BDA/tasks/${created.id}`, { due: null });
  be.handle('PATCH', `/lists/L-BDA/tasks/${created.id}`, { status: 'completed' });
  const open = be.handle('GET', '/lists/L-BDA/tasks?showCompleted=false').body.items;
  assert.equal(open.some(t => t.id === created.id), false);
  const t = be.tasks.find(x => x.id === created.id);
  assert.equal(t.due, undefined);
});
