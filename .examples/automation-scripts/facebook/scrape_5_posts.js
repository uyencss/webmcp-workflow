const fs = require('fs');
const path = require('path');
const { sendCommand } = require('./gateway_client');

async function main() {
  console.log('1. Connecting to Facebook via WebMCP Gateway...');
  
  const listResult = await sendCommand('listTabs');
  let fbTab = listResult.tabs.find(t => t.url.includes('facebook.com'));
  
  if (!fbTab) {
    console.log('Opening a new tab to Facebook...');
    const newTabResult = await sendCommand('newTab', { url: 'https://www.facebook.com/groups/vieclamitdev' });
    fbTab = { id: newTabResult.tabId };
    console.log('Waiting 10 seconds for page to load...');
    await new Promise(r => setTimeout(r, 10000));
  } else {
    console.log('Using existing tab:', fbTab.id);
  }

  const outputPath = path.join(__dirname, 'vieclamitdev_5_posts.json');
  let allPosts = [];
  
  // Load existing to allow incremental
  if (fs.existsSync(outputPath)) {
    try {
      allPosts = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      console.log(`Loaded ${allPosts.length} existing posts from file.`);
    } catch(e) {}
  }
  
  let postTextsSeen = new Set(allPosts.map(p => p.content.substring(0, 100)));
  
  console.log('2. Using WebMCP tools to extract posts...');
  
  // Close any popups
  try {
    await sendCommand('evaluateJS', {
      tabId: fbTab.id,
      code: `await navigator.modelContext.invokeTool('click_element', { selector: 'div[aria-label="Close"]' });`
    });
  } catch(e) {}
  
  let attempts = 0;
  while (allPosts.length < 5 && attempts < 20) {
    console.log(`--- Iteration ${attempts+1} | Current posts: ${allPosts.length} ---`);
    
    // We use execute_javascript tool to run async logic inside the page
    // 1. Click "See more"
    // 2. Extract author, date, text, likes, comments
    const extractResult = await sendCommand('evaluateJS', {
      tabId: fbTab.id,
      code: `
        return await navigator.modelContext.invokeTool('execute_javascript', {
          code: \`
            return (async () => {
              // Expand See More buttons
              const seeMores = Array.from(document.querySelectorAll('div[role="button"]'))
                .filter(b => b.textContent.trim() === 'See more' || b.textContent.trim() === 'Xem thêm');
              seeMores.forEach(b => b.click());
              
              if (seeMores.length > 0) {
                await new Promise(r => setTimeout(r, 1000));
              }

              const textBlocks = Array.from(document.querySelectorAll('div[dir="auto"]')).filter(el => el.textContent.length > 30);
              let extracted = [];
              
              for (let block of textBlocks) {
                 let curr = block;
                 let container = null;
                 while(curr && curr !== document.body) {
                    if (curr.getAttribute('role') === 'article' || curr.getAttribute('aria-posinset') || curr.getAttribute('data-ad-preview') === 'message' || (curr.parentElement && curr.parentElement.getAttribute('role') === 'feed')) {
                       container = curr;
                       break;
                    }
                    curr = curr.parentElement;
                 }
                 
                 // If not found, use a reasonable ancestor to capture Author/Date
                 if (!container) {
                     let up = block;
                     for(let i=0; i<6; i++) if (up.parentElement) up = up.parentElement;
                     container = up;
                 }
                 
                 if (!extracted.find(p => p.container === container)) {
                     // Get all text lines inside the container
                     let lines = container.innerText.split(String.fromCharCode(10)).map(l => l.trim()).filter(l => l);
                     
                     let authorEl = container.querySelector('[data-ad-rendering-role="profile_name"]');
                     let contentEl = container.querySelector('[data-ad-rendering-role="story_message"]');
                     
                     let author = authorEl ? authorEl.innerText.replace(new RegExp(String.fromCharCode(10), 'g'), ' ').trim() : (lines[0] || 'Unknown');
                     
                     let date = 'Unknown';
                     let dateEls = Array.from(container.querySelectorAll('a[href*="/posts/"], a[href*="/permalink/"]'));
                     if (dateEls.length > 0) {
                        let rawDate = dateEls[0].innerText || '';
                        // If it's not a heavily scrambled text with many newlines, use it
                        if (rawDate && rawDate.split(String.fromCharCode(10)).length < 4) {
                            date = rawDate.replace(new RegExp(String.fromCharCode(10), 'g'), ' ').trim();
                        } else {
                            // Try to grab from hovercard or aria-label
                            date = dateEls[0].getAttribute('aria-label') || 'Obfuscated by FB';
                        }
                     }
                     
                     // Get Content
                     let extractedContent = contentEl ? contentEl.innerText : container.innerText;
                     let likeCounts = Array.from(container.querySelectorAll('[aria-label*="reaction"], [aria-label*="Like"]'))
                                           .map(e => e.textContent).filter(t => t && t !== 'Like' && t !== 'Thích');
                     let comments = Array.from(container.querySelectorAll('span'))
                                           .map(s => s.textContent).filter(t => t.toLowerCase().includes('comment') || t.toLowerCase().includes('bình luận'));
                     
                     extracted.push({
                         container: container,
                         author: author,
                         date: date,
                         content: extractedContent,
                         likes: likeCounts.length > 0 ? likeCounts[0] : '0',
                         comments: comments.length > 0 ? comments[0] : '0'
                     });
                 }
              }
              return extracted.map(p => ({
                author: p.author,
                date: p.date,
                content: p.content, 
                likes: p.likes, 
                comments: p.comments
              }));
            })();
          \`
        });
      `
    });

    if (extractResult && extractResult.result && extractResult.result.content) {
      try {
        const jsonStr = extractResult.result.content[0].text;
        const resultData = JSON.parse(jsonStr);
        
        if (resultData.result && Array.isArray(resultData.result)) {
           for (let p of resultData.result) {
              const snippet = p.content.substring(0, 100);
              if (!postTextsSeen.has(snippet) && allPosts.length < 5) {
                 postTextsSeen.add(snippet);
                 allPosts.push({
                    author: p.author,
                    date: p.date,
                    content: p.content,
                    likes: p.likes,
                    comments: p.comments,
                    scrapedAt: new Date().toISOString()
                 });
                 console.log(`  + Extracted: ${p.author} - ${snippet.substring(0, 30)}...`);
                 
                 // Write incrementally
                 fs.writeFileSync(outputPath, JSON.stringify(allPosts, null, 2), 'utf8');
              }
           }
        }
      } catch (err) {
        console.error("  Parse error:", err.message);
      }
    }
    
    if (allPosts.length >= 5) break;
    
    console.log('  Scrolling page...');
    await sendCommand('evaluateJS', {
      tabId: fbTab.id,
      code: `
        return await navigator.modelContext.invokeTool('scroll_page', { 
          delta_y: 2000, 
          behavior: "smooth" 
        });
      `
    });
    
    attempts++;
    await new Promise(r => setTimeout(r, 4000));
  }
  
  console.log(`\nDone! Total posts saved: ${allPosts.length}`);
}

main();
