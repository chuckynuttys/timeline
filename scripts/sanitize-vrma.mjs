// Fix UniVRM .vrma exports whose humanoid hips is stripped: they write
// humanBones.hips.node = -1 AND leave the hips translation/rotation channels
// with NO target.node. three-vrm-animation crashes on hips=-1 ("reading
// 'matrixWorld'"), and GLTFLoader silently skips the orphaned channels, which
// would desync the plugin's channel<->track 1:1 mapping.
// Repair: append a "HipsRoot" node (not in any scene — hipsParent falls back
// to identity), point humanBones.hips and the orphaned channels at it, and —
// CRITICALLY — give it the animation's rest translation, read from the FIRST
// KEYFRAME of the hips translation sampler: the retargeter scales root motion
// by modelHipsY / restHipsPosition.y, so an identity node (y=0) explodes the
// hips to Infinity and the model vanishes.
// Idempotent: re-running backfills the translation on already-patched files.
// Usage: node scripts/sanitize-vrma.mjs public/models/vrma/*.vrma
import { readFileSync, writeFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node scripts/sanitize-vrma.mjs <file.vrma> [...]');
  process.exit(1);
}

for (const path of files) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'glTF') throw new Error(`${path}: not a glb container`);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
  const rest = buf.subarray(20 + jsonLen); // BIN chunk verbatim

  const ext = json.extensions?.VRMC_vrm_animation;
  if (!ext) {
    console.log(`${path}: no VRMC_vrm_animation — skipped`);
    continue;
  }
  const hips = ext.humanoid?.humanBones?.hips;
  if (!hips) {
    console.log(`${path}: no hips entry — skipped`);
    continue;
  }

  let hipsIdx = hips.node ?? -1;
  let rewired = 0;
  if (hipsIdx < 0) {
    hipsIdx = json.nodes.length;
    json.nodes.push({ name: 'HipsRoot' });
    hips.node = hipsIdx;
    for (const anim of json.animations ?? []) {
      for (const ch of anim.channels ?? []) {
        if (ch.target && ch.target.node == null) {
          ch.target.node = hipsIdx;
          rewired++;
        }
      }
    }
  } else if (json.nodes[hipsIdx]?.name !== 'HipsRoot') {
    console.log(`${path}: hips already valid — skipped`);
    continue;
  }

  // Rest transform for the synthetic node = FIRST KEYFRAME of the hips
  // channels (idle clips start at ~rest pose). Translation.y feeds the
  // retargeter's height ratio (identity => divide-by-zero => model at
  // Infinity); rotation feeds its `q · rest⁻¹` normalization (identity =>
  // the rig's baked hips orientation leaks through => model faces backward).
  const hipsNode = json.nodes[hipsIdx];
  const firstKeyframe = (path_, n) => {
    const ch = (json.animations ?? [])
      .flatMap((a) => a.channels.map((c) => ({ a, c })))
      .find(({ c }) => c.target.node === hipsIdx && c.target.path === path_);
    if (!ch) return null;
    const sampler = ch.a.samplers[ch.c.sampler];
    const acc = json.accessors[sampler.output];
    const bv = json.bufferViews[acc.bufferView];
    // BIN chunk starts after the JSON chunk's 8-byte header.
    const off = 20 + jsonLen + 8 + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    return Array.from({ length: n }, (_, i) => buf.readFloatLE(off + 4 * i));
  };
  if (!hipsNode.translation) {
    hipsNode.translation = firstKeyframe('translation', 3) ?? undefined;
  }
  if (!hipsNode.rotation) {
    hipsNode.rotation = firstKeyframe('rotation', 4) ?? undefined;
  }
  console.log(
    `${path}: rest hips t=[${(hipsNode.translation ?? []).map((n) => n.toFixed(3)).join(', ')}]` +
      ` r=[${(hipsNode.rotation ?? []).map((n) => n.toFixed(3)).join(', ')}]`,
  );

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
  console.log(`${path}: hips -> node ${hipsIdx}, ${rewired} channel(s) rewired`);
}
