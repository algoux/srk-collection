const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const {
  canUseIncrementalDiff,
  createBoundedRequest,
  createRequest,
  getRequestTimeoutMs,
  isRetriableError,
  parseCliArgs,
  parseNameStatusDiff,
  resolveIncrementalTargets,
  prepareSyncFile,
  sync,
  syncRank,
  syncCollection,
  withRequestRetry,
} = require('./sync');
const { LogicException, assertApiSuccess } = require('./rankland-v2-api');

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function apiSuccess(data = null) {
  return { body: { success: true, code: 0, data } };
}

function apiFailure(code, msg) {
  return { body: { success: false, code, msg } };
}

function getMultipartField(form, name) {
  const index = form._streams.findIndex(
    (part) => typeof part === 'string' && part.includes(`name="${name}"`),
  );
  return index === -1 ? undefined : form._streams[index + 1];
}

function getMultipartFilename(form) {
  const header = form._streams.find(
    (part) => typeof part === 'string' && part.includes('filename='),
  );
  const match = header && header.match(/filename="([^"]+)"/);
  return match && match[1];
}

async function prepareFixture(tempDir) {
  const source = {
    type: 'standard',
    version: '1.0.0',
    contest: {
      title: 'Foo Contest',
      startAt: '2025-01-01T00:00:00Z',
      duration: [5, 'h'],
      refLinks: [],
    },
    problems: [],
    series: [],
    rows: [],
    sorter: { algorithm: 'ICPC' },
    markers: [],
    contributors: ['Alice'],
  };
  await fs.writeJson(path.join(tempDir, 'foo.srk.json'), source, { spaces: 2 });
  return prepareSyncFile(tempDir, 'foo', {
    format: 'srk.json',
    path: 'foo.srk.json',
    name: 'Foo Display Name',
  });
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
          label: 'GET files/123',
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

test('createRequest targets the v2 API with the x-token header', () => {
  const previousToken = process.env.RL_API_AUTH_TOKEN;
  process.env.RL_API_AUTH_TOKEN = 'test-token';
  let requestOptions;
  const request = createRequest({
    extend: (options) => {
      requestOptions = options;
      return { options };
    },
  });

  assert.deepStrictEqual(request, { options: requestOptions });
  assert.strictEqual(requestOptions.prefixUrl, 'https://rl.algoux.cn/api/v2/');
  assert.deepStrictEqual(requestOptions.headers, { 'x-token': 'test-token' });

  if (previousToken === undefined) {
    delete process.env.RL_API_AUTH_TOKEN;
  } else {
    process.env.RL_API_AUTH_TOKEN = previousToken;
  }
});

test('assertApiSuccess throws LogicException with business details for a failed JSON response', () => {
  assert.throws(
    () =>
      assertApiSuccess(
        {
          body: JSON.stringify({
            success: false,
            code: 100002,
            msg: 'contest already exists',
          }),
        },
        'POST contests',
      ),
    (error) => {
      assert(error instanceof LogicException);
      assert.strictEqual(error.name, 'LogicException');
      assert.strictEqual(error.code, 100002);
      assert.strictEqual(error.msg, 'contest already exists');
      assert.match(error.message, /POST contests/);
      assert.match(error.message, /100002/);
      assert.match(error.message, /contest already exists/);
      return true;
    },
  );
});

test('assertApiSuccess treats success as the only business failure flag', () => {
  assert.deepStrictEqual(
    assertApiSuccess(
      {
        body: {
          success: true,
          code: 999999,
          data: { ok: true },
        },
      },
      'GET contests/foo',
    ),
    { ok: true },
  );
});

test('createBoundedRequest converts got business HTTP errors before retrying', async () => {
  let attempts = 0;
  const request = createBoundedRequest(
    {
      get: async () => {
        attempts += 1;
        const error = new Error('Response code 500');
        error.name = 'HTTPError';
        error.response = {
          statusCode: 500,
          body: {
            success: false,
            code: 100002,
            msg: 'contest already exists',
          },
        };
        throw error;
      },
    },
    {
      logger: { log() {} },
      sleep: async () => {},
    },
  );

  await assert.rejects(
    () => request.get('contests/foo', { responseType: 'json' }),
    (error) => {
      assert(error instanceof LogicException);
      assert.strictEqual(error.code, 100002);
      assert.strictEqual(error.msg, 'contest already exists');
      assert.match(error.message, /contest already exists/);
      return true;
    },
  );
  assert.strictEqual(attempts, 1);
});

test('isRetriableError never retries a LogicException with a transport-like business code', () => {
  assert.strictEqual(
    isRetriableError(new LogicException('ECONNRESET', 'business rule rejected the request')),
    false,
  );
});

test('prepareSyncFile minifies SRK data, hashes it, and builds complete contest metadata', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-test-'));

  try {
    const file = await prepareFixture(tempDir);

    assert.strictEqual(
      file.fileContent.toString('utf8'),
      '{"type":"standard","version":"1.0.0","contest":{"title":"Foo Contest","startAt":"2025-01-01T00:00:00Z","duration":[5,"h"],"refLinks":[]},"problems":[],"series":[],"rows":[],"sorter":{"algorithm":"ICPC"},"markers":[],"contributors":["Alice"]}',
    );
    assert.strictEqual(
      file.sha256,
      'f3e3d29d758b9131cc0ee2ab80ff8d428f25c0b7ed97cf20ed5f8822d04d590b',
    );
    assert.deepStrictEqual(file.contestMetadata, {
      name: 'Foo Display Name',
      title: { fallback: 'Foo Contest' },
      startAt: '2025-01-01T00:00:00Z',
      duration: [5, 'h'],
      frozenDuration: null,
      banner: null,
      refLinks: [],
      problems: [],
      markers: [],
      series: [],
      sorter: { algorithm: 'ICPC' },
      contributors: ['Alice'],
    });
  } finally {
    await fs.remove(tempDir);
  }
});

