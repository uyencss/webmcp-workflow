const { sendCommand } = require('./gateway_client');
const fs = require('fs');
const path = require('path');

async function main() {
  try {
    const tabId = 64587790;
    console.log(`Taking screenshot of Facebook tab ${tabId}...`);
    const result = await sendCommand('screenshot', { tabId });
    const buf = Buffer.from(result.base64, 'base64');
    const out = path.join(__dirname, 'fb_screenshot.png');
    fs.writeFileSync(out, buf);
    console.log(`Saved screenshot to ${out}`);
  } catch (err) {
    console.error('Error:', err.message);
  }
}
main();
