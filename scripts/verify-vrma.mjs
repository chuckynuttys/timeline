// VRMA pipeline verification: real reika.vrm + retargeted animations,
// random cycling, manual dropdown, action hygiene, lookAt across switches.
import { send, evaljs, sleep, ws } from './cdp.mjs';

const dbg = (expr) => evaljs(`window.__avatarDebug.${expr}`);

await send('Console.enable');
const lines = [];
ws.addEventListener('message', (ev) => {
  const e = JSON.parse(ev.data);
  if (e.method === 'Console.messageAdded' && e.params.message.text.includes('AvatarPanel'))
    lines.push(e.params.message.text.slice(0, 200));
});

await send('Page.navigate', { url: 'http://localhost:5173/' });
await sleep(15000); // 72MB VRM + 13 vrma loads
console.log(lines.filter((l) => l.includes('mode') || l.includes('VRMA')).map((l) => '  | ' + l).join('\n'));
console.log('1 state:', JSON.stringify({
  mode: await dbg('mode()'),
  springJoints: await dbg('springJoints()'),
  anims: (await dbg('anims()')).length,
  play: await dbg('playState()'),
}));

// 2) random cycling: watch the current clip change over ~35s
const seen = [];
for (let i = 0; i < 12; i++) {
  const p = await dbg('playState()');
  if (seen[seen.length - 1] !== p.current) seen.push(p.current);
  await sleep(3000);
}
const noImmediateRepeat = seen.every((n, i) => i === 0 || n !== seen[i - 1]);
console.log('2 random walk:', seen.join(' -> '));
console.log('  distinct switches:', seen.length - 1, '| no immediate repeats:', noImmediateRepeat,
  '| activeActions:', await dbg('activeActions()'), '(expect <= 2)');

// 3) dropdown -> manual mode, holds
const opts = await evaljs(`[...document.querySelectorAll('.anim-select option')].map(o => o.value)`);
console.log('3 dropdown options:', opts.length, '(expect 14)');
await evaljs(`(() => { const s = document.querySelector('.anim-select'); s.value = 'Dance02'; s.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
await sleep(500);
console.log('3 after pick    :', JSON.stringify(await dbg('playState()')), '| select shows:', await evaljs(`document.querySelector('.anim-select').value`));
await sleep(12000); // longer than any clip — manual must HOLD
console.log('3 12s later     :', JSON.stringify(await dbg('playState()')), '(must still be manual/Dance02)');

// 4) lookAt still tracks across clip playback
const ahead = await dbg('lookTarget()');
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 40, y: 40, buttons: 0 });
await sleep(600);
const tracked = await dbg('lookTarget()');
console.log('4 lookAt during animation moves:', Math.abs(tracked[0] - ahead[0]) > 0.05);

// 5) action hygiene after rapid manual switching (in-page loop via the select)
await evaljs(`(async () => { const names = window.__avatarDebug.anims(); for (let i = 0; i < 12; i++) { const ev = new Event('change', { bubbles: true }); const s = document.querySelector('.anim-select'); s.value = names[i % names.length]; s.dispatchEvent(ev); await new Promise(r => setTimeout(r, 120)); } return 1; })()`);
await sleep(1000);
console.log('5 after 12 rapid switches: activeActions =', await dbg('activeActions()'), '(expect <= 2)',
  '| state:', JSON.stringify(await dbg('playState()')));

// 6) back to random
await evaljs(`(() => { const s = document.querySelector('.anim-select'); s.value = '__random'; s.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
await sleep(400);
console.log('6 back to random:', JSON.stringify(await dbg('playState()')), '| select shows:', await evaljs(`document.querySelector('.anim-select').value`));
process.exit(0);
