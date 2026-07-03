// Minimal CDP client for the Timeline app's WebView2 (--remote-debugging-port=9222)
const targets = await fetch('http://127.0.0.1:9222/json').then((r) => r.json());
const page = targets.find((t) => t.type === 'page' && t.url.includes('localhost:5173'));
if (!page) {
  console.error('No page target found. Targets:', targets.map((t) => `${t.type} ${t.url}`));
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
const events = [];

ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d);
    pending.delete(d.id);
  } else if (d.method) {
    events.push(d);
  }
};
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaljs(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.result?.exceptionDetails) {
    return { __error: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text };
  }
  return r.result?.result?.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mouseDrag(fromX, fromY, toX, toY, steps = 12) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX, y: fromY, pointerType: 'mouse' });
  await sleep(60);
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: fromX, y: fromY, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse',
  });
  await sleep(60);
  for (let i = 1; i <= steps; i++) {
    const x = fromX + ((toX - fromX) * i) / steps;
    const y = fromY + ((toY - fromY) * i) / steps;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1, pointerType: 'mouse' });
    await sleep(25);
  }
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: toX, y: toY, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse',
  });
  await sleep(120);
}

await send('Runtime.enable');
await send('Console.enable');

export { send, evaljs, mouseDrag, sleep, events, ws };
