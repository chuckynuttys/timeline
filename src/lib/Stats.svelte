<script lang="ts">
  import { store } from './store.svelte';
  import { getStats, type Stats, type DailyTotal } from './db';
  import { formatDuration } from './format';

  type RangeKey = 'today' | 'week' | '7days' | 'all';
  const RANGES: { key: RangeKey; label: string }[] = [
    { key: 'today', label: 'Today' },
    { key: 'week', label: 'This week' },
    { key: '7days', label: 'Last 7 days' },
    { key: 'all', label: 'All time' },
  ];

  /** Deleted track fallback color — must match db.ts DELETED_COLOR. */
  const DELETED_COLOR = '#6b7280';
  const RANGE_KEY = 'timeline.stats-range.v1';

  // Date range persists across launches; the chip filters are session-only
  // (reset to all-on each launch, per spec).
  function loadRange(): RangeKey {
    try {
      const v = localStorage.getItem(RANGE_KEY);
      if (v && RANGES.some((r) => r.key === v)) return v as RangeKey;
    } catch {
      // storage unavailable — default
    }
    return 'all';
  }
  let range = $state<RangeKey>(loadRange());
  function setRange(r: RangeKey) {
    range = r;
    try {
      localStorage.setItem(RANGE_KEY, r);
    } catch {
      // storage unavailable — range just won't persist
    }
  }

  // Excluded = the chips the user turned OFF. Empty set = all-on = no filter.
  let excludedTracks = $state<Set<number>>(new Set());
  let excludedActivities = $state<Set<number>>(new Set());

  let stats = $state<Stats | null>(null);
  let trendDaily = $state<DailyTotal[]>([]);
  let trendLabel = $state('');
  let loadToken = 0;

  /* ---- local-day helpers (match the timeline's local-date logic) ----------- */
  const localMidnight = (t: number) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const addLocalDays = (dayStart: number, n: number) => {
    const d = new Date(dayStart);
    d.setDate(d.getDate() + n);
    return d.getTime();
  };

  function rangeBounds(r: RangeKey, now: number): { since?: number; until?: number } {
    const midnight = localMidnight(now);
    const tomorrow = addLocalDays(midnight, 1);
    if (r === 'today') return { since: midnight, until: tomorrow };
    // Week starts Sunday (getDay() 0 = Sun) — the local calendar week.
    if (r === 'week')
      return { since: addLocalDays(midnight, -new Date(now).getDay()), until: tomorrow };
    if (r === '7days') return { since: addLocalDays(midnight, -6), until: tomorrow };
    return {}; // all time — unbounded
  }

  // Activity chips are SCOPED by the track filter: an activity shows only when
  // at least one of its eligible tracks is currently included (no eligibility =
  // always shown). Deselecting a track therefore hides & deactivates its
  // activities' chips.
  const visibleActivities = $derived(
    store.activities.filter((a) => {
      const elig = store.eligibility[a.id] ?? [];
      return elig.length === 0 || elig.some((tid) => !excludedTracks.has(tid));
    }),
  );

  const includedTrackIds = $derived(
    store.tracks.filter((t) => !excludedTracks.has(t.id)).map((t) => t.id),
  );

  /** Only constrain activities when a VISIBLE one is turned off; else no filter
   *  (track scoping is already carried by the trackIds filter). */
  function activityFilterIds(): number[] | undefined {
    const anyOff = visibleActivities.some((a) => excludedActivities.has(a.id));
    if (!anyOff) return undefined;
    return visibleActivities.filter((a) => !excludedActivities.has(a.id)).map((a) => a.id);
  }

  async function load() {
    const token = ++loadToken;
    const now = Date.now();
    const { since, until } = rangeBounds(range, now);
    const trackIds = excludedTracks.size ? includedTrackIds : undefined;
    const activityIds = activityFilterIds();
    try {
      const s = await getStats({ since, until, trackIds, activityIds });
      if (token !== loadToken) return; // a newer load superseded this one
      stats = s;
      if (range === 'today') {
        // A single column is useless — show the last 7 days for context.
        const ts = await getStats({
          since: addLocalDays(localMidnight(now), -6),
          until: addLocalDays(localMidnight(now), 1),
          trackIds,
          activityIds,
        });
        if (token !== loadToken) return;
        trendDaily = ts.dailyTotals;
        trendLabel = 'last 7 days';
      } else if (range === 'all') {
        trendDaily = s.dailyTotals.slice(-30); // cap: most recent 30 days
        trendLabel = s.dailyTotals.length > 30 ? 'last 30 days' : 'all time';
      } else {
        trendDaily = s.dailyTotals;
        trendLabel = range === 'week' ? 'this week' : 'last 7 days';
      }
    } catch (e) {
      console.error('getStats failed', e);
    }
  }

  // Refresh on ledger changes (complete/uncomplete bump ledgerVersion), range
  // changes, filter toggles, and entity add/remove. No per-second polling.
  $effect(() => {
    store.ledgerVersion;
    range;
    excludedTracks;
    excludedActivities;
    store.tracks.length;
    store.activities.length;
    store.eligibility;
    load();
  });

  function toggle(set: Set<number>, id: number): Set<number> {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }

  const trackColors = $derived(new Map(store.tracks.map((t) => [t.id, t.color])));
  const colorFor = (trackId: number | null) =>
    trackId == null ? DELETED_COLOR : (trackColors.get(trackId) ?? DELETED_COLOR);

  const hasData = $derived((stats?.completedCount ?? 0) > 0);
  const topTrack = $derived(stats?.trackTotals.find((t) => t.seconds > 0) ?? null);
  const trackBars = $derived((stats?.trackTotals ?? []).filter((t) => t.seconds > 0));
  const activityBars = $derived((stats?.activityTotals ?? []).filter((a) => a.seconds > 0));
  const trackMax = $derived(trackBars[0]?.seconds ?? 1);
  const activityMax = $derived(activityBars[0]?.seconds ?? 1);

  const daySum = (d: DailyTotal) => d.perTrack.reduce((s, p) => s + p.seconds, 0);
  const trendMax = $derived(
    trendDaily.reduce((m, d) => Math.max(m, daySum(d)), 0),
  );
  const hasTrend = $derived(trendMax > 0);
  const colW = $derived(trendDaily.length ? 100 / trendDaily.length : 100);

  /** Bottom-anchored stacked segments (tallest track at the base) in 0..100. */
  function stackSegments(d: DailyTotal) {
    const segs: { y: number; h: number; color: string }[] = [];
    let acc = 0;
    for (const p of [...d.perTrack].sort((a, b) => b.seconds - a.seconds)) {
      const h = trendMax > 0 ? (p.seconds / trendMax) * 100 : 0;
      segs.push({ y: 100 - acc - h, h, color: colorFor(p.track_id) });
      acc += h;
    }
    return segs;
  }

  const isToday = (dayStart: number) => dayStart === localMidnight(Date.now());
  const fmtDay = (dayStart: number) =>
    new Date(dayStart).toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
