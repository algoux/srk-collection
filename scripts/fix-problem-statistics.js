const path = require('path');
const fs = require('fs');
const { parseConfig } = require('./parse');

async function fix(dir) {
  console.log(`Fixing collection ${dir}`);
  const _s = Date.now();
  const { config, fileMap } = parseConfig(dir);
  // sync srk files
  const files = Object.keys(fileMap)
    .map((uniqueKey) => {
      const filePath = path.resolve(dir, fileMap[uniqueKey].path);
      switch (fileMap[uniqueKey].format) {
        case 'srk.json': {
          const fileJson = JSON.parse(
            fs.readFileSync(path.resolve(dir, fileMap[uniqueKey].path), 'utf8'),
          );
          return {
            uniqueKey,
            name: fileMap[uniqueKey].name,
            filePath,
            fileJson,
          };
        }
        default:
          throw new Error(
            `Prepare failed for ${uniqueKey}: unknown file format ${fileMap[uniqueKey]}`,
          );
      }
    })
    .filter(Boolean);
  console.log(`Found ${files.length} ranklists to fix`);

  for (const file of files) {
    // console.log('file', file);
    const { fileJson } = file;
    const { rows, problems } = fileJson;
    let needToFix = false;
    problems.forEach((p) => {
      if (!p.statistics) {
        needToFix = true;
        p.statistics = {
          accepted: 0,
          submitted: 0,
        };
      }
    });
    if (needToFix) {
      rows.forEach((r) => {
        r.statuses.forEach((s, index) => {
          if (!s.result) {
            return;
          }
          if (s.result === 'AC' || s.result === 'FB') {
            problems[index].statistics.accepted++;
          }
          problems[index].statistics.submitted += s.tries;
        });
      });
      fs.writeFileSync(file.filePath, JSON.stringify(fileJson, null, 2));
      console.log(`Finished ${file.uniqueKey}`);
    }
  }
}

if (!process.argv[2]) {
  console.error('Usage: node fix-xcpcio.js <collection_dir>');
  process.exit(1);
}

fix(process.argv[2]).catch((e) => {
  console.error(e);
  process.exit(1);
});
