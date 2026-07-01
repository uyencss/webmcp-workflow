const fs = require('fs');
const { CliError, toErrorPayload } = require('./errors');
const { writeJson } = require('./output');
const { runCommand } = require('./commands/run-command');
const { validateCommand } = require('./commands/validate-command');
const { dryRunCommand } = require('./commands/dry-run-command');
const { listCommand } = require('./commands/list-command');
const { profilesCommand } = require('./commands/profiles-command');
const { doctorCommand } = require('./commands/doctor-command');
const { historyCommand } = require('./commands/history-command');
const { daemonCommand } = require('./commands/daemon-command');

const COMMANDS = {
  run: runCommand,
  validate: validateCommand,
  'dry-run': dryRunCommand,
  list: listCommand,
  profiles: profilesCommand,
  doctor: doctorCommand,
  history: historyCommand,
  daemon: daemonCommand,
};

function printRootHelp(stdout = process.stdout) {
  stdout.write(`Workflow Dispatcher CLI

Usage:
  workflow-dispatcher <command> [options]

Commands:
  run <workflow-id-or-path>       Execute a workflow JSON file or configured workflow id
  validate <workflow-id-or-path>  Normalize and validate without executing
  dry-run <workflow-id-or-path>   Print validation, commands, routes, and template refs
  list                            List workflows from dispatcher.config.json
  profiles                        List connected gateway profiles via /health
  doctor                          Check gateway, extension, and profile selection
  history                         List recent workflow runs
  daemon                          Run enabled scheduled workflows from config

Common options:
  --config <path>                 Config file path (default: ./dispatcher.config.json)
  --gateway <name-or-url>         Gateway name from config or explicit /api URL
  --profile <id-or-alias>         Gateway profile id or configured profile alias
  --var KEY=VALUE                 Runtime variable override. Repeatable
  --vars-json <json>              Runtime variables as a JSON object
  --vars-file <path>              Runtime variables from a JSON file
  --timeout <ms>                  Workflow command timeout override
  --run-id <id>                   Stable run id
  --json                          Print machine-readable final output
  --json-events                   Stream runner event envelopes as JSONL
  --strict                        Treat unknown template variables as validation errors
  --allow-unknown-command         Allow passthrough gateway commands not in catalog
  --help                          Show help

Environment:
  WEBMCP_GATEWAY_URL              Default gateway /api URL
  WEBMCP_PROFILE_ID               Default profile id for multi-profile gateways

Examples:
  workflow-dispatcher doctor
  workflow-dispatcher profiles --gateway local
  workflow-dispatcher dry-run workflows/gemini/generate_image.json
  workflow-dispatcher run gemini-generate-image --profile personal --var PROMPT="hello"
`);
}

function readOptionValue(args, index, name) {
  if (index + 1 >= args.length) {
    throw new CliError(`${name} requires a value`, { code: 'USAGE_ERROR', exitCode: 2 });
  }
  return args[index + 1];
}

function parsePositiveInteger(raw, name) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new CliError(`${name} must be a positive integer`, { code: 'USAGE_ERROR', exitCode: 2 });
  }
  return value;
}

function parseJsonObject(raw, name) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('must be a JSON object');
    }
    return parsed;
  } catch (error) {
    throw new CliError(`Invalid ${name}: ${error.message}`, {
      code: 'USAGE_ERROR',
      exitCode: 2,
      cause: error,
    });
  }
}

function parseVarPair(raw) {
  const eqIndex = raw.indexOf('=');
  if (eqIndex === -1) {
    throw new CliError(`--var must be KEY=VALUE, got "${raw}"`, {
      code: 'USAGE_ERROR',
      exitCode: 2,
    });
  }
  return [raw.slice(0, eqIndex), raw.slice(eqIndex + 1)];
}

