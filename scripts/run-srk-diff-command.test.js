const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractDiagnoseSummary, renderDiagnoseComment, run } = require('./run-srk-diff-command');

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function runTests() {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok - ${name}`);
      console.error(error);
    }
  }

  if (failed > 0) {
    process.exitCode = 1;
  }
}

function createTempGitRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srk-diff-command-test-'));
  childProcess.execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  childProcess.execFileSync('git', ['config', 'user.email', 'ci@example.test'], {
    cwd: repoDir,
  });
  childProcess.execFileSync('git', ['config', 'user.name', 'CI Test'], { cwd: repoDir });
  return repoDir;
}

function commitAll(repoDir, message) {
  childProcess.execFileSync('git', ['add', '.'], { cwd: repoDir });
  childProcess.execFileSync('git', ['commit', '-m', message], { cwd: repoDir, stdio: 'ignore' });
  return childProcess
    .execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf8',
    })
    .trim();
}

test('extractDiagnoseSummary reads the Issues line from diagnose text', () => {
  const summary = extractDiagnoseSummary(
    [
      'SRK Diagnostics',
      'File: official/sample.srk.json',
      'Issues: 4 (error 0, warning 1, info 3)',
      '',
      'Precision',
    ].join('\n'),
  );

  assert.strictEqual(summary, 'Issues: 4 (error 0, warning 1, info 3)');
});

test('renderDiagnoseComment creates a collapsed block per file with full escaped output', () => {
  const comment = renderDiagnoseComment({
    jobUrl: 'https://github.com/algoux/srk-collection/actions/runs/1/job/2',
    fileCount: 2,
    failureCount: 1,
    results: [
      {
        filePath: 'official/a.srk.json',
        ok: true,
        output: 'SRK Diagnostics\nIssues: 4 (error 0, warning 1, info 3)\n<raw>',
        failure: '',
      },
      {
        filePath: 'official/b.srk.json',
        ok: false,
        output: 'SRK Diagnostics\nNo issues found\n',
        failure: 'exit code 2',
      },
    ],
  });

  assert(comment.includes('<!-- srk-diagnose-log -->'));
  assert(comment.includes('<summary><code>official/a.srk.json</code> - Issues: 4'));
  assert(comment.includes('<summary><code>official/b.srk.json</code> - Issues: unknown'));
  assert(comment.includes('&lt;raw&gt;'));
  assert(comment.includes('Command result: failed (exit code 2)'));
  assert.strictEqual((comment.match(/<details>/g) || []).length, 2);
});

test('run writes diagnose comment markdown from per-file command output', () => {
  const repoDir = createTempGitRepo();
  fs.mkdirSync(path.join(repoDir, 'official'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'official', 'sample.srk.json'), '{}\n');
  const base = commitAll(repoDir, 'base');

  fs.writeFileSync(path.join(repoDir, 'official', 'sample.srk.json'), '{"changed":true}\n');
  const head = commitAll(repoDir, 'head');

  const fakeSrk = path.join(repoDir, 'fake-srk.js');
  fs.writeFileSync(
    fakeSrk,
    [
      '#!/usr/bin/env node',
      'console.log("SRK Diagnostics");',
      'console.log("Issues: 4 (error 0, warning 1, info 3)");',
      'console.log("Full diagnostic body");',
    ].join('\n'),
  );
  fs.chmodSync(fakeSrk, 0o755);

  const commentPath = path.join(repoDir, 'diagnose-comment.md');
  const exitCode = run({
    command: 'diagnose',
    base,
    head,
    worktree: repoDir,
    srkBin: fakeSrk,
    allowCommandFailures: true,
    commentMarkdown: commentPath,
    commentJobUrl: 'https://github.com/algoux/srk-collection/actions/runs/1/job/2',
  });

  assert.strictEqual(exitCode, 0);
  const comment = fs.readFileSync(commentPath, 'utf8');
  assert(comment.includes('<summary><code>official/sample.srk.json</code> - Issues: 4'));
  assert(comment.includes('Full diagnostic body'));
});

runTests();
