<script lang="ts">
  import { onMount } from 'svelte';
  import * as THREE from 'three';
  import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
  import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
  import { store } from './store.svelte';

  /* ---- tuning ---------------------------------------------------------- */
  /** Soft fill so nothing is pitch black. */
  const AMBIENT_INTENSITY = 1.1;
  /** Key light, slightly above/front. */
  const KEY_INTENSITY = 2.2;
  /** How much of the panel HEIGHT the framed subject occupies (0.9 = nearly
   *  full, small margin). Raise to zoom in, lower to pull back. */
  const FRAME_FILL = 0.9;
  /** 'full' = whole body; 'upper' = hips-up character shot (closer). */
  const FRAME_TARGET: 'full' | 'upper' = 'full';
  /** Slight downward viewing angle (camera above target center). */
  const ELEVATION_DEG = 12;
  /** Reframe settles this long after the last resize event. */
  const REFRAME_DEBOUNCE_MS = 120;
  /* ---- orbit (drag to circle her, wheel to dolly) ------------------------ */
  /** Dolly clamps as fractions of the framed ("home") distance: close enough
   *  for a face shot without clipping inside the head; can't fly to infinity. */
  const ORBIT_MIN_FACTOR = 0.35;
  const ORBIT_MAX_FACTOR = 3;
  /** Polar range: never directly overhead, but allowed WELL below the horizon
   *  (160° ≈ looking steeply up from near the floor) for low-angle shots. */
  const POLAR_MIN_DEG = 15;
  const POLAR_MAX_DEG = 160;
  const ORBIT_DAMPING = 0.08;
  /** Crossfade length between clips. */
  const FADE_S = 0.3;
  /** Clip-name fragments that count as a celebration, in preference order. */
  const CELEBRATE_NAMES = ['wave', 'dance', 'cheer', 'jump'];
  const MODEL_URL = '/models/reika.glb';

  /** Load failed → muted placeholder instead of the canvas. Never throws. */
  let failed = $state(false);

  let container: HTMLDivElement;
  let canvas: HTMLCanvasElement;

  // Imperative three.js state — lives outside Svelte reactivity on purpose.
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene;
  let camera: THREE.PerspectiveCamera;
  let mixer: THREE.AnimationMixer | null = null;
  let clips: THREE.AnimationClip[] = [];
  let idleAction: THREE.AnimationAction | null = null;
  let currentAction: THREE.AnimationAction | null = null;
  /** World-space bounding box captured once at load; framing derives from it. */
  let frameBox: THREE.Box3 | null = null;
  let controls: OrbitControls | null = null;
  /** True once the user orbits/zooms — they own the camera; resize then only
   *  updates aspect (no snap-back). Cleared by the double-click home reset. */
  let userAdjusted = false;
  const timer = new THREE.Timer(); // Clock is deprecated in three r185
  let raf = 0;
  let running = false;
  let destroyed = false;

  /**
   * Fit the camera to the target box for the CURRENT aspect. Fits by HEIGHT:
   * distance = (targetHeight/2) / tan(vFov/2) / FRAME_FILL — the subject
   * occupies FRAME_FILL of the vertical view. In a narrow panel, width gets a
   * fit of its own and the LARGER distance wins, so the head never crops; in a
   * wide panel she simply has side space. 'upper' targets the top half of the
   * box (hips-up shot). Slight downward angle. Pure function of (box, aspect)
   * — safe to re-run on any resize.
   */
  function frame(): { center: THREE.Vector3; dist: number } | null {
    if (!frameBox || !camera) return null;
    const box = frameBox.clone();
    if (FRAME_TARGET === 'upper') box.min.y = (box.min.y + box.max.y) / 2;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    const vHalf = THREE.MathUtils.degToRad(camera.fov) / 2;
    const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
    const distH = size.y / 2 / Math.tan(vHalf) / FRAME_FILL;
    const distW = size.x / 2 / Math.tan(hHalf); // width fits exactly, no crop
    const dist = Math.max(distH, distW);

    const elev = THREE.MathUtils.degToRad(ELEVATION_DEG);
    camera.position.set(
      center.x,
      center.y + dist * Math.sin(elev),
      center.z + dist * Math.cos(elev),
    );
    camera.lookAt(center.x, center.y, center.z);
    return { center, dist };
  }

  /**
   * The "home" view: auto-frame, then hand the SAME pose to the controls —
   * orbit target at her center and dolly clamps derived from the framed
   * distance. OrbitControls re-reads camera.position relative to target on
   * every update(), so setting both and updating keeps the two in agreement
   * (no fight between framing and orbiting). Clears user ownership.
   */
  function goHome() {
    const f = frame();
    if (!f) return;
    if (controls) {
      controls.target.copy(f.center);
      controls.minDistance = f.dist * ORBIT_MIN_FACTOR;
      controls.maxDistance = f.dist * ORBIT_MAX_FACTOR;
      controls.update();
    }
    userAdjusted = false;
    if (renderer && !document.hidden) renderer.render(scene, camera);
  }

  /** Start (or restart) the rAF loop. Swallows the hidden-time clock gap so the
   *  mixer doesn't fast-forward the animation on return from background. */
  function start() {
    if (running || destroyed || !renderer) return;
    running = true;
    timer.reset(); // discard time accumulated while paused
    const loop = () => {
      if (!running) return;
      timer.update();
      mixer?.update(timer.getDelta());
      controls?.update(); // damping needs a per-frame update
      renderer!.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  /** Crossfade to a clip by name. loop=false plays once (clamped) and then
   *  crossfades back to idle via the mixer's 'finished' event. */
  export function playClip(name: string, { loop = true } = {}) {
    if (!mixer) return;
    const clip = THREE.AnimationClip.findByName(clips, name)
      ?? clips.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!clip) {
      console.warn(`AvatarPanel: no clip named "${name}"`);
      return;
    }
    const next = mixer.clipAction(clip);
    if (next === currentAction) return;
    next.reset();
    next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    next.clampWhenFinished = !loop;
    if (currentAction) next.crossFadeFrom(currentAction, FADE_S, false);
    next.play();
    currentAction = next;
  }

  /** Crossfade back to the looping idle clip. */
  export function returnToIdle() {
    if (!mixer || !idleAction || currentAction === idleAction) return;
    idleAction.reset();
    idleAction.setLoop(THREE.LoopRepeat, Infinity);
    if (currentAction) idleAction.crossFadeFrom(currentAction, FADE_S, false);
    idleAction.play();
    currentAction = idleAction;
  }

  /** Play the first celebration-ish clip once, if the export has one. */
  function celebrate() {
    if (!mixer) return;
    for (const frag of CELEBRATE_NAMES) {
      const clip = clips.find((c) => c.name.toLowerCase().includes(frag));
      if (clip) {
        playClip(clip.name, { loop: false });
        return;
      }
    }
    // no celebratory clip in this export — stay idle
  }

  // Part D: react to LIVE completions only. liveCompletionVersion is bumped in
  // the same tick-path that fires the notification (gated on store.reconciled),
  // so startup catch-up can never trigger it. The avatar merely READS a counter
  // — if this component dies, nothing else is affected.
  let lastSeen = store.liveCompletionVersion;
  $effect(() => {
    const v = store.liveCompletionVersion;
    if (v !== lastSeen) {
      lastSeen = v;
      celebrate();
    }
  });

  onMount(() => {
    let ro: ResizeObserver | null = null;
    let lastW = 0;
    let lastH = 0;
    let reframeTimer: ReturnType<typeof setTimeout> | undefined;
    const stopWheel = (e: WheelEvent) => e.stopPropagation();

    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
      renderer.setClearColor(0x000000, 0); // transparent — panel bg shows through
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(35, 1, 0.05, 100);
      camera.position.set(0, 1, 3); // non-degenerate until the model frames

      // Orbit: left-drag circles her, wheel dollies. Listens on the CANVAS
      // only, so the quadrant splitters at the panel edges are untouched.
      controls = new OrbitControls(camera, canvas);
      controls.enablePan = false; // panning off-target loses the character
      controls.enableDamping = true;
      controls.dampingFactor = ORBIT_DAMPING;
      controls.minPolarAngle = THREE.MathUtils.degToRad(POLAR_MIN_DEG);
      controls.maxPolarAngle = THREE.MathUtils.degToRad(POLAR_MAX_DEG);
      // Any interaction (rotate start or wheel) hands the camera to the user.
      controls.addEventListener('start', () => (userAdjusted = true));

      scene.add(new THREE.AmbientLight(0xffffff, AMBIENT_INTENSITY));
      const key = new THREE.DirectionalLight(0xffffff, KEY_INTENSITY);
      key.position.set(0.6, 1.4, 1.2); // slightly above and in front
      scene.add(key);

      new GLTFLoader().load(
        MODEL_URL,
        (gltf) => {
          if (destroyed) return;
          // NOTE: orientation is export-dependent (the old glTFast export faced
          // away; the current UnityGltf one faces +Z, toward the camera). If a
          // future export comes in backwards, set rotation.y = Math.PI here.
          scene.add(gltf.scene);

          clips = gltf.animations;
          console.info(
            'AvatarPanel clips:',
            clips.length ? clips.map((c) => c.name) : '(none)',
          );
          if (clips.length) {
            mixer = new THREE.AnimationMixer(gltf.scene);
            const idle =
              clips.find((c) => c.name.toLowerCase() === 'idle') ??
              clips.find((c) => c.name.toLowerCase().includes('idle')) ??
              clips[0];
            idleAction = mixer.clipAction(idle);
            idleAction.setLoop(THREE.LoopRepeat, Infinity);
            idleAction.play();
            currentAction = idleAction;
            // One-shot clips (celebrations) hand control back to idle.
            mixer.addEventListener('finished', () => returnToIdle());
            // Pose frame 0 BEFORE framing: Unity exports can bind the mesh far
            // off-origin while the animation snaps the skeleton to the origin —
            // framing the bind pose would aim the camera at empty space.
            mixer.update(0);
          }
          gltf.scene.updateMatrixWorld(true);

          // Frame on BONE world positions when the model is rigged (the
          // animated-pose truth — Box3.setFromObject ignores skinning and
          // reports bind-space bounds). Bones sit slightly inside the
          // silhouette, so pad by a few % of the height — just enough for
          // flesh/hair, NOT a safety factor that pushes the camera away.
          const boneBox = new THREE.Box3();
          let boneCount = 0;
          gltf.scene.traverse((o) => {
            if ((o as THREE.Bone).isBone) {
              boneBox.expandByPoint(o.getWorldPosition(new THREE.Vector3()));
              boneCount++;
            }
          });
          if (boneCount > 0) {
            const h = boneBox.max.y - boneBox.min.y;
            boneBox.expandByScalar(h * 0.05);
            frameBox = boneBox;
          } else {
            frameBox = new THREE.Box3().setFromObject(gltf.scene);
          }
          // Home view: frame + hand target/clamps to the controls + render.
          goHome();
        },
        undefined,
        (err) => {
          console.warn(
            `AvatarPanel: could not load ${MODEL_URL} — showing placeholder. ` +
              'Is public/models/reika.glb present?',
            err,
          );
          failed = true;
          stop();
        },
      );

      // Panel is user-resizable. Per observer event (every mousemove of a
      // splitter drag): buffer size + aspect + ONE SYNCHRONOUS RENDER in the
      // same callback — renderer.setSize() reallocates (blanks) the drawing
      // buffer, and waiting for the next rAF tick would present that blank
      // frame (the flicker). setSize(..., false) leaves styling to CSS so
      // there's no layout feedback into the observer. The Box3 reframe is
      // DEBOUNCED — one final reframe + render when the gesture settles;
      // slightly loose framing mid-drag is fine. Nothing is ever recreated
      // here — buffer size, camera params, and render calls only.
      ro = new ResizeObserver((entries) => {
        const { width, height } = entries[0].contentRect;
        if (!renderer || width < 2 || height < 2) return; // 0 mid-drag: skip
        const w = Math.round(width);
        const h = Math.round(height);
        if (w === lastW && h === lastH) return; // no-op resize
        lastW = w;
        lastH = h;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        if (!document.hidden) renderer.render(scene, camera); // never blank
        // Once the user has orbited/zoomed they own the camera: resize only
        // updates aspect + projection above — no reframe snap-back. A fresh
        // (untouched) panel keeps the debounced auto-reframe.
        if (userAdjusted) return;
        clearTimeout(reframeTimer);
        reframeTimer = setTimeout(() => {
          if (!userAdjusted) goHome();
        }, REFRAME_DEBOUNCE_MS);
      });
      // The observer fires once on observe(), which does the initial sizing.
      ro.observe(container);

      // Double-click = return to the home framing (also clears userAdjusted).
      canvas.addEventListener('dblclick', goHome);

      // Dev-only introspection for the CDP verification scripts (tree-shaken
      // out of production builds). Never used by app code.
      if (import.meta.env.DEV) {
        (window as unknown as Record<string, unknown>).__avatarDebug = {
          camPos: () => camera.position.toArray(),
          target: () => controls?.target.toArray(),
          dist: () => controls && camera.position.distanceTo(controls.target),
          clamps: () => controls && [controls.minDistance, controls.maxDistance],
          userAdjusted: () => userAdjusted,
        };
      }
      // Wheel containment: OrbitControls preventDefaults the dolly, but the
      // event would still BUBBLE — stop it so it can never scroll-chain into
      // an ancestor. (The timeline's three wheel surfaces live in a different
      // panel subtree and are untouched either way.)
      canvas.addEventListener('wheel', stopWheel);

      start();
    } catch (e) {
      // WebGL context refused, driver issues, anything — degrade, never crash.
      console.warn('AvatarPanel: renderer init failed — showing placeholder.', e);
      failed = true;
    }

    // Own loop only; pause while backgrounded (this app runs all day).
    const onVisibility = () => {
      if (document.hidden) stop();
      else if (!failed) start();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      destroyed = true;
      stop();
      clearTimeout(reframeTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('dblclick', goHome);
      canvas.removeEventListener('wheel', stopWheel);
      controls?.dispose(); // detaches its canvas listeners
      controls = null;
      ro?.disconnect();
      mixer?.stopAllAction();
      // Dispose everything we allocated: geometries, materials, their textures,
      // then the GL context. The panel lives all day — no leaks allowed.
      scene?.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mats = Array.isArray(mesh.material)
          ? mesh.material
          : mesh.material
            ? [mesh.material]
            : [];
        for (const m of mats) {
          for (const v of Object.values(m)) {
            if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
          }
          m.dispose();
        }
      });
      renderer?.dispose();
      renderer = null;
    };
  });
</script>

<!-- The canvas is ALWAYS in the DOM (the renderer owns it); failure just hides
     it under a muted overlay. Swapping it out via {#if} would pull the element
     from a live WebGL context. -->
<div class="avatar-panel" bind:this={container}>
  <canvas bind:this={canvas} class:hidden={failed}></canvas>
  {#if failed}
    <div class="unavailable">avatar unavailable</div>
  {/if}
</div>

<style>
  .avatar-panel {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  canvas {
    /* Explicit CSS size: a <canvas> is a replaced element — without this its
       CSS box tracks the backing store and fights the ResizeObserver. */
    display: block;
    width: 100%;
    height: 100%;
  }

  canvas.hidden {
    visibility: hidden;
  }

  .unavailable {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: #6f6f6f;
    font-size: 0.9rem;
  }
</style>
