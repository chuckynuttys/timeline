// Fix Unity glTFast exports that put `skin` on nodes whose mesh has no
// JOINTS_0/WEIGHTS_0 attributes — three's SkinnedMesh.normalizeSkinWeights
// crashes on those ("reading 'count'"). Stripping the bogus skin ref makes the
// mesh render rigidly at its node transform, which is what the data supports.
// Usage: node scripts/sanitize-glb.mjs public/models/reika.glb
import { readFileSync, writeFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('usage: node scripts/sanitize-glb.mjs <file.glb>');
  process.exit(1);
}

const buf = readFileSync(path);
if (buf.toString('ascii', 0, 4) !== 'glTF') throw new Error('not a glb');
const jsonLen = buf.readUInt32LE(12);
if (buf.toString('ascii', 16, 20) !== 'JSON') throw new Error('unexpected chunk order');
const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
const rest = buf.subarray(20 + jsonLen); // BIN chunk (and any others), verbatim

let fixed = 0;
for (const node of json.nodes ?? []) {
  if (node.skin === undefined || node.mesh === undefined) continue;
  const mesh = json.meshes[node.mesh];
  const skinned = mesh.primitives.every(
    (p) => p.attributes && p.attributes.WEIGHTS_0 !== undefined,
  );
  if (!skinned) {
    console.log(`stripping skin ${node.skin} from node "${node.name}"`);
    delete node.skin;
    fixed++;
  }
}
if (!fixed) {
  console.log('nothing to fix');
  process.exit(0);
}

// Re-pack: JSON chunk padded to 4 bytes with spaces (per glb spec).
let jsonText = JSON.stringify(json);
while (Buffer.byteLength(jsonText) % 4 !== 0) jsonText += ' ';
const jsonBuf = Buffer.from(jsonText, 'utf8');
const header = Buffer.alloc(20);
header.write('glTF', 0, 'ascii');
header.writeUInt32LE(2, 4);
header.writeUInt32LE(20 + jsonBuf.length + rest.length, 8);
header.writeUInt32LE(jsonBuf.length, 12);
header.write('JSON', 16, 'ascii');
writeFileSync(path, Buffer.concat([header, jsonBuf, rest]));
console.log(`fixed ${fixed} node(s); wrote ${path}`);
