#!/usr/bin/env node

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const VALID_COMMANDS = new Set(['validate', 'diagnose']);

function usage() {
  return [
    'Usage: node scripts/run-srk-diff-command.js --command <validate|diagnose> --base <sha> --head <sha> [options]',
    '',
    'Options:',
    '  --worktree <path>              git worktree to inspect (default: current directory)',
    '  --srk-bin <path>               srk executable path (default: ./node_modules/.bin/srk)',
    '  --comment-markdown <path>      write a diagnose PR comment body to this path',
    '  --comment-job-url <url>        Actions log URL to include in the diagnose PR comment',
    '  --allow-command-failures       continue and exit 0 even when srk commands fail',
    '  -h, --help                     print this help',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    allowCommandFailures: false,
    worktree: '.',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    switch (arg) {
      case '--command':
        options.command = argv[(i += 1)];
        break;
      case '--base':
        options.base = argv[(i += 1)];
        break;
      case '--head':
        options.head = argv[(i += 1)];
        break;
      case '--worktree':
        options.worktree = argv[(i += 1)];
        break;
      case '--srk-bin':
        options.srkBin = argv[(i += 1)];
        break;
      case '--comment-markdown':
        options.commentMarkdown = argv[(i += 1)];
        break;
      case '--comment-job-url':
        options.commentJobUrl = argv[(i += 1)];
        break;
      case '--allow-command-failures':
        options.allowCommandFailures = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.help) {
    return options;
  }

  if (!VALID_COMMANDS.has(options.command)) {
    throw new Error('--command must be either validate or diagnose');
  }

  if (!options.base) {
    throw new Error('--base is required');
  }

  if (!options.head) {
    throw new Error('--head is required');
  }

  return options;
}

function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function parseNameStatusDiffZ(output) {
  const tokens = output.toString('utf8').split('\0');
  if (tokens[tokens.length - 1] === '') {
    tokens.pop();
  }

  const files = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i];
    i += 1;

    if (!status) {
      continue;
    }

    if (status[0] === 'D') {
      i += 1;
      continue;
    }

    let filePath;
    if (status[0] === 'R' || status[0] === 'C') {
      i += 1;
      filePath = tokens[i];
      i += 1;
    } else {
      filePath = tokens[i];
      i += 1;
    }

    if (filePath && normalizePath(filePath).endsWith('.srk.json')) {
      files.push(normalizePath(filePath));
    }
  }

  return [...new Set(files)];
}

function getChangedSrkFiles({ base, head, worktree }) {
  const diff = childProcess.execFileSync(
    'git',
    ['diff', '--name-status', '-z', '--diff-filter=ACMRT', base, head],
    {
      cwd: worktree,
      encoding: 'buffer',
    },
  );

  return parseNameStatusDiffZ(diff);
}

function getDefaultSrkBin(rootDir) {
  const binaryName = process.platform === 'win32' ? 'srk.cmd' : 'srk';
  return path.join(rootDir, 'node_modules', '.bin', binaryName);
}

