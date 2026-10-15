// 以本機 CLI fixture 執行真 subprocess；不連 origin、不改任何站台。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCustomerPublishTools, createLocalPublishDeps } from '../dist/tools/customer-publish-tools.js';

const origin = 'https://demo.example.com';
const publicationId = 'pgc-confirmed-1';
const evidence = {
  publication_id: publicationId, stage: 'awaiting_browser', content_verified: false,
  scope: 'pgc', app: 'my-preview', origin, languages: ['en', 'zh-TW'], candidate_digest: 'sha256:' + 'ab'.repeat(32),
};

async function fixture(run, { confirmationId = 'customer-confirmation-42', ...extra } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'customer-publication-'));
  const oldPath = process.env.PATH;
  fs.mkdirSync(path.join(cwd, 'bin'));
  fs.mkdirSync(path.join(cwd, 'data'));
  const meta = JSON.stringify({ keep: true, origin_source_version: { source_lng: 'en', content_sha256: 'before' } });
  fs.writeFileSync(path.join(cwd, 'data/preview-meta.json'), meta);
  const executable = path.join(cwd, 'bin/readyai-project');
  fs.writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync('argv.jsonl', JSON.stringify(args) + '\\n');
const response = JSON.parse(fs.readFileSync('response.json', 'utf8'));
const id = args[args.indexOf('--publication-id') + 1];
const action = args[2];
if (action === 'start' && !args.includes('--dry-run')) {
  const stateDir = 'data/customer-publications';
  const records = fs.readdirSync(stateDir).filter(name => name.endsWith('.json')).map(name => JSON.parse(fs.readFileSync(stateDir + '/' + name, 'utf8')));
  if (!records.some(record => record.publication_id === id)) throw new Error('Mapping must be durable before start');
}
const selected = args.includes('--dry-run') ? response.dryRun : action === 'status' ? (response.status || response) : response;
const out = selected.stdout.replaceAll('PUBLICATION_ID', id);
process.stdout.write(out);
process.stderr.write(response.stderr || '');
process.exitCode = selected.exitCode;
`, { mode: 0o700 });
  process.env.PATH = `${path.join(cwd, 'bin')}${path.delimiter}${oldPath}`;
  const config = {
    cwd, originBaseUrl: origin, siteToken: 'never-send-me', appName: 'my-preview',
    languages: ['en', 'zh-TW'], confirmationId,
    fetch: async () => { throw new Error('Tool must not fetch/audit origin'); }, ...extra,
  };
  const tool = () => buildCustomerPublishTools(createLocalPublishDeps(config))[0];
  const respond = (body, exitCode = 0, prefix = 'human progress\n', { digest = 'sha256:' + 'ab'.repeat(32), status } = {}) => {
    fs.writeFileSync(path.join(cwd, 'response.json'), JSON.stringify({
      stdout: `${prefix}${typeof body === 'string' ? body : JSON.stringify(body)}\n\n`, exitCode,
      stderr: 'upstream private output must not escape',
      dryRun: { stdout: JSON.stringify({ok:true,data:{candidate_digest:digest}}) + '\n', exitCode: 0 },
      status: status ? { stdout: JSON.stringify(status) + '\n', exitCode: status.ok ? 0 : 3 } : undefined,
    }));
  };
  const calls = () => fs.existsSync(path.join(cwd, 'argv.jsonl'))
    ? fs.readFileSync(path.join(cwd, 'argv.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  try {
    await run({ tool, respond, calls, config });
    assert.equal(fs.readFileSync(path.join(cwd, 'data/preview-meta.json'), 'utf8'), meta, 'Tool must preserve drift baseline');
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}
const execute = async (tool, params = {}) => {
  const result = await tool.execute('not-a-stable-confirmation', params, undefined, undefined, {});
  assert.deepEqual(JSON.parse(result.content[0].text), result.details);
  return result.details;
};
const success = (overrides = {}) => ({ ok: true, data: { ...evidence, publication_id: 'PUBLICATION_ID', ...overrides } });

describe('customer publication CLI boundary', () => {
  it('starts one PGC publication; retry after tool recreation reuses confirmation identity', async () => {
    await fixture(async ({ tool, respond, calls, config }) => {
      respond(success());
      const first = await execute(tool());
      const second = await execute(tool());
      assert.equal(first.ok, true);
      assert.equal(first.status, 'triggered');
      assert.equal(first.content_verified, false);
      assert.equal(first.stage, 'awaiting_browser');
      assert.match(first.publication_id, /^pgc-[a-f0-9]{64}$/);
      assert.equal(second.publication_id, first.publication_id);
      assert.deepEqual(calls().map(args => args.includes('--dry-run') ? 'dry-run' : args[2]), ['dry-run', 'start', 'dry-run', 'status', 'resume']);
      assert.deepEqual(calls()[1], [
        'preview', 'publication', 'start', '--name', 'my-preview', '--scope', 'pgc',
        '--lng', 'en,zh-TW', '--publication-id', first.publication_id, '--json',
      ]);
      assert.equal(first.changed_records, 'unknown');
      const stateDir = path.join(config.cwd, 'data/customer-publications');
      const [stateName] = fs.readdirSync(stateDir);
      const stateFile = path.join(stateDir, stateName);
      assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
      const saved = fs.readFileSync(stateFile, 'utf8');
      assert.doesNotMatch(saved, /customer-confirmation-42|never-send-me|Bearer/);
      assert.equal(JSON.parse(saved).publication_id, first.publication_id);
    });
  });

  it('resumes the supplied ID without starting or selecting scope/languages', async () => {
    await fixture(async ({ tool, respond, calls }) => {
      respond(success({ stage: 'db_partial' }));
      const result = await execute(tool(), { publication_id: publicationId });
      assert.equal(result.publication_id, publicationId);
      assert.equal(result.stage, 'db_partial');
      assert.deepEqual(calls().filter(args => !args.includes('--dry-run')), ['status', 'resume'].map(action => [
        'preview', 'publication', action, '--name', 'my-preview', '--publication-id', publicationId, '--json',
      ]));
    }, { confirmationId: 'cli' });
  });

  it('uses adapter_output result envelope and leaves partial content unverified', async () => {
    await fixture(async ({ tool, respond }) => {
      respond({ ok: true, result: { ...evidence, publication_id: 'PUBLICATION_ID', stage: 'files_applied' } });
      const result = await execute(tool());
      assert.equal(result.ok, true);
      assert.equal(result.stage, 'files_applied');
      assert.equal(result.content_verified, false);
    });
  });

  it('forwards explicit drift force/reason exactly once; CLI owns all audit I/O', async () => {
    await fixture(async ({ tool, respond, calls }) => {
      respond(success());
      const result = await execute(tool(), { force_reason: ' 客戶已確認外部修改 ' });
      assert.equal(result.ok, true);
      assert.deepEqual(calls()[1].slice(-4), ['--force', '--reason', '客戶已確認外部修改', '--json']);
      assert.equal(calls()[1].filter(x => x === '--force').length, 1);
    });
  });

  it('retains partial session on structured failure; only blocked drift asks for force', async () => {
    await fixture(async ({ tool, respond, calls }) => {
      for (const [details, status] of [
        [{ code: 'lease_conflict', http_status: 409 }, undefined],
        [{ code: 'schema_conflict', http_status: 409 }, undefined],
        [{ drift_gate: { result: 'blocked' } }, 'origin_drift'],
      ]) {
        respond({ ok: false, error: { message: 'review required', error_class: 'needs_review', retryable: false,
          hint: 'Inspect publication status', details: { ...evidence, publication_id: 'PUBLICATION_ID', stage: 'db_partial', ...details } } }, 2);
        const result = await execute(tool());
        assert.equal(result.ok, false);
        assert.equal(result.stage, 'db_partial');
        assert.equal(result.status, status);
        assert.equal(result.content_verified, false);
        assert.match(result.publication_id, /^pgc-/);
        assert.equal(result.details.error_class, 'needs_review');
      }
      assert.equal(calls().filter(args => args[2] === 'start' && !args.includes('--dry-run')).length, 1, 'No duplicate start after failure');
      assert.ok(calls().every(args => !args.includes('--force')));
    });
  });

  it('preserves resume ID and classified retryable/reconcile/fatal errors', async () => {
    await fixture(async ({ tool, respond }) => {
      for (const [error_class, exitCode] of [['fatal', 1], ['reconcile', 3], ['retryable', 4]]) {
        respond({ ok: false, error: { message: 'operation incomplete', error_class, retryable: error_class === 'retryable', hint: 'Read status' } }, exitCode, '', { status: success() });
        const result = await execute(tool(), { publication_id: publicationId });
        assert.equal(result.ok, false);
        assert.equal(result.publication_id, publicationId);
        assert.equal(result.details.error_class, error_class);
        assert.equal(result.content_verified, false);
      }
    });
  });

  it('fails closed for malformed/legacy JSON, wrong identity and exit/envelope disagreement', async () => {
    await fixture(async ({ tool, respond, calls }) => {
      for (const [body, exitCode] of [
        ['not JSON', 0], ['{"ok":true,"data":{}}', 0], [{ ok: true, data: evidence }, 0],
        [success({ scope: 'staff' }), 0], [success({ app: 'other' }), 0],
        [success({ origin: 'https://other.example.com' }), 0], [success({ languages: ['en'] }), 0],
        [success({ candidate_digest: 'sha256:' + 'cd'.repeat(32) }), 0], [success({ content_verified: 'false' }), 0], [success({ stage: '' }), 0],
        [success({ languages: ['en', 'en', 'zh-TW'] }), 0],
        [success(), 4], [{ ok: false, error: { message: 'bad' } }, 0],
        [`${JSON.stringify(success())}\ntrailing noise`, 0],
      ]) {
        respond(body, exitCode);
        const result = await execute(tool());
        assert.equal(result.ok, false, JSON.stringify(body));
        assert.equal(result.content_verified, false);
        assert.doesNotMatch(JSON.stringify(result), /upstream private|never-send-me/);
      }
      assert.equal(calls().filter(args => args[2] === 'start' && !args.includes('--dry-run')).length, 1);
    });
  });

  it('lost response recovers persisted mapping with status then resume, never another start', async () => {
    await fixture(async ({ tool, respond, calls }) => {
      respond('lost response');
      const first = await execute(tool());
      assert.equal(first.ok, false);
      respond(success());
      const retry = await execute(tool());
      assert.equal(retry.ok, true);
      assert.equal(first.publication_id, retry.publication_id);
      assert.deepEqual(calls().map(args => args.includes('--dry-run') ? 'dry-run' : args[2]), ['dry-run', 'start', 'dry-run', 'status', 'resume']);
    });
  });

  it('same confirmation with changed candidate refuses before resume or new start', async () => {
    await fixture(async ({ tool, respond, calls }) => {
      respond(success());
      await execute(tool());
      respond(success(), 0, '', { digest: 'sha256:' + 'cd'.repeat(32) });
      const retry = await execute(tool());
      assert.equal(retry.ok, false);
      assert.equal(retry.details.code, 'candidate_changed');
      assert.deepEqual(calls().map(args => args.includes('--dry-run') ? 'dry-run' : args[2]), ['dry-run', 'start', 'dry-run']);
    });
  });

  it('does not resume when status cannot establish exact session identity', async () => {
    await fixture(async ({ tool, respond, calls }) => {
      respond(success(), 0, '', { status: { ok:true, data:{ ...evidence, publication_id:'PUBLICATION_ID', app:'wrong' } } });
      const result = await execute(tool(), { publication_id: publicationId });
      assert.equal(result.ok, false);
      assert.equal(calls().some(args => args[2] === 'resume'), false);
    });
  });

  it('same-ID start is allowed only after status explicitly says session_not_found', async () => {
    await fixture(async ({ tool, respond, calls }) => {
      respond('response lost');
      const first = await execute(tool());
      respond(success(), 0, '', { status: { ok:false, error:{ message:'not found', error_class:'reconcile', retryable:false, hint:'same ID start', details:{code:'session_not_found'} } } });
      const retry = await execute(tool());
      assert.equal(retry.ok, true);
      assert.equal(retry.publication_id, first.publication_id);
      const starts = calls().filter(args => args[2] === 'start' && !args.includes('--dry-run'));
      assert.equal(starts.length, 2);
      assert.equal(starts[0][starts[0].indexOf('--publication-id') + 1], starts[1][starts[1].indexOf('--publication-id') + 1]);
      assert.equal(calls().some(args => args[2] === 'resume'), false);
    });
  });

  it('rejects changed status candidate before resume', async () => {
    await fixture(async ({ tool, respond, calls }) => {
      respond(success(), 0, '', { status:{ok:true,data:{...evidence,publication_id:'PUBLICATION_ID',candidate_digest:'sha256:'+'cd'.repeat(32)}} });
      const result = await execute(tool(), { publication_id:publicationId });
      assert.equal(result.ok, false);
      assert.equal(calls().some(args => args[2] === 'resume'), false);
    });
  });

  it('refuses corrupt or redirected persisted mapping before status/start', async () => {
    await fixture(async ({ tool, respond, calls, config }) => {
      respond(success());
      await execute(tool());
      const stateDir = path.join(config.cwd, 'data/customer-publications');
      const stateFile = path.join(stateDir, fs.readdirSync(stateDir)[0]);
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      fs.writeFileSync(stateFile, JSON.stringify({...saved, publication_id:'pgc-other-confirmation'}));
      const before = calls().length;
      assert.equal((await execute(tool())).ok, false);
      assert.equal(calls().length, before + 1);
      assert.ok(calls().at(-1).includes('--dry-run'));
    });
  });

  it('rejects symlink state directories before any mutating command', async () => {
    await fixture(async ({ tool, respond, calls, config }) => {
      const state = path.join(config.cwd, 'data/customer-publications');
      fs.symlinkSync(config.cwd, state);
      respond(success());
      assert.equal((await execute(tool())).ok, false);
      assert.deepEqual(calls().map(args => args.includes('--dry-run')), [true]);
    });
  });

  it('does not promote a CLI true flag to public/browser verification', async () => {
    await fixture(async ({ tool, respond }) => {
      respond(success({ content_verified: true, stage: 'receiver_verified' }));
      const result = await execute(tool());
      assert.equal(result.status, 'triggered');
      assert.equal(result.content_verified, false);
    });
  });

  it('rejects missing stable identity, staff scope and invalid arguments before CLI', async () => {
    await fixture(async ({ tool, calls }) => {
      for (const params of [ {}, { scope: 'staff' }, { publication_id: '../bad' },
        { force_reason: 'x'.repeat(513) }, { force_reason: {} }, { confirmation_id: 'cli' } ]) {
        const result = await execute(tool(), params);
        assert.equal(result.ok, false);
      }
      assert.deepEqual(calls(), []);
      assert.equal(tool().parameters.properties.scope, undefined);
    }, { confirmationId: 'cli' });
  });

  it('accepts explicit stable confirmation identity when env identity is absent', async () => {
    await fixture(async ({ tool, respond }) => {
      respond(success());
      const first = await execute(tool(), { confirmation_id: 'confirmation-99' });
      const retry = await execute(tool(), { confirmation_id: 'confirmation-99' });
      const next = await execute(tool(), { confirmation_id: 'confirmation-100' });
      assert.equal(first.ok, true);
      assert.equal(first.publication_id, retry.publication_id);
      assert.notEqual(first.publication_id, next.publication_id);
    }, { confirmationId: '' });
  });
});
