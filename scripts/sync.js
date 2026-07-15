const childProcess = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const util = require('util');
const { default: PQueue } = require('p-queue');
const FormData = require('form-data');
const { parseConfig } = require('./parse');
const {
  COLLECTION_NOT_FOUND_CODE,
  CONTEST_NOT_FOUND_CODE,
  FILE_NOT_FOUND_CODE,
  LogicException,
  assertApiSuccess,
  createRequest,
  executeApiRequest,
  getApiResource,
} = require('./rankland-v2-api');

const RANK_MAIN_FILE_CATEGORY = 'RankMain';
const MAX_RETRIES = 5;
const MAX_ATTEMPTS = MAX_RETRIES + 1;
const INITIAL_TIMEOUT_MS = 30000;
const RETRY_TIMEOUT_STEP_MS = 15000;
const RETRY_DELAY_MS = 1000;
const SYNC_CONCURRENCY = 10;
const MAX_RANK_TASK_REQUESTS = 20;
const MAX_COLLECTION_TASK_REQUESTS = 10;

class RetryExhaustedError extends Error {
  constructor(label, attempts, cause) {
    super(`${label} failed after ${attempts} attempts: ${formatError(cause)}`);
    this.name = 'RetryExhaustedError';
    this.cause = cause;
    this.attempts = attempts;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function formatError(error) {
  if (!error) {
    return 'unknown error';
  }
  const code = error.code ? `${error.code} ` : '';
  return `${code}${error.message || String(error)}`.trim();
}

function getStatusCode(error) {
  return error && error.response && error.response.statusCode;
}

function isRetriableError(error) {
  if (error instanceof LogicException) {
    return false;
  }
  const statusCode = getStatusCode(error);
  if ([408, 429, 500, 502, 503, 504].includes(statusCode)) {
    return true;
  }

  return [
    'ECONNRESET',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENOTFOUND',
    'ECONNREFUSED',
    'ECONNABORTED',
    'EPIPE',
  ].includes(error && error.code);
}

function getRequestTimeoutMs(attemptIndex) {
  return INITIAL_TIMEOUT_MS + RETRY_TIMEOUT_STEP_MS * attemptIndex;
}

async function withRequestRetry(operation, options = {}) {
  const logger = options.logger || console;
  const label = options.label || 'request';
  const sleepFn = options.sleep || sleep;
  let lastError;

  for (let attemptIndex = 0; attemptIndex < MAX_ATTEMPTS; attemptIndex += 1) {
    const attempt = attemptIndex + 1;
    const timeout = getRequestTimeoutMs(attemptIndex);

    try {
      return await operation({ attempt, attemptIndex, timeout });
    } catch (error) {
      lastError = error;
      const canRetry = isRetriableError(error);
      if (!canRetry) {
        throw error;
      }

      if (attemptIndex >= MAX_RETRIES) {
        throw new RetryExhaustedError(label, attempt, error);
      }

      logger.log(
        `Retrying request due to error: ${formatError(error)} (attempt ${attempt}/${MAX_ATTEMPTS})`,
      );
      await sleepFn(RETRY_DELAY_MS);
    }
  }

  throw new RetryExhaustedError(label, MAX_ATTEMPTS, lastError);
}

function createBoundedRequest(request, options = {}) {
  const logger = options.logger || console;
  const sleepFn = options.sleep || sleep;
  const maxRequests = options.maxRequests || MAX_RANK_TASK_REQUESTS;
  let requestCount = 0;

  async function run(method, url, requestOptions = {}) {
    requestCount += 1;
    if (requestCount > maxRequests) {
      throw new Error(`Exceeded maximum logical request count (${maxRequests}) for sync task`);
    }

    return withRequestRetry(
      ({ timeout }) =>
        executeApiRequest(
          () =>
            request[method](url, {
              ...requestOptions,
              timeout,
            }),
          `${method.toUpperCase()} ${url}`,
        ),
      {
        label: `${method.toUpperCase()} ${url}`,
        logger,
        sleep: sleepFn,
      },
    );
  }

  return {
    get: (url, options) => run('get', url, options),
    post: (url, options) => run('post', url, options),
    patch: (url, options) => run('patch', url, options),
    put: (url, options) => run('put', url, options),
  };
}

function parseCliArgs(argv) {
  const parsed = {
    dir: undefined,
    changedFrom: undefined,
    changedTo: undefined,
    dryRun: false,
  };
  let hasChangedFrom = false;
  let hasChangedTo = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--changed-from':
        i += 1;
        hasChangedFrom = true;
        parsed.changedFrom = argv[i];
        break;
      case '--changed-to':
        i += 1;
        hasChangedTo = true;
        parsed.changedTo = argv[i];
        break;
      case '--dry-run':
        parsed.dryRun = true;
        break;
      default:
        if (arg && arg.startsWith('--')) {
          throw new Error(`Unknown option ${arg}`);
        }
        if (parsed.dir) {
          throw new Error(`Unexpected argument ${arg}`);
        }
        parsed.dir = arg;
        break;
    }
  }

