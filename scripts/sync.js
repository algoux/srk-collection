const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const got = require('got');
const { default: PQueue } = require('p-queue');
const FormData = require('form-data');
const { parseConfig } = require('./parse');

const queue = new PQueue({ concurrency: 20 });

const req = got.extend({
  prefixUrl: 'https://rl-api.algoux.cn/',
  headers: {
    algoux: process.env.ALGOUX_API_TOKEN,
  },
  timeout: 30000,
  retry: {
    limit: 3,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'],
    calculateDelay: ({ error, attemptCount }) => {
      console.log(`Retrying request due to error: ${error.code} ${error.message} (attempt ${attemptCount})`);
      return 1000;
    },
  },
});

async function sync(dir) {
  console.log(`Starting sync collection ${dir} (in parallel)`);
  const _s = Date.now();
  const tempUploadingDir = path.resolve(os.tmpdir(), 'rl-srk-collection-sync');
  await fs.ensureDir(tempUploadingDir);
  const { config, fileMap } = parseConfig(dir);
  // sync srk files
  const files = Object.keys(fileMap).map((uniqueKey) => {
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
          fileContent: Buffer.from(JSON.stringify(fileJson), 'utf8'),
        };
      }
      default:
        throw new Error(
          `Prepare failed for ${uniqueKey}: unknown file format ${fileMap[uniqueKey]}`,
        );
    }
  });
  let hasError = false;
  for (const file of files) {
    queue.add(async () => {
      console.log('Syncing rank', file.uniqueKey);
      try {
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
            if (
              Buffer.isBuffer(remoteFileContent.body) &&
              remoteFileContent.body.equals(file.fileContent)
            ) {
              console.log(`Skipped cuz file ${file.uniqueKey} is up to date`);
              needUpload = false;
              if (checkRes.data.name === file.name) {
                console.log(`Skipped cuz rank ${file.uniqueKey} is up to date`);
                return;
              }
            }
          } catch (e) {
            if (!e.response) {
              throw e;
            }
            if (e.response.statusCode !== 404) {
              throw e;
            } else {
              // file not found, upload it later
            }
          }
          isUpsert = true;
        } else if (checkRes.code !== 11) {
          throw new Error(
            `Sync failed: unknown response (code: ${checkRes.code}) when checking remote rank`,
          );
        }
        // upload file
        let fileID = checkRes && checkRes.code === 0 ? checkRes.data.fileID : undefined;
        if (needUpload) {
          console.log('Uploading file', file.uniqueKey);
          const tempFilePath = path.join(tempUploadingDir, path.basename(file.filePath));
          await fs.writeFile(tempFilePath, file.fileContent);
          const uploadForm = new FormData();
          uploadForm.append('file', fs.createReadStream(tempFilePath));
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
      } catch (e) {
        console.error(`Sync failed for ${file.uniqueKey}:`, e);
        hasError = true;
        throw e;
      }
    });
  }
  await queue.onIdle();

  if (hasError) {
    console.error('Some ranklists failed to sync, aborting collection sync');
    await fs.remove(tempUploadingDir);
    process.exit(1);
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
    const { body: updateCollectionRes } = await req.put(
      `rank/group/${checkCollectionRes.data.id}`,
      {
        json: {
          name: config.name,
          content: JSON.stringify(config),
        },
        responseType: 'json',
      },
    );
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
    throw new Error(
      `Sync failed: unknown response (code: ${checkCollectionRes.code}) when checking remote collection`,
    );
  }
  await fs.remove(tempUploadingDir);
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
