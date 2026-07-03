import { send, evaljs, sleep, events, ws } from './cdp.mjs';

await send('Log.enable');
// force reload to catch boot-time errors
await send('Page.enable');
await send('Page.reload', { ignoreCache: false });
await sleep(2500);

for (const e of events) {
  if (e.method === 'Runtime.exceptionThrown') {
    console.log('EXCEPTION:', JSON.stringify(e.params.exceptionDetails, null, 1).slice(0, 1500));
  } else if (e.method === 'Console.messageAdded' && ['error', 'warning'].includes(e.params.message.level)) {
    console.log(`${e.params.message.level.toUpperCase()}:`, e.params.message.text.slice(0, 500));
  }
}
const dom = await evaljs(`({
  wrap: !!document.querySelector('.timeline-wrap'),
  timeline: !!document.querySelector('.timeline'),
  ticks: document.querySelectorAll('.tick').length,
  blocks: document.querySelectorAll('.block').length,
  bodyHtml: document.querySelector('.timeline-body')?.innerHTML.slice(0, 300) ?? 'NO .timeline-body',
})`);
console.log('DOM:', JSON.stringify(dom, null, 1));
ws.close();
