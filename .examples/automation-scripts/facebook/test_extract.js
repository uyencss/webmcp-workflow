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
              const textBlocks = Array.from(document.querySelectorAll('div[dir="auto"]')).filter(el => el.textContent.length > 50);
              let extracted = [];
              for (let block of textBlocks) {
                 let up = block;
                 for(let i=0; i<6; i++) if (up.parentElement) up = up.parentElement;
                 
                 let authorNode = up.querySelector('h3, h4, strong');
                 let author = authorNode ? authorNode.innerText : 'Unknown';
                 
                 let dateNodes = Array.from(up.querySelectorAll('a[role="link"], span[id]'));
                 let date = 'Unknown';
                 for (let node of dateNodes) {
                     if (node.innerText && node.innerText.match(/\\d+ (min|h|d|w|m|y|June|July|August|September|October|November|December|January|February|March|April|May)/i)) {
                         date = node.innerText;
                         break;
                     }
                 }
                 if (date === 'Unknown') {
                     // try to look for the hover text inside links
                     let spans = Array.from(up.querySelectorAll('a[role="link"] span'));
                     for (let s of spans) {
                        if (s.innerText && s.innerText.match(/[0-9]/)) { date = s.innerText; break; }
                     }
                 }
                 extracted.push({ author, date });
              }
              return extracted.slice(0, 3);
            })();
          \`
        });
      `
    });
    console.log(JSON.stringify(extractResult.result, null, 2));
  } catch(e) { console.error(e); }
})();
