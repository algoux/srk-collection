const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');

function parseConfig(dir) {
  console.log(`Starting conversion of config.yaml in ${dir}`);
  const fileMap = {};
  const configPath = path.resolve(dir, 'config.yaml');
  const config = yaml.load(fs.readFileSync(configPath).toString());

  const convert = (item, base) => {
    item.path = item.path.replace(/\\/g, '/');
    const curPath = path.join(base, item.path);
    if (Array.isArray(item.children)) {
      // dir
      const children = item.children.map((item) => convert(item, curPath));
      return {
        type: 2,
        uniqueKey: `dir-${item.path}`,
        name: item.name,
        children,
      };
    } else if (item.format) {
      // file
      switch (item.format) {
        case 'srk.json': {
          const filePath = `${curPath}.${item.format}`;
          let fileDisplayName;
          try {
            const jsonContent = JSON.parse(fs.readFileSync(path.resolve(dir, filePath)).toString());
            const title = jsonContent.contest.title;
            if (typeof title === 'string') {
              fileDisplayName = title;
            } else if (typeof title === 'object') {
              fileDisplayName = title['zh-CN'] || title.fallback;
            } else {
              throw new Error(`Invalid title type ${typeof title}`);
            }
            if (!fileDisplayName) {
              throw new Error('Cannot find a valid contest name');
            }
          } catch (e) {
            console.error('Error parsing srk.json', e);
            throw e;
          }
          fileMap[item.path] = {
            format: item.format,
            path: filePath,
            name: fileDisplayName,
          };
          return {
            type: 1,
            uniqueKey: item.path,
            name: item.name,
          };
        }
        default:
          throw new Error(`Parse failed for ${curPath}: unknown file format ${item.format}`);
      }
    } else {
      throw new Error(
        `Parse failed for ${curPath}: it must be a dir (with children property) or a file (with format property)`,
      );
    }
  };

  const children = config.root.children.map((child) => convert(child, ''));

  const newConfig = {
    root: {
      children,
    },
  };

  console.log(`Finished conversion, found ${Object.keys(fileMap).length} files`);

  return {
    config: newConfig,
    fileMap,
  };
}

module.exports = {
  parseConfig,
};

// const { config: newConfig, fileMap } = parseConfig('official');
// fs.writeFileSync('new-config.json', JSON.stringify(newConfig, null, 2));
