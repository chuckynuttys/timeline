import { send, evaljs, mouseDrag, sleep, ws } from './cdp.mjs';

await send('Page.enable');
await send('Page.reload');
await sleep(2500);

// Pick a block whose center is VISIBLE and actually hit-testable (not behind
// the gutter, not covered by an overlapping block).
const target = await evaljs(`(() => {
  const tl = document.querySelector('.timeline').getBoundingClientRect();
  for (const b of document.querySelectorAll('.block')) {
    const r = b.getBoundingClientRect();
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    if (cx > tl.x + 20 && cx < tl.right - 20 && document.elementFromPoint(cx, cy)?.closest('.block') === b) {
      const blocks = [...document.querySelectorAll('.block')];
      return { idx: blocks.indexOf(b), cx, cy, top: b.style.top, left: b.style.left, bg: b.style.background };
    }
  }
  return null;
})()`);
console.log('target:', JSON.stringify(target));

// T1: cross-lane drag straight down one lane
await mouseDrag(target.cx, target.cy, target.cx, target.cy + 88);
await sleep(400);
const after = await evaljs(`(() => {
  const b = document.querySelectorAll('.block')[${'' + (await 0, '')}${target.idx}];
  return { top: b.style.top, left: b.style.left, bg: b.style.background };
})()`);
const leftDelta = Math.abs(parseFloat(after.left) - parseFloat(target.left));
console.log(`T1 CROSS-LANE: top ${target.top} -> ${after.top} (expect +88) | bg ${target.bg} -> ${after.bg}`);
console.log(`   time drift: ${leftDelta.toFixed(1)}px | ${leftDelta <= 16 ? 'OK (within snap)' : 'FAIL'}`);

// T2: pool drop into the Rest lane (3rd lane)
const drop = await evaljs(`(() => {
  const chip = document.querySelector('.chip').getBoundingClientRect();
  const tl = document.querySelector('.timeline').getBoundingClientRect();
  return { cx: chip.x + chip.width / 2, cy: chip.y + chip.height / 2,
           tx: tl.x + tl.width * 0.7, ty: tl.y + 28 + 2 * 88 + 44 };
})()`);
const nBefore = await evaljs(`document.querySelectorAll('.block').length`);
await mouseDrag(drop.cx, drop.cy, drop.tx, drop.ty);
await sleep(400);
const nb = await evaljs(`(() => {
  const bs = document.querySelectorAll('.block');
  const b = bs[bs.length - 1];
  return { n: bs.length, top: b.style.top, bg: b.style.background };
})()`);
console.log(`T2 POOL DROP -> REST: blocks ${nBefore} -> ${nb.n} | top ${nb.top} (expect 212px) | bg ${nb.bg} (expect rgb(201, 139, 219))`);

ws.close();
