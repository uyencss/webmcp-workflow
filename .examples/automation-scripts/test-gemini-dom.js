const { sendCommand } = require('./gateway_client');

async function main() {
  try {
    const listResult = await sendCommand('listTabs');
    let geminiTab = listResult.tabs.find(t => t.url.includes('gemini.google.com'));
    if (!geminiTab) return;
    const tabId = geminiTab.id;

    const result = await sendCommand('evaluateJS', {
      tabId,
      code: `
        function extractMarkdown(node) {
          let md = '';
          for (let child of node.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
              md += child.textContent;
            } else if (child.nodeType === Node.ELEMENT_NODE) {
              const tag = child.tagName;
              if (tag === 'PRE') {
                const header = child.parentElement ? child.parentElement.querySelector('.code-block-header') : null;
                let lang = '';
                if (header) {
                  lang = header.innerText.split('\\n')[0].trim();
                }
                // don't recurse into PRE, just take textContent
                md += '\\n\\n\`\`\`' + lang + '\\n' + child.textContent.trim() + '\\n\`\`\`\\n\\n';
              } else if (tag === 'P') {
                md += extractMarkdown(child) + '\\n\\n';
              } else if (tag === 'UL' || tag === 'OL') {
                md += extractMarkdown(child) + '\\n';
              } else if (tag === 'LI') {
                md += '- ' + extractMarkdown(child).trim() + '\\n';
              } else if (tag === 'B' || tag === 'STRONG') {
                md += '**' + extractMarkdown(child) + '**';
              } else if (tag === 'I' || tag === 'EM') {
                md += '*' + extractMarkdown(child) + '*';
              } else if (tag === 'CODE') {
                // Inline code usually
                md += '\`' + child.textContent + '\`';
              } else {
                if (child.classList && child.classList.contains('code-block-header')) continue;
                md += extractMarkdown(child);
              }
            }
          }
          return md;
        }

        const responses = Array.from(document.querySelectorAll('message-content'));
        if (responses.length > 0) {
          return extractMarkdown(responses[responses.length - 1]).replace(/\\n{3,}/g, '\\n\\n').trim();
        }
        return "Not found";
      `
    });
    console.log(result.result);

  } catch (err) {
    console.error(err.message);
  }
}
main();
