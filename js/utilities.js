// utilities.js — US electric utility service territories + capability profiles
//
// Data source: HIFLD "Electric Retail Service Territories" (national, ~2,931 polygons,
// EIA-861 derived). Hosted on ArcGIS Online (CORS-enabled, same pattern as the
// HIFLD transmission layer used in transmission.js).
//
// Everything is namespaced under window._UTIL to avoid global `let`/`const`
// collisions with map.js (which breaks the inline script if a name is reused).

window._UTIL = window._UTIL || {
  URL: 'https://services3.arcgis.com/OYP7N6mAJJCyH6hd/arcgis/rest/services/Electric_Retail_Service_Territories_HIFLD/FeatureServer/0/query',
  FIELDS: 'OBJECTID,NAME,TYPE,STATE,HOLDING_CO,CNTRL_AREA,PLAN_AREA,SUMMR_PEAK,WINTR_PEAK,SUMMER_CAP,WINTER_CAP,NET_GEN,PURCHASED,NET_EX,RETAIL_MWH,WSALE_MWH,TOTAL_MWH,TRANS_MWH,CUSTOMERS,NAICS_DESC,REGULATED,ADDRESS,CITY,ZIP,TELEPHONE,WEBSITE,YEAR,SOURCE',
  map: null,
  layer: null,
  loaded: false,
  features: [],          // all features (GeoJSON)
  selectedId: null,
  sortKey: 'SUMMR_PEAK',
  sortDir: -1,
  // Ownership type → color + label
  TYPE_COLORS: {
    'INVESTOR OWNED':        '#4f8ef7',
    'COOPERATIVE':           '#22c55e',
    'MUNICIPAL':             '#f59e0b',
    'POLITICAL SUBDIVISION': '#a855f7',
    'STATE':                 '#06b6d4',
    'FEDERAL':               '#ef4444',
    'OTHER':                 '#94a3b8',
  },
  activeTypes: null,     // Set of enabled type keys (null until built)
};

// Normalize the raw TYPE string to one of our color buckets
_UTIL.typeKey = function (t) {
  if (!t) return 'OTHER';
  const u = String(t).toUpperCase();
  if (_UTIL.TYPE_COLORS[u]) return u;
  if (u.indexOf('MUNICIPAL') === 0) return 'MUNICIPAL';
  if (u.indexOf('COOP') === 0) return 'COOPERATIVE';
  return 'OTHER';
};

_UTIL.colorFor = function (t) {
  return _UTIL.TYPE_COLORS[_UTIL.typeKey(t)];
};

// Friendly label for a balancing-authority / control-area code
_UTIL.BA_NAMES = {
  PJM: 'PJM Interconnection', MISO: 'Midcontinent ISO', SWPP: 'Southwest Power Pool',
  ERCO: 'ERCOT', CISO: 'California ISO', NYIS: 'New York ISO', ISNE: 'ISO New England',
  SOCO: 'Southern Company', TVA: 'Tennessee Valley Authority', DUK: 'Duke Energy Carolinas',
  CPLE: 'Duke Progress East', FPL: 'Florida Power & Light', FPC: 'Duke Energy Florida',
  BPAT: 'Bonneville Power', PACE: 'PacifiCorp East', PACW: 'PacifiCorp West',
  PSCO: 'Public Service Colorado', AECI: 'Assoc. Electric Coop', WACM: 'WAPA Rocky Mtn',
  WALC: 'WAPA Desert SW', AZPS: 'Arizona Public Service', NEVP: 'NV Energy',
  PNM: 'PNM', SRP: 'Salt River Project', LGEE: 'LG&E / KU', SC: 'South Carolina E&G',
  NWMT: 'NorthWestern Energy',
};

