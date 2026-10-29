// readyai#162 C3：triggered 後背景驗收＋狀態用語。以本機 CLI 替身執行，不連 origin。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCustomerPublishTools, createLocalPublishDeps } from '../dist/tools/customer-publish-tools.js';
import { ACCEPT_WORDING, classifyPublication } from '../dist/tools/publication-accept.js';

const origin = 'https://demo.example.com';
const digest = 'sha256:' + 'ab'.repeat(32);
const base = { stage: 'awaiting_raw_verification', content_verified: false, scope: 'pgc', app: 'my-preview', origin, languages: ['en', 'zh-TW'], candidate_digest: digest };

// CLI 替身：依 state.json 回應；argv 記到 argv.jsonl。
const CLI = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync('argv.jsonl', JSON.stringify(args) + '\\n');
const state = JSON.parse(fs.readFileSync('state.json', 'utf8'));
const action = args[2];
const id = args.includes('--publication-id') ? args[args.indexOf('--publication-id') + 1] : null;
const ok = data => { process.stdout.write(JSON.stringify({ ok: true, data }) + '\\n'); };
if (action === 'candidate') ok({ ...state.base, publication_id: null });
else if (action === 'status') {
  if (state.status === 'missing') { process.stdout.write(JSON.stringify({ ok:false, error:{ message:'none', error_class:'reconcile', retryable:false, hint:'h', details:{ code:'session_not_found' } } }) + '\\n'); process.exitCode = 3; }
  else ok({ ...state.base, publication_id: id, ...state.status });
}
else if (action === 'start' || action === 'resume') ok({ ...state.base, publication_id: id });
else if (action === 'accept') { process.stderr.write('accept progress\\n'); ok(state.accept ?? { publication_id: id, result: 'verified', content_verified: true }); }
`;

async function fixture(run, accept) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-accept-'));
  const oldPath = process.env.PATH;
  fs.mkdirSync(path.join(cwd, 'bin'));
  fs.writeFileSync(path.join(cwd, 'bin/readyai-project'), CLI, { mode: 0o700 });
  process.env.PATH = `${path.join(cwd, 'bin')}${path.delimiter}${oldPath}`;
  const setState = (s) => fs.writeFileSync(path.join(cwd, 'state.json'), JSON.stringify({ base, status: 'missing', ...s }));
  setState({});
  const config = { cwd, originBaseUrl: origin + '/', siteToken: 'x', appName: 'my-preview', languages: ['en', 'zh-TW'], confirmationId: 'confirm-1' };
  const tools = buildCustomerPublishTools(createLocalPublishDeps(config, undefined, accept));
  const call = async (name, params = {}) => (await tools.find(t => t.name === name).execute('call-1', params, undefined, undefined, {})).details;
  const dir = path.join(cwd, 'data/customer-publications');
  const argv = () => fs.existsSync(path.join(cwd, 'argv.jsonl')) ? fs.readFileSync(path.join(cwd, 'argv.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  try { await run({ cwd, dir, call, setState, argv }); }
  finally { process.env.PATH = oldPath; fs.rmSync(cwd, { recursive: true, force: true }); }
}

function fakeAccept({ alive = true } = {}) {
  const spawned = [];
  let pid = 5000;
  return { spawned, deps: { spawnRunner: (args, cwd) => { spawned.push({ args, cwd }); return ++pid; }, isAlive: () => alive } };
}
const mode = file => fs.statSync(file).mode & 0o777;

describe('publication accept（readyai#162 C3）', () => {
  it('triggered 後 spawn 一次 accept、帶正確參數、鎖檔 0600、回 C3 用語', async () => {
    const fake = fakeAccept();
    await fixture(async ({ dir, call }) => {
      const r = await call('publish_confirmed');
      assert.equal(r.status, 'triggered');
      assert.equal(r.acceptance, 'started');
      assert.match(r.message, /系統正在做上線驗收，完成後您問我就能看到結果/);
      assert.doesNotMatch(r.message, /會通知|主動通知您/);
      assert.equal(r.content_verified, false);
      assert.equal(fake.spawned.length, 1);
      const [, id, cliJson] = fake.spawned[0].args;
      assert.equal(id, r.publication_id);
      assert.deepEqual(JSON.parse(cliJson), ['preview', 'publication', 'accept', '--name', 'my-preview', '--expected-origin', origin,
        '--publication-id', r.publication_id, '--expected-candidate-digest', digest, '--json']);
      const lock = path.join(dir, `${r.publication_id}.accept.lock`);
      assert.equal(mode(lock), 0o600);
      assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, 5001);
    }, fake.deps);
  });

  it('同一 publication 重複 triggered（runner 還活著）不會重複 spawn', async () => {
    const fake = fakeAccept({ alive: true });
    await fixture(async ({ call, setState }) => {
      const first = await call('publish_confirmed');
      setState({ status: {} }); // 第二次走 status→resume
      const second = await call('publish_confirmed');
      assert.equal(second.status, 'triggered');
      assert.equal(second.publication_id, first.publication_id);
      assert.equal(second.acceptance, 'running');
      assert.equal(fake.spawned.length, 1);
    }, fake.deps);
  });

  it('已有結果檔不重跑；無結果且 runner 已死才補跑', async () => {
    const fake = fakeAccept({ alive: false });
    await fixture(async ({ dir, call, setState }) => {
      const first = await call('publish_confirmed');
      assert.equal(fake.spawned.length, 1);
      setState({ status: {} });
      // runner 已死、沒有結果、stage 仍 awaiting_raw_verification → 狀態查詢補跑
      const s = await call('publication_status');
      assert.equal(s.state, 'running');
      assert.equal(s.acceptance, 'started');
      assert.equal(fake.spawned.length, 2);
      // 寫入結果後：不再 spawn
      fs.writeFileSync(path.join(dir, `${first.publication_id}.accept.json`),
        JSON.stringify({ ok: true, publication_id: first.publication_id, result: 'failed', content_verified: false, error: { code: 'x', message: 'y' } }) + '\n', { mode: 0o600 });
      const again = await call('publish_confirmed');
      assert.equal(again.acceptance, 'finished');
      const s2 = await call('publication_status');
      assert.equal(s2.state, 'failed');
      assert.equal(fake.spawned.length, 2);
    }, fake.deps);
  });

  it('四種狀態用語：verified／running／expired_unverified／failed', async () => {
    const fake = fakeAccept({ alive: true });
    await fixture(async ({ dir, call, setState }) => {
      const { publication_id: id } = await call('publish_confirmed');
      // 執行中
      setState({ status: {} });
      let s = await call('publication_status');
      assert.deepEqual([s.state, s.message, s.content_verified], ['running', '正在做上線驗收', false]);
      // CLI status verified
      setState({ status: { stage: 'verified', content_verified: true } });
      s = await call('publication_status', { publication_id: id });
      assert.deepEqual([s.state, s.message, s.content_verified], ['verified', '已完成上線驗收', true]);
      // CLI status expired_unverified（W9 降級結案）
      setState({ status: { stage: 'expired_unverified', content_verified: false } });
      s = await call('publication_status');
      assert.equal(s.state, 'expired_unverified');
      assert.equal(s.message, '內容已更新到網站，但沒來得及完成完整驗收，已記錄由後勤追蹤');
      assert.equal(s.content_verified, false);
      // accept 結束且 failed
      fs.unlinkSync(path.join(dir, `${id}.accept.lock`));
      fs.writeFileSync(path.join(dir, `${id}.accept.json`), JSON.stringify({ ok: true, result: 'failed', content_verified: false }) + '\n', { mode: 0o600 });
      setState({ status: { stage: 'awaiting_raw_verification' } });
      s = await call('publication_status');
      assert.deepEqual([s.state, s.message], ['failed', '上線驗收沒有通過，已記錄由後勤追蹤']);
      for (const w of Object.values(ACCEPT_WORDING)) assert.doesNotMatch(w, /通知/);
    }, fake.deps);
  });

  it('superseded（被同站後續發布取代）→ 固定用語、content_verified=false、不補跑', async () => {
    const fake = fakeAccept({ alive: false });
    await fixture(async ({ call, setState }) => {
      await call('publish_confirmed');
      setState({ status: { stage: 'superseded', content_verified: false } });
      const s = await call('publication_status');
      assert.deepEqual([s.state, s.message, s.content_verified, s.stage], ['superseded', '這次的修改已被之後的發布涵蓋，以最新一次發布為準', false, 'superseded']);
      assert.equal(s.acceptance, undefined);
      assert.equal(fake.spawned.length, 1);
    }, fake.deps);
    // 即使 accept 結果寫 failed，CLI 終止 stage 仍優先
    assert.equal(classifyPublication({ ok: true, stage: 'superseded', content_verified: false }, { running: false, result: { ok: true, result: 'failed' } }), 'superseded');
    assert.equal(classifyPublication({ ok: true, stage: 'superseded', content_verified: false }, { running: true }), 'superseded');
  });

  it('content_verified 只信 CLI：accept 說 verified 但 status 不是 → failed；status 查不到才採信 accept', () => {
    const acc = { running: false, result: { ok: true, result: 'verified', content_verified: true } };
    assert.equal(classifyPublication({ ok: true, stage: 'awaiting_normal_verification', content_verified: false }, acc), 'failed');
    assert.equal(classifyPublication({ ok: false }, acc), 'verified');
    assert.equal(classifyPublication({ ok: true, stage: 'verified', content_verified: false }, { running: false }), 'unknown');
    assert.equal(classifyPublication({ ok: false }, { running: false, resultInvalid: true }), 'failed');
    assert.equal(classifyPublication({ ok: false }, { running: false, result: { ok: true, data: { result: 'expired_unverified', content_verified: false } } }), 'expired_unverified');
  });

  it('C1 JsonCommand 形狀 {ok, result:{result,…}}：verified／expired_unverified／failed／superseded 都正確分類', () => {
    const c1 = (inner) => ({ running: false, result: { ok: true, result: {
      publication_id: 'pgc-1', stage: 'verified', content_verified: false,
      phases: { raw: 'verified', end: 'done', normal: 'verified' }, evidence_dir: '/tmp/e', error: null, ...inner } } });
    const noStatus = { ok: false };
    const verified = c1({ result: 'verified', stage: 'verified', content_verified: true });
    assert.equal(classifyPublication(noStatus, verified), 'verified');
    // status 查得到且 verified 時一致
    assert.equal(classifyPublication({ ok: true, stage: 'verified', content_verified: true }, verified), 'verified');
    // status 查得到卻未 verified：前後不一致交後勤
    assert.equal(classifyPublication({ ok: true, stage: 'awaiting_normal_verification', content_verified: false }, verified), 'failed');
    // verified 但 content_verified 不是 true：不升格
    assert.equal(classifyPublication(noStatus, c1({ result: 'verified', content_verified: false })), 'failed');
    const expired = c1({ result: 'expired_unverified', stage: 'expired_unverified', content_verified: false,
      phases: { raw: 'skipped', end: 'skipped', normal: 'skipped' } });
    assert.equal(classifyPublication(noStatus, expired), 'expired_unverified');
    assert.equal(classifyPublication({ ok: true, stage: 'awaiting_raw_verification', content_verified: false }, expired), 'expired_unverified');
    const failed = c1({ result: 'failed', stage: 'awaiting_raw_verification', content_verified: false,
      phases: { raw: 'failed', end: 'skipped', normal: 'skipped' }, error: { code: 'raw_mismatch', message: 'x' } });
    assert.equal(classifyPublication(noStatus, failed), 'failed');
    const superseded = c1({ result: 'failed', stage: 'superseded', content_verified: false,
      phases: { raw: 'skipped', end: 'skipped', normal: 'skipped' }, error: { code: 'superseded', message: 'x' } });
    assert.equal(classifyPublication(noStatus, superseded), 'superseded');
    // ok:false（用法錯誤）一律 failed
    assert.equal(classifyPublication(noStatus, { running: false, result: { ok: false, error: { code: 'usage' } } }), 'failed');
    // 另兩種相容形狀仍有效
    assert.equal(classifyPublication(noStatus, { running: false, result: { ok: true, result: 'verified', content_verified: true } }), 'verified');
    assert.equal(classifyPublication(noStatus, { running: false, result: { ok: true, data: { result: 'expired_unverified', content_verified: false } } }), 'expired_unverified');
    // data 與 result 物件同時出現＝雙重權威，不採信
    assert.equal(classifyPublication(noStatus, { running: false, result: { ok: true, data: { result: 'verified', content_verified: true }, result: { result: 'verified', content_verified: true } } }), 'failed');
  });

  it('結果檔為 C1 JsonCommand 形狀（status 查不到）→ publication_status 依此分類', async () => {
    const fake = fakeAccept({ alive: false });
    await fixture(async ({ dir, call, setState }) => {
      const { publication_id: id } = await call('publish_confirmed');
      const file = path.join(dir, `${id}.accept.json`);
      const write = inner => fs.writeFileSync(file, 'progress line\n' + JSON.stringify({ ok: true, result: { publication_id: id, phases: {}, evidence_dir: null, error: null, ...inner } }) + '\n', { mode: 0o600 });
      setState({ status: 'missing' });
      write({ result: 'verified', stage: 'verified', content_verified: true });
      let s = await call('publication_status');
      assert.deepEqual([s.state, s.content_verified], ['verified', true]);
      fs.unlinkSync(file);
      write({ result: 'expired_unverified', stage: 'expired_unverified', content_verified: false });
      assert.equal((await call('publication_status')).state, 'expired_unverified');
      fs.unlinkSync(file);
      write({ result: 'failed', stage: 'awaiting_raw_verification', content_verified: false, error: { code: 'x', message: 'y' } });
      assert.equal((await call('publication_status')).state, 'failed');
      fs.unlinkSync(file);
      write({ result: 'failed', stage: 'superseded', content_verified: false });
      s = await call('publication_status');
      assert.deepEqual([s.state, s.content_verified], ['superseded', false]);
      assert.equal(fake.spawned.length, 1);
    }, fake.deps);
  });

  it('沒有任何發布紀錄 → 查不到，不亂猜', async () => {
    await fixture(async ({ call }) => {
      const s = await call('publication_status');
      assert.equal(s.ok, false);
      assert.equal(s.error, 'publication_not_found');
      assert.equal(s.content_verified, false);
    }, fakeAccept().deps);
  });

  it('真實 detached runner：結果檔與 log 皆 0600、跑完移除鎖檔', async () => {
    await fixture(async ({ dir, call, argv }) => {
      const r = await call('publish_confirmed');
      assert.equal(r.acceptance, 'started');
      const result = path.join(dir, `${r.publication_id}.accept.json`);
      const log = path.join(dir, `${r.publication_id}.accept.log`);
      const lock = path.join(dir, `${r.publication_id}.accept.lock`);
      for (let i = 0; i < 200 && (!fs.existsSync(result) || fs.existsSync(lock)); i++) await new Promise(res => setTimeout(res, 50));
      assert.equal(mode(result), 0o600);
      assert.equal(mode(log), 0o600);
      assert.equal(mode(dir), 0o700);
      assert.equal(fs.existsSync(lock), false);
      assert.match(fs.readFileSync(log, 'utf8'), /accept progress/);
      assert.equal(JSON.parse(fs.readFileSync(result, 'utf8').trim()).data.result, 'verified');
      assert.ok(argv().some(a => a[2] === 'accept'));
    }, {});
  });
});