test('syncRank creates the contest before uploading RankMain and then associates the file', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-test-'));
  const calls = [];

  try {
    const file = await prepareFixture(tempDir);
    const updated = await syncRank(file, {
      dryRun: false,
      logger: { log: () => {}, error: () => {} },
      request: {
        get: async (url) => {
          calls.push(['get', url]);
          assert.strictEqual(url, 'public/contests/foo');
          return apiFailure(100001, 'contest not found');
        },
        post: async (url, options) => {
          calls.push(['post', url]);
          if (url === 'contests') {
            assert.deepStrictEqual(options.json, {
              uk: 'foo',
              ...file.contestMetadata,
              users: [],
            });
            return apiSuccess({ _id: '1001' });
          }
          assert.strictEqual(url, 'files');
          assert.strictEqual(getMultipartField(options.body, 'contestId'), '1001');
          assert.strictEqual(getMultipartField(options.body, 'category'), 'RankMain');
          assert.strictEqual(getMultipartFilename(options.body), 'foo.srk.json');
          return apiSuccess({ id: '2001' });
        },
        patch: async (url, options) => {
          calls.push(['patch', url]);
          assert.strictEqual(url, 'contests/foo');
          assert.deepStrictEqual(options.json, {
            ...file.contestMetadata,
            srkFileID: '2001',
          });
          return apiSuccess();
        },
      },
      tempUploadingDir: tempDir,
    });

    assert.strictEqual(updated, true);
    assert.deepStrictEqual(calls, [
      ['get', 'public/contests/foo'],
      ['post', 'contests'],
      ['post', 'files'],
      ['patch', 'contests/foo'],
    ]);
  } finally {
    await fs.remove(tempDir);
  }
});

test('syncRank reuses matching RankMain metadata without remote writes', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-test-'));
  const writes = [];

  try {
    const file = await prepareFixture(tempDir);
    const updated = await syncRank(file, {
      dryRun: false,
      logger: { log: () => {}, error: () => {} },
      request: {
        get: async (url) => {
          if (url === 'public/contests/foo') {
            return apiSuccess({
              _id: '1001',
              uk: 'foo',
              ...file.contestMetadata,
              startAt: '2025-01-01T08:00:00+08:00',
              duration: [18000, 's'],
              srkFileID: '2001',
            });
          }
          assert.strictEqual(url, 'public/files/2001');
          return apiSuccess({
            id: '2001',
            contestId: '1001',
            category: 'RankMain',
            hashType: 'sha256',
            hashValue: file.sha256,
          });
        },
        post: async (url) => {
          writes.push(['post', url]);
          throw new Error(`unexpected post ${url}`);
        },
        patch: async (url) => {
          writes.push(['patch', url]);
          throw new Error(`unexpected patch ${url}`);
        },
      },
      tempUploadingDir: tempDir,
    });

    assert.strictEqual(updated, false);
    assert.deepStrictEqual(writes, []);
  } finally {
    await fs.remove(tempDir);
  }
});

