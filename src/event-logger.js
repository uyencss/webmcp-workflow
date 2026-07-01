const { appendJsonLine } = require('./run-history');
const { redact } = require('./redaction');

function summarizeValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 117)}...` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value).slice(0, 160);
}

class EventLogger {
  constructor(options = {}) {
    this.jsonEvents = Boolean(options.jsonEvents);
    this.quiet = Boolean(options.quiet);
    this.eventsFile = options.eventsFile;
    this.redactKeys = options.redactKeys;
    this.stdout = options.stdout || process.stdout;
    this.stderr = options.stderr || process.stderr;
  }

  attach(runner) {
    runner.on('event', (event) => this.handleEvent(event));
  }

  handleEvent(event) {
    const safeEvent = redact(event, this.redactKeys);
    if (this.eventsFile) appendJsonLine(this.eventsFile, safeEvent);

    if (this.jsonEvents) {
      this.stdout.write(`${JSON.stringify(safeEvent)}\n`);
      return;
    }

    if (this.quiet) return;
    this.printHuman(safeEvent);
  }

  printHuman(event) {
    const payload = event.payload || {};

    if (event.type === 'start') {
      this.stdout.write(`Run: ${event.runId}\n`);
      this.stdout.write(`Workflow: ${payload.workflow?.name || event.workflowId} (${event.workflowId})\n`);
      this.stdout.write(`Steps: ${payload.totalSteps}\n`);
      if (payload.warnings?.length) {
        this.stdout.write(`Warnings: ${payload.warnings.length}\n`);
        for (const warning of payload.warnings) this.stdout.write(`  - ${warning}\n`);
      }
      this.stdout.write('\n');
      return;
    }

    if (event.type === 'step') {
      const prefix = `[${(payload.stepIndex ?? 0) + 1}/${payload.totalSteps ?? '?'}] ${payload.stepId}`;
      if (payload.type === 'started') {
        const kind = payload.strategy ? `strategy:${payload.strategy}` : payload.command;
        this.stdout.write(`${prefix} started (${kind})\n`);
      } else if (payload.type === 'completed') {
        this.stdout.write(`${prefix} completed in ${payload.duration}ms\n`);
      } else if (payload.type === 'retrying') {
        this.stdout.write(`${prefix} retrying attempt ${payload.nextAttempt} after ${payload.delayMs}ms: ${payload.error?.code} ${payload.error?.message}\n`);
      } else if (payload.type === 'skipped') {
        this.stdout.write(`${prefix} skipped: ${payload.reason}\n`);
      } else if (payload.type === 'failed') {
        this.stdout.write(`${prefix} failed: ${payload.error?.code} ${payload.error?.message}\n`);
      }
      return;
    }

    if (event.type === 'progress') {
      this.stdout.write(`Captured ${payload.captureAs} from ${payload.stepId}\n`);
      return;
    }

    if (event.type === 'recovery') {
      this.stdout.write(`Recovery: ${payload.stepId} -> ${payload.nextStepId}\n`);
      return;
    }

    if (event.type === 'end') {
      this.stdout.write('\n');
      this.stdout.write(`Result: ${payload.status}\n`);
      this.stdout.write(`Duration: ${payload.duration}ms\n`);
      this.stdout.write(`Steps: ${payload.stepsCompleted} completed, ${payload.stepsFailed} failed, ${payload.stepsSkipped} skipped, ${payload.stepsTotal} total\n`);
      if (payload.error) this.stdout.write(`Error: ${payload.error.code} ${payload.error.message}\n`);
      return;
    }

    this.stdout.write(`${event.type}: ${summarizeValue(payload)}\n`);
  }
}

module.exports = {
  EventLogger,
};
