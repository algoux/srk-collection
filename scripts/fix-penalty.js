const path = require('path');
const fs = require('fs');
const { parseConfig } = require('./parse');

const excludeUniqueKeys = ['ccpc2019xiamen', 'icpc2025srni'];

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

// 检查单个文件的罚时问题
function checkFilePenalty(file, fixMode = false) {
  const { fileJson } = file;
  const { rows, sorter } = fileJson;
  const penaltyConfig = sorter?.config?.penalty || [20, 'min'];

  const timePrecision = sorter?.config?.timePrecision;
  const timeRounding = sorter?.config?.timeRounding || 'floor';

  const roundingFunc =
    {
      floor: Math.floor,
      ceil: Math.ceil,
      round: Math.round,
    }[timeRounding] || Math.floor;

  // 收集所有时间字段，找最精确单位
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
  let fixedIssues = 0;
  let needToSave = false;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    const { statuses, score } = row;
    let totalTimeValue = 0; // in compareUnit
    for (let statusIndex = 0; statusIndex < statuses.length; statusIndex++) {
      const status = statuses[statusIndex];
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
      if (fixMode) {
        // 修复模式：需要重新计算每个status的time
        for (let statusIndex = 0; statusIndex < statuses.length; statusIndex++) {
          const status = statuses[statusIndex];
          if (status.result && (status.result === 'AC' || status.result === 'FB')) {
            // 计算正确的status.time（不包含罚时）
            const penaltyTime = (status.tries - 1) * formatTimeDuration(penaltyConfig, 'ms');
            const correctStatusTime = formatTimeDuration(status.time, 'ms') - penaltyTime;

            // 写回时保持原单位
            status.time = [
              formatTimeDuration([correctStatusTime, 'ms'], status.time[1], roundingFunc),
              status.time[1],
            ];
            fixedIssues++;
            needToSave = true;
          }
        }
      }
    }
  }

  // 额外校验：在修复模式下，如果需要进行保存，重新检查修复后的结果是否符合条件
  if (fixMode && needToSave) {
    let verificationIssues = 0;
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      const { statuses, score } = row;
      let totalTimeValue = 0; // in compareUnit
      for (let statusIndex = 0; statusIndex < statuses.length; statusIndex++) {
        const status = statuses[statusIndex];
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
        verificationIssues++;
      }
    }

    // 如果校验发现问题，认为无法修复，不能保存
    if (verificationIssues > 0) {
      return { totalIssues, fixedIssues: 0, needToSave: false };
    }
  }

  return { totalIssues, fixedIssues, needToSave };
}

async function fix(dir, fixMode = false) {
  console.log(`${fixMode ? 'Fixing' : 'Checking'} penalty issues in collection ${dir}`);
  const _s = Date.now();
  const { config, fileMap } = parseConfig(dir);

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
  let totalIssues = 0;
  let totalFilesFixed = 0;

  for (const file of files) {
    if (excludeUniqueKeys.includes(file.uniqueKey)) continue;
    const { totalIssues: fileIssues, fixedIssues, needToSave } = checkFilePenalty(file, fixMode);

    if (fileIssues > 0) {
      totalFilesWithIssues++;
      totalIssues += fileIssues;

      if (fixMode) {
        if (needToSave) {
          fs.writeFileSync(file.filePath, JSON.stringify(file.fileJson, null, 2));
          console.log(`  Fixed ${fileIssues} issues in ${file.uniqueKey}`);
          totalFilesFixed++;
        } else {
          console.log(
            `  Found ${fileIssues} issues in ${file.uniqueKey} (could not fix all, may due to time precision)`,
          );
        }
      } else {
        console.log(`  Found ${fileIssues} issues in ${file.uniqueKey}`);
      }
    }
  }

  const duration = Date.now() - _s;

  if (fixMode) {
    console.log(`\nFix completed in ${duration}ms`);
    console.log(`Files with issues: ${totalFilesWithIssues}/${files.length}`);
    console.log(`Files fixed: ${totalFilesFixed}/${totalFilesWithIssues}`);
  } else {
    console.log(`\nCheck completed in ${duration}ms`);
    console.log(`Files with issues: ${totalFilesWithIssues}/${files.length}`);
    if (totalIssues > 0) {
      console.log(`\nUse -f flag to fix the issues`);
    }
  }
}

const args = process.argv.slice(2);
const fixMode = args.includes('-f');
const dir = args.find((arg) => !arg.startsWith('-'));

if (!dir) {
  console.error('Usage: node fix-penalty.js <collection_dir> [-f]');
  console.error('  -f: Fix the issues (default: check only)');
  process.exit(1);
}

fix(dir, fixMode).catch((e) => {
  console.error(e);
  process.exit(1);
});
