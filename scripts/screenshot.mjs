import { writeFileSync } from 'node:fs';
import { send, sleep, ws } from './cdp.mjs';

await sleep(400);
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(process.argv[2] ?? 'shot.png', Buffer.from(shot.result.data, 'base64'));
console.log('saved', process.argv[2] ?? 'shot.png');
ws.close();