test('syncRank replaces a mismatched RankMain hash and patches the existing contest', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-test-'));
  const calls = [];

  try {
    const file = await prepareFixture(tempDir);
    const updated = await syncRank(file, {
      dryRun: false,
      logger: { log: () => {}, error: () => {} },
      request: {
        get: async (url) => {
          calls.push(['get', url]);
          if (url === 'public/contests/foo') {
            return apiSuccess({
              _id: '1001',
              uk: 'foo',
              ...file.contestMetadata,
              srkFileID: '2001',
            });
          }
          return apiSuccess({
            id: '2001',
            contestId: '1001',
            category: 'RankMain',
            hashType: 'sha256',
            hashValue: '0'.repeat(64),
          });
        },
        post: async (url, options) => {
          calls.push(['post', url]);
          assert.strictEqual(url, 'files');
          assert.strictEqual(getMultipartField(options.body, 'contestId'), '1001');
          return apiSuccess({ id: '2002' });
        },
        patch: async (url, options) => {
          calls.push(['patch', url]);
          assert.strictEqual(options.json.srkFileID, '2002');
          assert.strictEqual('users' in options.json, false);
          return apiSuccess();
        },
      },
      tempUploadingDir: tempDir,
    });

    assert.strictEqual(updated, true);
    assert.deepStrictEqual(calls, [
      ['get', 'public/contests/foo'],
      ['get', 'public/files/2001'],
      ['post', 'files'],
      ['patch', 'contests/foo'],
    ]);
  } finally {
    await fs.remove(tempDir);
  }
});

test('syncRank dry-run does not call v2 write endpoints for a missing contest', async () => {
  const writes = [];
  const logs = [];
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-test-'));

  try {
    const file = await prepareFixture(tempDir);
    const updated = await syncRank(file, {
      dryRun: true,
      logger: { log: (message) => logs.push(message), error: () => {} },
      request: {
        get: async (url) => {
          assert.strictEqual(url, 'public/contests/foo');
          return apiFailure(100001, 'contest not found');
        },
        post: async (url) => {
          writes.push(['post', url]);
          throw new Error('dry-run should not post');
        },
        patch: async (url) => {
          writes.push(['patch', url]);
          throw new Error('dry-run should not patch');
        },
      },
      tempUploadingDir: tempDir,
    });

    assert.strictEqual(updated, false);
    assert.deepStrictEqual(writes, []);
    assert.ok(logs.some((message) => message.includes('[dry-run] Would create contest foo')));
    assert.ok(logs.some((message) => message.includes('[dry-run] Would upload file foo')));
    assert.ok(logs.some((message) => message.includes('[dry-run] Would associate file')));
  } finally {
    await fs.remove(tempDir);
  }
});

test('syncCollection sends direct JSON content through the v2 create endpoint', async () => {
  const config = { root: { children: [] } };
  const calls = [];

  await syncCollection('official', config, {
    dryRun: false,
    logger: { log: () => {}, error: () => {} },
    request: {
      get: async (url) => {
        calls.push(['get', url]);
        assert.strictEqual(url, 'public/collections/official');
        return apiFailure(102001, 'collection not found');
      },
      post: async (url, options) => {
        calls.push(['post', url]);
        assert.strictEqual(url, 'collections');
        assert.deepStrictEqual(options.json, { uk: 'official', content: config });
        return apiSuccess({ _id: '3001' });
      },
      patch: async (url) => {
        throw new Error(`unexpected patch ${url}`);
      },
    },
    sleep: async () => {},
  });

  assert.deepStrictEqual(calls, [
    ['get', 'public/collections/official'],
    ['post', 'collections'],
  ]);
});

test('syncCollection sends direct JSON content through the v2 update endpoint', async () => {
  const config = { root: { children: [{ type: 1, uniqueKey: 'foo', name: 'Foo' }] } };
  const calls = [];

  await syncCollection('official', config, {
    dryRun: false,
    logger: { log: () => {}, error: () => {} },
    request: {
      get: async (url) => {
        calls.push(['get', url]);
        return apiSuccess({ _id: '3001', uk: 'official', content: {} });
      },
      post: async (url) => {
        throw new Error(`unexpected post ${url}`);
      },
      patch: async (url, options) => {
        calls.push(['patch', url]);
        assert.strictEqual(url, 'collections/official');
        assert.deepStrictEqual(options.json, { content: config });
        return apiSuccess();
      },
    },
    sleep: async () => {},
  });

  assert.deepStrictEqual(calls, [
    ['get', 'public/collections/official'],
    ['patch', 'collections/official'],
  ]);
});

