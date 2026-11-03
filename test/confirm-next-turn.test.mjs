// W36R6：客戶說「請幫我發布，發布前先讓我看會發布哪些東西」，agent 在同一輪 check_only 後直接發布（r024b）。
// 技能已規定 check_only 後要停下、等對方下一則訊息明確同意；改由工具硬性拒絕同一輪的發布。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomerPublishTools, checkOnlyInCurrentTurn } from '../dist/tools/customer-publish-tools.js';

const user = (text) => ({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } });
const call = (args) => ({ type: 'message', message: { role: 'assistant', content: [
  { type: 'toolCall', id: 'c' + Math.random(), name: 'publish_confirmed', arguments: args }] } });
const result = (status) => ({ type: 'message', message: { role: 'toolResult', toolName: 'publish_confirmed',
  content: [{ type: 'text', text: JSON.stringify({ ok: true, status }) }] } });
const guard = { type: 'custom_message', customType: 'readyai_promise_guard', content: 'x' };
const text = (t) => ({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });

describe('checkOnlyInCurrentTurn', () => {
  it('同一輪先 check_only 再發布＝true（r024b）', () => {
    const entries = [user('你好'), call({ check_only: true }), result('pending_confirmation'), text('範圍如下…'),
      user('請幫我發布，發布前先讓我看會發布哪些東西。'), call({ check_only: true }), result('pending_confirmation'),
      call({ confirmation_id: 'x' })];
    assert.equal(checkOnlyInCurrentTurn(entries), true);
  });
  it('上一輪列出範圍、這一輪客戶同意後發布＝false', () => {
    const entries = [user('發布前先讓我看'), call({ check_only: true }), result('pending_confirmation'), text('範圍如下…'),
      user('確認發布。'), call({ confirmation_id: 'x' })];
    assert.equal(checkOnlyInCurrentTurn(entries), false);
  });
  it('隱藏的 guard 指示不算客戶訊息', () => {
    const entries = [user('請幫我發布'), call({ check_only: true }), result('pending_confirmation'), guard,
      call({ confirmation_id: 'x' })];
    assert.equal(checkOnlyInCurrentTurn(entries), true);
  });
  it('沒有紀錄時不擋', () => {
    assert.equal(checkOnlyInCurrentTurn([]), false);
    assert.equal(checkOnlyInCurrentTurn(undefined), false);
  });
});

describe('publish_confirmed 同一輪 check_only 後拒絕發布', () => {
  const deps = (calls) => ({ publish: async (input) => { calls.push(input); return { ok: true, status: input.check_only ? 'pending_confirmation' : 'triggered' }; } });
  const ctx = (entries) => ({ sessionManager: { getBranch: () => entries } });
  const sameTurn = [user('請幫我發布，發布前先讓我看'), call({ check_only: true }), result('pending_confirmation'), call({ confirmation_id: 'c-1' })];

  it('拒絕並要求先列給對方、等下一則訊息', async () => {
    const calls = [];
    const [tool] = buildCustomerPublishTools(deps(calls));
    const r = await tool.execute('t1', { confirmation_id: 'c-1' }, undefined, undefined, ctx(sameTurn));
    assert.equal(r.details.ok, false);
    assert.equal(r.details.details.code, 'confirm_next_turn');
    assert.match(r.details.error, /下一則訊息/);
    assert.deepEqual(calls, []);
  });
  it('check_only 本身照常', async () => {
    const calls = [];
    const [tool] = buildCustomerPublishTools(deps(calls));
    const r = await tool.execute('t1', { check_only: true }, undefined, undefined, ctx(sameTurn));
    assert.equal(r.details.status, 'pending_confirmation');
  });
  it('恢復既有 publication（publication_id）不擋', async () => {
    const calls = [];
    const [tool] = buildCustomerPublishTools(deps(calls));
    const r = await tool.execute('t1', { publication_id: 'pgc-' + 'a'.repeat(64) }, undefined, undefined, ctx(sameTurn));
    assert.equal(r.details.status, 'triggered');
  });
  it('下一輪客戶同意後照常發布', async () => {
    const calls = [];
    const [tool] = buildCustomerPublishTools(deps(calls));
    const entries = [...sameTurn.slice(0, 3), text('範圍如下…'), user('確認發布。'), call({ confirmation_id: 'c-1' })];
    const r = await tool.execute('t1', { confirmation_id: 'c-1' }, undefined, undefined, ctx(entries));
    assert.equal(r.details.status, 'triggered');
  });
});

describe('publish_confirmed 對方還沒看過範圍時拒絕發布', () => {
  const deps = (calls) => ({ publish: async (input) => { calls.push(input); return { ok: true, status: 'triggered' }; } });
  const ctx = (entries) => ({ sessionManager: { getBranch: () => entries } });

  it('從沒查過範圍就發布（例如換新對話後直接說確認發布）＝拒絕', async () => {
    const calls = [];
    const [tool] = buildCustomerPublishTools(deps(calls));
    const r = await tool.execute('t1', { confirmation_id: 'c-1' }, undefined, undefined, ctx([user('確認發布'), call({ confirmation_id: 'c-1' })]));
    assert.equal(r.details.details.code, 'confirm_first');
    assert.match(r.details.error, /check_only/);
    assert.deepEqual(calls, []);
  });
  it('範圍是在對方最後一則訊息之前查的＝照常發布', async () => {
    const calls = [];
    const [tool] = buildCustomerPublishTools(deps(calls));
    const entries = [user('先讓我看'), call({ check_only: true }), result('pending_confirmation'), text('範圍如下…'), user('確認發布'), call({ confirmation_id: 'c-1' })];
    const r = await tool.execute('t1', { confirmation_id: 'c-1' }, undefined, undefined, ctx(entries));
    assert.equal(r.details.status, 'triggered');
  });
});
