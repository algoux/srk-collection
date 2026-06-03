const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const {
  canUseIncrementalDiff,
  getRequestTimeoutMs,
  parseCliArgs,
  parseNameStatusDiff,
  resolveIncrementalTargets,
  syncRank,
  syncCollection,
  withRequestRetry,
} = require('./sync');

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function run() {
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

test('parseCliArgs accepts incremental and dry-run options', () => {
  const parsed = parseCliArgs([
    'official',
    '--changed-from',
    'base-sha',
    '--changed-to',
    'head-sha',
    '--dry-run',
  ]);

  assert.deepStrictEqual(parsed, {
    dir: 'official',
    changedFrom: 'base-sha',
    changedTo: 'head-sha',
    dryRun: true,
  });
});

test('parseCliArgs allows empty changed-from so CI can fall back to full sync', () => {
  const parsed = parseCliArgs(['official', '--changed-from', '', '--changed-to', 'head-sha']);

  assert.deepStrictEqual(parsed, {
    dir: 'official',
    changedFrom: '',
    changedTo: 'head-sha',
    dryRun: false,
  });
});

test('parseNameStatusDiff keeps changed srk files, config, and rename destinations', () => {
  const changedFiles = parseNameStatusDiff(
    [
      'M\tofficial/ccpc/foo.srk.json',
      'M\tofficial/config.yaml',
      'R100\tofficial/old.srk.json\tofficial/icpc/bar.srk.json',
      'M\tREADME.md',
      '',
    ].join('\n'),
  );

  assert.deepStrictEqual(changedFiles, [
    'official/ccpc/foo.srk.json',
    'official/config.yaml',
    'official/icpc/bar.srk.json',
    'README.md',
  ]);
});

test('resolveIncrementalTargets maps changed files to rank keys and collection sync', () => {
  const fileMap = {
    foo: { format: 'srk.json', path: 'ccpc/foo.srk.json', name: 'Foo' },
    bar: { format: 'srk.json', path: 'icpc/bar.srk.json', name: 'Bar' },
  };

  const targets = resolveIncrementalTargets({
    dir: 'official',
    fileMap,
    changedFiles: [
      'official/ccpc/foo.srk.json',
      'official/config.yaml',
      'official/icpc/bar.srk.json',
      'README.md',
    ],
  });

  assert.deepStrictEqual(targets, {
    fullSync: false,
    rankKeys: ['foo', 'bar'],
    syncCollection: true,
  });
});

test('resolveIncrementalTargets fails when a changed srk file is not in config.yaml', () => {
  assert.throws(
    () =>
      resolveIncrementalTargets({
        dir: 'official',
        fileMap: {
          foo: { format: 'srk.json', path: 'ccpc/foo.srk.json', name: 'Foo' },
        },
        changedFiles: ['official/ccpc/missing.srk.json'],
      }),
    /not referenced by official\/config\.yaml/,
  );
});

test('resolveIncrementalTargets returns no work for unrelated files', () => {
  const targets = resolveIncrementalTargets({
    dir: 'official',
    fileMap: {
      foo: { format: 'srk.json', path: 'ccpc/foo.srk.json', name: 'Foo' },
    },
    changedFiles: ['README.md'],
  });

  assert.deepStrictEqual(targets, {
    fullSync: false,
    rankKeys: [],
    syncCollection: false,
  });
});

test('canUseIncrementalDiff rejects missing or non-ancestor diff bases', () => {
  assert.strictEqual(canUseIncrementalDiff({ changedFrom: '', changedTo: 'head' }), false);

  const goodGit = (args) => {
    if (args.join(' ') === 'cat-file -e base^{commit}') {
      return '';
    }
    if (args.join(' ') === 'cat-file -e head^{commit}') {
      return '';
    }
    if (args.join(' ') === 'merge-base --is-ancestor base head') {
      return '';
    }
    throw new Error(`unexpected git args: ${args.join(' ')}`);
  };

  assert.strictEqual(
    canUseIncrementalDiff({
      changedFrom: 'base',
      changedTo: 'head',
      git: goodGit,
    }),
    true,
  );

  const nonAncestorGit = (args) => {
    if (args[0] === 'merge-base') {
      throw new Error('not ancestor');
    }
    return '';
  };

  assert.strictEqual(
    canUseIncrementalDiff({
      changedFrom: 'base',
      changedTo: 'head',
      git: nonAncestorGit,
    }),
    false,
  );
});

test('withRequestRetry uses stepped timeouts and stops after five retries', async () => {
  const timeouts = [];

  await assert.rejects(
    () =>
      withRequestRetry(
        async ({ timeout }) => {
          timeouts.push(timeout);
          const error = new Error('read ECONNRESET');
          error.code = 'ECONNRESET';
          throw error;
        },
        {
          label: 'GET rank/foo',
          logger: { log() {} },
          sleep: async () => {},
        },
      ),
    /failed after 6 attempts/,
  );

  assert.deepStrictEqual(timeouts, [30000, 45000, 60000, 75000, 90000, 105000]);
});

test('withRequestRetry does not retry non-retriable 404 responses', async () => {
  let attempts = 0;

  await assert.rejects(
    () =>
      withRequestRetry(
        async () => {
          attempts += 1;
          const error = new Error('Not Found');
          error.response = { statusCode: 404 };
          throw error;
        },
        {
          label: 'GET file/download',
          logger: { log() {} },
          sleep: async () => {},
        },
      ),
    /Not Found/,
  );

  assert.strictEqual(attempts, 1);
});

test('getRequestTimeoutMs follows the 30s plus 15s retry step strategy', () => {
  assert.strictEqual(getRequestTimeoutMs(0), 30000);
  assert.strictEqual(getRequestTimeoutMs(1), 45000);
  assert.strictEqual(getRequestTimeoutMs(5), 105000);
});

test('syncRank dry-run does not call remote write endpoints for missing rank', async () => {
  const writes = [];
  const logs = [];
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-test-'));

  await syncRank(
    {
      uniqueKey: 'foo',
      name: 'Foo Contest',
      filePath: path.join(tempDir, 'foo.srk.json'),
      fileContent: Buffer.from('{"contest":{"title":"Foo"}}'),
    },
    {
      dryRun: true,
      logger: { log: (message) => logs.push(message), error: () => {} },
      request: {
        get: async (url) => {
          assert.strictEqual(url, 'rank/foo');
          return { body: { code: 11 } };
        },
        post: async (url) => {
          writes.push(['post', url]);
          throw new Error('dry-run should not post');
        },
        put: async (url) => {
          writes.push(['put', url]);
          throw new Error('dry-run should not put');
        },
      },
      tempUploadingDir: tempDir,
    },
  );

  assert.deepStrictEqual(writes, []);
  assert.ok(logs.some((message) => message.includes('[dry-run] Would upload file foo')));
  assert.ok(logs.some((message) => message.includes('[dry-run] Would create rank foo')));

  await fs.remove(tempDir);
});

test('syncCollection dry-run does not call remote group write endpoints', async () => {
  const writes = [];
  const logs = [];

  await syncCollection(
    'official',
    { root: { children: [] } },
    {
      dryRun: true,
      logger: { log: (message) => logs.push(message), error: () => {} },
      request: {
        get: async (url) => {
          assert.strictEqual(url, 'rank/group/official');
          return { body: { code: 0, data: { id: 'group-id' } } };
        },
        post: async (url) => {
          writes.push(['post', url]);
          throw new Error('dry-run should not post');
        },
        put: async (url) => {
          writes.push(['put', url]);
          throw new Error('dry-run should not put');
        },
      },
      sleep: async () => {},
    },
  );

  assert.deepStrictEqual(writes, []);
  assert.ok(logs.some((message) => message.includes('[dry-run] Would update collection official')));
});

run();