// ── Number formatting ─────────────────────────────────────────────────────────
_UTIL.fmtMW = function (v) {
  if (v == null || v === '' || isNaN(v)) return '—';
  const n = +v;
  if (n >= 1000) return (n / 1000).toFixed(1) + ' GW';
  return Math.round(n).toLocaleString() + ' MW';
};
_UTIL.fmtNum = function (v) {
  if (v == null || v === '' || isNaN(v)) return '—';
  return Math.round(+v).toLocaleString();
};
_UTIL.fmtMWh = function (v) {
  if (v == null || v === '' || isNaN(v) || +v === 0) return '—';
  const n = +v;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' TWh';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + ' GWh';
  return Math.round(n).toLocaleString() + ' MWh';
};

// ── Entry point (called lazily on first view of the Utility sub-tab) ───────────
_UTIL.init = async function () {
  if (_UTIL.loaded) { if (_UTIL.map) setTimeout(() => _UTIL.map.invalidateSize(), 60); return; }
  _UTIL.loaded = true;

  _UTIL.map = L.map('util-map', { preferCanvas: true, minZoom: 3, maxZoom: 10, worldCopyJump: false })
    .setView([39.5, -97], 4);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO', subdomains: 'abcd', maxZoom: 10,
  }).addTo(_UTIL.map);
  setTimeout(() => _UTIL.map.invalidateSize(), 60);

  _UTIL.wireControls();

  try {
    await _UTIL.fetchAll();
    _UTIL.activeTypes = new Set(Object.keys(_UTIL.TYPE_COLORS));
    _UTIL.renderLegend();
    _UTIL.renderStats();
    _UTIL.populateIsoFilter();
    _UTIL.draw();
    _UTIL.renderTable();
    document.getElementById('util-loading').classList.add('hidden');
  } catch (e) {
    console.error('Utility territories load failed:', e);
    document.getElementById('util-loading').textContent = 'Failed to load utility data: ' + e.message;
  }
};

// Fetch all territories across paginated requests (maxRecordCount is 2000)
_UTIL.fetchAll = async function () {
  const PAGE = 2000;
  let offset = 0, all = [];
  for (let guard = 0; guard < 5; guard++) {
    const params = new URLSearchParams({
      where: '1=1',
      outFields: _UTIL.FIELDS,
      returnGeometry: 'true',
      maxAllowableOffset: '0.02',   // simplify geometry (~2km) to keep payload small
      geometryPrecision: '4',
      outSR: '4326',
      f: 'geojson',
      resultOffset: String(offset),
      resultRecordCount: String(PAGE),
    });
    const resp = await fetch(_UTIL.URL + '?' + params.toString());
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const gj = await resp.json();
    const feats = (gj.features || []).filter(f => f.geometry);
    all = all.concat(feats);
    if (feats.length < PAGE) break;
    offset += PAGE;
  }
  // Stable id + numeric coercion for sorting
  all.forEach(f => {
    const p = f.properties;
    p._tk = _UTIL.typeKey(p.TYPE);
    // HIFLD uses -999999 (and blanks) as a "not available" sentinel for numeric fields.
    // Null out the sentinel only — real net-exchange values can legitimately be negative.
    ['SUMMR_PEAK', 'WINTR_PEAK', 'SUMMER_CAP', 'WINTER_CAP', 'NET_GEN', 'PURCHASED',
     'NET_EX', 'RETAIL_MWH', 'WSALE_MWH', 'TOTAL_MWH', 'TRANS_MWH', 'CUSTOMERS']
      .forEach(k => {
        const n = (p[k] == null || p[k] === '') ? null : +p[k];
        p[k] = (n == null || isNaN(n) || n <= -999990) ? null : n;
      });
  });
  _UTIL.features = all;
  return all;
};

// ── Filtering ──────────────────────────────────────────────────────────────────
_UTIL.passesFilter = function (p) {
  if (_UTIL.activeTypes && !_UTIL.activeTypes.has(p._tk)) return false;
  const iso = document.getElementById('util-iso-filter').value;
  if (iso && p.CNTRL_AREA !== iso) return false;
  const minPeak = +document.getElementById('util-minpeak').value;
  if (minPeak > 0 && (!(p.SUMMR_PEAK >= minPeak))) return false;
  const q = document.getElementById('util-search').value.trim().toLowerCase();
  if (q && !(String(p.NAME || '').toLowerCase().includes(q) ||
             String(p.HOLDING_CO || '').toLowerCase().includes(q))) return false;
  return true;
};

