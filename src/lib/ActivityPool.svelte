<script lang="ts">
  import interact from 'interactjs';
  import type { Activity, ActivitySnapshot } from './db';
  import {
    store,
    dragUI,
    activityManagerUI,
    isEligible,
    removeActivityWithSnapshot,
    restoreActivity,
    scheduleActivity,
    setEligibleTrack,
  } from './store.svelte';
  import { anchor, snapTime } from './timeline-scale';
  import { pxPerMs } from './view.svelte';

  /** New blocks start at 30 min; the resize handle comes in the next phase. */
  const DEFAULT_DURATION_SECONDS = 1800;
  /** How long a single tap waits to prove it isn't half of a double-click. */
  const TAP_DELAY_MS = 250;

  let {
    getTimelinePane,
  }: { getTimelinePane: () => HTMLElement | undefined } = $props();

  /** Which chip's eligibility popover is open (tap toggles). */
  let editingId = $state<number | null>(null);
  /** Chip currently shaking after a rejected drop. */
  let shakeId = $state<number | null>(null);
  let shakeTimer: ReturnType<typeof setTimeout> | undefined;
  let toast = $state('');
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  /** Undo affordance for the context-menu delete. */
  let undo = $state<{ name: string; count: number; snapshot: ActivitySnapshot } | null>(
    null,
  );
  let undoTimer: ReturnType<typeof setTimeout> | undefined;

  /** How long the Undo toast lingers after a delete. */
  const UNDO_MS = 6000;

  /** Right-click context menu on a chip: which activity, at what screen pos. */
  let menu = $state<{ activity: Activity; x: number; y: number } | null>(null);

  async function deleteActivityWithUndo(activity: Activity) {
    // Reached only via the context menu's explicit Delete button. Deletion
    // never records time — deleteActivity only clears the ledger; see
    // completeBlock's single-writer invariant in db.ts.
    editingId = null;
    toast = '';
    let snapshot: ActivitySnapshot | null;
    try {
      snapshot = await removeActivityWithSnapshot(activity.id);
    } catch (e) {
      console.error('Failed to delete activity:', e);
      return;
    }
    if (!snapshot) return;
    clearTimeout(undoTimer);
    undo = {
      name: snapshot.activity.name,
      count: snapshot.blocks.length,
      snapshot,
    };
    undoTimer = setTimeout(() => (undo = null), UNDO_MS);
  }

  async function undoDelete() {
    if (!undo) return;
    clearTimeout(undoTimer);
    const snapshot = undo.snapshot;
    undo = null;
    try {
      await restoreActivity(snapshot);
    } catch (e) {
      console.error('Failed to undo delete:', e);
    }
  }

  function rejectDrop(activity: Activity) {
    const eligibleId = store.eligibility[activity.id]?.[0];
    const trackName = store.tracks.find((t) => t.id === eligibleId)?.name;
    toast = trackName
      ? `${activity.name} can only go in ${trackName}`
      : `${activity.name} isn't allowed in that track`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ''), 2400);
    shakeId = activity.id;
    clearTimeout(shakeTimer);
    shakeTimer = setTimeout(() => (shakeId = null), 500);
  }

  function handleDrop(activity: Activity, clientX: number, clientY: number) {
    const pane = getTimelinePane();
    if (!pane) return;
    // Containment uses the scroll area, not the whole pane — the pane now
    // includes the header strip, which shouldn't accept drops.
    const scrollArea = pane.querySelector<HTMLElement>('.timeline') ?? pane;
    const rect = scrollArea.getBoundingClientRect();
    const inside =
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom;
    if (!inside) return; // dropped outside the timeline — discard

    // Inverse of the timeline's x(t) = (t - anchor) * k, measured against
    // the track element. Its bounding rect already includes the current
    // translate, so this maps correctly in BOTH follow mode and the frozen
    // free (scrolled-away) mode.
    const trackEl = pane.querySelector<HTMLElement>('.track');
    if (!trackEl) return;
    const exact = anchor + (clientX - trackEl.getBoundingClientRect().left) / pxPerMs();
    const startTime = snapTime(exact);

    // The drop's y picks the TRACK. Hit-test against the rendered lane bands
    // (`.lane-row[data-track-id]`), whose on-screen rects already reflect the
    // variable track heights AND the current vertical lane scroll — so the
    // pool needs no knowledge of the sub-lane layout. Overlap in time is fine
    // (sub-lanes handle it); only eligibility can still bounce a drop.
    const rows = [
      ...pane.querySelectorAll<HTMLElement>('.lane-row[data-track-id]'),
    ];
    let trackId: number | undefined;
    for (const row of rows) {
      const rr = row.getBoundingClientRect();
      if (clientY >= rr.top && clientY < rr.bottom) {
        trackId = Number(row.dataset.trackId);
        break;
      }
    }
    if (trackId === undefined && rows.length > 0) {
      // above the first band -> first track; below the last -> last track
      const firstTop = rows[0].getBoundingClientRect().top;
      const clampRow = clientY < firstTop ? rows[0] : rows[rows.length - 1];
      trackId = Number(clampRow.dataset.trackId);
    }
    if (trackId === undefined) return;

    // Eligibility gate: the chip bounces back (it never moved — only the
    // ghost did) with a shake + toast instead of creating a block.
    if (!isEligible(activity.id, trackId)) {
      rejectDrop(activity);
      return;
    }

    scheduleActivity(activity.id, trackId, startTime, DEFAULT_DURATION_SECONDS).catch(
      (e) => console.error('Failed to schedule block:', e),
    );
  }

  async function onEligibilityChange(activity: Activity, trackId: number, e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    if (!input.checked) {
      // Unchecking the only eligible track is not allowed — snap it back.
      input.checked = true;
      return;
    }
    try {
      // Single-select: checking a track replaces the previous one; the other
      // checkboxes re-render unchecked from the store update.
      await setEligibleTrack(activity.id, trackId);
    } catch (err) {
      console.error('Failed to set eligibility:', err);
      input.checked = isEligible(activity.id, trackId);
    }
  }

  function onWindowPointerDown(event: PointerEvent) {
    const target = event.target as Element | null;
    if (menu && !target?.closest('.ctx-menu')) menu = null;
    if (editingId !== null && !target?.closest('.chip-wrap')) editingId = null;
  }

  async function menuDelete() {
    if (!menu) return;
    const activity = menu.activity;
    menu = null;
    await deleteActivityWithUndo(activity);
  }

  /**
   * Double-click fast path: schedule the activity RIGHT NOW in its eligible
   * track, through the same scheduleActivity path pool drops use — only the
   * trigger differs (start_time pinned to Date.now(), track auto-picked as the
   * lowest-sort_order eligible one; exactly one exists under single-select).
   */
  function quickScheduleNow(activity: Activity) {
    const track = store.tracks.find((t) => isEligible(activity.id, t.id));
    if (!track) return;
    scheduleActivity(activity.id, track.id, Date.now(), DEFAULT_DURATION_SECONDS).catch(
      (e) => console.error('Failed to quick-schedule block:', e),
    );
    // Make it visible: in free (scrolled-away) mode the timeline shows its
    // "Now" button — clicking it reuses that exact snap-back action. In
    // follow mode the button doesn't exist and this is a no-op: the block
    // appears at the now-line already on screen.
    getTimelinePane()?.querySelector<HTMLElement>('.now-button')?.click();
  }

  /**
   * Svelte action: chips are drag TEMPLATES. The chip itself never moves —
   * a fixed-position clone follows the cursor (the panes have
   * overflow:hidden, so transforming the chip itself would clip at the pane
   * edge). The clone keeps the chip's scoped classes, so it looks identical.
   *
   * Three gestures resolve to exactly one outcome, decided at pointerdown:
   *   - Shift held    -> DELETE the activity (no drag, no popover). The shift
   *                      state is captured natively at pointerdown (fires
   *                      before interact's synthetic events), so drag-start can
   *                      bail before creating a ghost and tap can branch to
   *                      delete. Runs on tap/release.
   *   - tap, no Shift  -> toggle the eligibility popover.
   *   - drag, no Shift -> create a block (existing behavior).
   */
  function chipDrag(node: HTMLElement, activity: Activity) {
    let ghost: HTMLElement | null = null;
    let offsetX = 0;
    let offsetY = 0;
    // Rebound by update() so a store reload doesn't leave a stale reference.
    let current = activity;
    // interact can emit tap at the end of a real drag; 'down' resets the
    // flag so only a genuinely drag-free press toggles the popover.
    let dragged = false;
    // Single-tap popover is DEFERRED by TAP_DELAY_MS so an incoming doubletap
    // (which interact fires right after the second tap) can cancel it — a
    // double-click must open no popover, not even a flash.
    let tapTimer: ReturnType<typeof setTimeout> | undefined;
    // Right-click opens the small context menu (Delete lives there — chips
    // are NOT deleted directly, unlike timeline blocks). preventDefault
    // suppresses the webview's native menu; contextmenu is a native event
    // outside interact's tap/drag arbitration, so jitter can't swallow it.
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      editingId = null; // don't stack the menu on an open popover
      menu = {
        activity: current,
        x: Math.min(e.clientX, window.innerWidth - 130),
        y: Math.min(e.clientY, window.innerHeight - 70),
      };
    };
    node.addEventListener('contextmenu', onContextMenu);

    const positionGhost = (clientX: number, clientY: number) => {
      if (ghost) {
        ghost.style.transform = `translate(${clientX - offsetX}px, ${clientY - offsetY}px)`;
      }
    };

    interact(node)
      .draggable({
        listeners: {
          start(event) {
            dragged = true;
            editingId = null; // a drag closes any open popover
            menu = null; // ...and any open context menu
            dragUI.activityId = current.id; // timeline highlights eligible lanes
            const r = node.getBoundingClientRect();
            offsetX = event.clientX - r.left;
            offsetY = event.clientY - r.top;

            ghost = node.cloneNode(true) as HTMLElement;
            Object.assign(ghost.style, {
              position: 'fixed',
              left: '0',
              top: '0',
              width: `${r.width}px`,
              margin: '0',
              pointerEvents: 'none',
              zIndex: '1000',
              opacity: '0.85',
            });
            document.body.appendChild(ghost);
            positionGhost(event.clientX, event.clientY);
            node.style.opacity = '0.4';
          },
          move(event) {
            positionGhost(event.clientX, event.clientY);
          },
          end(event) {
            // No ghost means the drag was a shift-abort or never really began —
            // nothing to place, and dragUI was never set.
            if (!ghost) return;
            ghost.remove();
            ghost = null;
            node.style.opacity = '';
            dragUI.activityId = null;
            handleDrop(current, event.clientX, event.clientY);
          },
        },
      })
      .on('down', () => {
        dragged = false;
      })
      .on('tap', (e: { button?: number }) => {
        // Left button only — right-clicks belong to the context menu. A plain
        // tap toggles the eligibility popover after a beat, in case a second
        // tap follows.
        if (dragged || (e.button !== undefined && e.button !== 0)) return;
        clearTimeout(tapTimer);
        tapTimer = setTimeout(() => {
          editingId = editingId === current.id ? null : current.id;
        }, TAP_DELAY_MS);
      })
      .on('doubletap', (e: { button?: number }) => {
        if (dragged || (e.button !== undefined && e.button !== 0)) return;
        clearTimeout(tapTimer); // swallow the pending single-tap popover
        editingId = null; // a slow double-click may have already opened it
        quickScheduleNow(current);
      });

    return {
      update: (newActivity: Activity) => {
        current = newActivity;
      },
      destroy: () => {
        clearTimeout(tapTimer);
        node.removeEventListener('contextmenu', onContextMenu);
        interact(node).unset();
      },
    };
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div class="pool">
  {#each store.activities as activity (activity.id)}
    {@const eligibleTrack = store.tracks.find(
      (t) => t.id === store.eligibility[activity.id]?.[0],
    )}
    <div class="chip-wrap">
      <div
        class="chip"
        class:shake={shakeId === activity.id}
        title="Drag to schedule · double-click to start now · click to set track · right-click to delete"
        use:chipDrag={activity}
      >
        <span class="swatch" style:background={activity.color}></span>
        {activity.name}
        <span
          class="track-dot"
          style:background={eligibleTrack?.color ?? '#555555'}
          title={`Allowed in ${eligibleTrack?.name ?? 'no track'}`}
        ></span>
      </div>

      {#if editingId === activity.id}
        <div class="popover">
          <p class="pop-title">Allowed track</p>
          {#each store.tracks as track (track.id)}
            <label class="pop-row">
              <input
                type="checkbox"
                checked={isEligible(activity.id, track.id)}
                onchange={(e) => onEligibilityChange(activity, track.id, e)}
              />
              <span class="swatch" style:background={track.color}></span>
              <span class="pop-name">{track.name}</span>
            </label>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <p class="empty">No activities yet.</p>
  {/each}

  <!-- Quick-add trigger for the EXISTING add-activity dropdown. A plain
       button with onclick — deliberately NOT under chipDrag, so it has no
       drag/ghost, no eligibility popover, and no shift-delete path. -->
  <button
    class="add-chip"
    title="New activity"
    aria-label="New activity"
    onclick={() => (activityManagerUI.open = true)}
  >
    +
  </button>

  {#if toast}
    <div class="toast">{toast}</div>
  {/if}

  {#if menu}
    <!-- position:fixed → viewport coords, immune to the pool's overflow:hidden -->
    <div class="ctx-menu" style:left="{menu.x}px" style:top="{menu.y}px">
      <button class="ctx-delete" onclick={menuDelete}>
        Delete “{menu.activity.name}”
      </button>
    </div>
  {/if}

  {#if undo}
    <div class="toast undo-toast">
      <span>
        Deleted <strong>{undo.name}</strong>
        {#if undo.count > 0}
          (removed {undo.count} block{undo.count === 1 ? '' : 's'})
        {/if}
      </span>
      <button class="undo-btn" onclick={undoDelete}>Undo</button>
    </div>
  {/if}
</div>

<style>
  .pool {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    align-content: flex-start;
    gap: 0.5rem;
    width: 100%;
    height: 100%;
    padding: 1rem;
  }

  .chip-wrap {
    position: relative;
  }

  .chip {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.75rem;
    font-size: 0.85rem;
    background: #2a2a2a;
    border: 1px solid #3a3a3a;
    border-radius: 999px;
    cursor: grab;
    touch-action: none; /* required for interact.js pointer dragging */
    transition:
      transform 120ms ease,
      box-shadow 120ms ease;
  }

  .chip:hover {
    transform: scale(1.03);
    box-shadow: 0 3px 10px rgba(0, 0, 0, 0.4);
  }

  .chip:active {
    cursor: grabbing;
  }

  .chip.shake {
    animation: chip-shake 400ms ease;
  }

  @keyframes chip-shake {
    0%, 100% { transform: translateX(0); }
    20% { transform: translateX(-5px); }
    40% { transform: translateX(5px); }
    60% { transform: translateX(-3px); }
    80% { transform: translateX(3px); }
  }

  /* Dashed, muted "new activity" affordance — same pill silhouette as chips. */
  .add-chip {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 2.8rem;
    padding: 0.4rem 0.75rem;
    font-size: 1rem;
    line-height: 1.1;
    font-weight: 600;
    color: #8a8a8a;
    background: transparent;
    border: 1px dashed #4a4a4a;
    border-radius: 999px;
    cursor: pointer;
    transition:
      color 120ms ease,
      border-color 120ms ease,
      background 120ms ease;
  }

  .add-chip:hover {
    color: #d5d5d5;
    border-color: #6f6f6f;
    background: rgba(255, 255, 255, 0.03);
  }

  .swatch {
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 50%;
    flex-shrink: 0;
  }

  /* Small "where am I allowed" indicator in the eligible track's color. */
  .track-dot {
    width: 0.45rem;
    height: 0.45rem;
    border-radius: 50%;
    flex-shrink: 0;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
  }

  .popover {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 60;
    min-width: 170px;
    padding: 0.4rem;
    background: #262626;
    border: 1px solid #3a3a3a;
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  }

  .pop-title {
    margin: 0.1rem 0.4rem 0.3rem;
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #8a8a8a;
  }

  .pop-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0.4rem;
    border-radius: 6px;
    cursor: pointer;
  }

  .pop-row:hover {
    background: #2e2e2e;
  }

  .pop-row input {
    accent-color: #4f8ef7;
    cursor: pointer;
  }

  .pop-name {
    font-size: 0.85rem;
    color: #d5d5d5;
  }

  .toast {
    position: absolute;
    bottom: 12px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 70;
    padding: 0.4rem 0.9rem;
    font-size: 0.8rem;
    color: #f0d3d4;
    background: #3a2426;
    border: 1px solid rgba(229, 72, 77, 0.55);
    border-radius: 999px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
    pointer-events: none;
    white-space: nowrap;
  }

  .ctx-menu {
    position: fixed;
    z-index: 1000;
    min-width: 120px;
    padding: 0.25rem;
    background: #262626;
    border: 1px solid #3a3a3a;
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  }

  .ctx-delete {
    display: block;
    width: 100%;
    padding: 0.35rem 0.7rem;
    font-size: 0.82rem;
    text-align: left;
    color: #e5484d;
    background: transparent;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    white-space: nowrap;
  }

  .ctx-delete:hover {
    background: #3a2426;
  }

  /* Neutral (not error-red) styling and clickable, unlike the reject toast. */
  .undo-toast {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    color: #e6e6e6;
    background: #2c2c2c;
    border-color: #454545;
    pointer-events: auto;
  }

  .undo-toast strong {
    font-weight: 600;
    color: #f5f5f5;
  }

  .undo-btn {
    padding: 0.15rem 0.7rem;
    font-size: 0.78rem;
    font-weight: 600;
    color: #e6e6e6;
    background: #3a3a3a;
    border: 1px solid #555555;
    border-radius: 999px;
    cursor: pointer;
    transition: background 120ms ease;
  }

  .undo-btn:hover {
    background: #474747;
  }

  .empty {
    color: #6f6f6f;
  }
</style>
