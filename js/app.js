// =============================================
// GPX TRACKER - Progressive Web App
// Standalone application logic
// =============================================

// --- Constants ---
const DB_NAME = 'gpx-tracker-db';
const DB_VERSION = 1;
const STORE_NAME = 'tracks';

// --- Global State ---
let chart, map, mapMarker, mapPolyline;
let parsedData = null;
let fileContent = '';
let fileName = '';
let deferredPrompt = null;


// =============================================
// 1. DATABASE (IndexedDB)
// =============================================

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveTrackToDB(track) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).add(track);
    req.onsuccess = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllTracks() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result.reverse());
    req.onerror = () => reject(req.error);
  });
}

async function deleteTrackFromDB(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}


// =============================================
// 2. GPX PARSER
// =============================================

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseGPX(text) {
  const xmlDoc = new DOMParser().parseFromString(text, 'text/xml');
  
  // Check for XML parse errors
  const parseError = xmlDoc.getElementsByTagName('parsererror');
  if (parseError.length > 0) {
    throw new Error('El archivo no es un XML válido');
  }
  
  const trkpts = xmlDoc.getElementsByTagName('trkpt');
  if (trkpts.length === 0) {
    throw new Error('GPX inválido: no se encontraron puntos de track');
  }

  // Get track name
  const nameTag = xmlDoc.getElementsByTagName('name')[0];
  const trackName = nameTag ? nameTag.textContent.trim() : (fileName ? fileName.replace('.gpx', '') : 'Sin nombre');

  let points = [];
  let totalDist = 0;
  let gain = 0;
  let loss = 0;

  for (let i = 0; i < trkpts.length; i++) {
    const lat = parseFloat(trkpts[i].getAttribute('lat'));
    const lon = parseFloat(trkpts[i].getAttribute('lon'));
    const eleNode = trkpts[i].getElementsByTagName('ele')[0];
    const ele = eleNode ? parseFloat(eleNode.textContent) : 0;

    if (i > 0) {
      totalDist += haversineDistance(points[i - 1].lat, points[i - 1].lon, lat, lon);
      const diff = ele - points[i - 1].ele;
      if (diff > 0) gain += diff;
      else loss += Math.abs(diff);
    }
    points.push({ lat, lon, ele, distance: totalDist });
  }

  return {
    nombre: trackName,
    puntos: points,
    distancia: parseFloat(totalDist.toFixed(2)),
    desnivelPositivo: Math.round(gain),
    desnivelNegativo: Math.round(loss),
    altitudMax: Math.round(Math.max(...points.map(p => p.ele))),
    altitudMin: Math.round(Math.min(...points.map(p => p.ele)))
  };
}


// =============================================
// 3. MAP (Leaflet)
// =============================================

function initMap() {
  map = L.map('map', {
    zoomControl: true,
    attributionControl: true
  }).setView([40.4167, -3.7033], 6);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
    maxZoom: 19
  }).addTo(map);

  mapMarker = L.circleMarker([0, 0], {
    radius: 7,
    color: '#2563eb',
    fillColor: '#ffffff',
    fillOpacity: 1,
    weight: 3
  }).addTo(map);
}

function updateMap(points) {
  const latLngs = points.map(p => [p.lat, p.lon]);
  if (mapPolyline) map.removeLayer(mapPolyline);

  mapPolyline = L.polyline(latLngs, {
    color: '#ef4444',
    weight: 4,
    opacity: 0.85
  }).addTo(map);

  map.fitBounds(mapPolyline.getBounds(), { padding: [30, 30] });

  // Add start and end markers
  const startIcon = L.divIcon({
    html: '<div style="background:#10b981;color:white;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:11px;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3);">A</div>',
    className: '',
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });

  const endIcon = L.divIcon({
    html: '<div style="background:#ef4444;color:white;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:11px;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3);">B</div>',
    className: '',
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });

  // Remove previous start/end markers
  if (window._startMarker) map.removeLayer(window._startMarker);
  if (window._endMarker) map.removeLayer(window._endMarker);

  window._startMarker = L.marker(latLngs[0], { icon: startIcon }).addTo(map);
  window._endMarker = L.marker(latLngs[latLngs.length - 1], { icon: endIcon }).addTo(map);
}

