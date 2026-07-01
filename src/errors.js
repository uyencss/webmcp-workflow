class CliError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'CliError';
    this.code = options.code || 'CLI_ERROR';
    this.exitCode = options.exitCode || 2;
    this.details = options.details;
    this.cause = options.cause;
  }
}

function toErrorPayload(error) {
  return {
    ok: false,
    error: {
      name: error.name || 'Error',
      code: error.code || 'ERROR',
      message: error.message || String(error),
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
  };
}

module.exports = {
  CliError,
  toErrorPayload,
};
