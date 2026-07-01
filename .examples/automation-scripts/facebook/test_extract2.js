const { sendCommand } = require('./gateway_client');
(async () => {
  try {
    const listResult = await sendCommand('listTabs');
    let fbTab = listResult.tabs.find(t => t.url.includes('facebook.com'));
    const extractResult = await sendCommand('evaluateJS', {
      tabId: fbTab.id,
      code: `
        return await navigator.modelContext.invokeTool('execute_javascript', {
          code: \`
            return (async () => {
              const posts = Array.from(document.querySelectorAll('div[aria-posinset]')).slice(0, 5);
              let extracted = [];
              for (let p of posts) {
                 let authorEl = p.querySelector('[data-ad-rendering-role="profile_name"], h2, h3, h4, strong');
                 let contentEl = p.querySelector('[data-ad-rendering-role="story_message"], div[dir="auto"]');
                 
                 let author = authorEl ? authorEl.innerText.replace(new RegExp(String.fromCharCode(10), 'g'), ' ').trim() : 'Unknown';
                 let content = contentEl ? contentEl.innerText.replace(new RegExp(String.fromCharCode(10), 'g'), ' ').trim() : 'Unknown';
                 extracted.push({ author, content: content.substring(0, 50) });
              }
              return extracted;
            })();
          \`
        });
      `
    });
    console.log(JSON.stringify(extractResult.result, null, 2));
  } catch(e) { console.error(e); }
})();