  if (!parsed.dir) {
    throw new Error(
      'Usage: node sync.js <collection_dir> [--changed-from <sha> --changed-to <sha>] [--dry-run]',
    );
  }
  if (hasChangedFrom !== hasChangedTo) {
    throw new Error('--changed-from and --changed-to must be provided together');
  }

  return parsed;
}

function parseNameStatusDiff(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      const status = parts[0];
      if (status.startsWith('R') || status.startsWith('C')) {
        return normalizePath(parts[2]);
      }
      return normalizePath(parts[1]);
    })
    .filter(Boolean);
}

function defaultGit(args, cwd = process.cwd()) {
  return childProcess.execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function canUseIncrementalDiff({ changedFrom, changedTo, git = defaultGit, cwd = process.cwd() }) {
  if (!changedFrom || !changedTo) {
    return false;
  }

  try {
    git(['cat-file', '-e', `${changedFrom}^{commit}`], cwd);
    git(['cat-file', '-e', `${changedTo}^{commit}`], cwd);
    git(['merge-base', '--is-ancestor', changedFrom, changedTo], cwd);
    return true;
  } catch (error) {
    return false;
  }
}

function getChangedFiles({ changedFrom, changedTo, dir, git = defaultGit, cwd = process.cwd() }) {
  const output = git(
    ['diff', '--name-status', '--diff-filter=ACMRT', changedFrom, changedTo, '--', dir],
    cwd,
  );
  return parseNameStatusDiff(output);
}

function resolveIncrementalTargets({ dir, fileMap, changedFiles }) {
  const configPath = normalizePath(`${dir}/config.yaml`);
  const filePathToKey = new Map();
  for (const [uniqueKey, file] of Object.entries(fileMap)) {
    filePathToKey.set(normalizePath(`${dir}/${file.path}`), uniqueKey);
  }

  const rankKeys = [];
  const seenRankKeys = new Set();
  let syncCollection = false;

  for (const changedFile of changedFiles.map(normalizePath)) {
    if (changedFile === configPath) {
      syncCollection = true;
      continue;
    }

    if (!changedFile.startsWith(`${dir}/`) || !changedFile.endsWith('.srk.json')) {
      continue;
    }

    const uniqueKey = filePathToKey.get(changedFile);
    if (!uniqueKey) {
      throw new Error(`Changed srk file ${changedFile} is not referenced by ${dir}/config.yaml`);
    }

    if (!seenRankKeys.has(uniqueKey)) {
      rankKeys.push(uniqueKey);
      seenRankKeys.add(uniqueKey);
    }
  }

  return {
    fullSync: false,
    rankKeys,
    syncCollection,
  };
}

function prepareSyncFile(dir, uniqueKey, fileMapEntry) {
  const filePath = path.resolve(dir, fileMapEntry.path);
  switch (fileMapEntry.format) {
    case 'srk.json': {
      const fileJson = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const fileContent = Buffer.from(JSON.stringify(fileJson), 'utf8');
      return {
        uniqueKey,
        name: fileMapEntry.name,
        filePath,
        fileContent,
        sha256: crypto.createHash('sha256').update(fileContent).digest('hex'),
        contestMetadata: buildContestMetadata(fileJson, fileMapEntry.name),
      };
    }
    default:
      throw new Error(
        `Prepare failed for ${uniqueKey}: unknown file format ${fileMapEntry.format}`,
      );
  }
}

function buildContestMetadata(srk, name) {
  if (!srk || typeof srk !== 'object' || Array.isArray(srk)) {
    throw new Error('Prepare failed: SRK payload must be an object');
  }
  const contest = srk.contest;
  if (!contest || typeof contest !== 'object' || Array.isArray(contest)) {
    throw new Error('Prepare failed: SRK contest must be an object');
  }

  return {
    name,
    title: normalizeContestTitle(contest.title),
    startAt: contest.startAt,
    duration: contest.duration,
    frozenDuration: contest.frozenDuration ?? null,
    banner: contest.banner ?? null,
    refLinks: contest.refLinks ?? null,
    problems: srk.problems ?? null,
    markers: srk.markers ?? null,
    series: srk.series ?? null,
    sorter: srk.sorter ?? null,
    contributors: srk.contributors ?? [],
  };
}

function normalizeContestTitle(title) {
  if (typeof title === 'string') {
    return { fallback: title };
  }
  if (!title || typeof title !== 'object' || Array.isArray(title)) {
    throw new Error('Prepare failed: contest.title must be a string or object');
  }
  return title;
}

function prepareSyncFiles(dir, fileMap, rankKeys) {
  return rankKeys.map((uniqueKey) => prepareSyncFile(dir, uniqueKey, fileMap[uniqueKey]));
}

function isReusableRankMainFile(remoteFile, contestId, file) {
  return Boolean(
    remoteFile &&
      remoteFile.contestId === contestId &&
      remoteFile.category === RANK_MAIN_FILE_CATEGORY &&
      remoteFile.hashType === 'sha256' &&
      remoteFile.hashValue === file.sha256,
  );
}

function isContestUpToDate(contest, contestMetadata, fileID) {
  return (
    contest.srkFileID === fileID &&
    Object.entries(contestMetadata).every(([key, value]) =>
      isContestMetadataValueEqual(key, contest[key], value),
    )
  );
}

function isContestMetadataValueEqual(key, actual, expected) {
  if (key === 'startAt') {
    const actualTime = Date.parse(actual);
    const expectedTime = Date.parse(expected);
    return Number.isFinite(actualTime) && actualTime === expectedTime;
  }
  if (key === 'duration' || key === 'frozenDuration') {
    if (actual === null || expected === null) {
      return actual === expected;
    }
    return durationToSeconds(actual) === durationToSeconds(expected);
  }
  return util.isDeepStrictEqual(actual, expected);
}

function durationToSeconds(duration) {
  if (!Array.isArray(duration) || duration.length !== 2) {
    return Number.NaN;
  }
  const multipliers = { s: 1, min: 60, h: 3600, d: 86400 };
  return duration[0] * multipliers[duration[1]];
}

async function syncRank(file, options) {
  const dryRun = Boolean(options.dryRun);
  const logger = options.logger || console;
  const tempUploadingDir = options.tempUploadingDir;
  const taskRequest =
    options.taskRequest ||
    createBoundedRequest(options.request, {
      logger,
      sleep: options.sleep,
      maxRequests: options.maxRequests || MAX_RANK_TASK_REQUESTS,
    });

  logger.log(`Syncing rank ${file.uniqueKey}`);
  const contestPath = `contests/${encodeURIComponent(file.uniqueKey)}`;
  const publicContestPath = `public/${contestPath}`;
  const existingContest = await getApiResource(
    () => taskRequest.get(publicContestPath, { responseType: 'json' }),
    CONTEST_NOT_FOUND_CODE,
    `GET ${publicContestPath}`,
  );

  if (!existingContest && dryRun) {
    logger.log(`[dry-run] Would create contest ${file.uniqueKey}`);
    logger.log(`[dry-run] Would upload file ${file.uniqueKey}`);
    logger.log(`[dry-run] Would associate file with contest ${file.uniqueKey}`);
    return;
  }

  let contestId = existingContest && existingContest._id;
  if (!existingContest) {
    logger.log('Creating contest', file.uniqueKey);
    const created = assertApiSuccess(
      await taskRequest.post('contests', {
        json: { uk: file.uniqueKey, ...file.contestMetadata, users: [] },
        responseType: 'json',
      }),
      'POST contests',
    );
    contestId = created && created._id;
  }
  if (!contestId) {
    throw new Error(`Sync failed: contest ${file.uniqueKey} is missing _id`);
  }

  let fileID = existingContest && existingContest.srkFileID;
  let reusableFile = false;
  if (fileID) {
    const publicFilePath = `public/files/${encodeURIComponent(fileID)}`;
    const remoteFile = await getApiResource(
      () => taskRequest.get(publicFilePath, { responseType: 'json' }),
      FILE_NOT_FOUND_CODE,
      `GET ${publicFilePath}`,
    );
    reusableFile = isReusableRankMainFile(remoteFile, contestId, file);
    if (reusableFile) {
      logger.log(`Skipped cuz file ${file.uniqueKey} is up to date`);
    } else if (!remoteFile) {
      logger.log(`Remote file for ${file.uniqueKey} is missing, upload planned`);
    }
  }

  if (!reusableFile) {
    if (dryRun) {
      logger.log(`[dry-run] Would upload file ${file.uniqueKey}`);
    } else {
      logger.log('Uploading file', file.uniqueKey);
      const tempFilePath = path.join(
        tempUploadingDir,
        `${file.uniqueKey.replace(/[^a-zA-Z0-9_.-]/g, '_')}-${path.basename(file.filePath)}`,
      );
      await fs.writeFile(tempFilePath, file.fileContent);
      const uploadForm = new FormData();
      uploadForm.append('contestId', contestId);
      uploadForm.append('category', RANK_MAIN_FILE_CATEGORY);
      uploadForm.append('file', fs.createReadStream(tempFilePath), {
        filename: path.basename(file.filePath),
      });
      const uploaded = assertApiSuccess(
        await taskRequest.post('files', {
          body: uploadForm,
          responseType: 'json',
        }),
        'POST files',
      );
      fileID = uploaded && uploaded.id;
      if (!fileID) {
        throw new Error('Sync failed: file upload response is missing data.id');
      }
    }
  }

  if (dryRun) {
    logger.log(`[dry-run] Would associate file with contest ${file.uniqueKey}`);
    return;
  }
  if (
    existingContest &&
    reusableFile &&
    isContestUpToDate(existingContest, file.contestMetadata, fileID)
  ) {
    logger.log(`Skipped cuz rank ${file.uniqueKey} is up to date`);
    return;
  }

  logger.log('Updating contest', file.uniqueKey);
  assertApiSuccess(
    await taskRequest.patch(contestPath, {
      json: { ...file.contestMetadata, srkFileID: fileID },
      responseType: 'json',
    }),
    `PATCH ${contestPath}`,
  );
}

async function syncCollection(dir, config, options) {
  const dryRun = Boolean(options.dryRun);
  const logger = options.logger || console;
  const taskRequest = createBoundedRequest(options.request, {
    logger,
    sleep: options.sleep,
    maxRequests: MAX_COLLECTION_TASK_REQUESTS,
  });

  logger.log('Syncing collection', dir);
  const collectionPath = `collections/${encodeURIComponent(dir)}`;
  const publicCollectionPath = `public/${collectionPath}`;
  const existingCollection = await getApiResource(
    () => taskRequest.get(publicCollectionPath, { responseType: 'json' }),
    COLLECTION_NOT_FOUND_CODE,
    `GET ${publicCollectionPath}`,
  );

  if (existingCollection) {
    if (dryRun) {
      logger.log(`[dry-run] Would update collection ${dir}`);
      return;
    }
    logger.log('Updating collection', dir);
    assertApiSuccess(
      await taskRequest.patch(collectionPath, {
        json: { content: config },
        responseType: 'json',
      }),
      `PATCH ${collectionPath}`,
    );
  } else {
    if (dryRun) {
      logger.log(`[dry-run] Would create collection ${dir}`);
      return;
    }
    logger.log('Creating collection', dir);
    assertApiSuccess(
      await taskRequest.post('collections', {
        json: { uk: dir, content: config },
        responseType: 'json',
      }),
      'POST collections',
    );
  }
}

function resolveSyncTargets(dir, fileMap, options = {}) {
  if (
    !canUseIncrementalDiff({
      changedFrom: options.changedFrom,
      changedTo: options.changedTo,
      git: options.git,
      cwd: options.cwd,
    })
  ) {
    return {
      fullSync: true,
      rankKeys: Object.keys(fileMap),
      syncCollection: true,
      changedFiles: undefined,
    };
  }

  const changedFiles = getChangedFiles({
    changedFrom: options.changedFrom,
    changedTo: options.changedTo,
    dir,
    git: options.git,
    cwd: options.cwd,
  });
  return {
    ...resolveIncrementalTargets({ dir, fileMap, changedFiles }),
    changedFiles,
  };
}

async function sync(dir, options = {}) {
  const logger = options.logger || console;
  const request = options.request || createRequest();
  logger.log(
    `Starting sync collection ${dir}${
      options.dryRun ? ' (dry-run)' : ''
    } (max concurrency ${SYNC_CONCURRENCY})`,
  );
  const startedAt = Date.now();
  const tempUploadingDir = path.resolve(os.tmpdir(), 'rl-srk-collection-sync');
  await fs.ensureDir(tempUploadingDir);

  try {
    const { config, fileMap } = parseConfig(dir);
    const targets = resolveSyncTargets(dir, fileMap, options);

    if (targets.fullSync) {
      logger.log('Running full sync');
    } else {
      logger.log(
        `Changed files: ${
          targets.changedFiles.length ? targets.changedFiles.join(', ') : '(none)'
        }`,
      );
      logger.log(
        `Incremental targets: ${targets.rankKeys.length} rank(s), collection ${
          targets.syncCollection ? 'yes' : 'no'
        }`,
      );
    }

    if (targets.rankKeys.length === 0 && !targets.syncCollection) {
      logger.log('No relevant changes found, skipping sync');
      return;
    }

    const files = prepareSyncFiles(dir, fileMap, targets.rankKeys);
    const queue = new PQueue({ concurrency: SYNC_CONCURRENCY });
    const failures = [];
    const rankTasks = files.map((file) =>
      queue.add(async () => {
        try {
          await syncRank(file, {
            dryRun: options.dryRun,
            logger,
            request,
            sleep: options.sleep,
            tempUploadingDir,
          });
        } catch (error) {
          logger.error(`Sync failed for ${file.uniqueKey}:`, error);
          failures.push({ file, error });
          throw error;
        }
      }),
    );

    await Promise.allSettled(rankTasks);

    if (failures.length > 0) {
      throw new Error(
        `Some ranklists failed to sync: ${failures.map(({ file }) => file.uniqueKey).join(', ')}`,
      );
    }

    if (targets.syncCollection) {
      await syncCollection(dir, config, {
        dryRun: options.dryRun,
        logger,
        request,
        sleep: options.sleep,
      });
    }

    logger.log(`Done in ${Date.now() - startedAt}ms`);
  } finally {
    await fs.remove(tempUploadingDir);
  }
}

async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  if (!process.env.RL_API_AUTH_TOKEN) {
    console.warn('No API token provided. Sync may fail');
  }

  try {
    await sync(parsed.dir, parsed);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  RetryExhaustedError,
  buildContestMetadata,
  canUseIncrementalDiff,
  createBoundedRequest,
  createRequest,
  getChangedFiles,
  getRequestTimeoutMs,
  isRetriableError,
  parseCliArgs,
  parseNameStatusDiff,
  prepareSyncFile,
  prepareSyncFiles,
  resolveIncrementalTargets,
  resolveSyncTargets,
  sync,
  syncCollection,
  syncRank,
  withRequestRetry,
};