</script>

<div class="stats">
  <!-- HEADER: range selector + summary cards -->
  <div class="ranges">
    {#each RANGES as r (r.key)}
      <button class="range" class:active={range === r.key} onclick={() => setRange(r.key)}>
        {r.label}
      </button>
    {/each}
  </div>

  <div class="cards">
    <div class="card">
      <div class="card-val">{formatDuration(stats?.grandTotalSeconds ?? 0)}</div>
      <div class="card-lbl">Total</div>
    </div>
    <div class="card">
      <div class="card-val">{stats?.completedCount ?? 0}</div>
      <div class="card-lbl">Completed</div>
    </div>
    <div class="card">
      <div class="card-val top">
        {#if topTrack}
          <span class="dot" style:background={topTrack.color}></span>
          <span class="top-name">{topTrack.name}</span>
        {:else}
          —
        {/if}
      </div>
      <div class="card-lbl">Top track</div>
    </div>
  </div>

  <!-- FILTER ROW: track chips, then track-scoped activity chips -->
  <div class="filters">
    <div class="chip-row">
      <button
        class="chip reset"
        class:dim={excludedTracks.size === 0}
        onclick={() => (excludedTracks = new Set())}>All</button
      >
      {#each store.tracks as t (t.id)}
        <button
          class="chip"
          class:off={excludedTracks.has(t.id)}
          style:--c={t.color}
          onclick={() => (excludedTracks = toggle(excludedTracks, t.id))}
        >
          <span class="chip-dot"></span>{t.name}
        </button>
      {/each}
    </div>
    <div class="chip-row">
      <button
        class="chip reset"
        class:dim={excludedActivities.size === 0}
        onclick={() => (excludedActivities = new Set())}>All</button
      >
      {#each visibleActivities as a (a.id)}
        <button
          class="chip"
          class:off={excludedActivities.has(a.id)}
          style:--c={a.color}
          onclick={() => (excludedActivities = toggle(excludedActivities, a.id))}
        >
          <span class="chip-dot"></span>{a.name}
        </button>
      {/each}
      {#if visibleActivities.length === 0}
        <span class="muted-inline">No activities in view</span>
      {/if}
    </div>
  </div>

  {#if hasData}
    <section class="bars">
      <h3>By track</h3>
      {#each trackBars as b (b.track_id)}
        <div class="bar-row">
          <div class="bar-head">
            <span class="swatch" style:background={b.color}></span>
            <span class="bar-name">{b.name}</span>
            <span class="bar-time">{formatDuration(b.seconds)}</span>
          </div>
          <div class="bar-track">
            <div
              class="bar-fill"
              style:width="{(b.seconds / trackMax) * 100}%"
              style:background={b.color}
            ></div>
          </div>
        </div>
      {/each}
    </section>

    <section class="bars">
      <h3>By activity</h3>
      {#each activityBars as b (b.activity_id)}
        <div class="bar-row">
          <div class="bar-head">
            <span class="swatch" style:background={b.color}></span>
            <span class="bar-name">{b.name}</span>
            <span class="bar-time">{formatDuration(b.seconds)}</span>
          </div>
          <div class="bar-track">
            <div
              class="bar-fill"
              style:width="{(b.seconds / activityMax) * 100}%"
              style:background={b.color}
            ></div>
          </div>
        </div>
      {/each}
    </section>
  {:else}
    <div class="empty">Nothing logged for this selection</div>
  {/if}

  <!-- TREND: hand-rolled stacked-bar SVG, one column per local day -->
  {#if hasTrend}
    <section class="trend">
      <h3>Daily trend <span class="trend-sub">· {trendLabel}</span></h3>
      <svg class="trend-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
        {#each trendDaily as d, i (d.dayStart)}
          <g>
            {#if isToday(d.dayStart)}
              <rect class="today-col" x={i * colW} y="0" width={colW} height="100"></rect>
            {/if}
            {#each stackSegments(d) as s}
              <rect
                x={i * colW + colW * 0.15}
                y={s.y}
                width={colW * 0.7}
                height={s.h}
                fill={s.color}
              ></rect>
            {/each}
            <title>{fmtDay(d.dayStart)} — {formatDuration(daySum(d))}</title>
          </g>
        {/each}
      </svg>
    </section>
  {/if}
</div>

<style>
  .stats {
    height: 100%;
    overflow-y: auto;
    padding: 0.6rem 0.75rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    font-size: 0.8rem;
    color: #cfcfcf;
  }

  /* range selector */
  .ranges {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .range {
    padding: 0.22rem 0.5rem;
    font-size: 0.72rem;
    border: 1px solid #3a3a3a;
    border-radius: 999px;
    background: transparent;
    color: #b8b8b8;
    cursor: pointer;
  }
  .range:hover {
    border-color: #565656;
  }
  .range.active {
    background: #3b6ea5;
    border-color: #3b6ea5;
    color: #fff;
  }

  /* summary cards */
  .cards {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.4rem;
  }
  .card {
    background: #242424;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 0.45rem 0.5rem;
    min-width: 0;
  }
  .card-val {
    font-size: 1rem;
    font-weight: 600;
    color: #f0f0f0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .card-val.top {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.85rem;
  }
  .top-name {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dot {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    flex: none;
  }
  .card-lbl {
    margin-top: 0.15rem;
    font-size: 0.62rem;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: #8a8a8a;
  }

  /* filter chips */
  .filters {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.28rem;
    align-items: center;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.18rem 0.45rem;
    font-size: 0.7rem;
    border-radius: 999px;
    border: 1px solid var(--c, #555);
    background: color-mix(in srgb, var(--c, #555) 22%, transparent);
    color: #eaeaea;
    cursor: pointer;
    max-width: 100%;
  }
  .chip-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--c, #888);
    flex: none;
  }
  /* excluded: muted / outlined */
  .chip.off {
    background: transparent;
    color: #777;
    border-color: #444;
  }
  .chip.off .chip-dot {
    background: #555;
  }
  .chip.reset {
    border-color: #4a4a4a;
    background: #333;
    color: #cfcfcf;
  }
  .chip.reset.dim {
    opacity: 0.5;
  }
  .muted-inline {
    font-size: 0.68rem;
    color: #777;
  }

  /* ranked bars */
  .bars h3,
  .trend h3 {
    margin: 0 0 0.35rem;
    font-size: 0.66rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #8a8a8a;
    font-weight: 600;
  }
  .trend-sub {
    text-transform: none;
    letter-spacing: 0;
    color: #6f6f6f;
  }
  .bar-row {
    margin-bottom: 0.4rem;
  }
  .bar-head {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin-bottom: 0.15rem;
  }
  .swatch {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 2px;
    flex: none;
  }
  .bar-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bar-time {
    flex: none;
    color: #9a9a9a;
    font-variant-numeric: tabular-nums;
  }
  .bar-track {
    height: 6px;
    background: #2a2a2a;
    border-radius: 3px;
    overflow: hidden;
  }
  .bar-fill {
    height: 100%;
    border-radius: 3px;
    min-width: 2px;
  }

  .empty {
    padding: 1rem 0.5rem;
    text-align: center;
    color: #777;
    background: #242424;
    border: 1px dashed #3a3a3a;
    border-radius: 6px;
  }

  /* trend strip */
  .trend-svg {
    width: 100%;
    height: 84px;
    display: block;
    background: #202020;
    border: 1px solid #303030;
    border-radius: 6px;
  }
  .today-col {
    fill: rgba(255, 255, 255, 0.06);
  }
</style>