// ── Map drawing ─────────────────────────────────────────────────────────────────
_UTIL.styleFor = function (p) {
  const sel = _UTIL.selectedId != null && p.OBJECTID === _UTIL.selectedId;
  return {
    color: sel ? '#ffffff' : _UTIL.colorFor(p.TYPE),
    weight: sel ? 2 : 0.4,
    fillColor: _UTIL.colorFor(p.TYPE),
    fillOpacity: sel ? 0.7 : 0.45,
  };
};

_UTIL.draw = function () {
  if (_UTIL.layer) { _UTIL.map.removeLayer(_UTIL.layer); _UTIL.layer = null; }
  const filtered = { type: 'FeatureCollection', features: _UTIL.features.filter(f => _UTIL.passesFilter(f.properties)) };
  _UTIL.layer = L.geoJSON(filtered, {
    style: f => _UTIL.styleFor(f.properties),
    onEachFeature: (f, lyr) => {
      lyr.on('click', () => _UTIL.select(f.properties.OBJECTID));
      lyr.bindTooltip(f.properties.NAME || 'Unknown', { sticky: true });
    },
  }).addTo(_UTIL.map);
};

// ── Selection / detail panel ─────────────────────────────────────────────────────
_UTIL.select = function (oid) {
  _UTIL.selectedId = oid;
  const f = _UTIL.features.find(x => x.properties.OBJECTID === oid);
  if (!f) return;
  if (_UTIL.layer) _UTIL.layer.setStyle(ff => _UTIL.styleFor(ff.properties));
  _UTIL.renderDetail(f.properties);
};

// Strip the HIFLD "NOT AVAILABLE" sentinel from a text field
_UTIL.txt = function (v) {
  return (v == null || v === '' || String(v).toUpperCase() === 'NOT AVAILABLE') ? null : String(v);
};

