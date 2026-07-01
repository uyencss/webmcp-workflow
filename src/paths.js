const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const EXAMPLES_ROOT = path.join(PROJECT_ROOT, '.examples');

function toAbsolutePath(filePath, baseDir = process.cwd()) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);
}

function defaultHealthUrl(apiUrl) {
  if (!apiUrl) return 'http://localhost:7865/health';
  if (apiUrl.endsWith('/api')) return `${apiUrl.slice(0, -4)}/health`;
  return new URL('/health', apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`).toString();
}

module.exports = {
  PROJECT_ROOT,
  EXAMPLES_ROOT,
  toAbsolutePath,
  defaultHealthUrl,
};