function escapeWorkflowCommand(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeWorkflowProperty(value) {
  return escapeWorkflowCommand(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function startGroup(title) {
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log(`::group::${escapeWorkflowCommand(title)}`);
    return;
  }

  console.log(`## ${title}`);
}

function endGroup() {
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log('::endgroup::');
  }
}

function formatCommandFailure(result) {
  if (result.error) {
    return result.error.message;
  }

  if (result.signal) {
    return `terminated by signal ${result.signal}`;
  }

  return `exit code ${result.status}`;
}

function combineCommandOutput(result) {
  if (result.stdout && result.stderr) {
    return `${result.stdout.replace(/\s*$/, '\n')}${result.stderr}`;
  }

  return result.stdout || result.stderr || '';
}

function runSrkCommand({ command, filePath, srkBin, worktree }) {
  startGroup(`srk ${command} ${filePath}`);
  const result = childProcess.spawnSync(srkBin, [command, filePath], {
    cwd: worktree,
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  endGroup();

  return {
    ...result,
    output: combineCommandOutput(result),
  };
}

function appendGitHubOutputs(outputs) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

function escapeMarkdownCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function appendStepSummary({ command, files, results, allowCommandFailures }) {
  if (!process.env.GITHUB_STEP_SUMMARY) {
    return;
  }

  const failures = results.filter((result) => !result.ok);
  const lines = [
    `## SRK ${command}`,
    '',
    `Changed SRK files: ${files.length}`,
    `Command failures: ${failures.length}`,
  ];

  if (allowCommandFailures && failures.length > 0) {
    lines.push('Command failures were recorded without failing this workflow.');
  }

  if (results.length > 0) {
    lines.push('', '| File | Result |', '| --- | --- |');
    for (const result of results) {
      lines.push(
        `| \`${escapeMarkdownCell(result.filePath)}\` | ${
          result.ok ? 'PASS' : escapeMarkdownCell(result.failure)
        } |`,
      );
    }
  }

  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

function reportValidateFailure(filePath, failure) {
  if (process.env.GITHUB_ACTIONS !== 'true') {
    return;
  }

  console.error(
    `::error file=${escapeWorkflowProperty(filePath)}::srk validate failed: ${escapeWorkflowCommand(
      failure,
    )}`,
  );
}

function extractDiagnoseSummary(output) {
  const match = String(output || '').match(
    /^Issues:\s+\d+\s+\(error\s+\d+,\s+warning\s+\d+,\s+info\s+\d+\)$/m,
  );
  return match ? match[0] : 'Issues: unknown';
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderDiagnoseComment({ jobUrl, fileCount, failureCount, results }) {
  const lines = [
    '<!-- srk-diagnose-log -->',
    '### SRK diagnose report',
    '',
    `Diagnose ran for ${fileCount} changed \`.srk.json\` file(s).`,
    '',
  ];

  if (failureCount > 0) {
    lines.push(
      `Diagnose command failures were recorded for ${failureCount} file(s); inspect the details below and the Actions log.`,
      '',
    );
  }

  if (jobUrl) {
    lines.push(`[Open diagnose job log](${jobUrl})`, '');
  }

  if (results.length === 0) {
    lines.push('No changed `.srk.json` files were found.');
    return lines.join('\n');
  }

  for (const result of results) {
    const output = result.output || '(no output)';
    lines.push(
      '<details>',
      `<summary><code>${escapeHtml(result.filePath)}</code> - ${escapeHtml(
        extractDiagnoseSummary(result.output),
      )}</summary>`,
      '',
      '<pre><code>',
      escapeHtml(output).replace(/\s+$/, '').trim(),
      '</code></pre>',
      '',
      '</details>',
      '',
    );
  }

  return lines.join('\n').replace(/\n+$/, '\n');
}

function writeDiagnoseComment({ filePath, jobUrl, files, results }) {
  if (!filePath) {
    return;
  }

  const failures = results.filter((result) => !result.ok);
  fs.writeFileSync(
    filePath,
    renderDiagnoseComment({
      jobUrl,
      fileCount: files.length,
      failureCount: failures.length,
      results,
    }),
  );
}

function run(options) {
  const rootDir = process.cwd();
  const worktree = path.resolve(rootDir, options.worktree);
  const srkBin = path.resolve(rootDir, options.srkBin || getDefaultSrkBin(rootDir));
  const files = getChangedSrkFiles({
    base: options.base,
    head: options.head,
    worktree,
  });

  console.log(`Diff base: ${options.base}`);
  console.log(`Diff head: ${options.head}`);
  console.log(`Worktree: ${worktree}`);
  console.log(`Changed .srk.json files: ${files.length}`);

  if (files.length === 0) {
    console.log(`No changed .srk.json files to ${options.command}.`);
    appendGitHubOutputs({
      file_count: 0,
      failure_count: 0,
    });
    appendStepSummary({
      command: options.command,
      files,
      results: [],
      allowCommandFailures: options.allowCommandFailures,
    });
    if (options.command === 'diagnose') {
      writeDiagnoseComment({
        filePath: options.commentMarkdown,
        jobUrl: options.commentJobUrl,
        files,
        results: [],
      });
    }
    return 0;
  }

  const results = [];
  for (const filePath of files) {
    const result = runSrkCommand({
      command: options.command,
      filePath,
      srkBin,
      worktree,
    });
    const ok = result.status === 0 && !result.error && !result.signal;
    const failure = ok ? '' : formatCommandFailure(result);

    if (ok) {
      console.log(`PASS srk ${options.command}: ${filePath}`);
    } else {
      console.log(`FAIL srk ${options.command}: ${filePath} (${failure})`);
      if (options.command === 'validate') {
        reportValidateFailure(filePath, failure);
      }
    }

    results.push({
      filePath,
      ok,
      failure,
      output: result.output,
    });
  }

  const failures = results.filter((result) => !result.ok);
  console.log(
    `SRK ${options.command} summary: ${results.length - failures.length}/${
      results.length
    } passed, ${failures.length} failed.`,
  );

  appendGitHubOutputs({
    file_count: files.length,
    failure_count: failures.length,
  });
  appendStepSummary({
    command: options.command,
    files,
    results,
    allowCommandFailures: options.allowCommandFailures,
  });
  if (options.command === 'diagnose') {
    writeDiagnoseComment({
      filePath: options.commentMarkdown,
      jobUrl: options.commentJobUrl,
      files,
      results,
    });
  }

  if (failures.length > 0 && !options.allowCommandFailures) {
    return 1;
  }

  return 0;
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log(usage());
      return;
    }

    process.exitCode = run(options);
  } catch (error) {
    console.error(error.message);
    console.error('');
    console.error(usage());
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  extractDiagnoseSummary,
  getChangedSrkFiles,
  parseArgs,
  parseNameStatusDiffZ,
  renderDiagnoseComment,
  run,
};