_UTIL.renderDetail = function (p) {
  const baCode = _UTIL.txt(p.CNTRL_AREA);
  const ba = baCode ? (_UTIL.BA_NAMES[baCode] ? `${_UTIL.BA_NAMES[baCode]} (${baCode})` : baCode) : '—';
  const planArea = _UTIL.txt(p.PLAN_AREA);
  const typeLabel = _UTIL.txt(p.TYPE) || 'Unclassified';
  const holding = _UTIL.txt(p.HOLDING_CO);
  const cell = (l, v, full) => `<div${full ? ' class="full"' : ''}><div class="l">${l}</div><div class="v">${v}</div></div>`;
  const sect = t => `<div class="ud-sect">${t}</div>`;

  let html = `<h3>${p.NAME || 'Unknown utility'}</h3>`;
  html += `<div class="ud-sub">${_UTIL.txt(p.STATE) || ''}${holding && holding !== _UTIL.txt(p.NAME) ? ' · ' + holding : ''}</div>`;
  html += `<span class="ud-badge" style="background:${_UTIL.colorFor(p.TYPE)}">${typeLabel}</span>`;

  // ── Capacity & demand ──
  html += sect('Capacity & Peak Demand');
  html += '<div class="ud-grid">';
  html += cell('Summer Peak', _UTIL.fmtMW(p.SUMMR_PEAK));
  html += cell('Winter Peak', _UTIL.fmtMW(p.WINTR_PEAK));
  html += cell('Summer Capacity', _UTIL.fmtMW(p.SUMMER_CAP));
  html += cell('Winter Capacity', _UTIL.fmtMW(p.WINTER_CAP));
  html += '</div>';
  if (p.SUMMER_CAP > 0 && p.SUMMR_PEAK > 0) {
    const margin = ((p.SUMMER_CAP - p.SUMMR_PEAK) / p.SUMMR_PEAK) * 100;
    const head = p.SUMMER_CAP - p.SUMMR_PEAK;
    html += `<div class="ud-note">Owned capacity vs. summer peak: <strong>${_UTIL.fmtMW(head)}</strong> (${margin.toFixed(0)}% reserve). ${margin < 15 ? 'Thin owned headroom — relies on market/PPA imports to serve load growth.' : 'Owns generation headroom above peak.'}</div>`;
  } else if (p.NET_GEN === 0 || (p.PURCHASED > 0 && !(p.NET_GEN > 0))) {
    html += `<div class="ud-note">Distribution-only utility — owns little or no generation; purchases power on the wholesale market.</div>`;
  }

  // ── Energy balance ──
  const flows = ['NET_GEN', 'PURCHASED', 'NET_EX', 'RETAIL_MWH', 'WSALE_MWH', 'TOTAL_MWH', 'TRANS_MWH'];
  if (flows.some(k => p[k] != null)) {
    html += sect('Annual Energy Balance');
    html += '<div class="ud-grid">';
    html += cell('Net Generation', _UTIL.fmtMWh(p.NET_GEN));
    html += cell('Purchased Power', _UTIL.fmtMWh(p.PURCHASED));
    html += cell('Retail Sales', _UTIL.fmtMWh(p.RETAIL_MWH));
    html += cell('Wholesale Sales', _UTIL.fmtMWh(p.WSALE_MWH));
    html += cell('Net Interchange', _UTIL.fmtMWh(p.NET_EX));
    html += cell('Total Disposition', _UTIL.fmtMWh(p.TOTAL_MWH));
    html += '</div>';
    if (p.NET_GEN > 0 && p.TOTAL_MWH > 0) {
      const self = Math.min(100, (p.NET_GEN / p.TOTAL_MWH) * 100);
      html += `<div class="ud-note">Self-generates <strong>${self.toFixed(0)}%</strong> of total energy handled; the balance is purchased.</div>`;
    }
  }

  // ── Service profile ──
  html += sect('Service Profile');
  html += '<div class="ud-grid">';
  html += cell('Customers', _UTIL.fmtNum(p.CUSTOMERS));
  html += cell('Ownership', typeLabel);
  html += cell('Balancing Authority', ba, true);
  if (planArea && planArea !== baCode) html += cell('Planning Authority', planArea, true);
  const naics = _UTIL.txt(p.NAICS_DESC);
  if (naics) html += cell('Sector (NAICS)', naics.toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase()), true);
  html += '</div>';

  // ── HQ & contact ──
  const city = _UTIL.txt(p.CITY), addr = _UTIL.txt(p.ADDRESS), zip = _UTIL.txt(p.ZIP), tel = _UTIL.txt(p.TELEPHONE);
  if (city || addr || tel) {
    html += sect('Headquarters & Contact');
    html += '<div class="ud-grid">';
    const loc = [city, _UTIL.txt(p.STATE), zip].filter(Boolean).join(', ');
    if (loc) html += cell('Location', loc, true);
    if (addr) html += cell('Address', addr, true);
    if (tel) html += cell('Phone', tel);
    html += '</div>';
  }

  if (p.WEBSITE && /^https?:|^www\./i.test(p.WEBSITE)) {
    const href = p.WEBSITE.startsWith('http') ? p.WEBSITE : 'http://' + p.WEBSITE;
    html += `<a class="ud-link" href="${href}" target="_blank" rel="noopener">Utility website ↗</a>`;
  }

  // ── Provenance footer ──
  const src = _UTIL.txt(p.SOURCE);
  const srcShort = src ? src.split(',')[0].replace(/^https?:\/\/(www\.)?/, '').split('/')[0] : 'HIFLD / EIA-861';
  html += `<div class="ud-foot">Source: ${srcShort}${p.YEAR ? ' · data year ' + p.YEAR : ''}. HIFLD Electric Retail Service Territories.</div>`;

  document.getElementById('util-detail').innerHTML = html;
};

