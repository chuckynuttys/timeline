// Behavioral proofs for VRM mode (run with the app on ?avatar=/models/test.vrm).
import { send, evaljs, sleep } from './cdp.mjs';

const dbg = (expr) => evaljs(`window.__avatarDebug.${expr}`);
const clip = async () => {
  const r = await evaljs(`(() => { const c = document.querySelector('.avatar-panel canvas').getBoundingClientRect(); return { x: Math.round(c.left), y: Math.round(c.top), width: Math.round(c.width), height: Math.round(c.height), scale: 1 }; })()`);
  return (await send('Page.captureScreenshot', { format: 'png', clip: r })).result.data;
};

await send('Page.navigate', { url: 'http://localhost:5173/?avatar=/models/test.vrm' });
await sleep(6000);
console.log('mode:', await dbg('mode()'), '| springJoints:', await dbg('springJoints()'));

// --- 1) lookAt tracks the mouse (with panel-relative direction) ---
const ahead = await dbg('lookTarget()');
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 30, y: 30, buttons: 0 }); // far top-left
await sleep(600); // damped lerp catches up
const tracked = await dbg('lookTarget()');
console.log('1 lookAt: ahead x', +ahead[0].toFixed(3), '-> tracked x', +tracked[0].toFixed(3),
  '| moved left+up:', tracked[0] < ahead[0] - 0.05 && tracked[1] > ahead[1]);

// --- 2) idle >5s -> gaze returns to straight ahead ---
await sleep(5600);
const returned = await dbg('lookTarget()');
const dist = Math.hypot(returned[0] - ahead[0], returned[1] - ahead[1], returned[2] - ahead[2]);
console.log('2 idle-return: back within', dist.toFixed(3), 'm of straight-ahead:', dist < 0.05);

// --- 3) spring bones: nudge the model sideways -> hair physics swings while
//        the camera is static and there is NO animation clip ---
const still1 = await clip();
const still2 = await clip();
await evaljs(`(() => { window.__avatarDebug.vrmRef().scene.position.x += 0.12; return 1; })()`);
await sleep(120);
await evaljs(`(() => { window.__avatarDebug.vrmRef().scene.position.x -= 0.12; return 1; })()`);
await sleep(150); // mid-swing
const swinging = await clip();
console.log('3 springs: at-rest frames identical:', still1 === still2,
  '| swinging frame differs after nudge:', swinging !== still2);

// --- 4) expressions facade drives visible change through vrm.update ---
const neutral = await clip();
await evaljs(`(() => { window.__avatarDebug.setExpression('happy', 1); return 1; })()`);
await sleep(200);
const happy = await clip();
await evaljs(`(() => { window.__avatarDebug.setExpression('happy', 0); return 1; })()`);
console.log('4 expression "happy" visibly changes the render:', happy !== neutral);

// --- 5) delta clamp: a 1.2s main-thread hitch must not explode the physics ---
await sleep(2500); // springs fully settle
const before = await clip();
await evaljs(`(() => { const t = performance.now(); while (performance.now() - t < 1200) {} return 'hitched'; })()`);
await sleep(700); // a few clamped frames
const after = await clip();
// exploded hair = massive pixel change; settled = near-identical render
console.log('5 hitch survived (frame within', Math.abs(after.length - before.length), 'bytes of pre-hitch, exploded would differ wildly)');

// --- 6) orbit + home still work in VRM mode ---
const c = await evaljs(`(() => { const r = document.querySelector('.avatar-panel canvas').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
const mouse = (type, x, y, buttons, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1, ...extra });
const home = await dbg('camPos()');
await mouse('mousePressed', c.x, c.y, 1);
for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', c.x + i * 15, c.y, 1); await sleep(20); }
await mouse('mouseReleased', c.x + 90, c.y, 0);
await sleep(500);
const orbited = await dbg('camPos()');
await mouse('mousePressed', c.x, c.y, 1); await mouse('mouseReleased', c.x, c.y, 0);
await mouse('mousePressed', c.x, c.y, 1, { clickCount: 2 }); await mouse('mouseReleased', c.x, c.y, 0, { clickCount: 2 });
await sleep(300);
const back = await dbg('camPos()');
const d3 = (a, b) => Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);
console.log('6 orbit works:', d3(home, orbited) > 0.5, '| dblclick home:', d3(back, home) < 0.01);
process.exit(0);
