#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function usage() {
  return [
    'Usage: node scripts/fix-problem-statistics.js <path>',
    '',
    'Arguments:',
    '  <path>  directory to scan recursively, or a single SRK JSON file',
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

function collectTargetFiles(targetPath) {
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

function patchSrk(srk) {
  const result = {
    changed: false,
    patchedProblems: 0,
  };
  const { rows, problems } = srk;

  problems.forEach((problem) => {
    if (!problem.statistics) {
      result.changed = true;
      result.patchedProblems += 1;
      problem.statistics = {
        accepted: 0,
        submitted: 0,
      };
    }
  });

  if (!result.changed) {
    return result;
  }

  rows.forEach((row) => {
    row.statuses.forEach((status, index) => {
      if (!status.result) {
        return;
      }
      if (status.result === 'AC' || status.result === 'FB') {
        problems[index].statistics.accepted++;
      }
      problems[index].statistics.submitted += status.tries;
    });
  });

  return result;
}

async function fix(targetPath) {
  const resolvedPath = path.resolve(targetPath);
  console.log(`Fixing ${resolvedPath}`);
  const files = collectTargetFiles(resolvedPath);
  console.log(`Found ${files.length} ranklists to fix`);

  const result = {
    targetPath: resolvedPath,
    scannedFiles: files.length,
    patchedFiles: [],
  };

  for (const filePath of files) {
    const fileJson = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const patchResult = patchSrk(fileJson);
    if (!patchResult.changed) {
      continue;
    }

    fs.writeFileSync(filePath, JSON.stringify(fileJson, null, 2));
    result.patchedFiles.push({
      filePath,
      patchedProblems: patchResult.patchedProblems,
    });
    console.log(`Finished ${filePath}`);
  }

  return result;
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) {
    throw new Error(usage());
  }

  return fix(argv[0]);
}

if (require.main === module) {
  Promise.resolve()
    .then(() => main())
    .catch((error) => {
      console.error(error.message || error);
      process.exitCode = 1;
    });
}

module.exports = {
  collectSrkFiles,
  collectTargetFiles,
  fix,
  isSrkJsonFile,
  patchSrk,
  usage,
};
