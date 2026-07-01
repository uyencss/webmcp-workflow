/**
 * @module runner
 * @description Public API barrel for the WebMCP workflow runner.
 *
 * Re-exports the core runner, transport, context, catalog, and errors so
 * consumers can import everything from a single path:
 *
 *   const { WorkflowRunner, sendCommand, RunnerError } = require('./src/runner');
 *
 * Individual modules can still be imported directly for tree-shaking or
 * when only a subset is needed:
 *
 *   const { RunnerError } = require('./src/runner/shared/errors');
 */

module.exports = {
  ...require('./core/workflow-runner'),
  ...require('./core/transport'),
  ...require('./core/runner-events'),
  ...require('./pipeline/workflow-context'),
  ...require('./pipeline/workflow-normalizer'),
  ...require('./pipeline/workflow-validator'),
  ...require('./catalog/command-catalog'),
  ...require('./shared/errors'),
};