function updateMarkerFromChart(dist) {
  if (!parsedData) return;
  const p = parsedData.puntos.reduce((prev, curr) =>
    Math.abs(curr.distance - dist) < Math.abs(prev.distance - dist) ? curr : prev
  );
  mapMarker.setLatLng([p.lat, p.lon]);
}


// =============================================
// 4. CHART (ECharts)
// =============================================

function initChart() {
  chart = echarts.init(document.getElementById('chartContainer'));
  window.addEventListener('resize', () => chart.resize());
}

function getSlopeColor(slope) {
  if (slope > 20) return '#171717';      // Black - Wall (>20%)
  if (slope > 15) return '#881337';      // Maroon - Steep wall (15-20%)
  if (slope > 10) return '#dc2626';      // Red - Hard climb (10-15%)
  if (slope > 6)  return '#ea580c';      // Orange - Demanding (6-10%)
  if (slope > 3)  return '#eab308';      // Yellow - Gentle (3-6%)
  if (slope >= 0) return '#10b981';      // Green - Flat (0-3%)
  return '#3b82f6';                      // Blue - Descent (<0%)
}

function renderChart() {
  const interval = parseFloat(document.getElementById('intervalSize').value);
  const points = parsedData.puntos;
  const maxDist = points[points.length - 1].distance;

  // Build interval sample points
  let intervals = [];
  for (let d = 0; d <= maxDist; d += interval) {
    let p = points.reduce((prev, curr) =>
      Math.abs(curr.distance - d) < Math.abs(prev.distance - d) ? curr : prev
    );
    intervals.push(p);
  }
  if (intervals[intervals.length - 1].distance < maxDist) {
    intervals.push(points[points.length - 1]);
  }

  // Calculate slope for each interval
  let pieces = [];
  let markAreas = [];

  for (let i = 0; i < intervals.length - 1; i++) {
    const run = intervals[i + 1].distance - intervals[i].distance;
    const rise = intervals[i + 1].ele - intervals[i].ele;
    const slope = (rise / (run * 1000)) * 100;
    const color = getSlopeColor(slope);

    pieces.push({
      gt: intervals[i].distance,
      lte: intervals[i + 1].distance,
      color: color
    });

    markAreas.push([
      {
        name: slope.toFixed(1) + '%',
        xAxis: intervals[i].distance,
        label: {
          show: true,
          position: 'top',
          fontSize: 9,
          fontWeight: 'bold',
          color: '#333'
        }
      },
      { xAxis: intervals[i + 1].distance }
    ]);
  }

  // Render chart
  chart.setOption({
    grid: { left: '12%', right: '5%', bottom: '15%', top: '10%' },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(255, 255, 255, 0.95)',
      borderColor: '#e2e8f0',
      textStyle: { fontSize: 12, fontFamily: 'Inter' },
      formatter: (params) => {
        const d = params[0].value[0];
        updateMarkerFromChart(d);
        return `<b>Dist.:</b> ${d.toFixed(2)} km<br><b>Alt.:</b> ${params[0].value[1].toFixed(0)} m`;
      }
    },
    xAxis: {
      type: 'value',
      name: 'km',
      splitLine: { show: false },
      axisLabel: { fontSize: 10, fontFamily: 'Inter' }
    },
    yAxis: {
      type: 'value',
      name: 'm',
      scale: true,
      axisLabel: { fontSize: 10, fontFamily: 'Inter' }
    },
    dataZoom: [
      { type: 'slider', bottom: 5, height: 20 },
      { type: 'inside' }
    ],
    visualMap: {
      show: false,
      type: 'piecewise',
      dimension: 0,
      pieces: pieces
    },
    series: [{
      type: 'line',
      data: points.map(p => [p.distance, p.ele]),
      symbol: 'none',
      smooth: true,
      lineStyle: { width: 2, color: '#333' },
      areaStyle: { opacity: 0.8 },
      markArea: { silent: true, data: markAreas }
    }]
  }, true);
}