test('syncCollection dry-run does not call v2 collection write endpoints', async () => {
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
          assert.strictEqual(url, 'public/collections/official');
          return apiSuccess({ _id: '3001', uk: 'official', content: {} });
        },
        post: async (url) => {
          writes.push(['post', url]);
          throw new Error('dry-run should not post');
        },
        patch: async (url) => {
          writes.push(['patch', url]);
          throw new Error('dry-run should not patch');
        },
      },
      sleep: async () => {},
    },
  );

  assert.deepStrictEqual(writes, []);
  assert.ok(logs.some((message) => message.includes('[dry-run] Would update collection official')));
});

for (const scenario of [
  { name: 'successful sync', options: {}, expected: true, calls: ['get', 'patch'] },
  { name: 'dry-run', options: { dryRun: true }, expected: false, calls: ['get'] },
  {
    name: 'no relevant changes',
    options: { changedFrom: 'base', changedTo: 'head', git: () => '' },
    expected: false,
    calls: [],
  },
  { name: 'failed sync', options: {}, failure: true, calls: ['get', 'patch'] },
]) {
  test(`sync reports completed updates: ${scenario.name}`, async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-result-test-'));
    const calls = [];
    try {
      await fs.writeFile(path.join(tempDir, 'config.yaml'), 'root:\n  children: []\n');
      const result = sync(tempDir, {
        ...scenario.options,
        logger: { log: () => {}, error: () => {} },
        request: {
          get: async () => {
            calls.push('get');
            return apiSuccess({ id: '3001', content: {} });
          },
          patch: async () => {
            calls.push('patch');
            return scenario.failure ? apiFailure(100001, 'sync rejected') : apiSuccess();
          },
        },
        sleep: async () => {},
      });
      if (scenario.failure) {
        await assert.rejects(result, /sync rejected/);
      } else {
        assert.deepStrictEqual(await result, {
          synced: scenario.expected,
          updatedRanks: [],
          collectionUpdated: scenario.expected,
        });
      }
      assert.deepStrictEqual(calls, scenario.calls);
    } finally {
      await fs.remove(tempDir);
    }
  });
}

async function prepareSyncSummaryFixture(tempDir, keys) {
  await prepareFixture(tempDir);
  const source = await fs.readJson(path.join(tempDir, 'foo.srk.json'));
  const files = {};
  for (const key of keys) {
    const name = `${key} Contest`;
    await fs.writeJson(path.join(tempDir, `${key}.srk.json`), {
      ...source,
      contest: { ...source.contest, title: name },
    });
    files[key] = prepareSyncFile(tempDir, key, {
      format: 'srk.json',
      path: `${key}.srk.json`,
      name,
    });
  }
  await fs.writeJson(path.join(tempDir, 'config.yaml'), {
    root: { children: keys.map((key) => ({ path: key, format: 'srk.json', name: key })) },
  });
  return files;
}

function makeSummaryRequest(files, outdatedKeys, onPatch) {
  return {
    get: async (url) => {
      if (url.startsWith('public/contests/')) {
        const key = decodeURIComponent(url.slice('public/contests/'.length));
        const file = files[key];
        assert(file, `unexpected contest ${key}`);
        return apiSuccess({
          _id: `contest-${key}`,
          uk: key,
          ...file.contestMetadata,
          name: outdatedKeys.includes(key) ? `Old ${file.name}` : file.name,
          srkFileID: `file-${key}`,
        });
      }
      if (url.startsWith('public/files/file-')) {
        const key = url.slice('public/files/file-'.length);
        const file = files[key];
        assert(file, `unexpected file ${key}`);
        return apiSuccess({
          contestId: `contest-${key}`,
          category: 'RankMain',
          hashType: 'sha256',
          hashValue: file.sha256,
        });
      }
      assert(url.startsWith('public/collections/'), `unexpected get ${url}`);
      return apiSuccess({ _id: 'collection-1', content: {} });
    },
    post: async (url) => {
      throw new Error(`Matching files must not be uploaded again: ${url}`);
    },
    patch: onPatch,
  };
}

