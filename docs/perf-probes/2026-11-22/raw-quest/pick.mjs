// Returns the visible echomultiverse page tab.
export async function pickTab() {
  const list = (await (await fetch('http://127.0.0.1:9222/json/list')).json()).filter(x => x.type === 'page' && /echomultiverse/.test(x.url));
  for (const t of list) {
    const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r));
    const v = await new Promise(r => { ws.addEventListener('message', e => r(JSON.parse(e.data).result?.result?.value)); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'document.visibilityState', returnByValue: true } })); });
    ws.close(); if (v === 'visible') return t;
  }
  return list[0];
}