// =============================================
// 5. FILE HANDLING & DISPLAY
// =============================================

function processAndDisplay(gpxText, name) {
  try {
    parsedData = parseGPX(gpxText);
    fileContent = gpxText;
    if (name) fileName = name;

    // Update stats UI
    document.getElementById('trackName').textContent = parsedData.nombre;
    document.getElementById('valDist').textContent = parsedData.distancia.toFixed(2) + ' km';
    document.getElementById('valEle').textContent = parsedData.desnivelPositivo + ' m';
    document.getElementById('valEleDown').textContent = parsedData.desnivelNegativo + ' m';
    document.getElementById('valAltMax').textContent = parsedData.altitudMax + ' m';
    document.getElementById('valAltMin').textContent = parsedData.altitudMin + ' m';

    // Show containers
    document.getElementById('statusContainer').classList.remove('hidden');
    document.getElementById('noDataMessage').classList.add('hidden');
    document.getElementById('slopeLegend').classList.remove('hidden');
    document.getElementById('btnGuardar').disabled = false;

    // Render map and chart
    updateMap(parsedData.puntos);
    renderChart();
  } catch (err) {
    alert('Error procesando GPX: ' + err.message);
  }
}

function handleFileSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  fileName = file.name;
  const reader = new FileReader();
  reader.onload = (evt) => processAndDisplay(evt.target.result, file.name);
  reader.readAsText(file);
}


// =============================================
// 6. TRACK SAVE / HISTORY
// =============================================

async function saveCurrentTrack() {
  if (!parsedData || !fileContent) return;

  const btn = document.getElementById('btnGuardar');
  const status = document.getElementById('saveStatus');
  btn.disabled = true;
  status.className = 'text-xs font-bold text-blue-600 animate-pulse h-4';
  status.textContent = 'Guardando...';

  try {
    await saveTrackToDB({
      fecha: new Date().toISOString(),
      nombre: parsedData.nombre,
      distancia: parsedData.distancia,
      desnivelPositivo: parsedData.desnivelPositivo,
      desnivelNegativo: parsedData.desnivelNegativo,
      altitudMax: parsedData.altitudMax,
      altitudMin: parsedData.altitudMin,
      gpxContent: fileContent
    });

    status.className = 'text-xs font-bold text-green-600 h-4';
    status.textContent = '✓ Guardado';
    btn.disabled = false;

    // Auto-clear status after 3s
    setTimeout(() => { status.textContent = ''; }, 3000);
  } catch (err) {
    status.className = 'text-xs font-bold text-red-600 h-4';
    status.textContent = '✕ Error';
    btn.disabled = false;
  }
}

