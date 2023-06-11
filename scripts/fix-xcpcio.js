const path = require('path');
const fs = require('fs');
const { parseConfig } = require('./parse');

const srkDefaultBallonColors = [
  'rgba(189, 14, 14, 0.7)',
  'rgba(255, 144, 228, 0.7)',
  'rgba(255, 255, 255, 0.7)',
  'rgba(38, 185, 60, 0.7)',
  'rgba(239, 217, 9, 0.7)',
  'rgba(243, 88, 20, 0.7)',
  'rgba(12, 76, 138, 0.7)',
  'rgba(156, 155, 155, 0.7)',
  'rgba(4, 154, 115, 0.7)',
  'rgba(159, 19, 236, 0.7)',
  'rgba(42, 197, 202, 0.7)',
  'rgba(142, 56, 54, 0.7)',
  'rgba(0, 0, 0, 0.7)',
];

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
          if (
            fileJson.contributors &&
            fileJson.contributors.find((c) => c.toUpperCase().indexOf('XCPCIO') > -1)
          ) {
            return {
              uniqueKey,
              name: fileMap[uniqueKey].name,
              filePath,
              fileJson,
            };
          }
          return;
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
    const { series, rows, problems } = fileJson;
    let matchedBalloonColor = 0;
    problems.forEach((p, index) => {
      p.statistics = {
        accepted: 0,
        submitted: 0,
      };
      if (p.style) {
        delete p.style.textColor;
        if (srkDefaultBallonColors[index] === p.style.backgroundColor) {
          matchedBalloonColor++;
        }
      }
    });
    if (matchedBalloonColor >= problems.length * 0.7) {
      // maybe it's just a default balloon color copied from ccpc srk, not the contest real config.
      console.log('Remove balloon colors due to default color config detected');
      problems.forEach((p) => {
        delete p.style;
      });
    }
    rows.forEach((r) => {
      if (!Array.isArray(r.statuses) || r.statuses.length === 0) {
        r.statuses = new Array(problems.length).fill(0).map(() => ({ result: null }));
      }
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
    const icpcRkSeries = series.find((s) => s.rule && s.rule.preset === 'ICPC');
    if (icpcRkSeries) {
      const seriesOptions = icpcRkSeries.rule.options;
      if (
        (seriesOptions.count && seriesOptions.count.value[0] === 0) ||
        (seriesOptions.ratio && seriesOptions.ratio.value[0] === 0)
      ) {
        console.log('No ICPC medals');
        !fileJson.remarks &&
          (fileJson.remarks = {
            'zh-CN':
              '这个榜单缺失奖牌数据，如果您有该比赛的原始榜单或获奖名单，欢迎联系我们补充数据。',
            fallback:
              'This ranklist lacks medal data. If you have the original ranklist or the list of winners, please contact us to supplement the data.',
          });
      }
    }
    console.log(`Finished ${file.uniqueKey}`);
    fs.writeFileSync(file.filePath, JSON.stringify(fileJson, null, 2));
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