// ── Legend (also acts as a type filter) ──────────────────────────────────────────
_UTIL.renderLegend = function () {
  const counts = {};
  _UTIL.features.forEach(f => { counts[f.properties._tk] = (counts[f.properties._tk] || 0) + 1; });
  const order = ['INVESTOR OWNED', 'COOPERATIVE', 'MUNICIPAL', 'POLITICAL SUBDIVISION', 'STATE', 'FEDERAL', 'OTHER'];
  const labels = { 'INVESTOR OWNED': 'Investor-Owned', 'COOPERATIVE': 'Cooperative', 'MUNICIPAL': 'Municipal', 'POLITICAL SUBDIVISION': 'Political Subdiv.', 'STATE': 'State', 'FEDERAL': 'Federal', 'OTHER': 'Other / N.A.' };
  const el = document.getElementById('util-type-legend');
  el.innerHTML = order.filter(k => counts[k]).map(k =>
    `<span class="util-type-chip" data-type="${k}" onclick="_UTIL.toggleType('${k}')">
       <span class="dot" style="background:${_UTIL.TYPE_COLORS[k]}"></span>${labels[k]}
       <span class="cnt">${counts[k]}</span>
     </span>`).join('');
};

_UTIL.toggleType = function (k) {
  if (_UTIL.activeTypes.has(k)) _UTIL.activeTypes.delete(k); else _UTIL.activeTypes.add(k);
  document.querySelector(`.util-type-chip[data-type="${k}"]`).classList.toggle('off', !_UTIL.activeTypes.has(k));
  _UTIL.draw();
  _UTIL.renderTable();
};

// ── Summary stat tiles (recomputed from current filter) ───────────────────────────
_UTIL.renderStats = function () {
  const f = _UTIL.features;
  const ious = f.filter(x => x.properties._tk === 'INVESTOR OWNED');
  const totPeak = f.reduce((s, x) => s + (x.properties.SUMMR_PEAK || 0), 0);
  const totCust = f.reduce((s, x) => s + (x.properties.CUSTOMERS || 0), 0);
  const tiles = [
    [_UTIL.fmtNum(f.length), 'Service territories'],
    [_UTIL.fmtNum(ious.length), 'Investor-owned utilities'],
    [(totPeak / 1000).toFixed(0) + ' GW', 'Aggregate summer peak'],
    [(totCust / 1e6).toFixed(0) + 'M', 'Customers served'],
  ];
  document.getElementById('util-stats').innerHTML = tiles.map(t =>
    `<div class="util-stat-tile"><div class="v">${t[0]}</div><div class="l">${t[1]}</div></div>`).join('');
};

// ── Balancing-authority dropdown ──────────────────────────────────────────────────
_UTIL.populateIsoFilter = function () {
  const counts = {};
  _UTIL.features.forEach(f => {
    const c = f.properties.CNTRL_AREA;
    if (c && c !== 'NOT AVAILABLE') counts[c] = (counts[c] || 0) + 1;
  });
  const sel = document.getElementById('util-iso-filter');
  Object.keys(counts).sort((a, b) => counts[b] - counts[a]).forEach(c => {
    const o = document.createElement('option');
    o.value = c;
    o.textContent = (_UTIL.BA_NAMES[c] ? `${_UTIL.BA_NAMES[c]} (${c})` : c) + ` — ${counts[c]}`;
    sel.appendChild(o);
  });
};

// ── Capability table ──────────────────────────────────────────────────────────────
_UTIL.COLS = [
  { k: 'NAME', label: 'Utility', num: false },
  { k: 'STATE', label: 'St', num: false },
  { k: 'TYPE', label: 'Type', num: false },
  { k: 'CNTRL_AREA', label: 'BA', num: false },
  { k: 'SUMMR_PEAK', label: 'Sum. Peak', num: true, fmt: 'mw' },
  { k: 'SUMMER_CAP', label: 'Capacity', num: true, fmt: 'mw' },
  { k: 'NET_GEN', label: 'Net Gen', num: true, fmt: 'mwh' },
  { k: 'CUSTOMERS', label: 'Customers', num: true, fmt: 'num' },
];