async function loadHistory() {
  const tbody = document.getElementById('tablaHistorial');
  const statsContainer = document.getElementById('historialStats');

  tbody.innerHTML = `
    <tr><td colspan="5" class="px-4 py-6 text-center text-blue-600 font-bold animate-pulse">
      Cargando...
    </td></tr>`;

  try {
    const tracks = await getAllTracks();

    if (tracks.length === 0) {
      statsContainer.classList.add('hidden');
      tbody.innerHTML = `
        <tr><td colspan="5" class="px-4 py-12 text-center text-gray-400">
          <svg class="w-12 h-12 mx-auto mb-3 text-gray-200" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/>
          </svg>
          <p class="font-bold">No hay tracks guardados</p>
          <p class="text-xs mt-1">Analiza y guarda tu primera ruta</p>
        </td></tr>`;
      return;
    }

    // Calculate totals
    const totalKm = tracks.reduce((sum, t) => sum + t.distancia, 0);
    const totalDplus = tracks.reduce((sum, t) => sum + t.desnivelPositivo, 0);

    statsContainer.classList.remove('hidden');
    statsContainer.querySelector('div').innerHTML = `
      <div class="text-center">
        <p class="text-[10px] text-gray-400 font-bold uppercase tracking-wider">Tracks</p>
        <p class="font-extrabold text-xl text-gray-800">${tracks.length}</p>
      </div>
      <div class="text-center">
        <p class="text-[10px] text-gray-400 font-bold uppercase tracking-wider">Km totales</p>
        <p class="font-extrabold text-xl text-blue-600">${totalKm.toFixed(1)}</p>
      </div>
      <div class="text-center">
        <p class="text-[10px] text-gray-400 font-bold uppercase tracking-wider">Desnivel total</p>
        <p class="font-extrabold text-xl text-emerald-600">${totalDplus.toLocaleString('es-ES')} m</p>
      </div>`;

    // Render table rows
    tbody.innerHTML = '';
    tracks.forEach(t => {
      const fecha = new Date(t.fecha);
      const fechaStr = fecha.toLocaleDateString('es-ES', {
        day: '2-digit', month: '2-digit', year: 'numeric'
      });

      const tr = document.createElement('tr');
      tr.className = 'hover:bg-blue-50/60 cursor-pointer transition-colors group';
      tr.innerHTML = `
        <td class="px-4 py-3 whitespace-nowrap text-gray-400 text-xs">${fechaStr}</td>
        <td class="px-4 py-3 font-semibold text-gray-900 group-hover:text-blue-600 transition-colors">${escapeHtml(t.nombre)}</td>
        <td class="px-4 py-3 whitespace-nowrap text-right text-blue-600 font-bold tabular-nums">${t.distancia.toFixed(2)}</td>
        <td class="px-4 py-3 whitespace-nowrap text-right text-emerald-600 font-bold tabular-nums">${t.desnivelPositivo} m</td>
        <td class="px-4 py-3 whitespace-nowrap text-center">
          <div class="flex items-center justify-center gap-1">
            <button class="btn-reanalyze p-1.5 text-gray-300 hover:text-blue-600 transition-colors rounded-lg hover:bg-blue-50" title="Analizar de nuevo">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>
            </button>
            <button class="btn-download p-1.5 text-gray-300 hover:text-emerald-600 transition-colors rounded-lg hover:bg-emerald-50" title="Descargar GPX">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
            </button>
            <button class="btn-delete p-1.5 text-gray-300 hover:text-red-600 transition-colors rounded-lg hover:bg-red-50" title="Eliminar">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
            </button>
          </div>
        </td>`;

      // Click row to re-analyze
      tr.addEventListener('click', (e) => {
        if (e.target.closest('.btn-download') || e.target.closest('.btn-delete') || e.target.closest('.btn-reanalyze')) return;
        reanalyzeTrack(t);
      });

      // Re-analyze button
      tr.querySelector('.btn-reanalyze').addEventListener('click', (e) => {
        e.stopPropagation();
        reanalyzeTrack(t);
      });

      // Download button
      tr.querySelector('.btn-download').addEventListener('click', (e) => {
        e.stopPropagation();
        downloadGPX(t.gpxContent, t.nombre + '.gpx');
      });

      // Delete button
      tr.querySelector('.btn-delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`¿Eliminar "${t.nombre}"?`)) {
          await deleteTrackFromDB(t.id);
          loadHistory();
        }
      });

      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `
      <tr><td colspan="5" class="px-4 py-6 text-center text-red-500 font-bold">
        Error al cargar el historial
      </td></tr>`;
  }
}

function reanalyzeTrack(track) {
  processAndDisplay(track.gpxContent, track.nombre + '.gpx');
  switchToTab('analizar');
}

