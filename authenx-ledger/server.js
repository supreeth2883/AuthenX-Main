const { createServer } = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { resolve } = require('node:path');

const PORT = 8080;

// For this simulation, we read the public keys from the main seeded db.
// In reality, this data would be fetched from Ethereum or a consortium blockchain network.
const dbPath = resolve(__dirname, '../authenx-node/authenx.db');
const db = new DatabaseSync(dbPath);

createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET' && req.url.startsWith('/ledger/public-keys/')) {
    const collegeId = req.url.split('/').pop();
    try {
      const stmt = db.prepare('SELECT id, name, public_key_hex, active FROM colleges WHERE id = ?');
      const row = stmt.get(collegeId);
      if (!row) {
        res.writeHead(404);
        return res.end(JSON.stringify({ error: 'College not found on ledger' }));
      }
      res.writeHead(200);
      res.end(JSON.stringify({
        source: 'Decentralized Consortium Ledger (Mock)',
        college_id: row.id,
        college_name: row.name,
        public_key_hex: row.public_key_hex,
        ledger_verified: row.active === 1
      }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Ledger Node Error' }));
    }
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(PORT, () => console.log(`[ledger] Blockchain public key ledger running on port ${PORT}`));
