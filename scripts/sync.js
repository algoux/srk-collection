const path = require('path');
const fs = require('fs');
const got = require('got');
const md5 = require('md5');
const FormData = require('form-data');
const { parseConfig } = require('./parse');

const req = got.extend({
  prefixUrl: 'https://rl.mushan.top/',
  // prefixUrl: 'https://rl-dev.algoux.org/',
  headers: {
    algoux: process.env.ALGOUX_API_TOKEN,
  },
  timeout: 30000,
});

async function sync(dir) {
  console.log(`Starting sync collection ${dir}`);
  const _s = Date.now();
  const { config, fileMap } = parseConfig(dir);
  // sync srk files
  const files = Object.keys(fileMap).map((uniqueKey) => {
    const filePath = path.resolve(dir, fileMap[uniqueKey].path);
    switch (fileMap[uniqueKey].format) {
      case 'srk.json': {
        const fileContent = fs.readFileSync(path.resolve(dir, fileMap[uniqueKey].path));
        return {
          uniqueKey,
          name: fileMap[uniqueKey].name,
          filePath,
          fileContent,
        };
      }
      default:
        throw new Error(`Prepare failed for ${uniqueKey}: unknown file format ${fileMap[uniqueKey]}`);
    }
  });
  for (const file of files) {
    console.log('Syncing rank', file.uniqueKey);
    const { body: checkRes } = await req.get(`rank/${file.uniqueKey}`, {
      responseType: 'json',
    });
    if (!checkRes) {
      throw new Error('Sync failed: no response when checking remote rank');
    }
    let needUpload = true;
    let isUpsert = false;
    if (checkRes.code === 0) {
      try {
        const remoteFileContent = await req.get(`file/download?id=${checkRes.data.fileID}`, {
          responseType: 'buffer',
        });
        if (Buffer.isBuffer(remoteFileContent.body) && remoteFileContent.body.equals(file.fileContent)) {
          console.log(`Skipped cuz file ${file.uniqueKey} is up to date`);
          needUpload = false;
          if (checkRes.data.name === file.name) {
            console.log(`Skipped cuz rank ${file.uniqueKey} is up to date`);
            continue;
          }
        }
      } catch (e) {
        if (e.response.statusCode !== 404) {
          throw e;
        } else {
          // file not found, upload it later
        }
      }
      isUpsert = true;
    } else if (checkRes.code !== 11) {
      throw new Error(`Sync failed: unknown response (code: ${checkRes.code}) when checking remote rank`);
    }
    // upload file
    let fileID = checkRes && checkRes.code === 0 ? checkRes.data.fileID : undefined;
    if (needUpload) {
      console.log('Uploading file', file.uniqueKey);
      const uploadForm = new FormData();
      uploadForm.append('file', fs.createReadStream(file.filePath));
      const { body: uploadRes } = await req.post('file/upload', {
        body: uploadForm,
        responseType: 'json',
      });
      if (!(uploadRes && uploadRes.code === 0)) {
        console.error('Upload failed:', uploadRes);
        throw new Error('Sync failed: unexpected response when uploading file');
      }
      fileID = uploadRes.data.id;
    }
    // create or update rank
    if (!isUpsert) {
      console.log('Creating rank', file.uniqueKey);
      const { body: createRes } = await req.post('rank', {
        json: {
          uniqueKey: file.uniqueKey,
          name: file.name,
          fileID,
        },
        responseType: 'json',
      });
      if (!(createRes && createRes.code === 0)) {
        console.error('Create rank failed:', createRes);
        throw new Error('Sync failed: unexpected response when creating rank');
      }
    } else {
      console.log('Updating rank', file.uniqueKey);
      const { body: updateRes } = await req.put(`rank/${checkRes.data.id}`, {
        json: {
          uniqueKey: file.uniqueKey,
          name: file.name,
          fileID,
        },
        responseType: 'json',
      });
      if (!(updateRes && updateRes.code === 0)) {
        console.error('Update rank failed:', updateRes);
        throw new Error('Sync failed: unexpected response when updating rank');
      }
    }
  }

  console.log('Syncing collection', dir);
  const { body: checkCollectionRes } = await req.get(`rank/group/${dir}`, {
    responseType: 'json',
  });
  if (!checkCollectionRes) {
    throw new Error('Sync failed: no response when checking remote collection');
  }
  if (checkCollectionRes.code === 0) {
    console.log('Updating collection', dir);
    const { body: updateCollectionRes } = await req.put(`rank/group/${checkCollectionRes.data.id}`, {
      json: {
        name: config.name,
        content: JSON.stringify(config),
      },
      responseType: 'json',
    });
    if (!(updateCollectionRes && updateCollectionRes.code === 0)) {
      console.error('Update collection failed:', updateCollectionRes);
      throw new Error('Sync failed: unexpected response when updating collection');
    }
  } else if (checkCollectionRes.code === 11) {
    console.log('Creating collection', dir);
    const { body: createCollectionRes } = await req.post('rank/group', {
      json: {
        uniqueKey: dir,
        name: dir,
        content: JSON.stringify(config),
      },
      responseType: 'json',
    });
    if (!(createCollectionRes && createCollectionRes.code === 0)) {
      console.error('Create collection failed:', createCollectionRes);
      throw new Error('Sync failed: unexpected response when creating collection');
    }
  } else {
    throw new Error(`Sync failed: unknown response (code: ${checkCollectionRes.code}) when checking remote collection`);
  }
  console.log(`Done in ${Date.now() - _s}ms`);
}

if (!process.argv[2]) {
  console.error('Usage: node sync.js <collection_dir>');
  process.exit(1);
}
if (!process.env.ALGOUX_API_TOKEN) {
  console.warn('No API token provided. Sync may fail');
}

sync(process.argv[2]).catch((e) => {
  console.error(e);
  process.exit(1);
});
