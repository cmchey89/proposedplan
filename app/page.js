'use client';

import { useEffect, useRef } from 'react';
import 'leaflet/dist/leaflet.css';

async function handleExportPdf() {
  const html2canvas = (await import('html2canvas')).default;
  const { jsPDF } = await import('jspdf');

  const mapEl = document.getElementById('map');
  const canvas = await html2canvas(mapEl, { useCORS: true, allowTaint: false });
  const imgData = canvas.toDataURL('image/png');

  const pdf = new jsPDF({
    orientation: canvas.width >= canvas.height ? 'landscape' : 'portrait',
    unit: 'px',
    format: [canvas.width, canvas.height],
  });
  pdf.addImage(imgData, 'PNG', 0, 0, canvas.width, canvas.height);
  pdf.save('sg-map-export.pdf');
}

export default function Page() {
  const didInit = useRef(false);

  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;

    let mapInstance = null;
    let outsideClickHandlerRef = null;

    (async () => {
    // leaflet touches `window` at import time, so it must be loaded
    // dynamically here rather than as a static top-level import — a
    // static import gets evaluated during Next's SSR pass even inside
    // a 'use client' component, which crashes with "window is not defined".
    const L = (await import('leaflet')).default;

    const SINGAPORE_CENTER = [1.3521, 103.8198];
    const LANDLOT_URL = 'https://www.onemap.gov.sg/maps/tiles/LandLot/{z}/{x}/{y}.png';
    const ATTRIBUTION = "&copy; <a href='https://www.onemap.gov.sg'>OneMap</a>, Singapore Land Authority";

    // Two-pass approach:
    // Pass 1 — find compact, text-shaped ink blobs (labels) via connected-
    // component analysis and repaint them with the local green fill color,
    // erasing the black text while leaving long line strokes untouched.
    // Pass 2 — now that labels are "healed" back to green, drop ALL green
    // fill (original + healed patches) to transparent in one uniform pass,
    // leaving only the surviving line ink visible over the satellite layer.
    function processTile(ctx, size) {
      const imgData = ctx.getImageData(0, 0, size, size);
      const data = imgData.data;

      const isInk = (i) => {
        const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3];
        const val = (r + g + b) / 3;
        const sat = Math.max(r, g, b) - Math.min(r, g, b);
        return a > 10 && val < 175 && sat < 25;
      };

      // dominant background color, for repainting over healed labels
      const hist = new Map();
      for (let i = 0; i < size * size; i++) {
        if (isInk(i)) continue;
        const key = data[i * 4] + ',' + data[i * 4 + 1] + ',' + data[i * 4 + 2];
        hist.set(key, (hist.get(key) || 0) + 1);
      }
      let bgColor = [207, 250, 222];
      let bgBest = 0;
      for (const [key, count] of hist) {
        if (count > bgBest) { bgBest = count; bgColor = key.split(',').map(Number); }
      }

      const visited = new Uint8Array(size * size);
      const stack = new Int32Array(size * size);
      const MAX_TEXT_HEIGHT = 18;
      const MAX_TEXT_WIDTH = 170;
      const MIN_FILL_RATIO = 0.20;

      for (let start = 0; start < size * size; start++) {
        if (!isInk(start) || visited[start]) continue;

        let sp = 0;
        stack[sp++] = start;
        visited[start] = 1;
        let minX = size, maxX = 0, minY = size, maxY = 0, count = 0;
        const members = [];

        while (sp > 0) {
          const idx = stack[--sp];
          const x = idx % size, y = (idx / size) | 0;
          members.push(idx);
          count++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;

          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
              const nIdx = ny * size + nx;
              if (isInk(nIdx) && !visited[nIdx]) {
                visited[nIdx] = 1;
                stack[sp++] = nIdx;
              }
            }
          }
        }

        const w = maxX - minX + 1, h = maxY - minY + 1;
        const fillRatio = count / (w * h);
        const looksLikeText = h <= MAX_TEXT_HEIGHT && w <= MAX_TEXT_WIDTH && fillRatio >= MIN_FILL_RATIO;

        if (looksLikeText) {
          for (const idx of members) {
            data[idx * 4] = bgColor[0];
            data[idx * 4 + 1] = bgColor[1];
            data[idx * 4 + 2] = bgColor[2];
          }
        }
      }

      // Pass 2: drop all remaining fill (original + healed-over labels)
      for (let i = 0; i < size * size; i++) {
        if (!isInk(i)) data[i * 4 + 3] = 0;
      }

      ctx.putImageData(imgData, 0, 0);
    }

    const LinesOnlyLandLot = L.GridLayer.extend({
      createTile: function (coords, done) {
        const size = this.getTileSize().x;
        const canvas = L.DomUtil.create('canvas', 'leaflet-tile');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          ctx.drawImage(img, 0, 0, size, size);
          try {
            processTile(ctx, size);
            done(null, canvas);
          } catch (err) {
            done(err, canvas);
          }
        };
        img.onerror = () => done(new Error('tile load error'), canvas);
        const z = coords.z, x = coords.x, y = coords.y;
        img.src = LANDLOT_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);

        return canvas;
      }
    });

    // zoomControl off here + added manually at bottomleft, since the
    // default topleft position collides with the search box.
    // renderer: L.canvas() forces polylines/circleMarkers to draw onto a
    // canvas instead of Leaflet's default SVG — html2canvas (used by
    // Export PDF) doesn't reliably capture nested SVG with transforms,
    // so lines were silently missing from the exported PDF without this.
    const map = L.map('map', { zoomControl: false, renderer: L.canvas() }).setView(SINGAPORE_CENTER, 13);
    L.control.zoom({ position: 'bottomleft' }).addTo(map);

    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { attribution: 'Tiles &copy; Esri', maxZoom: 19, maxNativeZoom: 19 }
    ).addTo(map);

    const landLot = new LinesOnlyLandLot({ attribution: ATTRIBUTION, maxZoom: 19 });
    landLot.addTo(map);

    document.getElementById('toggleLandLot').addEventListener('change', (e) => {
      if (e.target.checked) landLot.addTo(map);
      else map.removeLayer(landLot);
    });

    // Search: OneMap's address/postal search endpoint (public, no key needed
    // — it shows a nag about an auth token in the response but still
    // returns real results, and CORS is open).
    const searchInput = document.getElementById('searchInput');
    const searchResults = document.getElementById('searchResults');
    let debounceTimer = null;

    function clearResults() {
      searchResults.style.display = 'none';
      searchResults.innerHTML = '';
    }

    async function runSearch(query) {
      const url = 'https://www.onemap.gov.sg/api/common/elastic/search?searchVal='
        + encodeURIComponent(query) + '&returnGeom=Y&getAddrDetails=Y&pageNum=1';
      const res = await fetch(url);
      const json = await res.json();
      return json.results || [];
    }

    function showResults(results) {
      if (!results.length) {
        searchResults.innerHTML = '<div>No results found</div>';
        searchResults.style.display = 'block';
        return;
      }
      searchResults.innerHTML = '';
      for (const r of results) {
        const row = document.createElement('div');
        row.textContent = r.ADDRESS;
        row.addEventListener('click', () => {
          const lat = parseFloat(r.LATITUDE), lng = parseFloat(r.LONGITUDE);
          map.setView([lat, lng], 19);
          searchInput.value = r.ADDRESS;
          clearResults();
        });
        searchResults.appendChild(row);
      }
      searchResults.style.display = 'block';
    }

    searchInput.addEventListener('input', (e) => {
      const query = e.target.value.trim();
      clearTimeout(debounceTimer);
      if (query.length < 2) { clearResults(); return; }
      debounceTimer = setTimeout(async () => {
        try {
          const results = await runSearch(query);
          showResults(results.slice(0, 8));
        } catch (err) {
          searchResults.innerHTML = '<div>Search failed</div>';
          searchResults.style.display = 'block';
        }
      }, 300);
    });

    const outsideClickHandler = (e) => {
      if (!document.getElementById('searchBox').contains(e.target)) clearResults();
    };
    document.addEventListener('click', outsideClickHandler);

    // Drawing tools: manhole markers (existing/new) + existing/new infra lines.
    const LINE_COLORS = { blue: '#1e6fff', green: '#22a94c' };
    const MANHOLE_COLORS = { manholeBlue: '#1e6fff', manholeGreen: '#22a94c' };

    function makeManholeIcon(color) {
      return L.divIcon({
        className: 'manhole-icon',
        html: '<svg width="20" height="20" viewBox="0 0 20 20"><rect x="2" y="2" width="16" height="16" rx="3" fill="rgba(255,255,255,0.6)" stroke="' + color + '" stroke-width="2"/><line x1="3" y1="17" x2="17" y2="3" stroke="' + color + '" stroke-width="2"/></svg>',
        iconSize: [20, 20],
        iconAnchor: [10, 10],
      });
    }
    const manholeIcons = {
      manholeBlue: makeManholeIcon(MANHOLE_COLORS.manholeBlue),
      manholeGreen: makeManholeIcon(MANHOLE_COLORS.manholeGreen),
    };

    const manholeLayer = L.layerGroup().addTo(map);
    const lineLayer = L.layerGroup().addTo(map);

    let activeTool = null; // null | 'manholeBlue' | 'manholeGreen' | 'blue' | 'green' | 'delete'
    let currentPoints = [];
    let previewLine = null;
    let vertexMarkers = [];

    const toolButtons = {
      manholeBlue: document.getElementById('toolManholeBlue'),
      manholeGreen: document.getElementById('toolManholeGreen'),
      blue: document.getElementById('toolBlue'),
      green: document.getElementById('toolGreen'),
      delete: document.getElementById('toolDelete'),
    };

    function setActiveTool(tool) {
      // switching tools abandons any in-progress line
      resetCurrentLine();
      activeTool = (activeTool === tool) ? null : tool;
      for (const key in toolButtons) {
        toolButtons[key].classList.toggle('active', key === activeTool);
      }
      const drawingLine = activeTool === 'blue' || activeTool === 'green';
      if (drawingLine) map.doubleClickZoom.disable();
      else map.doubleClickZoom.enable();
      map.getContainer().style.cursor = activeTool === 'delete' ? 'crosshair' : '';
    }

    // Wires up delete-mode click handling on a placed manhole/line: when
    // the delete tool is active, clicking the feature removes it from its
    // layer group instead of letting the click fall through to the map.
    function makeDeletable(layer, group) {
      layer.on('click', (ev) => {
        if (activeTool !== 'delete') return;
        L.DomEvent.stopPropagation(ev);
        group.removeLayer(layer);
      });
    }

    function resetCurrentLine() {
      currentPoints = [];
      if (previewLine) { map.removeLayer(previewLine); previewLine = null; }
      for (const m of vertexMarkers) map.removeLayer(m);
      vertexMarkers = [];
    }

    function updatePreviewLine(color) {
      if (previewLine) map.removeLayer(previewLine);
      previewLine = L.polyline(currentPoints, { color, weight: 4, dashArray: '6,6' }).addTo(map);
    }

    function finishLine() {
      if ((activeTool === 'blue' || activeTool === 'green') && currentPoints.length >= 2) {
        const line = L.polyline(currentPoints, { color: LINE_COLORS[activeTool], weight: 4 }).addTo(lineLayer);
        makeDeletable(line, lineLayer);
      }
      resetCurrentLine();
    }

    for (const key in toolButtons) {
      toolButtons[key].addEventListener('click', () => setActiveTool(key));
    }

    document.getElementById('finishLine').addEventListener('click', finishLine);

    document.getElementById('clearAll').addEventListener('click', () => {
      manholeLayer.clearLayers();
      lineLayer.clearLayers();
      resetCurrentLine();
    });

    let clickTimer = null;

    function addLinePoint(latlng) {
      currentPoints.push(latlng);
      const dot = L.circleMarker(latlng, { radius: 4, color: LINE_COLORS[activeTool], fillOpacity: 1 }).addTo(map);
      vertexMarkers.push(dot);
      if (currentPoints.length >= 2) updatePreviewLine(LINE_COLORS[activeTool]);
    }

    map.on('click', (e) => {
      if (activeTool === 'manholeBlue' || activeTool === 'manholeGreen') {
        const marker = L.marker(e.latlng, { icon: manholeIcons[activeTool] }).addTo(manholeLayer);
        makeDeletable(marker, manholeLayer);
      } else if (activeTool === 'blue' || activeTool === 'green') {
        // Delay the point add so a following dblclick (to finish the line)
        // can cancel it instead of adding a spurious final vertex.
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => addLinePoint(e.latlng), 250);
      }
    });

    map.on('dblclick', () => {
      if (activeTool === 'blue' || activeTool === 'green') {
        clearTimeout(clickTimer);
        finishLine();
      }
    });

    mapInstance = map;
    outsideClickHandlerRef = outsideClickHandler;
    })();

    return () => {
      if (outsideClickHandlerRef) document.removeEventListener('click', outsideClickHandlerRef);
      if (mapInstance) mapInstance.remove();
    };
  }, []);

  return (
    <>
      <div id="searchBox">
        <input id="searchInput" type="text" placeholder="Search address or postal code..." autoComplete="off" />
        <div id="searchResults"></div>
      </div>
      <div id="panel">
        <label><input type="checkbox" id="toggleLandLot" defaultChecked /> Land lot lines</label>
      </div>
      <div id="drawToolbar">
        <button id="toolManholeBlue" data-tool="manholeBlue">
          <svg className="swatch" viewBox="0 0 20 20"><rect x="2" y="2" width="16" height="16" rx="3" fill="none" stroke="#1e6fff" strokeWidth="2" /><line x1="3" y1="17" x2="17" y2="3" stroke="#1e6fff" strokeWidth="2" /></svg>
          Existing manhole
        </button>
        <button id="toolManholeGreen" data-tool="manholeGreen">
          <svg className="swatch" viewBox="0 0 20 20"><rect x="2" y="2" width="16" height="16" rx="3" fill="none" stroke="#22a94c" strokeWidth="2" /><line x1="3" y1="17" x2="17" y2="3" stroke="#22a94c" strokeWidth="2" /></svg>
          New manhole
        </button>
        <div className="toolbar-divider"></div>
        <button id="toolBlue" data-tool="blue">
          <span className="swatch" style={{ background: '#1e6fff' }}></span>
          Existing infra
        </button>
        <button id="toolGreen" data-tool="green">
          <span className="swatch" style={{ background: '#22a94c' }}></span>
          New infra
        </button>
        <div className="toolbar-divider"></div>
        <button id="toolDelete" data-tool="delete">
          <span className="swatch" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#d11' }}>✕</span>
          Delete
        </button>
        <div className="toolbar-divider"></div>
        <button id="finishLine">Finish line</button>
        <button id="clearAll">Clear all</button>
        <button id="exportPdf" onClick={handleExportPdf}>Export PDF</button>
      </div>
      <div id="map"></div>
    </>
  );
}
