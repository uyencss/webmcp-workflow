#!/usr/bin/env node

const { main } = require('../src/cli');

main(process.argv.slice(2)).then((exitCode) => {
  process.exit(exitCode);
}).catch((error) => {
  const message = error && error.message ? error.message : String(error);
  console.error(`Fatal error: ${message}`);
  process.exit(error.exitCode || 1);
});
