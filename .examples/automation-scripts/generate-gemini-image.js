const { sendCommand } = require('./gateway_client');
const fs = require('fs');
const path = require('path');

// Ensure fetch is available (Node 18+)
if (typeof fetch === 'undefined') {
  global.fetch = require('node-fetch');
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const prompt = "Vẽ một bức ảnh về một chú chó Shiba dễ thương mặc trang phục ninja Nhật Bản, đang cầm một thanh kiếm katana nhỏ, phong cách anime rực rỡ, nền là rừng tre.";
  console.log(`🤖 Prompt: "${prompt}"`);

  try {
    console.log('1. Opening a new tab to Gemini...');
    const newTabResult = await sendCommand('newTab', { url: 'https://gemini.google.com/app' });
    const tabId = newTabResult.tabId;
    console.log(`   Opened Gemini in tab ID: ${tabId}`);

    // Wait for the page to load
    console.log('2. Waiting for page load (5s)...');
    await sleep(5000);

    // Focus and type the prompt
    console.log('3. Typing prompt into textbox...');
    const typeResponse = await sendCommand('evaluateJS', {
      tabId,
      code: `
        return new Promise((resolve) => {
          const el = document.querySelector('rich-textarea p') || document.querySelector('div[role="textbox"]');
          if (!el) return resolve({ success: false, error: 'Textbox not found' });
          el.focus();
          const range = document.createRange();
          const sel = window.getSelection();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('delete', false, null);
          document.execCommand('insertText', false, \`${prompt}\`);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          setTimeout(() => resolve({ success: true }), 500);
        });
      `
    });

    const typeResult = typeResponse?.result;
    if (!typeResult || !typeResult.success) {
      throw new Error(`Failed to type prompt: ${typeResult?.error || 'Unknown error'}`);
    }
    console.log('   Prompt typed successfully. Waiting 1s for state stabilization...');
    await sleep(1000);

    // Count messages before sending
    const preCountResponse = await sendCommand('evaluateJS', {
      tabId,
      code: "document.querySelectorAll('message-content').length;"
    });
    const preCount = parseInt(preCountResponse?.result) || 0;
    console.log(`   Message count before send: ${preCount}`);

    // Click send button
    console.log('4. Clicking Send button...');
    const sendResponse = await sendCommand('evaluateJS', {
      tabId,
      code: `
        const btn = document.querySelector('button[aria-label*="Send message"], button[aria-label*="Gửi"], button.send-button');
        if (btn && !btn.disabled) {
          btn.click();
          return { success: true, method: 'click' };
        }
        const el = document.querySelector('rich-textarea p') || document.querySelector('div[role="textbox"]');
        if (el) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          return { success: true, method: 'enter_key' };
        }
        return { success: false, error: 'Send button and textbox not found' };
      `
    });
    console.log('   Send action result:', sendResponse?.result);

    // Wait for the image generation to complete and retrieve the image URL
    console.log('5. Polling for generated images (max 90s)...');
    let imageUrls = [];
    let attempts = 0;
    const maxAttempts = 45; // 45 * 2s = 90s

    while (attempts < maxAttempts) {
      attempts++;
      await sleep(2000);

      // Inspect the last message-content for img tags
      const checkImagesResponse = await sendCommand('evaluateJS', {
        tabId,
        code: `
          const messages = document.querySelectorAll('message-content');
          if (messages.length === 0) return null;
          const lastMsg = messages[messages.length - 1];
          
          // Let's check for any img tags in the last message
          const imgs = Array.from(lastMsg.querySelectorAll('img'));
          if (imgs.length === 0) return null;
          
          // Filter to look for actual generated image URLs
          return imgs.map(img => img.src).filter(src => {
            if (!src) return false;
            return src.includes('googleusercontent') || src.startsWith('blob:') || src.startsWith('data:');
          });
        `
      });

      const checkImages = checkImagesResponse?.result;
      if (checkImages && checkImages.length > 0) {
        imageUrls = checkImages;
        break;
      }
      console.log(`   [Attempt ${attempts}/${maxAttempts}] Still generating/loading...`);
    }

    if (imageUrls.length === 0) {
      throw new Error('No generated images found in the response.');
    }

    console.log(`🎉 Found ${imageUrls.length} image(s):`, imageUrls);
    const targetUrl = imageUrls[0];

    // Download the image
    console.log('7. Downloading the image...');
    const filename = 'ninja_shiba.png';
    const outputPath = path.join(__dirname, filename);

    if (targetUrl.startsWith('blob:') || targetUrl.startsWith('data:')) {
      console.log('   Detected blob/data URL. Fetching content inside page context using Canvas...');
      const base64Response = await sendCommand('evaluateJS', {
        tabId,
        code: `
          return new Promise((resolve) => {
            try {
              const messages = document.querySelectorAll('message-content');
              if (messages.length === 0) return resolve({ success: false, error: 'No messages found' });
              const lastMsg = messages[messages.length - 1];
              const img = lastMsg.querySelector('img');
              if (!img) return resolve({ success: false, error: 'Image element not found' });
              
              const convert = () => {
                try {
                  const canvas = document.createElement('canvas');
                  canvas.width = img.naturalWidth;
                  canvas.height = img.naturalHeight;
                  const ctx = canvas.getContext('2d');
                  ctx.drawImage(img, 0, 0);
                  resolve({ success: true, base64: canvas.toDataURL('image/png') });
                } catch (e) {
                  resolve({ success: false, error: 'Canvas error: ' + e.message });
                }
              };

              if (!img.complete || img.naturalWidth === 0) {
                img.onload = convert;
                img.onerror = () => resolve({ success: false, error: 'Image failed to load' });
              } else {
                convert();
              }
            } catch (e) {
              resolve({ success: false, error: 'Script error: ' + e.message });
            }
          });
        `
      });

      const base64Data = base64Response?.result;

      if (!base64Data || !base64Data.success) {
        throw new Error(`Failed to convert image to base64: ${base64Data?.error || 'Unknown error'}`);
      }

      const base64Content = base64Data.base64.split(',')[1];
      fs.writeFileSync(outputPath, Buffer.from(base64Content, 'base64'));
    } else {
      console.log('   Detected standard URL. Fetching content directly in Node...');
      const response = await fetch(targetUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch image: HTTP ${response.status}`);
      }
      const buffer = await response.arrayBuffer();
      fs.writeFileSync(outputPath, Buffer.from(buffer));
    }

    console.log(`\n✅ Image successfully downloaded to: ${outputPath}\n`);

  } catch (err) {
    console.error('❌ Error during image generation:', err.message);
  }
}

main();
