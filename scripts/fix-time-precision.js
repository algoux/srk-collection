const path = require('path');
const fs = require('fs');
const { parseConfig } = require('./parse');

const excludeUniqueKeys = ['icpc2025srni'];

function formatTimeDuration(time, targetUnit = 'ms', fmt = (num) => num) {
  let ms = -1;
  switch (time[1]) {
    case 'ms':
      ms = time[0];
      break;
    case 's':
      ms = time[0] * 1000;
      break;
    case 'min':
      ms = time[0] * 1000 * 60;
      break;
    case 'h':
      ms = time[0] * 1000 * 60 * 60;
      break;
    case 'd':
      ms = time[0] * 1000 * 60 * 60 * 24;
      break;
    default:
      throw new Error(`Invalid source time unit ${time[1]}`);
  }
  switch (targetUnit) {
    case 'ms':
      return ms;
    case 's':
      return fmt(ms / 1000);
    case 'min':
      return fmt(ms / 1000 / 60);
    case 'h':
      return fmt(ms / 1000 / 60 / 60);
    case 'd':
      return fmt(ms / 1000 / 60 / 60 / 24);
    default:
      throw new Error(`Invalid target time unit ${targetUnit}`);
  }
}

function getBestUnit(times) {
  const unitPriority = ['ms', 's', 'min', 'h', 'd'];
  let best = 'd';
  for (const t of times) {
    if (!t || !t[1]) continue;
    if (unitPriority.indexOf(t[1]) < unitPriority.indexOf(best)) {
      best = t[1];
    }
  }
  return best;
}

// 计算罚时,返回使用目标单位的数值
function calculatePenalty(time, tries, penaltyConfig, targetUnit, roundingFunc) {
  const totalTime =
    formatTimeDuration(time, 'ms') + (tries - 1) * formatTimeDuration(penaltyConfig, 'ms');
  const value = formatTimeDuration([totalTime, 'ms'], targetUnit, roundingFunc);
  return value;
}

// 检查单个配置组合是否正确
function checkConfig(fileJson, timePrecision, timeRounding) {
  const { rows, sorter } = fileJson;
  const penaltyConfig = sorter?.config?.penalty || [20, 'min'];

  const roundingFunc =
    {
      floor: Math.floor,
      ceil: Math.ceil,
      round: Math.round,
    }[timeRounding] || Math.floor;

  const allTimes = [];
  for (const row of rows) {
    if (row.score && row.score.time) allTimes.push(row.score.time);
    for (const status of row.statuses) {
      if (status.time) allTimes.push(status.time);
    }
  }
  const bestUnit = getBestUnit(allTimes);

  // 确定用于累加和比较的单位
  const compareUnit = timePrecision || bestUnit;

  let totalIssues = 0;

  for (const row of rows) {
    const { statuses, score } = row;
    let totalTimeValue = 0; // in compareUnit
    for (const status of statuses) {
      if (status.result && (status.result === 'AC' || status.result === 'FB')) {
        const statusTotalTime = calculatePenalty(
          status.time,
          status.tries,
          penaltyConfig,
          compareUnit,
          roundingFunc,
        );
        totalTimeValue += statusTotalTime;
      }
    }
    const scoreTotalTime = formatTimeDuration(score.time, compareUnit, roundingFunc);
    if (totalTimeValue !== scoreTotalTime) {
      totalIssues++;
    }
  }

  return totalIssues === 0;
}

// 检查单个文件的时间精度配置问题
function checkFileTimePrecision(file, fixMode = false) {
  const { fileJson } = file;
  const { sorter } = fileJson;

  const currentTimePrecision = sorter?.config?.timePrecision;
  const currentTimeRounding = sorter?.config?.timeRounding || 'floor';

  // 检查当前配置是否正确
  const currentConfigCorrect = checkConfig(fileJson, currentTimePrecision, currentTimeRounding);

  if (currentConfigCorrect) {
    return { hasIssues: false, canFix: false, correctConfig: null };
  }

  // 尝试不同的配置组合
  const timePrecisions = [undefined, 'ms', 's', 'min', 'h'];
  const timeRoundings = ['floor', 'ceil', 'round'];

  for (const precision of timePrecisions) {
    for (const rounding of timeRoundings) {
      if (checkConfig(fileJson, precision, rounding)) {
        const correctConfig = { timePrecision: precision, timeRounding: rounding };

        if (fixMode) {
          // 修复模式：更新配置
          if (!sorter.config) {
            sorter.config = {};
          }
          sorter.config.timePrecision = precision;
          sorter.config.timeRounding = rounding;
        }

        return {
          hasIssues: true,
          canFix: true,
          correctConfig,
          currentConfig: { timePrecision: currentTimePrecision, timeRounding: currentTimeRounding },
        };
      }
    }
  }

  // 没有找到正确的配置
  return {
    hasIssues: true,
    canFix: false,
    correctConfig: null,
    currentConfig: { timePrecision: currentTimePrecision, timeRounding: currentTimeRounding },
  };
}

async function fix(dir, fixMode = false) {
  console.log(`${fixMode ? 'Fixing' : 'Checking'} time precision issues in collection ${dir}`);
  const _s = Date.now();
  const { config, fileMap } = parseConfig(dir);

  // 同步 srk 文件
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

  console.log(`Found ${files.length} ranklists to ${fixMode ? 'fix' : 'check'}`);

  let totalFilesWithIssues = 0;
  let totalFilesCanFix = 0;

  for (const file of files) {
    if (excludeUniqueKeys.includes(file.uniqueKey)) continue;
    const { hasIssues, canFix, correctConfig, currentConfig } = checkFileTimePrecision(
      file,
      fixMode,
    );

    if (hasIssues) {
      totalFilesWithIssues++;

      if (canFix) {
        totalFilesCanFix++;
        if (fixMode) {
          fs.writeFileSync(file.filePath, JSON.stringify(file.fileJson, null, 2));
          console.log(
            `  Fixed ${file.uniqueKey}: ${JSON.stringify(currentConfig)} -> ${JSON.stringify(
              correctConfig,
            )}`,
          );
        } else {
          console.log(
            `  Found issue in ${file.uniqueKey}: ${JSON.stringify(
              currentConfig,
            )} -> ${JSON.stringify(correctConfig)}`,
          );
        }
      } else {
        console.log(
          `  Found issue in ${file.uniqueKey}: ${JSON.stringify(currentConfig)} (cannot fix)`,
        );
      }
    }
  }

  const duration = Date.now() - _s;

  if (fixMode) {
    console.log(`\nFix completed in ${duration}ms`);
    console.log(`Files with issues: ${totalFilesWithIssues}/${files.length}`);
    console.log(`Files fixed: ${totalFilesCanFix}/${totalFilesWithIssues}`);
  } else {
    console.log(`\nCheck completed in ${duration}ms`);
    console.log(`Files with issues: ${totalFilesWithIssues}/${files.length}`);
    console.log(`Files can be fixed: ${totalFilesCanFix}/${totalFilesWithIssues}`);
    if (totalFilesCanFix > 0) {
      console.log(`\nUse -f flag to fix the issues`);
    }
  }
}

// 解析命令行参数
const args = process.argv.slice(2);
const fixMode = args.includes('-f');
const dir = args.find((arg) => !arg.startsWith('-'));

if (!dir) {
  console.error('Usage: node fix-time-precision.js <collection_dir> [-f]');
  console.error('  -f: Fix the issues (default: check only)');
  process.exit(1);
}

fix(dir, fixMode).catch((e) => {
  console.error(e);
  process.exit(1);
});
