import { test, assert, describe } from 'vitest';
import type { PlanOutcome, Task } from '@atlas/core';
import { areaOf, metricsForAsk, metricsForPlan, taskMetrics } from '../src/atlas/statsRecord';

const plan = (outcomes: PlanOutcome['outcomes'], extra: Partial<PlanOutcome> = {}): PlanOutcome => ({
  ok: outcomes.every((o) => o.ok),
  ran: outcomes.filter((o) => o.ok).length,
  outcomes,
  aborted: false,
  ...extra,
});

const as = (m: [string, number][]) => Object.fromEntries(m);

describe('what is counted from an outcome', () => {
  test('areas come from the skill id alone', () => {
    assert.equal(areaOf('files.createFolder'), 'area.files');
    assert.equal(areaOf('system.endProcess'), 'area.system');
    assert.equal(areaOf('web.search'), 'area.web');
    assert.equal(areaOf('apps.launch'), 'area.apps');
    assert.equal(areaOf('git.commit'), 'area.dev');
    assert.equal(areaOf('input.click'), 'area.input');
    assert.equal(areaOf('something.unheardOf'), 'area.other');
  });

  test('done, failed and declined steps are told apart', () => {
    const m = as(
      metricsForPlan(
        plan([
          { skill: 'files.move', ok: true },
          { skill: 'files.delete', ok: false, skipped: true },
          { skill: 'system.endProcess', ok: false, error: 'nope' },
        ]),
      ),
    );
    assert.deepEqual(m, { 'actions.done': 1, 'area.files': 1, 'actions.declined': 1, 'actions.failed': 1 });
  });

  test('a halted plan counts as stopped, not as failed steps', () => {
    const m = as(metricsForPlan(plan([{ skill: 'files.move', ok: false, error: 'halted' }], { halted: true, aborted: true })));
    assert.deepEqual(m, { 'actions.halted': 1 });
  });

  test('a typed message is counted, and who answered is recorded', () => {
    assert.deepEqual(as(metricsForAsk({ ok: true, mode: 'chat', text: 'hi', via: 'model' })), {
      'chat.messages_sent': 1,
      'chat.replies_model': 1,
    });
    assert.deepEqual(as(metricsForAsk({ ok: true, mode: 'chat', text: 'hi' })), {
      'chat.messages_sent': 1,
      'chat.replies_atlas': 1,
    });
    assert.deepEqual(as(metricsForAsk({ ok: false, mode: 'chat', error: 'offline' })), { 'chat.messages_sent': 1 });
    assert.deepEqual(as(metricsForAsk({ ok: false, mode: 'halted' })), { 'chat.messages_sent': 1, 'actions.halted': 1 });
  });

  test('nothing in what is recorded can carry content', () => {
    const all = [
      ...metricsForAsk({ ok: true, mode: 'chat', text: 'my secret sentence', via: 'model' }),
      ...metricsForPlan(plan([{ skill: 'files.move', ok: true, message: 'moved D:\\Private\\x.txt' }])),
    ];
    for (const [name, n] of all) {
      assert.match(name, /^[a-z]+\.[a-z_]+$/);
      assert.isNumber(n);
    }
  });

  test('tasks are counted when they newly end, and not at startup', () => {
    const t = (id: string, status: Task['status']) => ({ id, status }) as Task;
    assert.deepEqual(taskMetrics(null, [t('a', 'done')]), []);
    const before = new Map<string, Task['status']>([
      ['a', 'running'],
      ['b', 'done'],
    ]);
    const m = as(taskMetrics(before, [t('a', 'done'), t('b', 'done'), t('c', 'failed'), t('d', 'cancelled')]));
    assert.deepEqual(m, { 'tasks.completed': 1, 'tasks.failed': 1, 'tasks.cancelled': 1 });
  });
});
