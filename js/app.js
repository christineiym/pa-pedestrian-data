/* PA pedestrian accessibility data coverage — prototype.
 * No build step: plain JS + Leaflet.
 * Data: data/catalog.json, data/schema.json, data/municipalities.geojson, data/counties.geojson,
 *       data/osm_coverage.json (precomputed by scripts/osm_coverage.py; optional).
 * Routes: #  (state)  ·  #c=<County name>  ·  #m=<municipality GEOID>
 */
(() => {
  'use strict';

  const LEVEL_LABEL = ['none', 'partial', 'full'];
  const LEVEL_GLYPH = ['', '◐', '●'];
  const LEVEL_FILTERS = ['all', 'state', 'regional', 'county', 'municipal', 'crowd'];
  const POP_BINS = [
    [100000, '100k+'], [25000, '25k–100k'], [10000, '10k–25k'], [5000, '5k–10k'],
    [2500, '2.5k–5k'], [1000, '1k–2.5k'], [0, '< 1k'],
  ];
  const GROUPINGS = { county: 'County', pop: 'Population', type: 'Type' };
  const TYPE_ORDER = ['city', 'borough', 'township', 'town', 'municipality', 'other'];
  const GROUP_ROW_LIMIT = 100;
  const OSM_CLASSES = {
    sidewalk: { label: 'Sidewalks', color: 'cat-1', kind: 'line' },
    crossing: { label: 'Crossings', color: 'cat-2', kind: 'line' },
    curb: { label: 'Curbs / kerbs', color: 'cat-3', kind: 'dot' },
    steps: { label: 'Steps', color: 'cat-4', kind: 'dashed' },
    stop: { label: 'Transit stops', color: 'cat-5', kind: 'dot' },
  };

  const S = {
    catalog: null, schema: null, attrs: [],
    munis: [], byId: new Map(), counties: [], countyByName: new Map(),
    osm: null,                 // { fields, munis: {geoid: [..]}, generated, source }
    cov: new Map(),            // geoid -> { attrs, score }
    view: { county: null, muni: null },
    groupBy: 'county', colorBy: 'score', includeUnverified: false, search: '', expanded: new Set(), levelFilter: 'all',
    loaded: {}, adhoc: [],
    transit: null, feeds: null, stopsData: null, showPara: false,
  };

  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue('--' + name).trim();
  const pct = (x) => (x == null || isNaN(x) ? '—' : `${Math.round(x * 100)}%`);
  const fmt = (n) => Math.round(n).toLocaleString();
  const compact = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
  const typeLabel = (t) => (t === 'municipality' ? 'home-rule municipality' : t);

  // ---------- map ----------
  const map = L.map('map', { zoomSnap: 0.5, preferCanvas: true });
  const renderer = L.canvas({ padding: 0.5 });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · boundaries: US Census',
    maxZoom: 19,
  }).addTo(map);
  let muniLayer = null, countyLayer = null, highlight = null;

  // ---------- tooltip ----------
  const tip = $('#tooltip');
  function showTip(html, ev) {
    tip.innerHTML = html; tip.hidden = false;
    const x = Math.min(ev.clientX + 14, innerWidth - tip.offsetWidth - 8);
    const y = Math.min(ev.clientY + 14, innerHeight - tip.offsetHeight - 8);
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  const hideTip = () => { tip.hidden = true; };

  // ---------- OSM metrics → levels ----------
  function osmSums(ids) {
    if (!S.osm) return null;
    const out = Object.fromEntries(S.osm.fields.map((f) => [f, 0]));
    for (const id of ids) {
      const row = S.osm.munis[id]; if (!row) continue;
      S.osm.fields.forEach((f, i) => { out[f] += row[i]; });
    }
    return out;
  }

  function osmRatios(m) {
    const div = (a, b) => (b ? a / b : 0);
    return {
      sidewalkRatio: Math.min(1, div(m.sw_len + m.imp_len, 2 * m.st_len)),
      crossingDensity: div(m.x_n, m.st_len / 1000),          // crossings per street-km
      kerbRatio: Math.min(1, div(m.kerb_n, 2 * m.x_nodes)),
      width: div(m.sw_width, m.sw_n), surface: div(m.sw_surface, m.sw_n),
      incline: div(m.sw_incline, m.sw_n), smoothness: div(m.sw_smooth, m.sw_n),
      tactile: div(m.tact_n, m.x_n + m.kerb_n), aps: div(m.aps_n, m.sig_n),
      stopWheelchair: m.stop_n ? m.stop_wc / m.stop_n : null,
      stopAccessible: m.stop_n ? m.stop_wc_yes / m.stop_n : null,
    };
  }

  // Heuristic thresholds (placeholders — see PLAN.md). Input: summed metrics.
  function osmLevels(m) {
    const r = osmRatios(m);
    const lv = (x, full, part) => (x >= full ? 2 : x > part ? 1 : 0);
    return {
      sidewalks: lv(r.sidewalkRatio, 0.6, 0.05),
      crossings: lv(r.crossingDensity, 3, 0.2),
      curb_ramps: lv(r.kerbRatio, 0.6, 0.02),
      width: lv(r.width, 0.6, 0.02),
      surface: lv(r.surface, 0.6, 0.02),
      incline: lv(r.incline, 0.6, 0.02),
      condition: lv(r.smoothness, 0.6, 0.02),
      tactile: lv(r.tactile, 0.6, 0.02),
      steps: m.steps_n > 0 ? 2 : 0,
      aps: lv(r.aps, 0.6, 0.02),
    };
  }

  // ---------- coverage model ----------
  const allDatasets = () => S.catalog.datasets.concat(S.adhoc);

  function applies(ds, m) {
    const c = ds.coverage || {};
    return !!(c.statewide || c.counties?.includes(m.county) || c.municipalities?.includes(m.id));
  }

  function dsAttrs(ds, m) {
    if (ds.id === 'osm') return { values: S.osm && S.osm.munis[m.id] ? osmLevels(osmSums([m.id])) : {}, measured: !!S.osm };
    return { values: ds.attributes || {}, measured: false };
  }

  function computeCoverage(m) {
    const out = {};
    for (const a of S.attrs) out[a.id] = { level: 0, sources: [], assumed: false, measured: false };
    for (const ds of allDatasets()) {
      if (!applies(ds, m) || ds.machineReadable === false) continue;
      if (!ds.verified && !S.includeUnverified) continue;
      const { values, measured } = dsAttrs(ds, m);
      for (const a of S.attrs) {
        const lv = values[a.id] || 0; if (!lv) continue;
        const o = out[a.id];
        o.sources.push({ ds, level: lv, measured });
        if (lv > o.level) o.level = lv;
      }
    }
    for (const a of S.attrs) {
      const o = out[a.id];
      const best = o.sources.filter((s) => s.level === o.level);
      o.measured = best.some((s) => s.measured);
      o.assumed = o.level > 0 && !best.some((s) => s.measured || s.ds.verified);
    }
    return { attrs: out, score: S.attrs.reduce((t, a) => t + out[a.id].level, 0) / (2 * S.attrs.length) };
  }
  const recomputeAll = () => { for (const m of S.munis) S.cov.set(m.id, computeCoverage(m)); };

  /** Population-weighted aggregate over a set of municipalities. */
  function aggregate(list) {
    let pop = 0, wScore = 0;
    const attrs = Object.fromEntries(S.attrs.map((a) => [a.id, { covered: 0, full: 0 }]));
    for (const m of list) {
      const c = S.cov.get(m.id), w = m.pop;
      pop += w; wScore += w * c.score;
      for (const a of S.attrs) {
        const lv = c.attrs[a.id].level;
        if (lv >= 1) attrs[a.id].covered += w;
        if (lv === 2) attrs[a.id].full += w;
      }
    }
    for (const a of S.attrs) { attrs[a.id].covered /= pop || 1; attrs[a.id].full /= pop || 1; }
    return { n: list.length, pop, score: pop ? wScore / pop : 0, attrs };
  }

  const popBin = (p) => POP_BINS.find(([min]) => p >= min)[1];
  function groupKey(m) {
    if (S.groupBy === 'county') return m.county;
    if (S.groupBy === 'pop') return popBin(m.pop);
    return m.type;
  }
  function groupOrder(keys) {
    if (S.groupBy === 'pop') return POP_BINS.map((b) => b[1]).filter((k) => keys.includes(k));
    if (S.groupBy === 'type') return TYPE_ORDER.filter((k) => keys.includes(k));
    return keys.sort();
  }

  // ---------- color ----------
  function seqColor(x) { return css('seq-' + Math.max(1, Math.min(5, Math.ceil(x * 5)))); }
  // Scores cluster low, so the map uses explicit breaks rather than a linear 0–100% ramp.
  const SCORE_BREAKS = [0.1, 0.2, 0.3, 0.4];
  const scoreColor = (x) => (x <= 0 ? css('seq-0') : css('seq-' + (1 + SCORE_BREAKS.filter((b) => x >= b).length)));
  const levelColor = (lv) => css(['seq-0', 'seq-2', 'seq-4'][lv]);

  function muniFill(m) {
    if (S.colorBy === 'score') return scoreColor(S.cov.get(m.id).score);
    if (TRANSIT_VIEWS[S.colorBy]) {
      const v = TRANSIT_VIEWS[S.colorBy].value(transitRatios(transitSums([m.id]), m.area_km2));
      return v == null ? css('seq-0') : seqColor(Math.max(v, 0.001));
    }
    return levelColor(S.cov.get(m.id).attrs[S.colorBy].level);
  }

  // ---------- fixed-route transit (GTFS) ----------
  const TRANSIT_VIEWS = {
    tr_wb: { label: 'Stops with GTFS wheelchair_boarding', value: (r) => r.wbSpecified, empty: 'no fixed-route stops' },
    tr_sw: { label: 'Stops within 20 m of OSM sidewalk/crossing', value: (r) => r.nearSidewalk, empty: 'no fixed-route stops' },
    tr_para: { label: 'Area in ADA paratransit zone (derived)', value: (r) => (r.paraShare > 0 ? r.paraShare : null), empty: 'outside zone' },
  };
  const WB_STYLE = [
    { label: 'unknown (not specified)', color: 'text-muted' },
    { label: 'accessible', color: 'cat-3' },
    { label: 'not accessible', color: 'cat-2' },
  ];

  function transitSums(ids) {
    const out = { t_stops: 0, t_wb_spec: 0, t_wb_yes: 0, t_wb_no: 0, t_sw20: 0, t_para_km2: 0 };
    if (!S.transit) return out;
    for (const id of ids) {
      const row = S.transit.munis[id]; if (!row) continue;
      S.transit.fields.forEach((f, i) => { out[f] += row[i]; });
    }
    return out;
  }
  function transitRatios(t, areaKm2) {
    const n = t.t_stops;
    return {
      wbSpecified: n ? t.t_wb_spec / n : null, wbAccessible: n ? t.t_wb_yes / n : null,
      nearSidewalk: n ? t.t_sw20 / n : null, paraShare: areaKm2 ? Math.min(1, t.t_para_km2 / areaKm2) : 0,
    };
  }

  function transitHTML(ids, areaKm2, agencies) {
    if (!S.transit) return `<h3>Fixed-route transit</h3><p class="status err">data/transit_coverage.json not found. Run <code>scripts/fetch_gtfs.py</code> and <code>scripts/transit_coverage.py</code>.</p>`;
    const t = transitSums(ids), r = transitRatios(t, areaKm2);
    const row = (k, v) => `<tr><td class="muted">${k}</td><td class="num">${v}</td></tr>`;
    return `<h3>Fixed-route transit (GTFS · not scored)</h3>
      <table class="tbl compact">
        ${row('Stops (deduplicated across feeds)', fmt(t.t_stops))}
        ${agencies ? row('Agencies serving', agencies.length ? esc(agencies.join(', ')) : '—') : ''}
        ${row('Stops with wheelchair_boarding specified', t.t_stops ? `${pct(r.wbSpecified)} (${pct(r.wbAccessible)} accessible)` : '—')}
        ${row('Stops within 20 m of OSM sidewalk/crossing', t.t_stops ? pct(r.nearSidewalk) : '—')}
        ${row('Area in derived ADA paratransit zone', `${pct(r.paraShare)} (${t.t_para_km2.toFixed(1)} km²)`)}
      </table>`;
  }

  function feedsTableHTML() {
    if (!S.feeds) return '';
    const feeds = S.feeds.feeds.filter((f) => f.pa_stops > 0).sort((a, b) => b.pa_stops - a.pa_stops);
    const yn = (b) => (b ? '●' : '<span class="muted">—</span>');
    const share = (x) => `<span class="cell lvl-${x >= 0.6 ? 2 : x > 0 ? 1 : 0}" style="display:inline-block;min-width:38px;text-align:center;border-radius:3px">${pct(x)}</span>`;
    return `<h3>Fixed-route transit feeds (${feeds.length} with PA stops)</h3>
      <p class="small muted">GTFS feeds discovered via the Mobility Database. Columns show which accessibility fields each feed populates. Not scored.</p>
      <div class="matrix-wrap"><table class="tbl compact feeds">
        <thead><tr><th>Agency</th><th class="num">PA stops</th><th title="stops.wheelchair_boarding specified">Stop WB</th><th title="trips.wheelchair_accessible specified">Trip WA</th><th title="pathways.txt present">Path.</th><th title="levels.txt present">Lvls</th><th title="Service calendar end">Valid to</th></tr></thead>
        <tbody>${feeds.map((f) => `<tr>
          <td title="${esc(f.provider)} ${esc(f.name)} (${esc(f.id)})">${esc(f.provider)}${f.name ? ` <span class="muted small">${esc(f.name)}</span>` : ''}</td>
          <td class="num">${fmt(f.pa_stops)}</td><td>${share(f.stops_wb_specified)}</td><td>${share(f.trips_wa_specified)}</td>
          <td>${yn(f.has_pathways)}</td><td>${yn(f.has_levels)}</td>
          <td class="${f.expired ? 'status err' : ''}">${f.service_end ? String(f.service_end).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') : '—'}${f.expired ? ' (expired)' : ''}</td></tr>`).join('')}
        </tbody></table></div>`;
  }

  let paraLayer = null;
  function setParatransit(on) {
    S.showPara = on;
    if (!paraLayer) return;
    if (on && !map.hasLayer(paraLayer)) paraLayer.addTo(map);
    if (!on && map.hasLayer(paraLayer)) map.removeLayer(paraLayer);
    const panelBox = $('#para-toggle-panel'); if (panelBox) panelBox.checked = on;
    renderLegend();
  }

  async function loadStops() {
    if (!S.stopsData) {
      const r = await fetch('data/transit_stops.json');
      if (!r.ok) throw new Error('data/transit_stops.json not found — run scripts/transit_coverage.py.');
      S.stopsData = await r.json();
    }
    return S.stopsData;
  }

  async function toggleStops(m, onStatus) {
    const key = `gtfs@${m.id}`;
    if (S.loaded[key]) {
      const l = S.loaded[key].layer;
      map.hasLayer(l) ? map.removeLayer(l) : l.addTo(map);
      renderLegend(); return;
    }
    onStatus('Loading stops…');
    const data = await loadStops();
    const b = m.layer.getBounds().pad(0.05);
    const features = data.stops.filter(([lon, lat]) => b.contains([lat, lon])).map(([lon, lat, wb, sw, name, ag]) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { name, wheelchair_boarding: wb, near_sidewalk_20m: sw ? 'yes' : 'no', agencies: ag.map((i) => data.agencies[i]).join('; ') },
    }));
    const layer = L.geoJSON({ type: 'FeatureCollection', features }, {
      pointToLayer: (f, ll) => L.circleMarker(ll, {
        radius: 4.5, weight: f.properties.near_sidewalk_20m === 'yes' ? 1.5 : 2.5,
        color: f.properties.near_sidewalk_20m === 'yes' ? css('surface-1') : css('text-primary'),
        fillColor: css(WB_STYLE[f.properties.wheelchair_boarding].color), fillOpacity: 1,
      }),
      onEachFeature: (f, l) => l.bindPopup(`<b>${esc(f.properties.name || 'Stop')}</b><br>wheelchair_boarding: ${WB_STYLE[f.properties.wheelchair_boarding].label}<br>within 20 m of OSM sidewalk/crossing: ${f.properties.near_sidewalk_20m}<br><span class="muted">${esc(f.properties.agencies)}</span>`),
    });
    S.loaded[key] = { layer, kind: 'gtfs', geojson: { features }, inferred: inferSchema(features), name: 'GTFS stops' };
    layer.addTo(map);
    renderLegend();
    onStatus(`${features.length.toLocaleString()} stops in view extent.`);
  }

  // ---------- map layers ----------
  function buildMapLayers(muniGJ, countyGJ) {
    muniLayer = L.geoJSON(muniGJ, {
      renderer,
      style: () => ({ weight: 0.4, color: css('surface-1'), fillOpacity: 0.85 }),
      onEachFeature: (f, l) => {
        const m = S.byId.get(f.properties.id); m.layer = l;
        l.bindTooltip(() => muniTooltip(m), { sticky: true });
        l.on('click', () => go({ muni: m.id }));
      },
    }).addTo(map);
    countyLayer = L.geoJSON(countyGJ, {
      renderer, interactive: false,
      style: () => ({ weight: 1.2, color: css('text-secondary'), fill: false, opacity: 0.8 }),
    }).addTo(map);
  }

  function muniTooltip(m) {
    const c = S.cov.get(m.id);
    let extra = '';
    if (TRANSIT_VIEWS[S.colorBy]) {
      const t = transitSums([m.id]), r = transitRatios(t, m.area_km2);
      extra = `<br>Fixed-route stops: ${fmt(t.t_stops)}<br>${esc(TRANSIT_VIEWS[S.colorBy].label)}: ${pct(TRANSIT_VIEWS[S.colorBy].value(r))}`;
    } else if (S.colorBy !== 'score') {
      const a = S.attrs.find((x) => x.id === S.colorBy);
      extra = `<br>${esc(a.label)}: ${LEVEL_LABEL[c.attrs[a.id].level]}`;
    }
    return `<b>${esc(m.name)}</b> <span class="muted">${esc(typeLabel(m.type))}</span><br>${esc(m.county)} County · pop. ${fmt(m.pop)}<br>Coverage score ${pct(c.score)}${extra}`;
  }

  function restyleMap() {
    const { county, muni } = S.view;
    for (const m of S.munis) {
      // At municipality zoom keep fills light so streets and preview layers stay visible.
      const op = muni ? (m.id === muni ? 0.15 : 0.3) : county && m.county !== county ? 0.25 : 0.85;
      m.layer.setStyle({ fillColor: muniFill(m), fillOpacity: op });
    }
    renderLegend();
  }

  function setHighlight(geojsonOrLayer) {
    if (highlight) map.removeLayer(highlight);
    highlight = geojsonOrLayer ? L.geoJSON(geojsonOrLayer, { renderer, interactive: false, style: { color: css('text-primary'), weight: 2.5, fill: false } }).addTo(map) : null;
  }

  function renderLegend() {
    const el = $('#map-legend');
    let body;
    if (S.colorBy === 'score') {
      const labels = ['0', '< 10%', '10–20%', '20–30%', '30–40%', '≥ 40%'];
      body = `<div><b>Coverage score</b></div>${labels.map((l, i) => `<div class="row"><span class="swatch" style="background:var(--seq-${i})"></span>${l}</div>`).join('')}`;
    } else if (TRANSIT_VIEWS[S.colorBy]) {
      const v = TRANSIT_VIEWS[S.colorBy];
      body = `<div><b>${esc(v.label)}</b></div>
        <div class="ramp">${[1, 2, 3, 4, 5].map((i) => `<span style="background:var(--seq-${i})"></span>`).join('')}</div>
        <div class="row" style="justify-content:space-between"><span>0%</span><span>100%</span></div>
        <div class="row"><span class="swatch" style="background:var(--seq-0)"></span>${esc(v.empty)}</div>`;
    } else {
      const a = S.attrs.find((x) => x.id === S.colorBy);
      body = `<div><b>${esc(a.label)}</b></div>${[2, 1, 0].map((lv) => `<div class="row"><span class="swatch lvl-${lv}"></span>${LEVEL_GLYPH[lv]} ${LEVEL_LABEL[lv]}</div>`).join('')}`;
    }
    const visible = Object.values(S.loaded).filter((l) => map.hasLayer(l.layer));
    let layers = '';
    if (visible.some((l) => l.kind !== 'gtfs')) {
      layers += `<div style="margin-top:6px"><b>Preview layers</b></div>${Object.values(OSM_CLASSES).filter((v) => v.label !== 'Transit stops').map((v) => `<div class="row"><span class="swatch ${v.kind}" style="background:var(--${v.color});border-color:var(--${v.color})"></span>OSM ${esc(v.label.toLowerCase())}</div>`).join('')}`;
    }
    if (visible.some((l) => l.kind === 'gtfs')) {
      layers += `<div style="margin-top:6px"><b>GTFS stops: wheelchair_boarding</b></div>${[1, 2, 0].map((i) => `<div class="row"><span class="swatch dot" style="background:var(--${WB_STYLE[i].color})"></span>${WB_STYLE[i].label}</div>`).join('')}
        <div class="row"><span class="swatch dot" style="background:none;border:2.5px solid var(--text-primary)"></span>heavy ring = no OSM sidewalk within 20 m</div>`;
    }
    const para = paraLayer ? `<label class="row" style="margin-top:6px;cursor:pointer"><input type="checkbox" id="para-toggle" ${S.showPara ? 'checked' : ''}>
        <span class="swatch" style="background:color-mix(in srgb, var(--cat-5) 25%, transparent);border:1.5px dashed var(--cat-5)"></span>ADA paratransit area (derived)</label>` : '';
    el.innerHTML = body + layers + para;
    $('#para-toggle')?.addEventListener('change', (e) => setParatransit(e.target.checked));
  }

  // ---------- routing ----------
  function go({ county = null, muni = null } = {}) {
    const h = muni ? `#m=${muni}` : county ? `#c=${encodeURIComponent(county)}` : '';
    if (location.hash === h || (!h && !location.hash)) route(); else location.hash = h;
  }

  function route() {
    const h = location.hash.slice(1);
    const [k, v] = h.split('=');
    const val = v && decodeURIComponent(v);
    clearPreviewLayers();
    hideTip();
    if (k === 'm' && S.byId.has(val)) {
      const m = S.byId.get(val);
      S.view = { county: m.county, muni: m.id };
      map.fitBounds(m.layer.getBounds(), { padding: [30, 30], maxZoom: 15 });
      setHighlight(m.layer.feature);
      restyleMap(); renderMuni(m);
    } else if (k === 'c' && S.countyByName.has(val)) {
      const c = S.countyByName.get(val);
      S.view = { county: c.name, muni: null };
      map.fitBounds(c.bounds, { padding: [20, 20] });
      setHighlight(c.feature);
      restyleMap(); renderCounty(c);
    } else {
      S.view = { county: null, muni: null };
      map.fitBounds(S.catalog.state.bounds, { padding: [10, 10] });
      setHighlight(null);
      restyleMap(); renderState();
    }
    renderCrumbs();
  }

  function renderCrumbs() {
    const { county, muni } = S.view;
    const parts = [county || muni ? '<button data-go="">Pennsylvania</button>' : 'Pennsylvania'];
    if (county) parts.push(muni ? `<button data-go-county="${esc(county)}">${esc(county)} County</button>` : `${esc(county)} County`);
    if (muni) parts.push(esc(S.byId.get(muni).name));
    const el = $('#crumbs');
    el.innerHTML = parts.join(' › ');
    el.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      go(b.dataset.goCounty ? { county: b.dataset.goCounty } : {});
    };
  }

  // ---------- shared panel pieces ----------
  function controlsHTML({ grouping = true } = {}) {
    return `<div class="controls">
      ${grouping ? `<div class="row-flex"><span class="small muted">Group by</span>
        <div class="filters" id="group-by" style="margin:0">${Object.entries(GROUPINGS).map(([k, l]) => `<button class="chip" aria-pressed="${S.groupBy === k}" data-group="${k}">${l}</button>`).join('')}</div></div>` : ''}
      <div class="row-flex">
        <label class="small muted" for="color-by">Map color</label>
        <select id="color-by">
          <option value="score">Overall coverage score</option>
          <optgroup label="Attribute">${S.attrs.map((a) => `<option value="${a.id}">${esc(a.label)}</option>`).join('')}</optgroup>
          <optgroup label="Fixed-route transit (GTFS, not scored)">${Object.entries(TRANSIT_VIEWS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</optgroup>
        </select>
      </div>
      <label class="row-flex small"><input type="checkbox" id="incl-unverified" ${S.includeUnverified ? 'checked' : ''}>
        Include unverified catalog datasets in scores <span class="muted">(assumptions, shown with dashed outline)</span></label>
      <div class="row-flex">
        <input type="search" id="search" placeholder="Search ${S.view.county ? S.view.county + ' County' : fmt(S.munis.length)} municipalities…" value="${esc(S.search)}">
        <button class="btn" id="csv">Download CSV</button>
      </div>
    </div>`;
  }

  function wireControls(rerender) {
    $('#group-by')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-group]'); if (!b) return;
      S.groupBy = b.dataset.group; S.expanded.clear(); rerender();
    });
    const sel = $('#color-by'); sel.value = S.colorBy;
    sel.addEventListener('change', () => { S.colorBy = sel.value; restyleMap(); });
    const search = $('#search');
    let t;
    search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => { S.search = search.value; renderMatrixBody(); }, 150);
    });
    $('#csv').addEventListener('click', downloadCSV);
    $('#incl-unverified').addEventListener('change', (e) => { S.includeUnverified = e.target.checked; recomputeAll(); restyleMap(); rerender(); });
  }

  function legendInline() {
    return `<div class="legend-inline">
      <span><i class="swatch lvl-0"></i>none</span>
      <span><i class="swatch lvl-1"></i>◐ partial</span>
      <span><i class="swatch lvl-2"></i>● full</span>
      <span><i class="swatch" style="outline:1px dashed var(--text-muted);outline-offset:-2px"></i>assumed</span>
      <span class="muted">Group rows: % of population covered (≥ partial)</span>
    </div>`;
  }

  function matrixShell() {
    return `<div class="matrix-wrap"><table class="matrix" id="matrix">
      <thead><tr><th class="rowh"></th>${S.attrs.map((a) => `<th title="${esc(a.label)}">${esc(a.short)}</th>`).join('')}<th class="num">Score</th><th class="num">Pop</th></tr></thead>
      <tbody id="matrix-body"></tbody></table></div>`;
  }

  function muniRowHTML(m, indent) {
    const c = S.cov.get(m.id);
    return `<tr class="mrow" data-m="${m.id}">
      <th class="rowh${indent ? ' indent' : ''}" title="${esc(m.name)} ${esc(typeLabel(m.type))}, ${esc(m.county)} County">${esc(m.name)} <span class="muted small">${esc(m.type[0])}</span></th>
      ${S.attrs.map((a) => { const o = c.attrs[a.id]; return `<td class="cell lvl-${o.level}${o.assumed ? ' assumed' : ''}" data-attr="${a.id}">${LEVEL_GLYPH[o.level]}</td>`; }).join('')}
      <td class="score">${pct(c.score)}</td><td class="score">${compact(m.pop)}</td></tr>`;
  }

  function groupRowHTML(key, list, agg) {
    const open = S.expanded.has(key);
    const label = S.groupBy === 'county' ? key : S.groupBy === 'type' ? typeLabel(key) : `Pop. ${key}`;
    return `<tr class="grow" data-g="${esc(key)}">
      <th class="rowh"><span class="caret">${open ? '▾' : '▸'}</span>${esc(label)} <span class="muted small">${agg.n}</span>
        ${S.groupBy === 'county' ? `<button class="link-btn" data-open-county="${esc(key)}" title="Open county view">↗</button>` : ''}</th>
      ${S.attrs.map((a) => `<td class="cell gcell" data-attr="${a.id}" style="background:${agg.attrs[a.id].covered ? seqColor(agg.attrs[a.id].covered) : css('seq-0')};color:${agg.attrs[a.id].covered > 0.6 ? 'var(--on-full)' : 'var(--text-primary)'}">${Math.round(agg.attrs[a.id].covered * 100)}</td>`).join('')}
      <td class="score">${pct(agg.score)}</td><td class="score">${compact(agg.pop)}</td></tr>
      ${open ? list.slice(0, GROUP_ROW_LIMIT).map((m) => muniRowHTML(m, true)).join('') + (list.length > GROUP_ROW_LIMIT ? `<tr><td colspan="${S.attrs.length + 3}" class="small muted indent">… ${list.length - GROUP_ROW_LIMIT} more — use search or the county view</td></tr>` : '') : ''}`;
  }

  /** Renders the matrix body for the current scope (state or county), grouping and search. */
  function renderMatrixBody() {
    const body = $('#matrix-body'); if (!body) return;
    const scope = S.view.county ? S.munis.filter((m) => m.county === S.view.county) : S.munis;
    const q = S.search.trim().toLowerCase();
    if (q) {
      const hits = scope.filter((m) => m.name.toLowerCase().includes(q)).sort((a, b) => b.pop - a.pop);
      body.innerHTML = hits.slice(0, 200).map((m) => muniRowHTML(m, false)).join('') ||
        `<tr><td colspan="${S.attrs.length + 3}" class="muted small">No municipalities match.</td></tr>`;
      return;
    }
    if (S.view.county) {
      body.innerHTML = scope.slice().sort((a, b) => b.pop - a.pop).map((m) => muniRowHTML(m, false)).join('');
      return;
    }
    const groups = new Map();
    for (const m of scope) { const k = groupKey(m); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
    body.innerHTML = groupOrder([...groups.keys()]).map((k) => {
      const list = groups.get(k).sort((a, b) => b.pop - a.pop);
      return groupRowHTML(k, list, aggregate(list));
    }).join('');
  }

  function wireMatrix() {
    const tbl = $('#matrix');
    tbl.addEventListener('click', (e) => {
      const oc = e.target.closest('[data-open-county]');
      if (oc) { e.stopPropagation(); return go({ county: oc.dataset.openCounty }); }
      const g = e.target.closest('tr.grow');
      if (g) { S.expanded.has(g.dataset.g) ? S.expanded.delete(g.dataset.g) : S.expanded.add(g.dataset.g); return renderMatrixBody(); }
      const r = e.target.closest('tr.mrow');
      if (r) go({ muni: r.dataset.m });
    });
    tbl.addEventListener('mousemove', (e) => {
      const td = e.target.closest('td.cell'); if (!td) return hideTip();
      const a = S.attrs.find((x) => x.id === td.dataset.attr);
      const tr = td.parentElement;
      if (tr.dataset.m) {
        const m = S.byId.get(tr.dataset.m), o = S.cov.get(m.id).attrs[a.id];
        showTip(`<b>${esc(m.name)} · ${esc(a.label)}</b><br>${LEVEL_LABEL[o.level]}${o.assumed ? ' (assumed)' : ''}<br>${
          o.sources.length ? o.sources.map((s) => `${esc(s.ds.name)}: ${LEVEL_LABEL[s.level]}${s.measured ? ' (measured)' : s.ds.verified ? '' : ' (unverified)'}`).join('<br>') : '<span class="muted">No machine-readable source</span>'}`, e);
      } else {
        const key = tr.dataset.g;
        const list = S.munis.filter((m) => groupKey(m) === key);
        const agg = aggregate(list).attrs[a.id];
        showTip(`<b>${esc(key)} · ${esc(a.label)}</b><br>${pct(agg.covered)} of population in municipalities with ≥ partial coverage<br>${pct(agg.full)} with full coverage`, e);
      }
    });
    tbl.addEventListener('mouseleave', hideTip);
  }

  function datasetsHTML(list) {
    return `<div class="filters" id="level-filters">${LEVEL_FILTERS.map((l) => `<button class="chip" aria-pressed="${S.levelFilter === l}" data-level="${l}">${l}</button>`).join('')}</div>
      <div id="ds-list">${list.filter((d) => S.levelFilter === 'all' || d.level === S.levelFilter).map((d) => datasetCard(d)).join('') || '<p class="muted">No datasets at this level.</p>'}</div>`;
  }
  function wireDatasets(rerender) {
    $('#level-filters').addEventListener('click', (e) => { const b = e.target.closest('[data-level]'); if (b) { S.levelFilter = b.dataset.level; rerender(); } });
    wireDatasetCards($('#ds-list'));
  }

  // ---------- state view ----------
  function renderState() {
    const agg = aggregate(S.munis);
    const ds = allDatasets();
    const mr = ds.filter((d) => d.machineReadable !== false).length;
    const verified = ds.filter((d) => d.verified).length;
    $('#panel').innerHTML = `
      <h2>Statewide overview</h2>
      <p class="muted small">${fmt(S.munis.length)} municipalities (cities, boroughs, townships). Coverage = best available level per attribute across every dataset that applies. Click a municipality on the map or in the table to drill in.</p>
      ${osmBanner()}
      <div class="kpis">
        <div class="kpi"><div class="v">${pct(agg.attrs.sidewalks.covered)}</div><div class="l">of Pennsylvanians live where sidewalk data is ≥ partial</div></div>
        <div class="kpi"><div class="v">${pct(agg.attrs.curb_ramps.covered)}</div><div class="l">… where curb ramp data is ≥ partial</div></div>
        <div class="kpi"><div class="v">${pct(agg.score)}</div><div class="l">Population-weighted coverage score</div></div>
        <div class="kpi"><div class="v">${mr}/${ds.length}</div><div class="l">Datasets machine-readable (${verified} verified)</div></div>
        ${S.transit ? (() => { const t = transitSums(S.munis.map((m) => m.id)); return `
        <div class="kpi"><div class="v">${pct(t.t_wb_spec / t.t_stops)}</div><div class="l">of ${fmt(t.t_stops)} PA transit stops have GTFS wheelchair_boarding</div></div>
        <div class="kpi"><div class="v">${pct(t.t_sw20 / t.t_stops)}</div><div class="l">of stops are within 20 m of a mapped OSM sidewalk/crossing</div></div>`; })() : ''}
      </div>
      <h3>Coverage by ${GROUPINGS[S.groupBy].toLowerCase()}</h3>
      ${controlsHTML()}
      ${legendInline()}
      ${matrixShell()}
      ${feedsTableHTML()}
      <h3>Dataset catalog</h3>
      ${datasetsHTML(ds)}
    `;
    wireControls(renderState); renderMatrixBody(); wireMatrix(); wireDatasets(renderState);
  }

  function osmBanner() {
    return S.osm
      ? `<p class="small muted">OSM metrics: ${esc(S.osm.source)}.</p>`
      : `<p class="status err">data/osm_coverage.json not found — OSM coverage is empty. Run <code>scripts/osm_coverage.py</code> (see README).</p>`;
  }

  // ---------- county view ----------
  function renderCounty(c) {
    const list = S.munis.filter((m) => m.county === c.name);
    const agg = aggregate(list);
    const dss = allDatasets().filter((d) => d.coverage?.statewide || d.coverage?.counties?.includes(c.name) || d.coverage?.municipalities?.some((id) => S.byId.get(id)?.county === c.name));
    $('#panel').innerHTML = `
      <div class="row-flex" style="justify-content:space-between">
        <div><h2 style="margin:0">${esc(c.name)} County</h2><div class="muted small">${list.length} municipalities · pop. ${fmt(agg.pop)}</div></div>
        <div style="text-align:right"><div class="score-big">${pct(agg.score)}</div><div class="muted small">pop.-weighted score</div></div>
      </div>
      <h3>Attribute coverage (share of county population)</h3>
      ${S.attrs.map((a) => `<div class="attr-row"><div title="${esc(a.description)}">${esc(a.label)}</div>
        <div class="bar"><span class="meter"><span style="width:${agg.attrs[a.id].covered * 100}%"></span></span><span class="src">${pct(agg.attrs[a.id].covered)} ≥ partial · ${pct(agg.attrs[a.id].full)} full</span></div></div>`).join('')}
      ${osmMetricsHTML(osmSums(list.map((m) => m.id)))}
      ${transitHTML(list.map((m) => m.id), list.reduce((t, m) => t + m.area_km2, 0), [...new Set(list.flatMap((m) => S.transit?.agencies[m.id] || []))].sort())}
      <h3>Municipalities</h3>
      ${controlsHTML({ grouping: false })}
      ${legendInline()}
      ${matrixShell()}
      <h3>Datasets touching ${esc(c.name)} County (${dss.length})</h3>
      ${datasetsHTML(dss)}
    `;
    wireControls(() => renderCounty(c)); renderMatrixBody(); wireMatrix(); wireDatasets(() => renderCounty(c));
  }

  // ---------- municipality view ----------
  function renderMuni(m) {
    const cov = S.cov.get(m.id);
    const dss = allDatasets().filter((d) => applies(d, m));
    $('#panel').innerHTML = `
      <div class="row-flex" style="justify-content:space-between">
        <div><h2 style="margin:0">${esc(m.name)}</h2><div class="muted small">${esc(typeLabel(m.type))} · ${esc(m.county)} County · pop. ${fmt(m.pop)} · ${m.area_km2} km² · GEOID ${m.id}</div></div>
        <div style="text-align:right"><div class="score-big">${pct(cov.score)}</div><div class="muted small">coverage score</div></div>
      </div>
      ${osmBanner()}
      <h3>Attribute coverage</h3>
      ${S.attrs.map((a) => { const o = cov.attrs[a.id]; return `
        <div class="attr-row">
          <div title="${esc(a.description)}">${esc(a.label)}</div>
          <div class="bar"><span class="cell lvl-${o.level}${o.assumed ? ' assumed' : ''}">${LEVEL_LABEL[o.level]}</span>
            <span class="src">${o.sources.length ? o.sources.map((s) => esc(s.ds.name) + (s.measured ? ' (measured)' : s.ds.verified ? '' : '*')).join(', ') : '—'}</span></div>
        </div>`; }).join('')}
      <p class="small muted">${S.includeUnverified ? '* unverified catalog assumption' : 'Scores use verified/measured sources only. Unverified candidates are listed below; enable them in the state or county view.'}</p>
      ${osmMetricsHTML(osmSums([m.id]))}
      <div class="row-flex" style="margin-top:8px">
        <button class="btn primary" id="osm-load">Load OSM features</button>
        <span class="small muted" id="osm-status">Live from Overpass (municipality extent, or the current view if it is large).</span>
      </div>
      ${transitHTML([m.id], m.area_km2, S.transit?.agencies[m.id] || [])}
      <div class="row-flex" style="margin-top:8px">
        <button class="btn" id="gtfs-load" ${S.transit ? '' : 'disabled'}>Show GTFS stops</button>
        <label class="row-flex small"><input type="checkbox" id="para-toggle-panel" ${S.showPara ? 'checked' : ''} ${paraLayer ? '' : 'disabled'}> ADA paratransit area (derived)</label>
        <span class="small muted" id="gtfs-status"></span>
      </div>
      <h3>Datasets covering ${esc(m.name)} (${dss.length})</h3>
      <div id="ds-list">${dss.map((d) => datasetCard(d, m)).join('')}</div>
      <h3>Preview any layer by URL</h3>
      <p class="small muted">ArcGIS FeatureServer/MapServer layer (…/FeatureServer/0) or a GeoJSON URL. Features are fetched for the current map view. The server must allow CORS.</p>
      <div class="row-flex"><input type="url" id="adhoc-url" placeholder="https://…/FeatureServer/0"><button class="btn" id="adhoc-add">Add</button></div>
      <div class="status" id="adhoc-status"></div>
    `;
    wireDatasetCards($('#ds-list'));
    $('#osm-load').addEventListener('click', async (e) => {
      const st = $('#osm-status'); e.target.disabled = true;
      try { await togglePreview(S.catalog.datasets.find((d) => d.id === 'osm'), (msg) => { st.textContent = msg; }); }
      catch (err) { st.textContent = err.message; st.classList.add('err'); }
      finally { e.target.disabled = false; }
    });
    $('#adhoc-add').addEventListener('click', () => addAdhoc(m));
    $('#gtfs-load').addEventListener('click', async (e) => {
      const st = $('#gtfs-status'); e.target.disabled = true;
      try { await toggleStops(m, (msg) => { st.textContent = msg; }); }
      catch (err) { st.textContent = err.message; st.classList.add('err'); }
      finally { e.target.disabled = false; }
    });
    $('#para-toggle-panel').addEventListener('change', (e) => setParatransit(e.target.checked));
  }

  function osmMetricsHTML(s) {
    if (!s) return '';
    const r = osmRatios(s);
    const row = (k, v) => `<tr><td class="muted">${k}</td><td class="num">${v}</td></tr>`;
    return `<h3>OpenStreetMap measurements</h3>
      <table class="tbl compact">
        ${row('Sidewalk ways / length', `${fmt(s.sw_n)} / ${(s.sw_len / 1000).toFixed(1)} km`)}
        ${row('Street length (primary → residential)', `${(s.st_len / 1000).toFixed(1)} km`)}
        ${row('Est. sidewalk-to-street ratio', pct(r.sidewalkRatio))}
        ${row('Crossings (per street-km)', `${fmt(s.x_n)} (${r.crossingDensity.toFixed(1)})`)}
        ${row('Kerb nodes (per crossing end)', `${fmt(s.kerb_n)} (${pct(r.kerbRatio)})`)}
        ${row('Sidewalks tagged width · surface · incline · smoothness', `${pct(r.width)} · ${pct(r.surface)} · ${pct(r.incline)} · ${pct(r.smoothness)}`)}
        ${row('Crossings/kerbs with tactile_paving', pct(r.tactile))}
        ${row('Signalized crossings with APS tag', s.sig_n ? `${pct(r.aps)} of ${fmt(s.sig_n)}` : '—')}
        ${row('Steps (ways)', fmt(s.steps_n))}
        ${row('Transit stops · with wheelchair tag · tagged accessible', s.stop_n ? `${fmt(s.stop_n)} · ${pct(r.stopWheelchair)} · ${pct(r.stopAccessible)}` : '0')}
      </table>`;
  }

  // ---------- dataset cards ----------
  function datasetCard(d, m) {
    const key = layerKey(d, m);
    const loaded = S.loaded[key];
    const canPreview = m && d.endpoint && d.machineReadable !== false && d.endpoint.type !== 'overpass';
    const values = m ? dsAttrs(d, m).values : d.attributes || {};
    const pills = S.attrs.filter((a) => values[a.id]).map((a) => `<span class="cell lvl-${values[a.id]}">${esc(a.short)} ${LEVEL_GLYPH[values[a.id]]}</span>`).join('');
    const extent = d.coverage?.statewide ? 'statewide' : d.coverage?.counties ? `${d.coverage.counties.length} counties` : `${d.coverage?.municipalities?.length || 0} municipalities`;
    return `<div class="ds" data-ds="${d.id}">
      <div class="ds-head"><span class="ds-name">${esc(d.name)}</span><span class="tag">${esc(d.level)}</span></div>
      <div class="ds-meta">${esc(d.publisher)} · ${esc(d.format)}${d.license ? ' · ' + esc(d.license) : ''} · ${esc(extent)}</div>
      <div class="row-flex" style="gap:4px;margin-bottom:6px">
        ${d.verified ? '' : '<span class="tag unverified">unverified candidate</span>'}
        ${d.machineReadable === false ? '<span class="tag pdf">not machine-readable</span>' : ''}
        ${d.endpoint ? `<span class="tag">endpoint: ${esc(d.endpoint.type)}</span>` : '<span class="tag">no endpoint yet</span>'}
      </div>
      ${m || d.id !== 'osm' ? `<div class="attr-pills">${pills || '<span class="small muted">No attributes declared</span>'}</div>` : '<div class="small muted">Levels vary by municipality (measured).</div>'}
      ${d.notes ? `<div class="small muted" style="margin-top:6px">${esc(d.notes)}</div>` : ''}
      <div class="ds-actions">
        ${canPreview ? `<button class="btn" data-act="preview" aria-pressed="${!!(loaded && map.hasLayer(loaded.layer))}">${loaded ? 'Toggle layer' : 'Preview layer'}</button>` : ''}
        <button class="btn" data-act="schema">Schema</button>
        ${d.portal ? `<a class="btn" href="${esc(d.portal)}" target="_blank" rel="noopener">Portal ↗</a>` : ''}
      </div>
      <div class="status" data-status></div>
    </div>`;
  }

  function wireDatasetCards(root) {
    root.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]'); if (!btn) return;
      const card = btn.closest('[data-ds]');
      const d = allDatasets().find((x) => x.id === card.dataset.ds);
      if (btn.dataset.act === 'schema') return openSchema(d);
      const status = $('[data-status]', card);
      btn.disabled = true;
      try { await togglePreview(d, (msg) => { status.textContent = msg; status.classList.remove('err'); }); }
      catch (err) { status.textContent = err.message; status.classList.add('err'); }
      finally {
        btn.disabled = false;
        const l = S.loaded[layerKey(d, S.byId.get(S.view.muni))];
        btn.setAttribute('aria-pressed', String(!!(l && map.hasLayer(l.layer))));
      }
    });
  }

  // ---------- preview layers ----------
  const layerKey = (d, m) => `${d.id}@${m ? m.id : 'pa'}`;

  function clearPreviewLayers() {
    for (const v of Object.values(S.loaded)) map.removeLayer(v.layer);
    S.loaded = {};
  }

  async function togglePreview(d, onStatus) {
    const m = S.byId.get(S.view.muni); const key = layerKey(d, m);
    const existing = S.loaded[key];
    if (existing) {
      map.hasLayer(existing.layer) ? map.removeLayer(existing.layer) : existing.layer.addTo(map);
      return;
    }
    let res;
    if (d.endpoint.type === 'overpass') res = await loadOverpass(d.endpoint, m, onStatus);
    else {
      onStatus('Loading…');
      res = d.endpoint.type === 'arcgis' ? await loadArcGIS(d.endpoint.url, map.getBounds()) : await loadGeoJSON(d.endpoint.url);
    }
    const layer = geojsonLayer(res.geojson, (f) => css(OSM_CLASSES[f.properties?._class]?.color || 'cat-5'));
    S.loaded[key] = { ...res, layer, inferred: inferSchema(res.geojson.features) };
    layer.addTo(map);
    renderLegend();
    onStatus(`${res.geojson.features.length.toLocaleString()} features loaded${res.note ? ' ' + res.note : ''}.`);
  }

  function geojsonLayer(gj, colorFor) {
    return L.geoJSON(gj, {
      style: (f) => {
        const cls = f.properties?._class;
        return { color: colorFor(f), weight: cls === 'crossing' ? 3 : 2, dashArray: cls === 'steps' ? '4 3' : null, opacity: 0.95 };
      },
      pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 4, color: css('surface-1'), weight: 1.5, fillColor: colorFor(f), fillOpacity: 1 }),
      onEachFeature: (f, l) => {
        const rows = Object.entries(f.properties || {}).filter(([k]) => !k.startsWith('_') || k === '_osm_id')
          .map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</td></tr>`).join('');
        l.bindPopup(`<table>${rows || '<tr><td class="muted">no attributes</td></tr>'}</table>`);
      },
    });
  }

  // ---------- OSM / Overpass (live preview) ----------
  function classify(t) {
    if (t.highway === 'footway' && t.footway === 'sidewalk') return 'sidewalk';
    if (t.footway === 'crossing' || t.highway === 'crossing') return 'crossing';
    if (t.kerb || t.barrier === 'kerb') return 'curb';
    if (t.highway === 'steps') return 'steps';
    if (t.highway === 'bus_stop' || t.public_transport === 'platform') return 'stop';
    return 'other';
  }

  async function loadOverpass(ep, m, onStatus) {
    let b = m.layer.getBounds(), note = '';
    const area = (b.getNorth() - b.getSouth()) * (b.getEast() - b.getWest());
    if (area > 0.006) {
      if (map.getZoom() < 14) throw new Error(`${m.name} is large — zoom in to street level (the map view is used as the extent).`);
      b = map.getBounds(); note = '(current map view)';
    }
    const bb = `(${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()})`;
    const q = `[out:json][timeout:90];
(
  way["highway"="footway"]["footway"~"^(sidewalk|crossing)$"]${bb};
  node["highway"="crossing"]${bb};
  node["kerb"]${bb};
  node["barrier"="kerb"]${bb};
  way["highway"="steps"]${bb};
  node["highway"="bus_stop"]${bb};
  node["public_transport"="platform"]${bb};
);
out geom;`;
    const body = 'data=' + encodeURIComponent(q);
    let json = null, lastErr = '';
    for (const url of [ep.url, ...(ep.mirrors || [])]) {
      onStatus(`Querying ${new URL(url).host}…`);
      try {
        const res = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        if (!res.ok) { lastErr = `${new URL(url).host}: HTTP ${res.status}`; continue; }
        json = await res.json(); break;
      } catch (e) { lastErr = `${new URL(url).host}: ${e.message}`; }
    }
    if (!json) throw new Error(`All Overpass servers failed (last: ${lastErr}). Rate limits reset after a minute.`);
    const features = [];
    for (const el of json.elements) {
      const t = el.tags || {};
      let geometry = null;
      if (el.type === 'node') geometry = { type: 'Point', coordinates: [el.lon, el.lat] };
      else if (el.geometry) geometry = { type: 'LineString', coordinates: el.geometry.map((p) => [p.lon, p.lat]) };
      if (geometry) features.push({ type: 'Feature', geometry, properties: { ...t, _osm_id: `${el.type}/${el.id}`, _class: classify(t) } });
    }
    return { geojson: { type: 'FeatureCollection', features }, name: 'OpenStreetMap', note };
  }

  // ---------- ArcGIS / GeoJSON loaders ----------
  async function fetchJSON(url) {
    let res;
    try { res = await fetch(url); } catch { throw new Error('Request failed — the server may not allow cross-origin (CORS) requests.'); }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(j.error.message || 'Service error');
    return j;
  }

  async function loadArcGIS(url, b) {
    const base = url.replace(/\/+$/, '').replace(/\/query$/, '');
    const meta = await fetchJSON(base + '?f=json');
    if (!meta.fields) throw new Error('That is a service, not a layer. Append a layer id, e.g. /0.');
    const q = new URLSearchParams({
      where: '1=1', geometry: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(','),
      geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
      outFields: '*', outSR: '4326', f: 'geojson', resultRecordCount: '2000',
    });
    const geojson = await fetchJSON(`${base}/query?${q}`);
    return { geojson, name: meta.name, declaredFields: meta.fields.map((f) => ({ name: f.name, type: f.type.replace('esriFieldType', ''), alias: f.alias })) };
  }

  async function loadGeoJSON(url) {
    const gj = await fetchJSON(url);
    if (gj.type !== 'FeatureCollection') throw new Error('Expected a GeoJSON FeatureCollection.');
    return { geojson: gj, name: url.split('/').pop() };
  }

  async function addAdhoc(m) {
    const url = $('#adhoc-url').value.trim(); const st = $('#adhoc-status');
    if (!url) return;
    const type = /\/(FeatureServer|MapServer)\/\d+\/?(query)?$/i.test(url) ? 'arcgis' : 'geojson';
    const d = {
      id: 'adhoc-' + (S.adhoc.length + 1), name: url.split('/').slice(-3).join('/'), publisher: 'Ad-hoc URL', level: 'adhoc',
      format: type === 'arcgis' ? 'ArcGIS REST' : 'GeoJSON', machineReadable: true, verified: false,
      endpoint: { type, url }, coverage: { municipalities: [m.id] }, attributes: {},
      notes: 'Added in this session; attribute levels are guessed from field names and fill rates (see Schema).',
    };
    st.textContent = 'Loading…'; st.classList.remove('err');
    try {
      S.adhoc.push(d);
      await togglePreview(d, (msg) => { st.textContent = msg; });
      const l = S.loaded[layerKey(d, m)]; if (l?.name) d.name = l.name;
      d.attributes = guessAttrs(l.inferred, l.declaredFields);
      S.cov.set(m.id, computeCoverage(m));
      restyleMap(); renderMuni(m);
    } catch (err) {
      S.adhoc = S.adhoc.filter((x) => x !== d);
      st.textContent = err.message; st.classList.add('err');
    }
  }

  // ---------- schema inference ----------
  function inferSchema(features) {
    const keys = new Map();
    for (const f of features) {
      for (const [k, v] of Object.entries(f.properties || {})) {
        if (k.startsWith('_')) continue;
        let e = keys.get(k);
        if (!e) keys.set(k, (e = { name: k, count: 0, types: new Set(), examples: new Set() }));
        if (v === null || v === '') continue;
        e.count++; e.types.add(typeof v);
        if (e.examples.size < 4) e.examples.add(String(v).slice(0, 40));
      }
    }
    return {
      n: features.length,
      fields: [...keys.values()].sort((a, b) => b.count - a.count)
        .map((e) => ({ ...e, fill: features.length ? e.count / features.length : 0, types: [...e.types].join('|') || '—', examples: [...e.examples], mapsTo: mapField(e.name) })),
    };
  }

  function mapField(name) {
    const n = name.toLowerCase();
    const hit = S.attrs.find((a) => a.field_hints.some((h) => n.includes(h)));
    return hit ? hit.id : null;
  }

  function guessAttrs(inferred, declared) {
    const out = {};
    for (const f of inferred?.fields || []) if (f.mapsTo) out[f.mapsTo] = Math.max(out[f.mapsTo] || 0, f.fill >= 0.6 ? 2 : f.fill > 0 ? 1 : 0);
    for (const f of declared || []) { const mm = mapField(f.name); if (mm && !out[mm]) out[mm] = 1; }
    return out;
  }

  function openSchema(d) {
    const m = S.byId.get(S.view.muni);
    const loaded = m ? S.loaded[layerKey(d, m)] : null;
    const attrLabel = (id) => S.attrs.find((a) => a.id === id)?.label || id;
    const values = m ? dsAttrs(d, m).values : d.attributes || {};
    $('#schema-title').textContent = d.name;
    $('#schema-body').innerHTML = `
      <table class="tbl" style="margin-top:8px">
        <tr><th>Publisher</th><td>${esc(d.publisher)}</td><th>Level</th><td>${esc(d.level)}</td></tr>
        <tr><th>Format</th><td>${esc(d.format)}</td><th>License</th><td>${esc(d.license || '—')}</td></tr>
        <tr><th>Status</th><td>${d.verified ? 'verified' : 'unverified candidate'}</td><th>Endpoint</th><td>${d.endpoint ? `<code>${esc(d.endpoint.url)}</code>` : '—'}</td></tr>
      </table>
      <h3>Crosswalk to common accessibility schema${m ? ` (${esc(m.name)})` : ''}</h3>
      <table class="tbl">
        <thead><tr><th>Attribute</th><th>OSM / OSW equivalent</th><th>This dataset</th></tr></thead>
        <tbody>${S.attrs.map((a) => `<tr><td>${esc(a.label)}</td><td><code>${esc(a.osm)}</code></td>
          <td><span class="cell lvl-${values[a.id] || 0}" style="padding:1px 6px;border-radius:4px">${LEVEL_LABEL[values[a.id] || 0]}</span></td></tr>`).join('')}</tbody>
      </table>
      ${loaded?.declaredFields ? `<h3>Declared fields (from service metadata)</h3>
        <table class="tbl"><thead><tr><th>Field</th><th>Alias</th><th>Type</th><th>Maps to</th></tr></thead><tbody>
        ${loaded.declaredFields.map((f) => `<tr><td><code>${esc(f.name)}</code></td><td>${esc(f.alias)}</td><td>${esc(f.type)}</td><td>${mapField(f.name) ? esc(attrLabel(mapField(f.name))) : '<span class="muted">—</span>'}</td></tr>`).join('')}
        </tbody></table>` : ''}
      ${loaded?.inferred ? `<h3>Inferred schema (${loaded.inferred.n.toLocaleString()} features in preview)</h3>
        <table class="tbl"><thead><tr><th>${d.id === 'osm' ? 'Tag key' : 'Property'}</th><th>Type</th><th>Fill rate</th><th>Examples</th><th>Maps to</th></tr></thead><tbody>
        ${loaded.inferred.fields.slice(0, 150).map((f) => `<tr><td><code>${esc(f.name)}</code></td><td>${esc(f.types)}</td>
          <td class="num"><span class="fill" style="width:${Math.max(2, f.fill * 60)}px"></span>${pct(f.fill)}</td>
          <td class="small">${f.examples.map(esc).join(', ')}</td>
          <td>${f.mapsTo ? esc(attrLabel(f.mapsTo)) : '<span class="muted">—</span>'}</td></tr>`).join('')}
        </tbody></table>`
      : `<p class="muted small" style="margin-top:16px">${d.endpoint ? 'Load this layer from a municipality view to inspect its actual fields and fill rates.' : 'No endpoint recorded yet — the field-level schema will appear here once an endpoint is added to data/catalog.json.'}</p>`}
    `;
    $('#schema-dialog').showModal();
  }

  // ---------- CSV export ----------
  function downloadCSV() {
    const scope = S.view.county ? S.munis.filter((m) => m.county === S.view.county) : S.munis;
    const osmF = S.osm ? S.osm.fields : [];
    const trF = S.transit ? S.transit.fields : [];
    const head = ['geoid', 'name', 'type', 'county', 'pop2020', 'area_km2', 'pop_bin', 'coverage_score', ...S.attrs.map((a) => `lvl_${a.id}`), ...S.attrs.map((a) => `assumed_${a.id}`), ...osmF.map((f) => `osm_${f}`), ...trF.map((f) => `gtfs_${f}`), 'gtfs_agencies'];
    const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
    const lines = [head.join(',')];
    for (const m of scope) {
      const c = S.cov.get(m.id), row = S.osm?.munis[m.id] || [];
      lines.push([m.id, m.name, m.type, m.county, m.pop, m.area_km2, popBin(m.pop), c.score.toFixed(3),
        ...S.attrs.map((a) => c.attrs[a.id].level), ...S.attrs.map((a) => (c.attrs[a.id].assumed ? 1 : 0)), ...osmF.map((_, i) => row[i] ?? ''),
        ...trF.map((_, i) => S.transit.munis[m.id]?.[i] ?? ''), (S.transit?.agencies[m.id] || []).join('; ')].map(q).join(','));
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = `pa-ped-coverage-${S.view.county ? S.view.county.toLowerCase() + '-county' : 'statewide'}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  }

  // ---------- boot ----------
  const getJSON = (p, optional) => fetch(p).then((r) => (r.ok ? r.json() : optional ? null : Promise.reject(new Error(`${p}: HTTP ${r.status}`))));
  Promise.all([
    getJSON('data/catalog.json'), getJSON('data/schema.json'),
    getJSON('data/municipalities.geojson'), getJSON('data/counties.geojson'),
    getJSON('data/osm_coverage.json', true),
    getJSON('data/transit_coverage.json', true), getJSON('data/transit_feeds.json', true),
    getJSON('data/paratransit_ada.geojson', true),
  ]).then(([catalog, schema, muniGJ, countyGJ, osm, transit, feeds, para]) => {
    S.catalog = catalog; S.schema = schema; S.attrs = schema.attributes; S.osm = osm;
    S.transit = transit; S.feeds = feeds;
    if (para) {
      paraLayer = L.geoJSON(para, {
        renderer, interactive: false,
        style: { color: css('cat-5'), weight: 1.5, dashArray: '5 4', fillColor: css('cat-5'), fillOpacity: 0.12 },
      });
    }
    S.munis = muniGJ.features.map((f) => ({ ...f.properties }));
    S.munis.forEach((m) => S.byId.set(m.id, m));
    S.counties = countyGJ.features.map((f) => ({ ...f.properties, feature: f, bounds: L.geoJSON(f).getBounds() }));
    S.counties.forEach((c) => S.countyByName.set(c.name, c));
    recomputeAll();
    buildMapLayers(muniGJ, countyGJ);
    addEventListener('hashchange', route);
    route();
    // Shareable overlays: ?layers=para,stops (stops apply in a municipality view)
    const layers = (new URLSearchParams(location.search).get('layers') || '').split(',');
    if (layers.includes('para')) setParatransit(true);
    if (layers.includes('stops') && S.view.muni) toggleStops(S.byId.get(S.view.muni), (msg) => { const st = $('#gtfs-status'); if (st) st.textContent = msg; }).catch(() => {});
  }).catch((e) => {
    $('#panel').innerHTML = `<p class="status err">Could not load data files (${esc(e.message)}). Serve this folder over HTTP, e.g. <code>python3 -m http.server</code>.</p>`;
  });
})();
