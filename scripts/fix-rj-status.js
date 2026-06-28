/**
 * 批量修复 RJ with 0 tries 这类情况，将 RJ 置为 null
 */

const fs = require('fs');
const path = require('path');

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

function patchStatus(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    return false;
  }

  if (status.result !== 'RJ' || status.tries !== 0) {
    return false;
  }

  status.result = null;
  delete status.tries;
  delete status.time;
  return true;
}

function patchSrk(srk) {
  const result = {
    changed: false,
    patchedStatuses: 0,
  };

  if (!srk || !Array.isArray(srk.rows)) {
    return result;
  }

  for (const row of srk.rows) {
    if (!row || !Array.isArray(row.statuses)) {
      continue;
    }

    for (const status of row.statuses) {
      if (patchStatus(status)) {
        result.patchedStatuses += 1;
      }
    }
  }

  result.changed = result.patchedStatuses > 0;
  return result;
}

function processOfficialDir(officialDir) {
  const srkFiles = collectSrkFiles(officialDir);
  const result = {
    scannedFiles: srkFiles.length,
    patchedFiles: 0,
    patchedStatuses: 0,
  };

  for (const filePath of srkFiles) {
    const srk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const patchResult = patchSrk(srk);
    if (!patchResult.changed) {
      continue;
    }

    fs.writeFileSync(filePath, JSON.stringify(srk, null, 2));
    result.patchedFiles += 1;
    result.patchedStatuses += patchResult.patchedStatuses;
  }

  return result;
}

function main(argv = process.argv.slice(2)) {
  const officialDir = path.resolve(argv[0] || path.join(__dirname, '..', 'official'));
  const result = processOfficialDir(officialDir);
  console.log(`Scanned ${result.scannedFiles} SRK files in ${officialDir}`);
  console.log(`Patched ${result.patchedStatuses} RJ statuses in ${result.patchedFiles} files`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = {
  collectSrkFiles,
  isSrkJsonFile,
  patchSrk,
  patchStatus,
  processOfficialDir,
};
