const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  collectSrkFiles,
  getRepairReason,
  isSrkJsonFile,
  patchSrk,
  processDirectory,
} = require('./fix-sequential-user-ids');

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

function row(name, id, scoreValue = 1) {
  return {
    user: { name, id },
    score: { value: scoreValue },
    statuses: [],
  };
}

function createRows(count, options = {}) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const id = options.idForIndex ? options.idForIndex(index) : String(index + 1);
    const name = options.nameForIndex ? options.nameForIndex(index) : `team-${index + 1}`;
    const scoreValue = options.scoreForIndex ? options.scoreForIndex(index) : 1;
    rows.push(row(name, id, scoreValue));
  }
  return rows;
}

test('isSrkJsonFile accepts srk.json and .srk.json files only', () => {
  assert.strictEqual(isSrkJsonFile('official/foo.srk.json'), true);
  assert.strictEqual(isSrkJsonFile('official/foo/srk.json'), true);
  assert.strictEqual(isSrkJsonFile('official/foo.json'), false);
});

test('collectSrkFiles recursively returns sorted SRK paths', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-sequential-user-ids-'));
  fs.mkdirSync(path.join(tempDir, 'b'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, 'a'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'b', 'z.srk.json'), '{}\n');
  fs.writeFileSync(path.join(tempDir, 'a', 'srk.json'), '{}\n');
  fs.writeFileSync(path.join(tempDir, 'ignored.json'), '{}\n');

  assert.deepStrictEqual(
    collectSrkFiles(tempDir).map((filePath) => path.relative(tempDir, filePath).replace(/\\/g, '/')),
    ['a/srk.json', 'b/z.srk.json'],
  );
});

test('getRepairReason matches all positive-score rows by filtered order', () => {
  const srk = {
    rows: [
      row('solved-a', '1', 3),
      row('unsolved-late', '999', 0),
      row('solved-b', '2', 1),
    ],
  };

  assert.strictEqual(getRepairReason(srk), 'positive-score rows');
});

test('getRepairReason matches when the first half of rows is sequential', () => {
  const rows = createRows(10, {
    idForIndex: (index) => (index < 5 ? String(index + 1) : `real-id-${index + 1}`),
    scoreForIndex: () => 1,
  });

  assert.strictEqual(getRepairReason({ rows }), 'first 50% rows');
});

test('getRepairReason matches when the first 100 rows are sequential', () => {
  const rows = createRows(240, {
    idForIndex: (index) => (index < 100 ? String(index + 1) : `real-id-${index + 1}`),
    scoreForIndex: () => 1,
  });

  assert.strictEqual(getRepairReason({ rows }), 'first 100 rows');
});

test('patchSrk replaces every row id with the user name when repairable', () => {
  const srk = {
    rows: [
      row('solved-a', '1', 3),
      row('unsolved-late', '999', 0),
      row('solved-b', '2', 1),
    ],
  };

  const result = patchSrk(srk);

  assert.deepStrictEqual(result, {
    changed: true,
    patchedRows: 3,
    reason: 'positive-score rows',
  });
  assert.deepStrictEqual(
    srk.rows.map((item) => item.user.id),
    ['solved-a', 'unsolved-late', 'solved-b'],
  );
});

test('patchSrk does not change a non-repairable ranklist', () => {
  const srk = {
    rows: [row('alpha', 'x', 1), row('beta', 'y', 1), row('gamma', 'z', 1)],
  };

  const result = patchSrk(srk);

  assert.deepStrictEqual(result, {
    changed: false,
    patchedRows: 0,
    reason: null,
  });
  assert.deepStrictEqual(
    srk.rows.map((item) => item.user.id),
    ['x', 'y', 'z'],
  );
});

test('processDirectory writes only repairable files and reports them', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-sequential-user-ids-process-'));
  const nestedDir = path.join(tempDir, 'nested');
  fs.mkdirSync(nestedDir, { recursive: true });

  const repairablePath = path.join(nestedDir, 'repairable.srk.json');
  const untouchedPath = path.join(tempDir, 'untouched.srk.json');
  fs.writeFileSync(
    repairablePath,
    `${JSON.stringify({ rows: [row('team-a', '1', 1), row('team-b', '2', 1)] }, null, 2)}\n`,
  );
  fs.writeFileSync(
    untouchedPath,
    `${JSON.stringify({ rows: [row('alpha', 'x', 1), row('beta', 'y', 1)] }, null, 2)}\n`,
  );

  const untouchedBefore = fs.readFileSync(untouchedPath, 'utf8');
  const result = processDirectory(tempDir);

  assert.strictEqual(result.scannedFiles, 2);
  assert.deepStrictEqual(result.patchedFiles, [
    {
      filePath: repairablePath,
      relativePath: 'nested/repairable.srk.json',
      patchedRows: 2,
      reason: 'positive-score rows',
    },
  ]);
  assert.strictEqual(JSON.parse(fs.readFileSync(repairablePath, 'utf8')).rows[0].user.id, 'team-a');
  assert.strictEqual(fs.readFileSync(untouchedPath, 'utf8'), untouchedBefore);
});

runTests();
