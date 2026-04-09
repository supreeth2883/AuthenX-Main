const fs = require('fs');
const path = require('path');

function replaceInFile(filepath, replaces) {
  let content = fs.readFileSync(filepath, 'utf8');
  for (const [from, to] of replaces) {
    content = content.split(from).join(to);
  }
  fs.writeFileSync(filepath, content);
}

const filesCollege = [
  'ui/college/code-issued.html',
  'ui/college/dashboard.html',
  'ui/college/tokens.html',
  'ui/college/students.html',
  'ui/college/index.html'
];
filesCollege.forEach(f => {
  replaceInFile(f, [
    ['href="/college/', 'href="./'],
    ['href="/employer/', 'href="../employer/']
  ]);
});

const filesEmployer = [
  'ui/employer/index.html'
];
filesEmployer.forEach(f => {
  replaceInFile(f, [
    ['href="/college/', 'href="../college/'],
    ['href="/employer/', 'href="./']
  ]);
});
