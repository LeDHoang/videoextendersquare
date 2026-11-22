// Range + CORS (+ Private Network Access) file server for the A/B clips. usage: node serve.mjs <dir> <port>
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const dir = process.argv[2], port = +process.argv[3];
http.createServer((q, r) => {
  const h = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Allow-Headers': 'range', 'Access-Control-Expose-Headers': 'content-range,content-length,accept-ranges', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  if (q.method === 'OPTIONS') { r.writeHead(204, h); return r.end(); }
  const f = path.join(dir, path.basename(new URL(q.url, 'http://x').pathname));
  const html = f.endsWith('.html');
  if (!fs.existsSync(f)) { r.writeHead(404, h); return r.end(); }
  const n = fs.statSync(f).size, m = /bytes=(\d*)-(\d*)/.exec(q.headers.range || '');
  let a = 0, z = n - 1, code = 200;
  if (m) { a = m[1] ? +m[1] : n - +m[2]; z = m[1] && m[2] ? +m[2] : n - 1; code = 206; h['Content-Range'] = `bytes ${a}-${z}/${n}`; }
  r.writeHead(code, { ...h, 'Content-Type': html ? 'text/html' : 'video/mp4', 'Content-Length': z - a + 1 });
  console.log(new Date().toISOString().slice(11, 23), q.method, q.url, q.headers.range || '');
  if (q.method === 'HEAD') return r.end();
  fs.createReadStream(f, { start: a, end: z }).pipe(r);
}).listen(port, () => console.log('listening', port));
