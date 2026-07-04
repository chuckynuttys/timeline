// Verifies the dual-mode avatar pipeline. Usage:
//   node scripts/verify-vrm.mjs glb   — default chain (expects GLB fallback)
//   node scripts/verify-vrm.mjs vrm   — ?avatar=/models/test.vrm (expects VRM mode)
import { send, evaljs, sleep, ws } from './cdp.mjs';

const mode = process.argv[2] ?? 'glb';
const url =
  mode === 'vrm'
    ? 'http://localhost:5173/?avatar=/models/test.vrm'
    : 'http://localhost:5173/';

await send('Console.enable');
const lines = [];
ws.addEventListener('message', (ev) => {
  const e = JSON.parse(ev.data);
  if (e.method === 'Console.messageAdded' && e.params.message.text.includes('AvatarPanel'))
    lines.push(e.params.message.text.slice(0, 140));
});

await send('Page.navigate', { url });
await sleep(6000); // model load
console.log(lines.map((l) => '  | ' + l).join('\n'));
const state = await evaljs(`window.__avatarDebug ? {
  mode: window.__avatarDebug.mode(),
  springJoints: window.__avatarDebug.springJoints(),
  expressions: window.__avatarDebug.expressions(),
  camPos: window.__avatarDebug.camPos().map(n => +n.toFixed(2)),
  lookTarget: window.__avatarDebug.lookTarget().map(n => +n.toFixed(2)),
} : 'NO DEBUG HOOK'`);
console.log('state:', JSON.stringify(state));
process.exit(0);
