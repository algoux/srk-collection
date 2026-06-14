const fs = require('fs');
const path = require('path');

const COACH_SUFFIXES = ['(教练)', '（教练）', '(coach)', '(Coach)'];
const TARGET_VERSION = '0.3.13';

function stripCoachSuffix(value) {
  if (typeof value !== 'string') {
    return { changed: false, value };
  }

  const trimmed = value.trim();
  for (const suffix of COACH_SUFFIXES) {
    if (trimmed.endsWith(suffix)) {
      return {
        changed: true,
        value: trimmed.slice(0, -suffix.length).trim(),
      };
    }
  }

  return { changed: false, value };
}

function patchMemberName(member) {
  if (!member || typeof member !== 'object') {
    return false;
  }

  if (typeof member.name === 'string') {
    const result = stripCoachSuffix(member.name);
    if (result.changed) {
      member.name = result.value;
      member.role = 'coach';
      return true;
    }
    return false;
  }

  if (!member.name || typeof member.name !== 'object' || Array.isArray(member.name)) {
    return false;
  }

  let changed = false;
  for (const key of Object.keys(member.name)) {
    const result = stripCoachSuffix(member.name[key]);
    if (result.changed) {
      member.name[key] = result.value;
      changed = true;
    }
  }

  if (changed) {
    member.role = 'coach';
  }
  return changed;
}

function isCoachMember(member) {
  return Boolean(member && typeof member === 'object' && member.role === 'coach');
}

function reorderCoachMembers(teamMembers) {
  const nonCoaches = [];
  const coaches = [];

  for (const member of teamMembers) {
    if (isCoachMember(member)) {
      coaches.push(member);
    } else {
      nonCoaches.push(member);
    }
  }

  const orderedMembers = nonCoaches.concat(coaches);
  const changed = orderedMembers.some((member, index) => member !== teamMembers[index]);
  if (changed) {
    teamMembers.splice(0, teamMembers.length, ...orderedMembers);
  }

  return changed;
}

function patchSrk(srk) {
  const result = {
    changed: false,
    patchedMembers: 0,
    reorderedRows: 0,
  };

  if (!srk || !Array.isArray(srk.rows)) {
    return result;
  }

  for (const row of srk.rows) {
    const teamMembers = row?.user?.teamMembers;
    if (!Array.isArray(teamMembers)) {
      continue;
    }

    for (const member of teamMembers) {
      if (patchMemberName(member)) {
        result.patchedMembers += 1;
      }
    }

    if (reorderCoachMembers(teamMembers)) {
      result.reorderedRows += 1;
    }
  }

  result.changed = result.patchedMembers > 0 || result.reorderedRows > 0;
  if (result.changed) {
    srk.version = TARGET_VERSION;
  }

  return result;
}

function patchCoachMembers(srk) {
  return patchSrk(srk).patchedMembers;
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

function processOfficialDir(officialDir) {
  const srkFiles = collectSrkFiles(officialDir);
  const result = {
    scannedFiles: srkFiles.length,
    patchedFiles: 0,
    patchedMembers: 0,
  };

  for (const filePath of srkFiles) {
    const srk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const patchResult = patchSrk(srk);
    if (!patchResult.changed) {
      continue;
    }

    fs.writeFileSync(filePath, JSON.stringify(srk, null, 2));
    result.patchedFiles += 1;
    result.patchedMembers += patchResult.patchedMembers;
  }

  return result;
}

function main(argv = process.argv.slice(2)) {
  const officialDir = path.resolve(argv[0] || path.join(__dirname, '..', 'official'));
  const result = processOfficialDir(officialDir);
  console.log(`Scanned ${result.scannedFiles} SRK files in ${officialDir}`);
  console.log(`Patched ${result.patchedMembers} coach members in ${result.patchedFiles} files`);
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
  COACH_SUFFIXES,
  TARGET_VERSION,
  collectSrkFiles,
  isCoachMember,
  patchCoachMembers,
  patchMemberName,
  patchSrk,
  processOfficialDir,
  reorderCoachMembers,
  stripCoachSuffix,
};
