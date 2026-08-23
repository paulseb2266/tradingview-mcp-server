const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

const HTML_FILE = path.join(__dirname, 'paper-dashboard.html');
const DATA_FILE = path.join(__dirname, 'paper-dashboard-data.json');
const PORT = 3001;

http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  if (parsed.pathname === '/api/data') {
    res.setHeader('Content-Type', 'application/json');
    fs.readFile(DATA_FILE, (err, data) => {
      if (err) {
        res.writeHead(200);
        res.end(JSON.stringify({
          balance: 1000, startingBalance: 1000, openPositions: [], closedTrades: [],
          stats: { totalTrades: 0, wins: 0, losses: 0, winRate: null, totalRealizedPnl: 0 },
          lastUpdated: null,
        }));
        return;
      }
      res.writeHead(200);
      res.end(data);
    });
    return;
  }

  if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
    fs.readFile(HTML_FILE, (err, data) => {
      if (err) { res.writeHead(500); res.end('Could not read paper-dashboard.html'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');

}).listen(PORT, '127.0.0.1', () => {
  console.log('Paper trading dashboard running at http://localhost:' + PORT);
  console.log('Press Ctrl+C to stop.');
});
