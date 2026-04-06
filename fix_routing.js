const fs = require('fs');
const path = require('path');

function processDir(dir) {
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const fullPath = path.join(dir, item);
    if (fs.statSync(fullPath).isDirectory()) {
      processDir(fullPath);
    } else if (fullPath.endsWith('.html') || fullPath.endsWith('.js')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      const originalContent = content;

      // Fix shared paths
      content = content.replace(/(\.\.\/shared|\\.\/shared)\/authenx-code.js/g, '/shared/authenx-code.js');
      content = content.replace(/\.\.\/employer\/index\.html/g, '/employer/index.html');
      content = content.replace(/\.\.\/college\/index\.html/g, '/college/index.html');
      
      // Fix inside college
      if (fullPath.includes('/ui/college/')) {
        content = content.replace(/href="app\.css"/g, 'href="/college/app.css"');
        content = content.replace(/src="app\.js"/g, 'src="/college/app.js"');
        content = content.replace(/href="((dashboard|index|issue|students|tokens|audit|code-issued)\.html)"/g, 'href="/college/$1"');
        content = content.replace(/window\.location\.href\s*=\s*'((dashboard|index|issue|students|tokens|audit|code-issued)\.html)'/g, "window.location.href = '/college/$1'");
        content = content.replace(/window\.location\.href\s*=\s*`((dashboard|index|issue|students|tokens|audit|code-issued)\.html)`/g, "window.location.href = '/college/$1'");
      }

      // Fix inside employer
      if (fullPath.includes('/ui/employer/')) {
        content = content.replace(/href="verify\.css"/g, 'href="/employer/verify.css"');
        content = content.replace(/src="verify\.js"/g, 'src="/employer/verify.js"');
        content = content.replace(/href="((index|verify|decoding|verified|revoked)\.html)"/g, 'href="/employer/$1"');
        content = content.replace(/window\.location\.href\s*=\s*'((index|verify|decoding|verified|revoked)\.html)'/g, "window.location.href = '/employer/$1'");
        content = content.replace(/window\.location\.href\s*=\s*`((index|verify|decoding|verified|revoked)\.html)`/g, "window.location.href = '/employer/$1'");
      }

      if (content !== originalContent) {
        fs.writeFileSync(fullPath, content);
        console.log('Fixed:', fullPath);
      }
    }
  }
}

processDir(path.join(__dirname, 'ui'));
