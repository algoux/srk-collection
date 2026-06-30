#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const TIME_UNIT_MS = {
  ms: 1,
  s: 1000,
  min: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

function usage() {
  return [
    'Usage: node scripts/fix-fb.js <path> [--disable-fb-if-conflict]',
    '',
    'Arguments:',
    '  <path>                    directory to scan recursively, or a single SRK JSON file',
    '',
    'Options:',
    '  --disable-fb-if-conflict  skip all FB patches for a file when any problem has multiple',
    '                            same-time FB candidates',
  ].join('\n');
}

function parseArgs(argv = process.argv.slice(2)) {
  if (argv.length === 0) {
    throw new Error(usage());
  }

  if (argv.length > 2) {
    throw new Error(`Unknown argument: ${argv[2]}`);
  }

  const options = {
    targetPath: path.resolve(argv[0]),
    disableFBIfConflict: false,
    help: false,
  };

  if (argv[1] !== undefined) {
    if (argv[1] !== '--disable-fb-if-conflict') {
      throw new Error(`Unknown argument: ${argv[1]}`);
    }
    options.disableFBIfConflict = true;
  }

  return options;
}

function isSrkJsonFile(filePath) {
  const fileName = path.basename(filePath);
  return fileName === 'srk.json' || fileName.endsWith('.srk.json');
}

function collectSrkFiles(dir) {
  const files = [];
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSrkFiles(entryPath));
    } else if (entry.isFile() && isSrkJsonFile(entryPath)) {
      files.push(entryPath);
    }
  }

  return files;
}

function collectSrkTargetFiles(targetPath) {
  const resolvedPath = path.resolve(targetPath);
  const stats = fs.statSync(resolvedPath);

  if (stats.isDirectory()) {
    return collectSrkFiles(resolvedPath);
  }

  if (stats.isFile()) {
    return [resolvedPath];
  }

  throw new Error(`Unsupported path: ${targetPath}`);
}

function getTimeMs(time) {
  if (!Array.isArray(time) || time.length < 2) {
    return null;
  }

  const [value, unit] = time;
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    !Object.prototype.hasOwnProperty.call(TIME_UNIT_MS, unit)
  ) {
    return null;
  }

  return value * TIME_UNIT_MS[unit];
}

function cloneTime(time) {
  return Array.isArray(time) ? time.slice(0, 2) : time;
}

function getProblemAlias(srk, problemIndex) {
  const problem = Array.isArray(srk?.problems) ? srk.problems[problemIndex] : undefined;
  return typeof problem?.alias === 'string' ? problem.alias : null;
}

function getUserId(row) {
  const user = row?.user;
  if (!user) {
    return null;
  }

  if (user.id !== undefined && user.id !== null && `${user.id}` !== '') {
    return `${user.id}`;
  }

  if (typeof user.name === 'string') {
    return user.name;
  }

  if (user.name !== undefined) {
    return JSON.stringify(user.name);
  }

  return null;
}

function getUserName(row) {
  const name = row?.user?.name;
  if (typeof name === 'string') {
    return name;
  }

  if (name !== undefined) {
    return JSON.stringify(name);
  }

  return null;
}

function cleanCandidate(candidate) {
  return {
    rowIndex: candidate.rowIndex,
    userId: candidate.userId,
    userName: candidate.userName,
  };
}

function hasStatusFirstBlood(srk) {
  if (!Array.isArray(srk?.rows)) {
    return false;
  }

  return srk.rows.some(
    (row) => Array.isArray(row?.statuses) && row.statuses.some((status) => status?.result === 'FB'),
  );
}

function collectProblemFirstBloods(srk) {
  const bestByProblem = new Map();
  if (!Array.isArray(srk?.rows)) {
    return [];
  }

  srk.rows.forEach((row, rowIndex) => {
    if (!Array.isArray(row?.statuses)) {
      return;
    }

    row.statuses.forEach((status, problemIndex) => {
      if (status?.result !== 'AC') {
        return;
      }

      const timeMs = getTimeMs(status.time);
      if (timeMs === null) {
        return;
      }

      const candidate = {
        problemIndex,
        problemAlias: getProblemAlias(srk, problemIndex),
        rowIndex,
        userId: getUserId(row),
        userName: getUserName(row),
        status,
        time: cloneTime(status.time),
        timeMs,
      };
      const current = bestByProblem.get(problemIndex);

      if (!current || timeMs < current.timeMs) {
        bestByProblem.set(problemIndex, {
          problemIndex,
          problemAlias: candidate.problemAlias,
          time: candidate.time,
          timeMs,
          candidates: [candidate],
        });
      } else if (timeMs === current.timeMs) {
        current.candidates.push(candidate);
      }
    });
  });

  return [...bestByProblem.values()].sort((a, b) => a.problemIndex - b.problemIndex);
}

