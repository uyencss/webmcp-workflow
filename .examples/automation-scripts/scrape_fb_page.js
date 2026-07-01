const { sendCommand } = require('./gateway_client');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const url = 'https://www.facebook.com/GiveMeSport';
  console.log(`🤖 Opening Facebook page: ${url}`);

  try {
    const newTabResult = await sendCommand('newTab', { url });
    const tabId = newTabResult.tabId;
    console.log(`   Opened tab ID: ${tabId}`);

    console.log('   Waiting 7 seconds for Facebook to load...');
    await sleep(7000);

    // Scroll down twice to trigger loading of posts/images
    console.log('   Scrolling down to load more content...');
    await sendCommand('scroll', { deltaY: 800, tabId });
    await sleep(2000);
    await sendCommand('scroll', { deltaY: 800, tabId });
    await sleep(2000);

    console.log('   Scraping posts and images from page context...');
    const result = await sendCommand('evaluateJS', {
      tabId,
      code: `
        const posts = [];
        const messageElms = Array.from(document.querySelectorAll('[data-ad-comet-preview="message"]'));
        
        for (const msgEl of messageElms) {
          const text = msgEl.innerText.trim();
          let imageUrl = null;
          let current = msgEl;
          
          // Climb up up to 12 levels to find a container with a large image
          for (let i = 0; i < 12; i++) {
            if (!current.parentElement) break;
            current = current.parentElement;
            
            // Find images inside this ancestor
            const imgs = Array.from(current.querySelectorAll('img')).filter(img => {
              const rect = img.getBoundingClientRect();
              const w = rect.width || img.width || img.naturalWidth || 0;
              const h = rect.height || img.height || img.naturalHeight || 0;
              
              // Only match large post images (exclude page logo and other small images)
              if (w < 150 || h < 150) return false;
              
              const src = img.src || img.getAttribute('src') || '';
              return src.includes('scontent') || src.includes('fbcdn');
            });
            
            if (imgs.length > 0) {
              imageUrl = imgs[0].src || imgs[0].getAttribute('src');
              break; // found the image container!
            }
          }
          
          posts.push({ text, images: imageUrl ? [imageUrl] : [] });
        }
        return posts;
      `
    });

    const posts = result?.result || [];
    console.log(`   Found ${posts.length} candidate post structures.`);

    console.log('\n======================================');
    console.log('📱 3 LATEST POSTS FROM GIVEMESPORT 📱');
    console.log('======================================');

    let count = 0;
    for (const post of posts) {
      if (count >= 3) break;
      // Make sure there is text and at least one image
      if (!post.text && post.images.length === 0) continue;

      count++;
      console.log(`\nPost #${count}:`);
      console.log(`💬 Text: ${post.text.slice(0, 300)}${post.text.length > 300 ? '...' : ''}`);
      if (post.images.length > 0) {
        console.log(`🖼️ Images found (${post.images.length}):`);
        post.images.forEach((img, idx) => {
          console.log(`   [${idx + 1}] ${img}`);
        });
      } else {
        console.log('🖼️ No images found for this post.');
      }
    }
    console.log('======================================\n');

  } catch (err) {
    console.error('Error during scraping:', err.message);
  }
}

main();
