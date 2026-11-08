const { randomUUID } = require('crypto');
const { appendFileSync } = require('fs');

const MAX_RANKLISTS = 10;
const MAX_BODY_LENGTH = 4000;

function escapeMarkdownLabel(value) {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]]/g, '\\$&');
}

function ranklistLink({ uniqueKey, name }) {
  const key = encodeURIComponent(uniqueKey).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `- [${escapeMarkdownLabel(name)}](https://rank.ac/${key})`;
}

function buildSyncNotification({ summary, commit, repositoryUrl, runUrl }) {
  if (
    !summary ||
    summary.synced !== true ||
    typeof summary.collectionUpdated !== 'boolean' ||
    !Array.isArray(summary.updatedRanks) ||
    (summary.updatedRanks.length === 0 && !summary.collectionUpdated) ||
    summary.updatedRanks.some(
      (rank) =>
        !rank ||
        typeof rank.uniqueKey !== 'string' ||
        !rank.uniqueKey.trim() ||
        typeof rank.name !== 'string' ||
        !rank.name.trim(),
    )
  ) {
    throw new Error('Expected a completed sync summary with updated ranklists or collection metadata.');
  }
  if (!/^[0-9a-f]{40}$/i.test(commit || '')) {
    throw new Error('Expected the synchronized commit SHA.');
  }
  for (const url of [repositoryUrl, runUrl]) {
    if (typeof url !== 'string' || !/^https:\/\//.test(url) || /[\s<>()[\]]/.test(url)) {
      throw new Error('Expected HTTPS repository and workflow URLs.');
    }
  }

  const ranks = summary.updatedRanks;
  const lines = ranks.map(ranklistLink);
  const heading = [
    '## Collection sync completed',
    '',
    `**Updated ranklists:** ${ranks.length}`,
    ...(summary.collectionUpdated ? ['Collection metadata updated.'] : []),
    '',
  ];
  const footer = [
    '',
    `Commit: [${commit.slice(0, 7)}](${repositoryUrl.replace(/\/$/, '')}/commit/${commit})`,
    `[View full sync summary](${runUrl}#summary)`,
  ];
  const render = (count) => [
    ...heading,
    ...(ranks.length ? lines.slice(0, count) : ['No ranklists changed.']),
    ...(count < ranks.length ? [`- … and ${ranks.length - count} more ranklists`] : []),
    ...footer,
  ].join('\n');

  let count = Math.min(MAX_RANKLISTS, ranks.length);
  let body = render(count);
  while (body.length > MAX_BODY_LENGTH && count > 0) {
    body = render(--count);
  }
  if (body.length > MAX_BODY_LENGTH) {
    throw new Error('Sync notification context exceeds the 4000-character body limit.');
  }
  return { body, markdown: render(ranks.length) };
}

function main() {
  const { body, markdown } = buildSyncNotification({
    summary: JSON.parse(process.env.SYNC_SUMMARY),
    commit: process.env.SYNC_COMMIT,
    repositoryUrl: process.env.REPOSITORY_URL,
    runUrl: process.env.WORKFLOW_RUN_URL,
  });
  if (!process.env.GITHUB_OUTPUT || !process.env.GITHUB_STEP_SUMMARY) {
    throw new Error('GITHUB_OUTPUT and GITHUB_STEP_SUMMARY are required.');
  }
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  const delimiter = `meowpush_${randomUUID()}`;
  appendFileSync(process.env.GITHUB_OUTPUT, `body<<${delimiter}\n${body}\n${delimiter}\n`);
}

if (require.main === module) {
  main();
}

module.exports = { buildSyncNotification };
