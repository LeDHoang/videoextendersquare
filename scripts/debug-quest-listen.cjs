// Live CDP listener for the Quest reels tab: records console + exception + entry
// events for a fixed window, prints JSON lines to stdout. Use while reproducing a
// WebXR enter/abort to capture the underlying error before the tab is hidden.
// Node 26 (global fetch + WebSocket). Usage: node debug-quest-listen.cjs [seconds]

const DURATION = parseInt(process.argv[2] || '40', 10);
const REELS_HOST = 'localhost:5173/reels';

(async () => {
  const res = await fetch('http://localhost:9222/json');
  const tabs = await res.json();
  const reels = tabs.filter(t => t.type === 'page' && (t.url || '').includes(REELS_HOST));
  if (!reels.length) { console.error('NO_REELS_TAB:', tabs.map(t => t.url).join(' | ')); process.exit(1); }

  const ws = new WebSocket(reels[0].webSocketDebuggerUrl);
  let nextId = 1;
  const send = (method, params = {}) => ws.send(JSON.stringify({ id: nextId++, method, params }));

  const onMsg = (ev) => {
    const m = JSON.parse(ev.data);
    try {
      if (m.method === 'Runtime.consoleAPICalled') {
        const args = m.params.args.map(a => {
          if (a.value !== undefined) return JSON.stringify(a.value);
          if (a.description) return a.description;
          return String(a);
        }).join(' ');
        console.log('CONSOLE[' + m.params.type + '] ' + args.slice(0, 600));
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        console.log('EXCEPTION ' + (d.exception ? d.exception.description || d.exception.value : d.text));
      } else if (m.method === 'Log.entryAdded') {
        const e = m.params.entry;
        console.log('LOG[' + e.level + '] ' + e.text.slice(0, 600));
      }
    } catch (err) { console.log('PARSE_ERR', String(err)); }
  };

  ws.addEventListener('open', () => {
    send('Runtime.enable');
    send('Log.enable');
    console.log('LISTENING for ' + DURATION + 's — reproduce VR enter now…');
    setTimeout(() => { console.log('DONE'); try { ws.close(); } catch (e) {} process.exit(0); }, DURATION * 1000);
  });
  ws.addEventListener('message', onMsg);
  ws.addEventListener('error', (e) => { console.log('WS_ERROR', String(e)); process.exit(1); });
  ws.addEventListener('close', () => process.exit(0));
})();