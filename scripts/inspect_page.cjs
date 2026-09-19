const fs = require('fs');

async function inspect(urlPattern, outScreenshot) {
  const verRes = await fetch('http://localhost:9222/json/version');
  const ver = await verRes.json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  let id = 1;
  const callbacks = new Map();

  const call = (method, params = {}, sessionId) => {
    const msgId = id++;
    const payload = { id: msgId, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      callbacks.set(msgId, { resolve, reject });
      ws.send(JSON.stringify(payload));
    });
  };

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && callbacks.has(m.id)) {
      const { resolve, reject } = callbacks.get(m.id);
      callbacks.delete(m.id);
      if (m.error) reject(m.error);
      else resolve(m.result);
    }
  });

  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  const targets = await call('Target.getTargets');
  const page = (targets.targetInfos || []).find(t => (t.url || '').includes(urlPattern));
  if (!page) {
    console.error('Target not found for pattern:', urlPattern);
    process.exit(1);
  }

  const { sessionId } = await call('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  await call('Runtime.enable', {}, sessionId);
  await call('Page.enable', {}, sessionId);

  const evalRes = await call('Runtime.evaluate', {
    expression: `({
      title: document.title,
      url: window.location.href,
      bodyText: document.body.innerText.slice(0, 500),
      hasErrorBoundary: document.body.innerText.includes('SOMETHING WENT WRONG') || document.body.innerText.includes('replace is not a function')
    })`,
    returnByValue: true
  }, sessionId);

  console.log('EVAL RESULT:', JSON.stringify(evalRes.result ? evalRes.result.value : evalRes, null, 2));

  if (outScreenshot) {
    const shot = await call('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(outScreenshot, Buffer.from(shot.data, 'base64'));
    console.log('Saved screenshot to:', outScreenshot);
  }

  process.exit(0);
}

const args = process.argv.slice(2);
inspect(args[0] || 'reels/immersive-preview', args[1]).catch((err) => {
  console.error(err);
  process.exit(1);
});
