// End-to-end profiles verification. Stages: tab UI -> switch to Test ->
// complete a block in Test (its OWN ledger) -> switch back -> add/remove.
import { send, evaljs, sleep } from './cdp.mjs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const dir = path.join(process.env.APPDATA, 'com.chardoh.timeline');
const count = (file, table) => {
  const db = new DatabaseSync(path.join(dir, file), { readOnly: true });
  const n = db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
  db.close();
  return n;
};
const testFile = () => {
  const db = new DatabaseSync(path.join(dir, 'profiles.db'), { readOnly: true });
  const r = db.prepare(`SELECT db_file FROM profiles WHERE name = 'Test'`).get();
  db.close();
  return r.db_file;
};
const mouse = (type, x, y, buttons, extra = {}) =>
  send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1, ...extra });
const drag = async (x1, y1, x2, y2, steps = 10) => {
  await mouse('mousePressed', x1, y1, 1);
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps, 1);
    await sleep(25);
  }
  await mouse('mouseReleased', x2, y2, 0);
};
const click = (sel) => evaljs(`(() => { const b = [...document.querySelectorAll('${sel}')]; if (!b.length) return 'NOT FOUND'; b[0].click(); return 'clicked'; })()`);
const clickProfileRow = (name) => evaljs(`(() => {
  const btn = [...document.querySelectorAll('.profile-name')].find(b => b.textContent.trim().startsWith('${name}'));
  if (!btn) return 'row not found'; btn.click(); return 'clicked ' + btn.textContent.trim();
})()`);
const ui = () => evaljs(`(() => ({
  title: document.title,
  activeLabel: document.querySelector('.active-profile')?.textContent?.trim(),
  blocks: document.querySelectorAll('.block').length,
  total: document.querySelectorAll('.stats .card .card-val')[0]?.textContent?.trim(),
}))()`);

// A) boot state
await send('Page.navigate', { url: 'http://localhost:5173/' });
await sleep(3000);
console.log('A boot          ', JSON.stringify(await ui()));

// B) profiles tab snapshot
await click('.tab:nth-child(2)');
await sleep(200);
const rows = await evaljs(`[...document.querySelectorAll('.profile-row')].map(r => ({
  name: r.querySelector('.profile-name').textContent.trim(),
  nameDisabled: r.querySelector('.profile-name').disabled,
  removeDisabled: r.querySelector('.remove').disabled,
  removeTip: r.querySelector('.remove').title,
}))`);
console.log('B rows          ', JSON.stringify(rows));

// C) switch to Test (confirm flow) -> reload
console.log('C click Test    ', await clickProfileRow('Test'));
await sleep(200);
console.log('C confirm text  ', await evaljs(`document.querySelector('.confirm span')?.textContent?.trim()`));
await click('.confirm-yes');
await sleep(4000); // reload + boot + catch-up
console.log('C in Test       ', JSON.stringify(await ui()));

// D) schedule + complete a block in Test: drop the first pool chip well LEFT
// of the now-line (start in the past), shrink to min so its end has passed,
// and let the 1s tick complete it — into TEST's ledger only.
const entriesBefore = count(testFile(), 'time_entries');
const chardohBefore = count('timeline.db', 'time_entries');
const chip = await evaljs(`(() => { const c = document.querySelector('.chip'); const r = c.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
const lane = await evaljs(`(() => { const t = document.querySelector('.timeline').getBoundingClientRect(); return { x: t.left + t.width*0.25 - 250, y: t.top + 80, nowX: t.left + t.width*0.25 }; })()`);
await drag(chip.x, chip.y, lane.x, lane.y, 12);
await sleep(600);
const b = await evaljs(`(() => { const bs = [...document.querySelectorAll('.block:not(.completed)')]; const bl = bs[bs.length-1]; if (!bl) return null; const r = bl.getBoundingClientRect(); const rz = bl.querySelector('.resize-zone').getBoundingClientRect(); return { cy: r.top + r.height/2, rzx: rz.left + rz.width/2, left: r.left }; })()`);
console.log('D dropped block ', b ? 'yes' : 'NO BLOCK');
await drag(b.rzx, b.cy, b.left + 5, b.cy, 8); // shrink to min: end in the past
await sleep(2200); // completion tick
console.log('D test ledger   +', count(testFile(), 'time_entries') - entriesBefore,
  '| chardoh ledger +', count('timeline.db', 'time_entries') - chardohBefore, '(expect +1 and +0)');
console.log('D test ui       ', JSON.stringify(await ui()));

// E) switch back to Chardoh
await click('.tab:nth-child(2)');
await sleep(200);
await clickProfileRow('Chardoh');
await sleep(200);
await click('.confirm-yes');
await sleep(4000);
console.log('E back Chardoh  ', JSON.stringify(await ui()));

// F) add a third profile (REAL key events so Svelte's binding engages),
// CANCEL its switch, then remove it via the red ✕.
const { existsSync } = await import('node:fs');
await click('.tab:nth-child(2)');
await sleep(200);
const inp = await evaljs(`(() => { const i = document.querySelector('.add-input'); const r = i.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
await mouse('mousePressed', inp.x, inp.y, 1);
await mouse('mouseReleased', inp.x, inp.y, 0);
await send('Input.insertText', { text: 'Zeta' });
await sleep(200);
const addBtn = await evaljs(`(() => { const b = document.querySelector('.add-btn'); const r = b.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2, disabled: b.disabled }; })()`);
console.log('F add enabled   ', !addBtn.disabled);
await mouse('mousePressed', addBtn.x, addBtn.y, 1);
await mouse('mouseReleased', addBtn.x, addBtn.y, 0);
await sleep(1000);
console.log('F after add     ', await evaljs(`[...document.querySelectorAll('.profile-name')].map(b => b.textContent.trim().split('\\n')[0])`));
await click('.confirm-no'); // decline the switch — Zeta stays, we stay in Chardoh
await sleep(200);
const zetaFile = (() => {
  const db = new DatabaseSync(path.join(dir, 'profiles.db'), { readOnly: true });
  const r = db.prepare(`SELECT db_file FROM profiles WHERE name = 'Zeta'`).get();
  db.close();
  return r?.db_file;
})();
console.log('F zeta db file  ', zetaFile, '| exists on disk:', !!zetaFile && existsSync(path.join(dir, zetaFile)));
// remove Zeta
await evaljs(`(() => { const rows = [...document.querySelectorAll('.profile-row')]; const z = rows.find(r => r.textContent.includes('Zeta')); z.querySelector('.remove').click(); return 1; })()`);
await sleep(200);
console.log('F remove confirm', await evaljs(`document.querySelector('.confirm.danger span')?.textContent?.trim()`));
await click('.confirm-del');
await sleep(800);
console.log('F rows after del', await evaljs(`[...document.querySelectorAll('.profile-name')].map(b => b.textContent.trim().split('\\n')[0])`));
console.log('F zeta file gone:', !!zetaFile && !existsSync(path.join(dir, zetaFile)));
process.exit(0);
