const { resolveWorkflow } = require('./workflow-registry');
const { executeWorkflow } = require('./executor');
const { DispatcherQueue } = require('./queue');

class WorkflowDispatcher {
  constructor(config, options = {}) {
    this.config = config;
    this.options = options;
    this.env = options.env || {};
    this.stdout = options.stdout || process.stdout;
    this.stderr = options.stderr || process.stderr;
    this.queue = new DispatcherQueue();
    this.timers = [];
    this.running = false;
    this.stats = new Map();
  }

  scheduledWorkflows() {
    return Object.entries(this.config.workflows || {})
      .filter(([, workflow]) => workflow.schedule?.enabled);
  }

  start() {
    const scheduled = this.scheduledWorkflows();
    this.running = true;
    for (const [id, workflow] of scheduled) {
      const intervalMs = workflow.schedule.intervalMs;
      const run = () => this.runScheduled(id).catch((error) => {
        this.stderr.write(`Scheduled workflow ${id} failed: ${error.message}\n`);
      });
      run();
      this.timers.push(setInterval(run, intervalMs));
    }
    return scheduled.length;
  }

  stop() {
    this.running = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  async runScheduled(id) {
    const workflow = this.config.workflows[id];
    const state = this.stats.get(id) || { consecutiveFailures: 0 };
    const maxFailures = workflow.schedule.maxConsecutiveFailures || Infinity;
    if (state.consecutiveFailures >= maxFailures) return;

    const resolved = resolveWorkflow(id, {
      config: this.config,
      options: this.options,
      env: this.env,
    });
    const lockKey = workflow.queue?.lockKey || `gateway:${resolved.gateway.name || resolved.gateway.apiUrl}:profile:${resolved.profile.profileId || 'auto'}`;
    const result = await this.queue.run({
      id,
      lockKey,
      allowOverlap: workflow.queue?.allowOverlap === true,
    }, () => executeWorkflow(resolved, {
      jsonEvents: this.options.jsonEvents,
      stdout: this.stdout,
      stderr: this.stderr,
    }));

    if (!result.queued) {
      if (result.result.exitCode === 0) state.consecutiveFailures = 0;
      else state.consecutiveFailures += 1;
      state.lastRun = result.result.summary;
      this.stats.set(id, state);
    }
  }
}

module.exports = {
  WorkflowDispatcher,
};
