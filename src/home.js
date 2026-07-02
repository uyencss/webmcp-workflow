'use strict';

const os = require('os');
const path = require('path');

// Shared WebMCP kit home directory, kept consistent with the
// @gyga-browser/webmcp-browser-automation-kit extension (chrome-launcher/config.js).
// Priority: WEBMCP_HOME > WEBMCP_DATA_DIR (back-compat alias) > ~/.webmcp.
function getWebmcpHome() {
  return process.env.WEBMCP_HOME
    || process.env.WEBMCP_DATA_DIR
    || path.join(os.homedir(), '.webmcp');
}

// Default location for workflow run artifacts: <home>/workflow-runs.
function getDefaultHistoryDir() {
  return path.join(getWebmcpHome(), 'workflow-runs');
}

module.exports = { getWebmcpHome, getDefaultHistoryDir };
