<script lang="ts">
  import { onMount } from 'svelte';
  import * as THREE from 'three';
  import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
  import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
  import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
  import {
    VRMAnimationLoaderPlugin,
    createVRMAnimationClip,
    type VRMAnimation,
  } from '@pixiv/three-vrm-animation';
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

  /* ---- model loading (VRM-first chain) ----------------------------------- */
  /** DEV override: force a specific model (also `?avatar=/models/test.vrm` in
   *  the URL). Leave null for the production chain. */
  const DEV_FORCE_MODEL: string | null = null;
  /** Default chain: full VRM when the asset lands, glb until then. Dropping a
   *  valid reika.vrm into public/models switches modes with ZERO code edits. */
  const MODEL_CHAIN = ['/models/reika.vrm', '/models/reika.glb'];
  /** Per-mode facing normalization. FACING IS PER-EXPORT, not per-format: the
   *  first reika.vrm export rested facing -Z (needed Math.PI here); the
   *  current one rests +Z like the spec (0). If an export comes in backwards,
   *  this is the one knob to flip. */
  const VRM_ROTATION_Y = 0;
  const GLB_ROTATION_Y = 0;

  /* ---- VRMA animations (VRM mode only) ------------------------------------ */
  /** Where the VRM Animation files live (Vite static). */
  const VRMA_DIR = '/models/vrma/';
  /** STATIC MANIFEST of the copied .vrma files — the webview can't list a
   *  directory at runtime. ⚠ UPDATE THIS LIST when files in public/models/vrma
   *  change. Display names are derived by stripping the reika_KA_IdleNN_ prefix. */
  const VRMA_MANIFEST = [
    'reika_KA_Idle01_breathing.vrma',
    'reika_KA_Idle05_Stretch.vrma',
    'reika_KA_Idle06_JumpAround.vrma',
    'reika_KA_Idle07_SpinningJump.vrma',
    'reika_KA_Idle08_ComeUpWithAnIdea.vrma',
    'reika_KA_Idle14_Dance02.vrma',
    'reika_KA_Idle35_FingerSnap.vrma',
    'reika_KA_Idle36_Yay.vrma',
    'reika_KA_Idle37_Tsundere.vrma',
    'reika_KA_Idle41_CuteShyPose.vrma',
    'reika_KA_Idle44_GreetingBow.vrma',
    'reika_KA_Idle47_Scaring.vrma',
    'reika_KA_Idle90_HandsOnHipsConfident.vrma',
  ];
  const cleanVrmaName = (file: string) =>
    file.replace(/^reika_KA_Idle\d+_/, '').replace(/\.vrma$/, '');
  /** Longest dt ever fed to mixer/spring physics — a resume-from-background or
   *  a long frame hitch must not make the hair/skirt explode. */
  const MAX_DELTA_S = 0.1;

  /* ---- lookAt: head follows the mouse (VRM mode only) -------------------- */
  /** Mouse moves smaller than this are ignored (no micro-jitter). */
  const LOOK_DEAD_ZONE_PX = 4;
  /** Target damping: fraction of remaining distance per frame. */
  const LOOK_DAMP = 0.1;
  /** Mouse idle for this long -> gaze eases back to straight ahead. */
  const LOOK_IDLE_RETURN_MS = 5000;
  /** Virtual gaze plane this far in front of her face (m). */
  const LOOK_PLANE_DIST = 1.5;
  /** Lateral/vertical target travel (m) across the full window span. */
  const LOOK_SPAN_X = 1.2;
  const LOOK_SPAN_Y = 0.8;

  /** Load failed → muted placeholder instead of the canvas. Never throws. */
  let failed = $state(false);

  let container: HTMLDivElement;
  let canvas: HTMLCanvasElement;

  // Imperative three.js state — lives outside Svelte reactivity on purpose.
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene;
  let camera: THREE.PerspectiveCamera;
  /** Non-null exactly when a .vrm loaded — everything downstream branches on it. */
  let vrm: VRM | null = null;
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

  /* ---- lookAt state (world-space target; inert without vrm.lookAt) ------- */
  const lookAtTarget = new THREE.Object3D();
  /** Where the damped target is heading (mapped mouse point or straight-ahead). */
  const lookGoal = new THREE.Vector3();
  /** Straight-ahead resting point (head + LOOK_PLANE_DIST on +Z). */
  const lookAhead = new THREE.Vector3();
  const headPos = new THREE.Vector3();
  let lastMouseX = NaN;
  let lastMouseY = NaN;
  let lastMouseMoveAt = 0;

  /** Window-level mouse -> gaze goal on a virtual plane in front of her face.
   *  The AVATAR PANEL's center is the zero point (cursor over her = straight
   *  ahead), so directions read correctly wherever the panel sits on screen. */
  function onGlobalMouseMove(e: MouseEvent) {
    if (!vrm?.lookAt) return; // inert in GLB mode
    const moved = Math.hypot(e.clientX - lastMouseX, e.clientY - lastMouseY);
    if (moved < LOOK_DEAD_ZONE_PX) return; // dead zone: ignore micro-moves
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    lastMouseMoveAt = performance.now();
    const pr = container.getBoundingClientRect();
    const nx = (e.clientX - (pr.left + pr.width / 2)) / window.innerWidth;
    const ny = (e.clientY - (pr.top + pr.height / 2)) / window.innerHeight;
    lookGoal.set(
      headPos.x + nx * 2 * LOOK_SPAN_X,
      headPos.y - ny * 2 * LOOK_SPAN_Y,
      headPos.z + LOOK_PLANE_DIST,
    );
  }

  /** Per-frame gaze update: idle >5s eases the goal home; the lerp IS the
   *  ease/damping. The VRM's own authored lookAt ranges clamp head/eye
   *  rotation — never hand-clamp here. */
  function updateLookAt() {
    if (!vrm?.lookAt) return;
    if (performance.now() - lastMouseMoveAt > LOOK_IDLE_RETURN_MS) {
      lookGoal.copy(lookAhead);
    }
    lookAtTarget.position.lerp(lookGoal, LOOK_DAMP);
  }

  /* ---- expressions facade (the seam for future lip-sync / emotes) -------- */
  /** Set a VRM expression weight (0..1). No-op in GLB mode / unknown names. */
  export function setExpression(name: string, weight: number) {
    vrm?.expressionManager?.setValue(name, weight);
  }
  /** Names the loaded VRM actually exposes (empty in GLB mode). */
  export function listExpressions(): string[] {
    return vrm?.expressionManager?.expressions.map((e) => e.expressionName) ?? [];
  }
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
      // Clamp dt: a hitch (or any resume path that slips past timer.reset)
      // must never feed a huge step into the spring-bone physics.
      const delta = Math.min(timer.getDelta(), MAX_DELTA_S);
      // Order matters: animation pose first, THEN vrm.update layers spring
      // bones / lookAt / expressions on top of it (one call drives all three
      // — never poke springBoneManager & co. individually).
      mixer?.update(delta);
      updateLookAt();
      vrm?.update(delta);
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

  /* ---- playback controller (ONE place owns what's playing) ---------------- */
  /** 'random' = wander through the VRMA registry indefinitely; 'manual' =
   *  hold on the dropdown-selected clip until the user changes it. */
  let playMode: 'random' | 'manual' = 'random';
  /** The controller's selection (dropdown pick in manual, last random pick in
   *  random). A celebrate() one-shot plays OVER this without changing it, so
   *  the 'finished' handler can restore the right state afterwards. */
  let currentName = '';
  /** Loaded VRMA names (drives the dropdown; empty in GLB mode). */
  let animNames = $state<string[]>([]);
  /** Dropdown model: '__random' or a clip name. */
  let selectValue = $state('__random');
  /** Every action we ever started, so stale ones can be stop()ped — the mixer
   *  never accumulates live zero-weight actions across many switches. */
  const touchedActions = new Set<THREE.AnimationAction>();

  const findClip = (name: string) =>
    THREE.AnimationClip.findByName(clips, name) ??
    clips.find((c) => c.name.toLowerCase() === name.toLowerCase());

  /**
   * Load every manifest .vrma (VRM Animation format — NOT baked glTF clips)
   * and RETARGET each onto the loaded model via createVRMAnimationClip, giving
   * ordinary THREE.AnimationClips for the existing mixer. Faults are per-file:
   * one bad vrma is skipped, the rest still load. Kicks off RANDOM mode.
   */
  async function loadVrmaClips(model: VRM) {
    const l = new GLTFLoader();
    l.register((parser) => new VRMAnimationLoaderPlugin(parser));
    const results = await Promise.all(
      VRMA_MANIFEST.map(async (file) => {
        try {
          const gltf = await l.loadAsync(VRMA_DIR + file);
          const anim = (gltf.userData.vrmAnimations as VRMAnimation[] | undefined)?.[0];
          if (!anim) throw new Error('file has no VRMC_vrm_animation payload');
          const clip = createVRMAnimationClip(anim, model);
          clip.name = cleanVrmaName(file);
          return clip;
        } catch (e) {
          console.warn(`AvatarPanel: vrma failed (${file})`, e);
          return null;
        }
      }),
    );
    if (destroyed) return;
    clips = results
      .filter((c): c is THREE.AnimationClip => c !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
    animNames = clips.map((c) => c.name);
    console.info('AvatarPanel VRMA animations:', animNames.length ? animNames : '(none)');
    if (animNames.length) {
      // The frame box was measured at bind pose; jump/stretch clips carry real
      // root motion above it. Add headroom so animated apexes don't crop.
      if (frameBox) {
        const h = frameBox.max.y - frameBox.min.y;
        frameBox.max.y += h * 0.18;
        if (!userAdjusted) goHome();
      }
      playRandom(); // default behavior: wander forever
    }
  }

  /**
   * The single fade primitive. clampWhenFinished on EVERYTHING: a finished
   * LoopOnce action must hold its last frame so the next crossfade blends from
   * a pose, never from a T-pose snap. Actions come from mixer.clipAction (one
   * cached action per clip — reused, not respawned); anything that is neither
   * the incoming nor the outgoing action gets stop()ped here.
   */
  function fadeTo(clip: THREE.AnimationClip, { loop = false } = {}) {
    if (!mixer) return;
    const next = mixer.clipAction(clip);
    for (const a of touchedActions) {
      if (a !== next && a !== currentAction) a.stop();
    }
    touchedActions.add(next);
    next.reset();
    next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    next.clampWhenFinished = true;
    if (currentAction && currentAction !== next) {
      next.crossFadeFrom(currentAction, FADE_S, false);
    }
    next.play();
    currentAction = next;
  }

  /** RANDOM mode step: a fresh random clip (never the one that just played,
   *  when >1 exists), LoopOnce — 'finished' brings us back here forever. */
  function playRandom() {
    const pool = clips.filter((c) => clips.length <= 1 || c.name !== currentName);
    const clip = pool[Math.floor(Math.random() * pool.length)];
    if (!clip) return;
    currentName = clip.name;
    fadeTo(clip, { loop: false });
  }

  /** MANUAL mode: play the chosen clip LOOPING — it holds by construction
   *  (never fires 'finished'), until the user picks again or returns to
   *  Random. Exported as the public "play this" seam. */
  export function playClip(name: string) {
    const clip = findClip(name);
    if (!clip) {
      console.warn(`AvatarPanel: no clip named "${name}"`);
      return;
    }
    playMode = 'manual';
    currentName = name;
    selectValue = name;
    fadeTo(clip, { loop: true });
  }

  function setRandomMode() {
    playMode = 'random';
    selectValue = '__random';
    playRandom();
  }

  /** Mixer 'finished': random -> next random pick; manual -> restore the held
   *  selection (only reachable there after a celebrate one-shot); GLB mode ->
   *  legacy return-to-idle. Celebrations therefore never trap either mode. */
  function onClipFinished() {
    if (vrm && animNames.length) {
      if (playMode === 'manual') {
        const held = findClip(currentName);
        if (held) fadeTo(held, { loop: true });
      } else {
        playRandom();
      }
    } else {
      returnToIdle();
    }
  }

  /** GLB-fallback only: crossfade back to the looping baked idle clip. */
  export function returnToIdle() {
    if (!mixer || !idleAction || currentAction === idleAction) return;
    idleAction.reset();
    idleAction.setLoop(THREE.LoopRepeat, Infinity);
    if (currentAction) idleAction.crossFadeFrom(currentAction, FADE_S, false);
    idleAction.play();
    currentAction = idleAction;
  }

  /** Play the first celebration-ish clip ONCE over the current mode; the
   *  'finished' handler restores that mode (does NOT touch currentName). */
  function celebrate() {
    if (!mixer) return;
    for (const frag of CELEBRATE_NAMES) {
      const clip = clips.find((c) => c.name.toLowerCase().includes(frag));
      if (clip) {
        fadeTo(clip, { loop: false });
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

      /** Shared post-load path for BOTH modes — everything branches on `vrm`. */
      const onModelLoaded = (gltf: GLTF, url: string) => {
        vrm = (gltf.userData.vrm as VRM | undefined) ?? null;
        const root = vrm ? vrm.scene : gltf.scene;

        if (vrm) {
          // Perf passes (current three-vrm API; combineSkeletons superseded
          // removeUnnecessaryJoints in 3.x).
          VRMUtils.removeUnnecessaryVertices(gltf.scene);
          VRMUtils.combineSkeletons(gltf.scene);
          // VRM 0.x faces -Z; rotate to the VRM 1.0 +Z convention so BOTH
          // spec versions end up facing the home camera.
          if (vrm.meta?.metaVersion === '0') VRMUtils.rotateVRM0(vrm);
          root.rotation.y = VRM_ROTATION_Y;
          // Spring bones move meshes outside their static bounds — standard
          // three-vrm practice is to disable frustum culling on the model.
          root.traverse((o) => {
            if ((o as THREE.Mesh).isMesh) o.frustumCulled = false;
          });
          console.info(
            `AvatarPanel: VRM mode (${url}, spec ${vrm.meta?.metaVersion ?? '?'})`,
          );
          console.info(
            'AvatarPanel expressions:',
            listExpressions().length ? listExpressions() : '(none)',
          );
        } else {
          root.rotation.y = GLB_ROTATION_Y;
          console.info(`AvatarPanel: GLB fallback mode (${url})`);
        }
        scene.add(root);

        if (vrm) {
          // VRM mode animates via RETARGETED VRMA files, not baked glTF clips
          // (reika.vrm ships none). The mixer binds the retargeted tracks to
          // the normalized humanoid rig nodes inside vrm.scene.
          mixer = new THREE.AnimationMixer(root);
          mixer.addEventListener('finished', onClipFinished);
          void loadVrmaClips(vrm); // async; kicks off random mode when done
        } else {
          clips = gltf.animations;
          console.info(
            'AvatarPanel clips:',
            clips.length ? clips.map((c) => c.name) : '(none)',
          );
          if (clips.length) {
            mixer = new THREE.AnimationMixer(root);
            const idle =
              clips.find((c) => c.name.toLowerCase() === 'idle') ??
              clips.find((c) => c.name.toLowerCase().includes('idle')) ??
              clips[0];
            idleAction = mixer.clipAction(idle);
            touchedActions.add(idleAction);
            idleAction.setLoop(THREE.LoopRepeat, Infinity);
            idleAction.play();
            currentAction = idleAction;
            // One-shot clips (celebrations) hand control back to idle.
            mixer.addEventListener('finished', onClipFinished);
            // Pose frame 0 BEFORE framing: Unity exports can bind the mesh far
            // off-origin while the animation snaps the skeleton to the origin —
            // framing the bind pose would aim the camera at empty space.
            mixer.update(0);
          }
        }
        root.updateMatrixWorld(true);

        // Frame on BONE world positions when the model is rigged (the
        // animated-pose truth — Box3.setFromObject ignores skinning and
        // reports bind-space bounds). Bones sit slightly inside the
        // silhouette, so pad by a few % of the height — just enough for
        // flesh/hair, NOT a safety factor that pushes the camera away.
        const boneBox = new THREE.Box3();
        let boneCount = 0;
        root.traverse((o) => {
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
          frameBox = new THREE.Box3().setFromObject(root);
        }

        // lookAt hookup (VRM only; the framework no-ops cleanly without it).
        // World-space target on a plane in front of her face; the humanoid
        // head bone anchors the plane, the frame box approximates if absent.
        if (vrm?.lookAt) {
          const head = vrm.humanoid?.getNormalizedBoneNode('head');
          if (head) head.getWorldPosition(headPos);
          else frameBox.getCenter(headPos).setY(frameBox.max.y * 0.9);
          lookAhead.set(headPos.x, headPos.y, headPos.z + LOOK_PLANE_DIST);
          lookGoal.copy(lookAhead);
          lookAtTarget.position.copy(lookAhead);
          scene.add(lookAtTarget);
          vrm.lookAt.target = lookAtTarget;
        }

        // Home view: frame + hand target/clamps to the controls + render.
        goHome();
      };

      // ONE loader handles both formats: the VRM plugin only activates on
      // files carrying the VRM extensions; plain glb parses as before.
      const loader = new GLTFLoader();
      loader.register((parser) => new VRMLoaderPlugin(parser));
      // DEV: `?avatar=/models/test.vrm` (or DEV_FORCE_MODEL) pins one model.
      const forced = import.meta.env.DEV
        ? (new URLSearchParams(location.search).get('avatar') ?? DEV_FORCE_MODEL)
        : null;
      const chain = forced ? [forced] : MODEL_CHAIN;
      (async () => {
        for (const url of chain) {
          try {
            const gltf = await loader.loadAsync(url);
            if (!destroyed) onModelLoaded(gltf, url);
            return;
          } catch (e) {
            console.info(
              `AvatarPanel: ${url} unavailable — trying next.`,
              e instanceof Error ? e.message : e,
            );
          }
        }
        console.warn(
          `AvatarPanel: no model loaded (tried ${chain.join(', ')}) — showing placeholder.`,
        );
        failed = true;
        stop();
      })();

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
          mode: () => (vrm ? 'vrm' : 'glb'),
          expressions: () => listExpressions(),
          springJoints: () => vrm?.springBoneManager?.joints.size ?? 0,
          lookTarget: () => lookAtTarget.position.toArray(),
          lookGoal: () => lookGoal.toArray(),
          setExpression,
          /** Raw handle for dev probing (nudge the scene, poke managers). */
          vrmRef: () => vrm,
          anims: () => animNames,
          playState: () => ({ mode: playMode, current: currentName }),
          activeActions: () =>
            [...touchedActions].filter((a) => a.isRunning()).length,
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
    // GLOBAL mouse tracking (whole app window, not just the panel) so she
    // watches the cursor while the user works in the timeline. Inert in GLB
    // mode (the handler bails without vrm.lookAt).
    window.addEventListener('mousemove', onGlobalMouseMove);

    return () => {
      destroyed = true;
      stop();
      clearTimeout(reframeTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('mousemove', onGlobalMouseMove);
      canvas.removeEventListener('dblclick', goHome);
      canvas.removeEventListener('wheel', stopWheel);
      controls?.dispose(); // detaches its canvas listeners
      controls = null;
      ro?.disconnect();
      vrm = null; // colliders/joints are freed with the scene traverse below
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
  <!-- Dev/test affordance: pick an animation (manual mode, holds) or Random.
       Its own small pointer-events island in the corner — the rest of the
       canvas keeps orbit-drag. -->
  {#if animNames.length}
    <select
      class="anim-select"
      bind:value={selectValue}
      onchange={() => {
        if (selectValue === '__random') setRandomMode();
        else playClip(selectValue);
      }}
    >
      <option value="__random">🎲 Random (default)</option>
      {#each animNames as n (n)}
        <option value={n}>{n}</option>
      {/each}
    </select>
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

  .anim-select {
    position: absolute;
    left: 8px;
    bottom: 8px;
    max-width: 45%;
    background: rgba(30, 30, 30, 0.85);
    color: #cfcfcf;
    border: 1px solid #3a3a3a;
    border-radius: 5px;
    font-size: 0.72rem;
    padding: 0.2rem 0.35rem;
    z-index: 3;
  }
  .anim-select:focus {
    outline: none;
    border-color: #3b6ea5;
  }
</style>
