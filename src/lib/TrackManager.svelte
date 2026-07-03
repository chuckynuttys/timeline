<script lang="ts">
  import { store, addTrack, removeTrack } from './store.svelte';

  /** Preset palette for new tracks; first unused color is auto-assigned. */
  const PALETTE = [
    '#f7b955',
    '#4f8ef7',
    '#c98bdb',
    '#4fc26e',
    '#e5707e',
    '#5bc8c4',
    '#d3d162',
    '#e08d5a',
  ];

  let open = $state(false);
  let name = $state('');
  let busy = $state(false);
  let error = $state('');
  let root: HTMLDivElement;

  const nextColor = $derived(
    PALETTE.find((c) => !store.tracks.some((t) => t.color === c)) ??
      PALETTE[store.tracks.length % PALETTE.length],
  );

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    busy = true;
    error = '';
    try {
      await addTrack(trimmed, nextColor);
      name = '';
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  async function remove(id: number) {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await removeTrack(id);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function onWindowPointerDown(event: PointerEvent) {
    if (open && root && !root.contains(event.target as Node)) open = false;
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div class="track-manager" bind:this={root}>
  <button class="toggle" onclick={() => (open = !open)}>
    Tracks
    <span class="chevron" class:flipped={open}>▾</span>
  </button>

  {#if open}
    <div class="panel">
      {#each store.tracks as track (track.id)}
        <div class="row">
          <span class="swatch" style:background={track.color}></span>
          <span class="row-name">{track.name}</span>
          <button
            class="remove"
            disabled={store.tracks.length <= 1 || busy}
            title={store.tracks.length <= 1
              ? 'At least one track is required'
              : 'Remove track (its blocks move to the first track)'}
            onclick={() => remove(track.id)}
          >
            ✕
          </button>
        </div>
      {/each}

      <div class="add-row">
        <span class="swatch" style:background={nextColor}></span>
        <input
          placeholder="New track…"
          bind:value={name}
          disabled={busy}
          onkeydown={(e) => e.key === 'Enter' && submit()}
        />
        <button class="add" disabled={busy || !name.trim()} onclick={submit}>Add</button>
      </div>

      {#if error}
        <p class="error">{error}</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .track-manager {
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

  .panel {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 50;
    min-width: 220px;
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
  }

  .remove:hover:not(:disabled) {
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

  .error {
    margin: 0.3rem 0.4rem 0.1rem;
    font-size: 0.75rem;
    color: #e5484d;
  }
</style>
