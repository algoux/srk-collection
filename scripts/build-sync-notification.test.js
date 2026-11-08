const assert = require('assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const { mkdtempSync, readFileSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const path = require('path');
const { buildSyncNotification } = require('./build-sync-notification');

const context = {
  commit: '1234567890abcdef1234567890abcdef12345678',
  repositoryUrl: 'https://github.com/algoux/srk-collection',
  runUrl: 'https://github.com/algoux/srk-collection/actions/runs/42',
};
function makeSummary(count) {
  return {
    synced: true,
    updatedRanks: Array.from({ length: count }, (_, i) => ({ uniqueKey: `contest-${i + 1}`, name: `Contest ${i + 1}` })),
    collectionUpdated: false,
  };
}
let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

test('lists every updated ranklist up to ten, with canonical short links', () => {
  for (const count of [1, 10]) {
    const { body, markdown } = buildSyncNotification({ ...context, summary: makeSummary(count) });
    assert.equal(body, markdown);
    assert(body.includes(`**Updated ranklists:** ${count}`));
    for (let i = 1; i <= count; i++) assert(body.includes(`- [Contest ${i}](https://rank.ac/contest-${i})`));
    assert(!body.includes('more ranklists'));
    assert(body.includes(`[1234567](${context.repositoryUrl}/commit/${context.commit})`));
  }
});

test('limits notifications to ten links and reports the exact omitted count', () => {
  const { body, markdown } = buildSyncNotification({ ...context, summary: makeSummary(13) });
  assert.equal(body.split('\n').filter((line) => line.startsWith('- [')).length, 10);
  assert(body.includes('- … and 3 more ranklists'));
  assert(!body.includes('https://rank.ac/contest-11'));
  assert(markdown.includes('https://rank.ac/contest-13'));
  assert(!markdown.includes('more ranklists'));
});

test('preserves source titles and safely escapes Markdown and short URL path characters', () => {
  const summary = makeSummary(1);
  summary.updatedRanks[0] = { uniqueKey: 'contest/one (final)?#中', name: 'Final [A]* <tag> & Cup\nInjected' };
  const { body } = buildSyncNotification({ ...context, summary });
  assert(body.includes('[Final \\[A\\]\\* &lt;tag&gt; &amp; Cup Injected]'));
  assert(body.includes('(https://rank.ac/contest%2Fone%20%28final%29%3F%23%E4%B8%AD)'));
  assert(!body.includes('<tag>'));
});

test('handles collection-only updates without inventing updated ranklists', () => {
  const summary = { synced: true, updatedRanks: [], collectionUpdated: true };
  const { body } = buildSyncNotification({ ...context, summary });
  assert(body.includes('**Updated ranklists:** 0'));
  assert(body.includes('Collection metadata updated.'));
  assert(body.includes('No ranklists changed.'));
  assert(!body.includes('https://rank.ac/'));
});

test('enforces 4000 characters without cutting Markdown links or losing omitted counts', () => {
  const summary = makeSummary(10);
  summary.updatedRanks.forEach((rank) => { rank.name = 'Long title '.repeat(100); });
  const { body, markdown } = buildSyncNotification({ ...context, summary });
  const shown = body.split('\n').filter((line) => line.startsWith('- [')).length;
  assert(shown > 0 && shown < 10);
  assert(body.length <= 4000);
  assert(body.includes(`- … and ${10 - shown} more ranklists`));
  assert(markdown.includes('https://rank.ac/contest-10'));
  summary.updatedRanks[0].name = 'x'.repeat(5000);
  const oversized = buildSyncNotification({ ...context, summary });
  assert(oversized.body.length <= 4000);
  assert(oversized.body.includes('- … and 10 more ranklists'));
});

test('rejects invalid, empty, or unsuccessful result summaries', () => {
  for (const summary of [null, {}, { ...makeSummary(1), synced: false }, makeSummary(0), { ...makeSummary(1), updatedRanks: [null] }]) {
    assert.throws(() => buildSyncNotification({ ...context, summary }));
  }
});

test('CLI writes bounded multiline output and the full job summary, without sending anything', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sync-notification-'));
  try {
    const output = path.join(dir, 'output');
    const summaryFile = path.join(dir, 'summary');
    const summary = makeSummary(12);
    const env = {
      ...process.env,
      SYNC_SUMMARY: JSON.stringify(summary),
      SYNC_COMMIT: context.commit,
      REPOSITORY_URL: context.repositoryUrl,
      WORKFLOW_RUN_URL: context.runUrl,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summaryFile,
    };
    const script = path.join(__dirname, 'build-sync-notification.js');
    execFileSync(process.execPath, [script], { env });
    const contents = readFileSync(output, 'utf8');
    const [header, ...lines] = contents.split('\n');
    const delimiter = header.replace(/^body<</, '');
    assert.match(delimiter, /^meowpush_[a-f0-9-]+$/);
    assert.equal(lines[lines.length - 2], delimiter);
    const expected = buildSyncNotification({ ...context, summary });
    assert.equal(lines.slice(0, -2).join('\n'), expected.body);
    assert.equal(readFileSync(summaryFile, 'utf8'), `${expected.markdown}\n`);
    const invalid = spawnSync(process.execPath, [script], { env: { ...env, SYNC_SUMMARY: 'invalid JSON' }, encoding: 'utf8' });
    assert.notEqual(invalid.status, 0);
    assert.equal(readFileSync(output, 'utf8'), contents);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
console.log(`${passed} notification formatter tests passed.`);