function parseArgs(args, cwd = process.cwd()) {
  const result = {
    command: null,
    positional: [],
    options: {
      variables: {},
      cwd,
      json: false,
      jsonEvents: false,
      strict: false,
      allowUnknownCommand: false,
      history: true,
    },
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      result.options.help = true;
      continue;
    }
    if (arg === '--json') {
      result.options.json = true;
      continue;
    }
    if (arg === '--json-events') {
      result.options.jsonEvents = true;
      continue;
    }
    if (arg === '--strict') {
      result.options.strict = true;
      continue;
    }
    if (arg === '--allow-unknown-command') {
      result.options.allowUnknownCommand = true;
      continue;
    }
    if (arg === '--dry-run') {
      result.options.dryRun = true;
      continue;
    }
    if (arg === '--no-history') {
      result.options.history = false;
      continue;
    }
    if (arg === '--config') {
      result.options.config = readOptionValue(args, i, '--config');
      i += 1;
      continue;
    }
    if (arg === '--gateway') {
      result.options.gateway = readOptionValue(args, i, '--gateway');
      i += 1;
      continue;
    }
    if (arg === '--profile') {
      result.options.profile = readOptionValue(args, i, '--profile');
      i += 1;
      continue;
    }
    if (arg === '--timeout') {
      result.options.timeoutMs = parsePositiveInteger(readOptionValue(args, i, '--timeout'), '--timeout');
      i += 1;
      continue;
    }
    if (arg === '--run-id') {
      result.options.runId = readOptionValue(args, i, '--run-id');
      i += 1;
      continue;
    }
    if (arg === '--history-dir') {
      result.options.historyDir = readOptionValue(args, i, '--history-dir');
      i += 1;
      continue;
    }
    if (arg === '--limit') {
      result.options.limit = parsePositiveInteger(readOptionValue(args, i, '--limit'), '--limit');
      i += 1;
      continue;
    }
    if (arg === '--var') {
      const [key, value] = parseVarPair(readOptionValue(args, i, '--var'));
      result.options.variables[key] = value;
      i += 1;
      continue;
    }
    if (arg === '--vars-json') {
      Object.assign(result.options.variables, parseJsonObject(readOptionValue(args, i, '--vars-json'), '--vars-json'));
      i += 1;
      continue;
    }
    if (arg === '--vars-file') {
      const file = readOptionValue(args, i, '--vars-file');
      const raw = fs.readFileSync(file, 'utf8');
      Object.assign(result.options.variables, parseJsonObject(raw, '--vars-file'));
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new CliError(`Unknown option: ${arg}`, { code: 'USAGE_ERROR', exitCode: 2 });
    }

    if (!result.command && COMMANDS[arg]) {
      result.command = arg;
    } else if (!result.command) {
      throw new CliError(`Unknown command: ${arg}`, { code: 'USAGE_ERROR', exitCode: 2 });
    } else {
      result.positional.push(arg);
    }
  }

  return result;
}

function normalizeCommand(parsed) {
  if (!parsed.command) return parsed.command;
  if (parsed.command === 'run' && parsed.options.dryRun) return 'dry-run';
  return parsed.command;
}

async function main(args = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const cwd = io.cwd || process.cwd();
  let parsed;

  try {
    parsed = parseArgs(args, cwd);
  } catch (error) {
    const wantsJson = args.includes('--json');
    if (wantsJson) writeJson(stdout, toErrorPayload(error));
    else {
      stderr.write(`Error: ${error.message}\n\n`);
      printRootHelp(stderr);
    }
    return error.exitCode || 2;
  }

  if (!parsed.command || parsed.options.help) {
    printRootHelp(stdout);
    return 0;
  }

  const commandName = normalizeCommand(parsed);
  const handler = COMMANDS[commandName];
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Aborted by signal'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    return await handler(parsed.positional, {
      cwd,
      stdout,
      stderr,
      options: parsed.options,
      signal: controller.signal,
    });
  } catch (error) {
    const exitCode = error.exitCode || (error.code === 'GATEWAY_UNAVAILABLE' ? 3 : 1);
    if (parsed.options.json) writeJson(stdout, toErrorPayload(error));
    else {
      stderr.write(`Error: ${error.message}\n`);
      if (Array.isArray(error.details)) {
        for (const detail of error.details) stderr.write(`  - ${detail}\n`);
      } else if (error.details) {
        stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
      }
    }
    return exitCode;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (require.main === module) {
  main().then((exitCode) => process.exit(exitCode));
}

module.exports = {
  main,
  parseArgs,
  printRootHelp,
};
