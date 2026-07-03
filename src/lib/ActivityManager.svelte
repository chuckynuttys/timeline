<script lang="ts">
  import { store, addActivity, removeActivity, activityManagerUI } from './store.svelte';

  /** Preset palette for new activities; first unused color is pre-selected. */
  const PALETTE = [
    '#4f8ef7',
    '#4fc26e',
    '#c98bdb',
    '#f7b955',
    '#e5707e',
    '#5bc8c4',
    '#d3d162',
    '#e08d5a',
  ];

  // Open state is shared (store.activityManagerUI) so the pool's "+" chip can
  // trigger this same dropdown; `ui` is just a short local alias.
  const ui = activityManagerUI;
  let name = $state('');
  let busy = $state(false);
  let error = $state('');
  /** Palette offset; the swatch cycles through PALETTE on click. */
  let colorIdx = $state<number | null>(null);
  let trackId = $state<number | null>(null);
  /** Two-click delete: first ✕ arms, second confirms (no native dialogs). */
  let armedId = $state<number | null>(null);
  let root: HTMLDivElement;
  let nameInput = $state<HTMLInputElement>();

  // However the panel was opened (toggle or "+" chip), land ready to type.
  $effect(() => {
    if (ui.open) nameInput?.focus();
  });

  const defaultColor = $derived(
    PALETTE.find((c) => !store.activities.some((a) => a.color === c)) ??
      PALETTE[store.activities.length % PALETTE.length],
  );
  const color = $derived(colorIdx === null ? defaultColor : PALETTE[colorIdx]);
  /** Selected track, defaulting to the lowest-sort_order one. */
  const selectedTrackId = $derived(trackId ?? store.tracks[0]?.id);

  function cycleColor() {
    colorIdx = ((colorIdx ?? PALETTE.indexOf(defaultColor)) + 1) % PALETTE.length;
  }

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || busy || selectedTrackId === undefined) return;
    busy = true;
    error = '';
    try {
      await addActivity(trimmed, color, selectedTrackId);
      name = '';
      colorIdx = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function remove(id: number) {
    if (busy) return;
    if (armedId !== id) {
      armedId = id;
      return;
    }
    busy = true;
    error = '';
    try {
      await removeActivity(id);
      armedId = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function onWindowPointerDown(event: PointerEvent) {
    if (ui.open && root && !root.contains(event.target as Node)) {
      ui.open = false;
      armedId = null;
    }
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div class="activity-manager" bind:this={root}>
  <button class="toggle" onclick={() => ((ui.open = !ui.open), (armedId = null))}>
    Activities
    <span class="chevron" class:flipped={ui.open}>▾</span>
  </button>

  {#if ui.open}
    <div class="panel">
      {#each store.activities as activity (activity.id)}
        <div class="row">
          <span class="swatch" style:background={activity.color}></span>
          <span class="row-name">{activity.name}</span>
          <button
            class="remove"
            class:armed={armedId === activity.id}
            disabled={busy}
            title={armedId === activity.id
              ? 'Click again to delete the activity AND its scheduled blocks'
              : 'Remove activity (also removes its scheduled blocks)'}
            onclick={() => remove(activity.id)}
          >
            {armedId === activity.id ? 'Delete?' : '✕'}
          </button>
        </div>
      {:else}
        <p class="empty">No activities yet.</p>
      {/each}

      <div class="add-row">
        <button
          class="swatch-btn"
          title="Click to change color"
          onclick={cycleColor}
          style:background={color}
          aria-label="Cycle activity color"
        ></button>
        <input
          placeholder="New activity…"
          bind:this={nameInput}
          bind:value={name}
          disabled={busy}
          onkeydown={(e) => e.key === 'Enter' && submit()}
        />
        <select
          value={selectedTrackId}
          disabled={busy}
          title="The track this activity is allowed in"
          onchange={(e) => (trackId = Number(e.currentTarget.value))}
        >
          {#each store.tracks as track (track.id)}
            <option value={track.id}>{track.name}</option>
          {/each}
        </select>
        <button class="add" disabled={busy || !name.trim()} onclick={submit}>Add</button>
      </div>

      {#if error}
        <p class="error">{error}</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .activity-manager {
    position: relative;
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.2rem 0.6rem;
    font-size: 0.8rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #9a9a9a;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    cursor: pointer;
    transition: color 120ms ease, border-color 120ms ease;
  }

  .toggle:hover {
    color: #d5d5d5;
    border-color: #3a3a3a;
  }

  .chevron {
    font-size: 0.7rem;
    transition: transform 120ms ease;
  }

  .chevron.flipped {
    transform: rotate(180deg);
  }

  /* Anchored to the right edge: the manager sits at the far right of the
     pool header, so a left-anchored panel would overflow the window. */
  .panel {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 50;
    min-width: 300px;
    padding: 0.4rem;
    background: #262626;
    border: 1px solid #3a3a3a;
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  }

  .row,
  .add-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0.4rem;
    border-radius: 6px;
  }

  .row:hover {
    background: #2e2e2e;
  }

  .swatch {
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 3px;
    flex-shrink: 0;
  }

  .swatch-btn {
    width: 0.9rem;
    height: 0.9rem;
    padding: 0;
    border: 1px solid rgba(255, 255, 255, 0.25);
    border-radius: 3px;
    flex-shrink: 0;
    cursor: pointer;
  }

  .row-name {
    flex: 1;
    font-size: 0.85rem;
    color: #d5d5d5;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .remove {
    padding: 0 0.3rem;
    font-size: 0.75rem;
    color: #8a8a8a;
    background: transparent;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
  }

  .remove:hover:not(:disabled),
  .remove.armed {
    color: #e5484d;
    background: #3a2426;
  }

  .remove:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .add-row {
    margin-top: 0.2rem;
    border-top: 1px solid #333333;
    padding-top: 0.5rem;
  }

  .add-row input {
    flex: 1;
    min-width: 0;
    padding: 0.25rem 0.5rem;
    font-size: 0.85rem;
    color: #e6e6e6;
    background: #1e1e1e;
    border: 1px solid #3a3a3a;
    border-radius: 6px;
    outline: none;
  }

  .add-row input:focus {
    border-color: #5a5a5a;
  }

  .add-row select {
    max-width: 90px;
    padding: 0.25rem 0.3rem;
    font-size: 0.8rem;
    color: #d5d5d5;
    background: #1e1e1e;
    border: 1px solid #3a3a3a;
    border-radius: 6px;
    outline: none;
  }

  .add {
    padding: 0.25rem 0.6rem;
    font-size: 0.8rem;
    font-weight: 600;
    color: #d5d5d5;
    background: #333333;
    border: 1px solid #444444;
    border-radius: 6px;
    cursor: pointer;
  }

  .add:hover:not(:disabled) {
    background: #3d3d3d;
  }

  .add:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .empty {
    margin: 0.3rem 0.4rem;
    font-size: 0.8rem;
    color: #6f6f6f;
  }

  .error {
    margin: 0.3rem 0.4rem 0.1rem;
    font-size: 0.75rem;
    color: #e5484d;
  }
</style>