function downloadGPX(content, filename) {
  const blob = new Blob([content], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}


// =============================================
// 7. TAB NAVIGATION
// =============================================

function switchToTab(tab) {
  const btnA = document.getElementById('tabAnalizar');
  const btnH = document.getElementById('tabHistorial');
  const btnC = document.getElementById('tabCrear');
  const vistaA = document.getElementById('vistaAnalizar');
  const vistaH = document.getElementById('vistaHistorial');
  const vistaC = document.getElementById('vistaCrear');

  const activeClass = 'px-4 py-1.5 text-sm font-bold rounded-md bg-blue-600 text-white transition-all duration-200';
  const inactiveClass = 'px-4 py-1.5 text-sm font-bold rounded-md text-gray-300 hover:text-white hover:bg-slate-600 transition-all duration-200';

  // Hide all views, deactivate all buttons
  vistaA.classList.add('hidden');
  vistaH.classList.add('hidden');
  vistaC.classList.add('hidden');
  btnA.className = inactiveClass;
  btnH.className = inactiveClass;
  btnC.className = inactiveClass;

  if (tab === 'analizar') {
    vistaA.classList.remove('hidden');
    btnA.className = activeClass;
    // Recalculate map/chart sizes after tab switch
    setTimeout(() => {
      if (chart) chart.resize();
      if (map) map.invalidateSize();
    }, 150);
  } else if (tab === 'historial') {
    vistaH.classList.remove('hidden');
    btnH.className = activeClass;
    loadHistory();
  } else if (tab === 'crear') {
    vistaC.classList.remove('hidden');
    btnC.className = activeClass;
    // Lazy-init creator map
    if (typeof initCreator === 'function') {
      setTimeout(() => initCreator(), 150);
    }
  }
}


// =============================================
// 8. PWA INSTALL
// =============================================

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  document.getElementById('installBanner').classList.remove('hidden');
});

window.addEventListener('appinstalled', () => {
  document.getElementById('installBanner').classList.add('hidden');
  deferredPrompt = null;
});

function installApp() {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  deferredPrompt.userChoice.then(() => {
    document.getElementById('installBanner').classList.add('hidden');
    deferredPrompt = null;
  });
}

// Register Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('Service Worker registrado:', reg.scope))
      .catch(err => console.warn('Service Worker error:', err));
  });
}


// =============================================
// 9. INITIALIZATION
// =============================================

document.addEventListener('DOMContentLoaded', () => {
  // Initialize map and chart
  initMap();
  initChart();

  // File input
  document.getElementById('gpxFile').addEventListener('change', handleFileSelect);

  // Interval change
  document.getElementById('intervalSize').addEventListener('change', () => {
    if (parsedData) renderChart();
  });

  // Save button
  document.getElementById('btnGuardar').addEventListener('click', saveCurrentTrack);

  // Tab navigation
  document.getElementById('tabAnalizar').addEventListener('click', () => switchToTab('analizar'));
  document.getElementById('tabHistorial').addEventListener('click', () => switchToTab('historial'));
  document.getElementById('tabCrear').addEventListener('click', () => switchToTab('crear'));

  // PWA install buttons
  const installBtn = document.getElementById('btnInstall');
  const dismissBtn = document.getElementById('btnDismiss');
  if (installBtn) installBtn.addEventListener('click', installApp);
  if (dismissBtn) dismissBtn.addEventListener('click', () => {
    document.getElementById('installBanner').classList.add('hidden');
  });

  // Handle drag and drop
  const body = document.body;
  body.addEventListener('dragover', (e) => {
    e.preventDefault();
    body.classList.add('ring-4', 'ring-blue-400', 'ring-inset');
  });

  body.addEventListener('dragleave', () => {
    body.classList.remove('ring-4', 'ring-blue-400', 'ring-inset');
  });

  body.addEventListener('drop', (e) => {
    e.preventDefault();
    body.classList.remove('ring-4', 'ring-blue-400', 'ring-inset');
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith('.gpx')) {
      fileName = file.name;
      const reader = new FileReader();
      reader.onload = (evt) => processAndDisplay(evt.target.result, file.name);
      reader.readAsText(file);
    }
  });
});
