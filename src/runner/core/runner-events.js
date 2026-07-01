/**
 * @module core/runner-events
 * @description Factory for structured runner event envelopes.
 *
 * Every event emitted by {@link WorkflowRunner} passes through the factory
 * returned by {@link createEventFactory}.  Each envelope carries a monotonic
 * `eventId`, ISO timestamp, and the originating `runId` / `workflowId` so
 * consumers can correlate events across runs.
 */

/**
 * Create a stamping function that produces versioned event envelopes.
 *
 * The returned `makeEvent(type, payload)` function auto-increments a counter
 * scoped to the run, producing unique event IDs of the form `<runId>:<seq>`.
 *
 * @param {Object} options
 * @param {string} options.runId      - Unique identifier for this workflow run.
 * @param {string} options.workflowId - The workflow definition's id.
 * @param {Function} [options.getTabId] - Optional getter for the currently active tab id.
 * @returns {function(string, Object=): Object} An event-stamping function.
 *
 * @example
 *   const makeEvent = createEventFactory({ runId: 'run-1', workflowId: 'wf-1' });
 *   const event = makeEvent('step', { stepId: 'open-page' });
 *   // => { version: 1, eventId: 'run-1:1', runId: 'run-1', ... }
 */
function createEventFactory({ runId, workflowId, getTabId }) {
  let eventCounter = 0;

  return function makeEvent(type, payload = {}) {
    eventCounter += 1;

    return {
      version: 1,
      eventId: `${runId}:${eventCounter}`,
      runId,
      workflowId,
      tabId: getTabId ? getTabId() : undefined,
      timestamp: new Date().toISOString(),
      type,
      payload,
    };
  };
}

module.exports = {
  createEventFactory,
};
