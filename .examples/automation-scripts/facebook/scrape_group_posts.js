const fs = require('fs');
const path = require('path');
const { sendCommand } = require('./gateway_client');

async function main() {
  console.log('1. Finding or opening Facebook Group tab...');
  let tabId;
  try {
    const listResult = await sendCommand('listTabs');
    let fbTab = listResult.tabs.find(t => t.url.includes('facebook.com/groups/vieclamitdev'));
    
    if (fbTab) {
      console.log(`Using existing tab: ${fbTab.id}`);
      tabId = fbTab.id;
    } else {
      console.log('Opening a new tab to the Facebook group...');
      const newTabResult = await sendCommand('newTab', { url: 'https://www.facebook.com/groups/vieclamitdev' });
      tabId = newTabResult.tabId;
      console.log('Opened Facebook in tab:', tabId);
    }

    console.log('Waiting 10 seconds for page load...');
    await new Promise(r => setTimeout(r, 10000));

    console.log('2. Starting to scan posts using WebMCP Tools...');
    let allPosts = new Set();
    let postsData = [];
    
    let scrollAttempts = 0;
    while (postsData.length < 50 && scrollAttempts < 30) {
      console.log(`\n--- Scroll Attempt ${scrollAttempts + 1} | Collected: ${postsData.length} posts ---`);
      
      // Close popup if present by using click_element tool
      await sendCommand('evaluateJS', {
        tabId,
        code: `
          // Try to close popup if present, ignore errors if not found
          try {
            await navigator.modelContext.invokeTool('click_element', { selector: 'div[aria-label="Close"]' });
          } catch(e) {}
        `
      });

      // Extract posts using query_selector_all
      const extractResult = await sendCommand('evaluateJS', {
        tabId,
        code: `
          return await navigator.modelContext.invokeTool('query_selector_all', { 
            selector: 'div[role="article"]',
            attributes: ['aria-describedby']
          });
        `
      });

      if (extractResult && extractResult.result && extractResult.result.content) {
        try {
          const jsonStr = extractResult.result.content[0].text;
          const parsed = JSON.parse(jsonStr);
          if (parsed.elements) {
            for (let el of parsed.elements) {
              // 'text' contains innerText. Clean it up a bit.
              let bestText = el.text || "";
              
              if (bestText.length > 50 && bestText.includes('Like') && bestText.includes('Comment')) {
                 bestText = bestText.split('Like')[0].trim();
              }

              let postId = (el.attributes && el.attributes['aria-describedby']) 
                             ? el.attributes['aria-describedby'] 
                             : Math.random().toString(36).substr(2, 9);

              if (bestText && !allPosts.has(bestText) && bestText.length > 30) {
                allPosts.add(bestText);
                postsData.push({
                  id: postId,
                  content: bestText,
                  scrapedAt: new Date().toISOString()
                });
              }
            }
          }
        } catch(e) {
          console.error("Error parsing MCP response:", e.message);
        }
      }
      
      console.log(`Total unique posts so far: ${postsData.length}`);
      
      if (postsData.length >= 50) {
        break;
      }
      
      // Scroll down using scroll_page tool
      await sendCommand('evaluateJS', {
        tabId,
        code: `
          return await navigator.modelContext.invokeTool('scroll_page', { 
            delta_y: 2000, 
            behavior: "smooth" 
          });
        `
      });
      
      scrollAttempts++;
      // Wait for new content to load using wait_for_element (or just simple timeout)
      await new Promise(r => setTimeout(r, 4000));
    }
    
    // Save to file
    const outputPath = path.join(__dirname, 'vieclamitdev_posts_webmcp.json');
    fs.writeFileSync(outputPath, JSON.stringify(postsData.slice(0, 50), null, 2), 'utf8');
    
    console.log(`\nSuccess! Saved ${Math.min(postsData.length, 50)} posts to ${outputPath}`);

  } catch (err) {
    console.error('Error during Facebook post extraction:', err.message);
  }
}

main();
