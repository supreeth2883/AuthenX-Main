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
  'ui/college/index.html',
  'ui/college/issue.html',
  'ui/college/app.js'
];
filesCollege.forEach(f => {
  replaceInFile(f, [
    ['href="./', 'href="/college/'],
    ['src="./', 'src="/college/'],
    ['window.location.href = \'./', 'window.location.href = \'/college/'],
    ['window.location.href = "./', 'window.location.href = "/college/'],
    ['href="../employer/', 'href="/employer/'],
    ['src="../shared/', 'src="/shared/']
  ]);
});

const filesEmployer = [
  'ui/employer/index.html',
  'ui/employer/verify.html',
  'ui/employer/verified.html',
  'ui/employer/revoked.html',
  'ui/employer/decoding.html',
  'ui/employer/verify.js'
];
filesEmployer.forEach(f => {
  replaceInFile(f, [
    ['href="./', 'href="/employer/'],
    ['src="./', 'src="/employer/'],
    ['window.location.href = \'./', 'window.location.href = \'/employer/'],
    ['window.location.href = "./', 'window.location.href = "/employer/'],
    ['href="../college/', 'href="/college/'],
    ['src="../shared/', 'src="/shared/']
  ]);
});

