#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function usage() {
  return [
    'Usage: node scripts/fix-sequential-user-ids.js <dir>',
    '',
    'Recursively scans <dir> for srk.json and *.srk.json files.',
    'If row ids look like generated 1-based row indexes, rewrites every row user.id to user.name.',
  ].join('\n');
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

function normalizeRelativePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function hasPatchableUserName(row) {
  return (
    row?.user &&
    typeof row.user === 'object' &&
    typeof row.user.name === 'string' &&
    row.user.name.length > 0
  );
}

function rowIdMatchesOneBasedIndex(row, index) {
  return hasPatchableUserName(row) && row.user.id === String(index + 1);
}

function getPositiveScoreReason(rows) {
  const positiveScoreRows = rows.filter((row) => row?.score?.value > 0);
  if (positiveScoreRows.length === 0) {
    return null;
  }

  if (positiveScoreRows.every((row, index) => rowIdMatchesOneBasedIndex(row, index))) {
    return 'positive-score rows';
  }

  return null;
}

function getFirstHalfReason(rows) {
  const sampleSize = Math.ceil(rows.length / 2);
  if (sampleSize === 0) {
    return null;
  }

  const sampleRows = rows.slice(0, sampleSize);
  if (sampleRows.every((row, index) => rowIdMatchesOneBasedIndex(row, index))) {
    return 'first 50% rows';
  }

  return null;
}

function getFirstHundredReason(rows) {
  const sampleSize = Math.min(100, rows.length);
  if (sampleSize === 0) {
    return null;
  }

  const sampleRows = rows.slice(0, sampleSize);
  if (sampleRows.every((row, index) => rowIdMatchesOneBasedIndex(row, index))) {
    return 'first 100 rows';
  }

  return null;
}

function getRepairReason(srk) {
  if (!srk || !Array.isArray(srk.rows) || srk.rows.length === 0) {
    return null;
  }

  if (!srk.rows.every(hasPatchableUserName)) {
    return null;
  }

  return (
    getPositiveScoreReason(srk.rows) ||
    getFirstHalfReason(srk.rows) ||
    getFirstHundredReason(srk.rows)
  );
}

function patchSrk(srk) {
  const result = {
    changed: false,
    patchedRows: 0,
    reason: null,
  };

  const reason = getRepairReason(srk);
  if (!reason) {
    return result;
  }

  result.reason = reason;
  for (const row of srk.rows) {
    if (row.user.id !== row.user.name) {
      row.user.id = row.user.name;
      result.patchedRows += 1;
    }
  }

  result.changed = result.patchedRows > 0;
  return result;
}

function processDirectory(dir) {
  const rootDir = path.resolve(dir);
  const srkFiles = collectSrkFiles(rootDir);
  const result = {
    rootDir,
    scannedFiles: srkFiles.length,
    patchedFiles: [],
  };

  for (const filePath of srkFiles) {
    const srk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const patchResult = patchSrk(srk);
    if (!patchResult.changed) {
      continue;
    }

    fs.writeFileSync(filePath, JSON.stringify(srk, null, 2));
    result.patchedFiles.push({
      filePath,
      relativePath: normalizeRelativePath(path.relative(rootDir, filePath)),
      patchedRows: patchResult.patchedRows,
      reason: patchResult.reason,
    });
  }

  return result;
}

function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    return { help: true };
  }

  if (argv.length !== 1) {
    throw new Error('Expected exactly one directory argument');
  }

  return { dir: argv[0] };
}

function renderReport(result) {
  const lines = [
    `Scanned ${result.scannedFiles} SRK files in ${result.rootDir}`,
    `Patched ${result.patchedFiles.length} files`,
  ];

  if (result.patchedFiles.length === 0) {
    lines.push('No repairable files found.');
    return lines.join('\n');
  }

  for (const patchedFile of result.patchedFiles) {
    lines.push(
      `- ${patchedFile.relativePath}: ${patchedFile.patchedRows} rows (${patchedFile.reason})`,
    );
  }

  return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }

  const result = processDirectory(options.dir);
  console.log(renderReport(result));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    console.error('');
    console.error(usage());
    process.exitCode = 1;
  }
}

module.exports = {
  collectSrkFiles,
  getRepairReason,
  isSrkJsonFile,
  parseArgs,
  patchSrk,
  processDirectory,
  renderReport,
};