function summarySyncOptions(tempDir, keys, request, extra = {}) {
  return {
    changedFrom: 'base',
    changedTo: 'head',
    git: (args) =>
      args[0] === 'diff'
        ? keys.map((key) => `M\t${tempDir}/${key}.srk.json`).join('\n')
        : '',
    logger: { log: () => {}, error: () => {} },
    request,
    sleep: async () => {},
    ...extra,
  };
}

test('sync lists only updated ranklists in source order after concurrent metadata updates', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-summary-test-'));
  try {
    const keys = ['first', 'unchanged', 'last'];
    const files = await prepareSyncSummaryFixture(tempDir, keys);
    const completed = [];
    const request = makeSummaryRequest(files, ['first', 'last'], async (url, options) => {
      const key = url.slice('contests/'.length);
      assert(['first', 'last'].includes(key), `unexpected patch ${url}`);
      assert.strictEqual(options.json.srkFileID, `file-${key}`);
      assert.strictEqual(options.json.name, files[key].name);
      if (key === 'first') await new Promise((resolve) => setImmediate(resolve));
      completed.push(key);
      return apiSuccess();
    });
    const summary = await sync(tempDir, summarySyncOptions(tempDir, keys, request));
    assert.deepStrictEqual(completed, ['last', 'first']);
    assert.deepStrictEqual(summary, {
      synced: true,
      updatedRanks: [
        { uniqueKey: 'first', name: 'first Contest' },
        { uniqueKey: 'last', name: 'last Contest' },
      ],
      collectionUpdated: false,
    });
  } finally {
    await fs.remove(tempDir);
  }
});

for (const scenario of [
  { name: 'already synchronized ranklists', outdatedKeys: [], dryRun: false },
  { name: 'dry-run with pending metadata updates', outdatedKeys: ['foo'], dryRun: true },
]) {
  test(`sync reports no updates for ${scenario.name}`, async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-summary-test-'));
    try {
      const files = await prepareSyncSummaryFixture(tempDir, ['foo']);
      const request = makeSummaryRequest(files, scenario.outdatedKeys, async (url) => {
        throw new Error(`Unexpected write: ${url}`);
      });
      const summary = await sync(
        tempDir,
        summarySyncOptions(tempDir, ['foo'], request, { dryRun: scenario.dryRun }),
      );
      assert.deepStrictEqual(summary, {
        synced: false,
        updatedRanks: [],
        collectionUpdated: false,
      });
    } finally {
      await fs.remove(tempDir);
    }
  });
}

test('sync reports collection-only updates without listing unchanged ranklists', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-summary-test-'));
  try {
    const files = await prepareSyncSummaryFixture(tempDir, ['foo']);
    const writes = [];
    const request = makeSummaryRequest(files, [], async (url) => {
      writes.push(url);
      return apiSuccess();
    });
    const summary = await sync(
      tempDir,
      summarySyncOptions(tempDir, [], request, {
        git: (args) => (args[0] === 'diff' ? `M\t${tempDir}/config.yaml` : ''),
      }),
    );
    assert.deepStrictEqual(writes, [`collections/${encodeURIComponent(tempDir)}`]);
    assert.deepStrictEqual(summary, {
      synced: true,
      updatedRanks: [],
      collectionUpdated: true,
    });
  } finally {
    await fs.remove(tempDir);
  }
});

for (const phase of ['rank', 'collection']) {
  test(`sync rejects a ${phase} failure even when another ranklist was updated`, async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-summary-test-'));
    try {
      const files = await prepareSyncSummaryFixture(tempDir, ['first', 'last']);
      const writes = [];
      const request = makeSummaryRequest(files, ['first', 'last'], async (url) => {
        writes.push(url);
        if (
          (phase === 'rank' && url === 'contests/last') ||
          (phase === 'collection' && url.startsWith('collections/'))
        ) {
          return apiFailure(100002, 'summary fixture write rejected');
        }
        return apiSuccess();
      });
      const options = summarySyncOptions(tempDir, ['first', 'last'], request);
      if (phase === 'collection') {
        options.changedFrom = '';
      }
      await assert.rejects(
        sync(tempDir, options),
        phase === 'rank' ? /Some ranklists failed to sync: last/ : /summary fixture write rejected/,
      );
      assert(writes.includes('contests/first'));
      if (phase === 'rank') assert(!writes.some((url) => url.startsWith('collections/')));
    } finally {
      await fs.remove(tempDir);
    }
  });
}

run();
