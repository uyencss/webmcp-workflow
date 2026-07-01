const { sendCommand } = require('./gateway_client');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const url = 'https://dantri.com.vn';
  console.log(`🤖 Scraping 5 latest news from: ${url}`);

  try {
    console.log('1. Opening a new tab to Dan Tri...');
    const newTabResult = await sendCommand('newTab', { url });
    const tabId = newTabResult.tabId;
    console.log(`   Opened tab ID: ${tabId}`);

    console.log('2. Waiting 5 seconds for page load...');
    await sleep(5000);

    // List available page tools first (as per agent skill contract)
    console.log('3. Listing page-registered WebMCP tools...');
    const listToolsRes = await sendCommand('webmcp.listTools', { tabId });
    console.log('   Available page tools:', listToolsRes.result?.tools?.map(t => t.name) || []);

    // Invoke query_selector_all page tool
    console.log('4. Invoking query_selector_all via webmcp.invokeTool...');
    const queryRes = await sendCommand('webmcp.invokeTool', {
      tabId,
      toolName: 'query_selector_all',
      input: {
        selector: 'h3, article, .article-title, .article-item',
        max_results: 50,
        attributes: ['class', 'id']
      }
    });

    // Parse the inner JSON content
    const textContent = queryRes.result?.content?.[0]?.text;
    if (!textContent) {
      throw new Error('No content returned from page tool');
    }

    const parsedResult = JSON.parse(textContent);
    console.log(`   Found ${parsedResult.elements?.length || 0} candidate article wrappers.`);

    // Let's run evaluateJS to extract 5 clean news titles, URLs and descriptions
    // as it allows precise DOM parsing of Dantri's layout.
    console.log('5. Extracting 5 news articles via page evaluateJS...');
    const extractRes = await sendCommand('evaluateJS', {
      tabId,
      code: `
        const articles = [];
        
        // Dantri uses h3 with class containing "title" or "article" or inside .article-item
        // Let's check headers h3, h2, h1 that contain links
        const headers = Array.from(document.querySelectorAll('h3, h2, .article-title, .article-item'));
        
        for (const h of headers) {
          const a = h.tagName === 'A' ? h : h.querySelector('a');
          if (!a) continue;
          
          const title = a.innerText.trim();
          const href = a.href;
          if (!title || !href || !href.startsWith('http')) continue;
          
          // Avoid duplicate articles
          if (articles.some(item => item.url === href || item.title === title)) continue;
          
          // Find description (usually sibling or inside parent)
          let description = '';
          const parent = h.parentElement;
          if (parent) {
            const descEl = parent.querySelector('.article-sapo, .sapo, p');
            if (descEl) {
              description = descEl.innerText.trim();
            }
          }
          
          articles.push({ title, url: href, description });
          if (articles.length >= 5) break;
        }
        
        // If not enough articles, try all links with article-like URLs
        if (articles.length < 5) {
          const allLinks = Array.from(document.querySelectorAll('a'));
          for (const a of allLinks) {
            const title = a.innerText.trim();
            const href = a.href;
            if (!title || title.length < 15 || !href || !href.includes('.htm')) continue;
            if (articles.some(item => item.url === href || item.title === title)) continue;
            articles.push({ title, url: href, description: '' });
            if (articles.length >= 5) break;
          }
        }
        
        return articles;
      `
    });

    const articles = extractRes.result;
    console.log('\n======================================');
    console.log('📰 5 TIN TỨC MỚI NHẤT TỪ DÂN TRÍ 📰');
    console.log('======================================');
    
    if (articles && articles.length > 0) {
      articles.forEach((art, idx) => {
        console.log(`\n${idx + 1}. ${art.title}`);
        console.log(`   🔗 Link: ${art.url}`);
        if (art.description) {
          console.log(`   📝 Mô tả: ${art.description}`);
        }
      });
      console.log('======================================\n');
    } else {
      console.log('Không tìm thấy tin tức nào.');
    }

  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}

main();
