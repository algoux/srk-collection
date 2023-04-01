const path = require('path');
const fs = require('fs');
const { parseConfig } = require('./parse');

function genSitemap(dir) {
  const { fileMap } = parseConfig(dir);
  let ids = Object.keys(fileMap).map(id => `https://rl.algoux.org/ranklist/${id}`);
  return ids.join('\n');
}

if (!process.argv[2]) {
  console.error('Usage: node sync.js <collection_dir>');
  process.exit(1);
}

const sitemapVol = genSitemap(process.argv[2]);
fs.writeFileSync('sitemap_ranklist_vol_1.txt', sitemapVol);
