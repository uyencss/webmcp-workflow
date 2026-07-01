const DEFAULT_REDACT_KEYS = ['token', 'password', 'cookie', 'authorization', 'apikey', 'apiKey'];

function shouldRedactKey(key, redactKeys) {
  const normalized = String(key || '').toLowerCase();
  return redactKeys.some((item) => normalized.includes(String(item).toLowerCase()));
}

function redact(value, redactKeys = DEFAULT_REDACT_KEYS) {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, redactKeys));
  }

  if (!value || typeof value !== 'object') return value;

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = shouldRedactKey(key, redactKeys) ? '[REDACTED]' : redact(item, redactKeys);
  }
  return output;
}

module.exports = {
  DEFAULT_REDACT_KEYS,
  redact,
};