function formatConflict(group) {
  return {
    problemIndex: group.problemIndex,
    problemAlias: group.problemAlias,
    time: cloneTime(group.time),
    candidates: group.candidates.map(cleanCandidate),
  };
}

function patchSrk(srk, { disableFBIfConflict = false } = {}) {
  const result = {
    changed: false,
    patchedStatuses: 0,
    firstBloods: [],
    conflicts: [],
    skippedExistingFB: false,
    disabledByConflict: false,
  };

  if (!Array.isArray(srk?.rows)) {
    return result;
  }

  if (hasStatusFirstBlood(srk)) {
    result.skippedExistingFB = true;
    return result;
  }

  const groups = collectProblemFirstBloods(srk);
  result.conflicts = groups.filter((group) => group.candidates.length > 1).map(formatConflict);

  if (disableFBIfConflict && result.conflicts.length > 0) {
    result.disabledByConflict = true;
    return result;
  }

  for (const group of groups) {
    for (const candidate of group.candidates) {
      candidate.status.result = 'FB';
      result.patchedStatuses += 1;
      result.firstBloods.push({
        problemIndex: group.problemIndex,
        problemAlias: group.problemAlias,
        rowIndex: candidate.rowIndex,
        userId: candidate.userId,
        userName: candidate.userName,
        time: cloneTime(candidate.time),
      });
    }
  }

  result.changed = result.patchedStatuses > 0;
  return result;
}

function processPath(targetPath, options = {}) {
  const resolvedPath = path.resolve(targetPath);
  const srkFiles = collectSrkTargetFiles(resolvedPath);
  const result = {
    targetPath: resolvedPath,
    scannedFiles: srkFiles.length,
    patchedFiles: [],
    conflicts: [],
    disabledFiles: [],
  };

  for (const filePath of srkFiles) {
    const srk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const patchResult = patchSrk(srk, options);

    for (const conflict of patchResult.conflicts) {
      result.conflicts.push({ filePath, ...conflict });
    }

    if (patchResult.disabledByConflict) {
      result.disabledFiles.push(filePath);
    }

    if (!patchResult.changed) {
      continue;
    }

    fs.writeFileSync(filePath, JSON.stringify(srk, null, 2));
    result.patchedFiles.push({
      filePath,
      patchedStatuses: patchResult.patchedStatuses,
      firstBloods: patchResult.firstBloods,
    });
  }

  return result;
}

function processDirectory(dir, options = {}) {
  return processPath(dir, options);
}

function formatPath(filePath) {
  const relative = path.relative(process.cwd(), filePath);
  return relative && !relative.startsWith('..') ? relative : filePath;
}

function formatTime(time) {
  return Array.isArray(time) ? `${time[0]} ${time[1]}` : 'unknown time';
}

function formatProblem(conflict) {
  const indexLabel = `#${conflict.problemIndex + 1}`;
  return conflict.problemAlias ? `${conflict.problemAlias} (${indexLabel})` : indexLabel;
}

function formatCandidate(candidate) {
  const name =
    candidate.userName && candidate.userName !== candidate.userId ? ` ${candidate.userName}` : '';
  const id = candidate.userId || 'unknown-user';
  return `${id}${name} row ${candidate.rowIndex + 1}`;
}

function printResult(result, options) {
  console.log(`Scanned ${result.scannedFiles} SRK files in ${options.targetPath}`);

  if (result.patchedFiles.length === 0) {
    console.log('Patched files: none');
  } else {
    console.log('Patched files:');
    for (const file of result.patchedFiles) {
      console.log(`- ${formatPath(file.filePath)} (${file.patchedStatuses} FB statuses)`);
    }
  }

  if (result.conflicts.length > 0) {
    console.warn('Conflicts:');
    for (const conflict of result.conflicts) {
      const candidates = conflict.candidates.map(formatCandidate).join(', ');
      console.warn(
        `- ${formatPath(conflict.filePath)} problem ${formatProblem(conflict)} at ${formatTime(
          conflict.time,
        )}: ${candidates}`,
      );
    }
  }

  if (result.disabledFiles.length > 0) {
    console.warn(
      `FB calculation disabled for ${result.disabledFiles.length} files due to conflict.`,
    );
  }
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = processPath(options.targetPath, {
    disableFBIfConflict: options.disableFBIfConflict,
  });
  printResult(result, options);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}

module.exports = {
  collectProblemFirstBloods,
  collectSrkFiles,
  collectSrkTargetFiles,
  getTimeMs,
  hasStatusFirstBlood,
  isSrkJsonFile,
  parseArgs,
  patchSrk,
  processDirectory,
  processPath,
  usage,
};
