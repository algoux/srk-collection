/**
 * batch convert srk from 0.2.x to 0.3.0
 */

const path = require('path');
const fs = require('fs');

const files = [
  './official/ccpc/ccpc2020/ccpc2020changchun.srk.json',
  './official/ccpc/ccpc2020/ccpc2020province-henan.srk.json',
  './official/ccpc/ccpc2020/ccpc2020final.srk.json',
  './official/ccpc/ccpc2020/ccpc2020mianyang.srk.json',
  './official/ccpc/ccpc2020/ccpc2020weihai.srk.json',
  './official/ccpc/ccpc2019/ccpc2019beijing.srk.json',
  './official/ccpc/ccpc2019/ccpc2019haerbin.srk.json',
  './official/ccpc/ccpc2022/ccpc2022mianyang.srk.json',
  './official/ccpc/ccpc2022/ccpc2022province-henan.srk.json',
  './official/ccpc/ccpc2022/ccpc2022guangzhou.srk.json',
  './official/ccpc/ccpc2022/ccpc2022guilin.srk.json',
  './official/ccpc/ccpc2022/ccpc2022weihai.srk.json',
  './official/ccpc/ccpc2021/ccpc2021ladies.srk.json',
  './official/icpc/icpc2021/icpc2021shanghai.srk.json',
  './official/icpc/icpc2021/icpc2021shenyang.srk.json',
  './official/icpc/icpc2021/icpc2021final.srk.json',
  './official/icpc/icpc2021/icpc2021jinan.srk.json',
  './official/icpc/icpc2021/icpc2021nanjing.srk.json',
  './official/icpc/icpc2022/icpc2022xian.srk.json',
  './official/icpc/icpc2022/icpc2022hefei.srk.json',
  './official/icpc/icpc2022/icpc2022shenyang.srk.json',
];

for (const file of files) {
  let data = JSON.parse(fs.readFileSync(path.resolve(file)).toString());
  console.log('Conv', path.resolve(file));
  delete data['type'];
  delete data['version'];
  data = {
    type: 'general',
    version: '0.3.0',
    ...data,
  };
  data.series.forEach((series, index) => {
    if (Array.isArray(series.segments)) {
      // use rows[].ranks as series count
      const seriesCounts = series.segments.map((seg) => seg.count);
      series.segments.forEach((seg) => {
        delete seg['count'];
      });
      let rankValueCounts = new Array(series.segments.length).fill(0);
      data.rows.forEach((row) => {
        if (!row.ranks || !row.ranks[index]) {
          console.error('FATAL: no `ranks` in row:', index, row);
          process.exit(1);
        }
        if (row.ranks[index].segmentIndex !== null && row.ranks[index].segmentIndex !== undefined) {
          rankValueCounts[row.ranks[index].segmentIndex]++;
        }
      });
      if (JSON.stringify(seriesCounts) !== JSON.stringify(rankValueCounts)) {
        console.error('series count mismatch:', seriesCounts, rankValueCounts);
      }
      const usingCounts = rankValueCounts;
      series.rule = {
        preset: 'ICPC',
        options: {
          count: {
            value: usingCounts,
          },
        },
      };
    } else if (series.title === 'R#') {
      series.rule = {
        preset: 'Normal',
        options: {},
      };
    } else if (series.title === 'S#') {
      series.rule = {
        preset: 'UniqByUserField',
        options: {
          field: 'organization',
          includeOfficialOnly: true,
        },
      };
    } else {
      console.warn('Unknown series', series);
    }
  });
  data.rows.forEach((row) => {
    delete row.ranks;
    let id = row.user.id ||row.user.name;
    delete row.user.id;
    row.user = {
      id,
      ...row.user,
    };
  });
  if (new Set(data.rows.map((row) => row.user.id)).size !== data.rows.length) {
    console.warn('duplicate user id found');
  }
  fs.writeFileSync(path.resolve('out', path.basename(file)), JSON.stringify(data));
}