_UTIL.renderTable = function () {
  const thead = document.getElementById('util-thead');
  thead.innerHTML = _UTIL.COLS.map(c =>
    `<th class="${c.num ? 'num' : ''}" onclick="_UTIL.sortBy('${c.k}')">${c.label}${_UTIL.sortKey === c.k ? (_UTIL.sortDir < 0 ? ' ▼' : ' ▲') : ''}</th>`).join('');

  let rows = _UTIL.features.filter(f => _UTIL.passesFilter(f.properties)).map(f => f.properties);
  const k = _UTIL.sortKey, dir = _UTIL.sortDir;
  rows.sort((a, b) => {
    let av = a[k], bv = b[k];
    if (typeof av === 'number' || typeof bv === 'number') {
      av = av == null ? -Infinity : av; bv = bv == null ? -Infinity : bv;
      return (av - bv) * dir;
    }
    return String(av || '').localeCompare(String(bv || '')) * dir;
  });
  const LIMIT = 150;
  const shown = rows.slice(0, LIMIT);
  document.getElementById('util-table-count').textContent =
    `— ${rows.length.toLocaleString()} match current filters${rows.length > LIMIT ? `, showing top ${LIMIT}` : ''}`;

  const fmt = (v, how) => how === 'mw' ? _UTIL.fmtMW(v) : how === 'mwh' ? _UTIL.fmtMWh(v) : how === 'num' ? _UTIL.fmtNum(v) : (v == null || v === 'NOT AVAILABLE' ? '—' : v);
  document.getElementById('util-tbody').innerHTML = shown.map(p =>
    `<tr onclick="_UTIL.selectAndZoom(${p.OBJECTID})">
       <td><span class="type-dot" style="background:${_UTIL.colorFor(p.TYPE)}"></span>${p.NAME || '—'}</td>
       <td>${p.STATE || '—'}</td>
       <td>${(p.TYPE && p.TYPE !== 'NOT AVAILABLE') ? p.TYPE.replace('INVESTOR OWNED', 'IOU') : '—'}</td>
       <td>${(p.CNTRL_AREA && p.CNTRL_AREA !== 'NOT AVAILABLE') ? p.CNTRL_AREA : '—'}</td>
       <td class="num">${fmt(p.SUMMR_PEAK, 'mw')}</td>
       <td class="num">${fmt(p.SUMMER_CAP, 'mw')}</td>
       <td class="num">${fmt(p.NET_GEN, 'mwh')}</td>
       <td class="num">${fmt(p.CUSTOMERS, 'num')}</td>
     </tr>`).join('');
};

_UTIL.selectAndZoom = function (oid) {
  _UTIL.select(oid);
  const f = _UTIL.features.find(x => x.properties.OBJECTID === oid);
  if (f && _UTIL.map) {
    try { _UTIL.map.fitBounds(L.geoJSON(f).getBounds(), { maxZoom: 8, padding: [40, 40] }); } catch (e) {}
  }
  document.getElementById('util-map').scrollIntoView({ behavior: 'smooth', block: 'center' });
};

_UTIL.sortBy = function (k) {
  if (_UTIL.sortKey === k) _UTIL.sortDir *= -1;
  else { _UTIL.sortKey = k; _UTIL.sortDir = (k === 'NAME' || k === 'STATE') ? 1 : -1; }
  _UTIL.renderTable();
};

// ── Control wiring ────────────────────────────────────────────────────────────────
_UTIL.wireControls = function () {
  let t;
  const refresh = () => { _UTIL.draw(); _UTIL.renderTable(); };
  document.getElementById('util-search').addEventListener('input', () => { clearTimeout(t); t = setTimeout(refresh, 250); });
  document.getElementById('util-iso-filter').addEventListener('change', refresh);
  document.getElementById('util-minpeak').addEventListener('input', e => {
    document.getElementById('util-minpeak-val').textContent = (+e.target.value).toLocaleString() + ' MW';
    clearTimeout(t); t = setTimeout(refresh, 150);
  });
};
