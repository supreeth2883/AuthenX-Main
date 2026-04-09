const http = require('http');
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.writeHead(401);
  res.end('fail');
}).listen(9999, () => {
  const req = http.request('http://localhost:9999', res => {
    console.log(res.headers);
    process.exit(0);
  });
  req.end();
});
