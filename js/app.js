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
// =============================================
// CLOUD SYNC & DATABASE (IndexedDB + Cloud JSON)
// =============================================

const CLOUD_SYNC_URL = 'https://jsonblob.com/api/jsonBlob/019fa81c-49e9-74ad-b47a-76d7a51000c1';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function generateGPXFromPoints(name, points) {
  if (!points || !Array.isArray(points) || points.length === 0) return '';
  const safeName = (name || 'Ruta').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="GPX Tracker">\n  <trk>\n    <name>${safeName}</name>\n    <trkseg>\n`;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p) continue;
    let lat, lon, ele;
    if (Array.isArray(p)) {
      lat = p[0];
      lon = p[1];
      ele = p[2] !== undefined ? p[2] : 0;
    } else {
      lat = p.lat !== undefined ? p.lat : p[0];
      lon = p.lon !== undefined ? p.lon : (p.lng !== undefined ? p.lng : p[1]);
      ele = p.ele !== undefined ? p.ele : (p[2] !== undefined ? p[2] : 0);
    }
    if (isNaN(lat) || isNaN(lon)) continue;
    xml += `      <trkpt lat="${lat}" lon="${lon}"><ele>${ele}</ele></trkpt>\n`;
  }
  xml += `    </trkseg>\n  </trk>\n</gpx>`;
  return xml;
}

function extractPointsFromGPX(gpxXml) {
  if (!gpxXml || typeof gpxXml !== 'string') return [];
  const pts = [];
  const latRegex = /lat=["']([^"']+)["']/i;
  const lonRegex = /lon=["']([^"']+)["']/i;
  const eleRegex = /<ele>([^<]+)<\/ele>/i;

  const trkpts = gpxXml.split(/<\/trkpt>/i);
  for (const block of trkpts) {
    const latM = block.match(latRegex);
    const lonM = block.match(lonRegex);
    const eleM = block.match(eleRegex);
    if (latM && lonM) {
      const lat = parseFloat(latM[1]);
      const lon = parseFloat(lonM[1]);
      const ele = eleM ? parseFloat(eleM[1]) : 0;
      if (!isNaN(lat) && !isNaN(lon)) {
        pts.push([Number(lat.toFixed(5)), Number(lon.toFixed(5)), Math.round(ele || 0)]);
      }
    }
  }
  return pts;
}

function prepareTrackForCloud(t) {
  const copy = { ...t, inCloud: true };

  // 1. Extract points if missing or empty
  if ((!copy.points || copy.points.length === 0) && copy.gpxContent) {
    copy.points = extractPointsFromGPX(copy.gpxContent);
  }

  // 2. Clean up whitespace / compress heavy XML
  if (copy.gpxContent && typeof copy.gpxContent === 'string') {
    if (copy.gpxContent.length > 40000 && copy.points && copy.points.length > 0) {
      delete copy.gpxContent;
    } else {
      copy.gpxContent = copy.gpxContent.replace(/>\s+</g, '><').trim();
    }
  }

  delete copy.puntos;
  return copy;
}

function restoreCloudTrack(t) {
  const track = { ...t, inCloud: true };
  const pts = track.points || track.puntos;

  // Rebuild gpxContent if missing or invalid
  if (!track.gpxContent || !track.gpxContent.includes('<trkpt')) {
    if (pts && Array.isArray(pts) && pts.length > 0) {
      track.gpxContent = generateGPXFromPoints(track.nombre, pts);
    }
  }
  return track;
}

async function getCloudTracks() {
  try {
    const res = await fetch(CLOUD_SYNC_URL + '?t=' + Date.now(), {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      cache: 'no-store'
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data.tracks)) return null;

    // Restore full track objects with generated GPX XML content
    return data.tracks.map(t => restoreCloudTrack(t));
  } catch (err) {
    console.warn('Cloud sync fetch warning:', err);
    return null;
  }
}

async function syncTracksToCloud(tracksArray) {
  if (!tracksArray || tracksArray.length === 0) return true;

  try {
    const cloudPayload = tracksArray.map(t => prepareTrackForCloud(t));

    const res = await fetch(CLOUD_SYNC_URL, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ tracks: cloudPayload })
    });

    if (res.ok) {
      // ONLY if HTTP PUT succeeded (200 OK), update local IndexedDB records with inCloud: true
      for (const t of tracksArray) {
        if (t && t.id) {
          await saveTrackToLocalDB({ ...t, inCloud: true });
        }
      }
      return true;
    } else {
      console.error('Cloud sync PUT failed with status:', res.status, res.statusText);
      return false;
    }
  } catch (err) {
    console.error('Cloud sync save error:', err);
    return false;
  }
}

async function forceSyncAllToCloud() {
  const syncStatus = document.getElementById('cloudSyncStatus');
  const btn = document.getElementById('btnForceSync');
  if (btn) btn.disabled = true;

  if (syncStatus) {
    syncStatus.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-blue-50 text-blue-700 border border-blue-200 animate-pulse';
    syncStatus.innerHTML = `<span>⏳ Subiendo rutas a la nube...</span>`;
  }

  try {
    const localTracks = await getLocalTracks();
    const cloudTracks = await getCloudTracks();
    const mergedTracks = mergeTracks(localTracks, cloudTracks || []);

    const ok = await syncTracksToCloud(mergedTracks);

    if (ok) {
      const freshLocal = await getLocalTracks();
      renderHistoryTable(freshLocal);

      if (syncStatus) {
        syncStatus.className = 'inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200';
        syncStatus.innerHTML = `<span>✓ ${freshLocal.length} rutas subidas</span>`;
      }
    } else {
      if (syncStatus) {
        syncStatus.className = 'inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-red-50 text-red-700 border border-red-200';
        syncStatus.innerHTML = `<span>✕ Error al subir</span>`;
      }
      alert('Error: El servidor no pudo recibir las rutas. Comprueba tu conexión a Internet.');
    }
  } catch (err) {
    alert('Error al forzar la subida a la nube: ' + err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function saveTrackToLocalDB(track) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(track);
    req.onsuccess = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}

async function getLocalTracks() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result.reverse());
    req.onerror = () => reject(req.error);
  });
}

async function getAllTracks() {
  // 1. Try to fetch latest tracks from cloud
  const cloudTracks = await getCloudTracks();
  if (cloudTracks !== null) {
    // Save/cache all cloud tracks into IndexedDB
    for (const t of cloudTracks) {
      if (t && t.id) await saveTrackToLocalDB(t);
    }
    return cloudTracks;
  }

  // 2. Fallback to local IndexedDB if offline
  return getLocalTracks();
}

async function saveTrackToDB(track) {
  if (!track.id) {
    track.id = Date.now() + Math.floor(Math.random() * 1000);
  }

  // Save to local IndexedDB
  await saveTrackToLocalDB(track);

  // Sync current list of tracks to Cloud
  try {
    const allLocal = await getLocalTracks();
    await syncTracksToCloud(allLocal);
  } catch (e) {
    console.warn('Error pushing to cloud sync:', e);
  }
}

async function deleteTrackFromDB(id) {
  const targetId = (typeof id === 'string' && !isNaN(id)) ? Number(id) : id;

  // 1. Delete from local IndexedDB (try both Number and String key types)
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(targetId);
    store.delete(String(targetId));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  // 2. Get remaining local tracks
  const remaining = await getLocalTracks();

  // 3. Overwrite cloud payload with remaining tracks
  try {
    const cloudPayload = remaining.map(t => prepareTrackForCloud(t));
    await fetch(CLOUD_SYNC_URL, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ tracks: cloudPayload })
    });
  } catch (e) {
    console.warn('Error syncing deletion to cloud:', e);
  }

  // 4. Re-render table
  renderHistoryTable(remaining);
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
  const safeFileName = (typeof fileName !== 'undefined' && fileName) ? fileName.replace('.gpx', '') : 'Sin nombre';
  const trackName = nameTag ? nameTag.textContent.trim() : safeFileName;

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
    points: points,
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

  const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
    maxZoom: 19
  });

  const satLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; Esri',
    maxZoom: 19
  });

  osmLayer.addTo(map);

  L.control.layers({
    '🗺️ Mapa': osmLayer,
    '🛰️ Satélite': satLayer
  }, null, { position: 'topright' }).addTo(map);

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

    await loadHistory();

    status.className = 'text-xs font-bold text-green-600 h-4';
    status.textContent = '✓ Guardado';
  } catch (err) {
    status.className = 'text-xs font-bold text-red-600 h-4';
    status.textContent = '✕ Error';
    btn.disabled = false;
  }
}

function renderHistoryTable(tracks) {
  const tbody = document.getElementById('tablaHistorial');
  const statsContainer = document.getElementById('historialStats');
  if (!tbody) return;

  if (!tracks || tracks.length === 0) {
    if (statsContainer) statsContainer.classList.add('hidden');
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
  const totalKm = tracks.reduce((sum, t) => sum + (t.distancia || 0), 0);
  const totalDplus = tracks.reduce((sum, t) => sum + (t.desnivelPositivo || 0), 0);

  if (statsContainer) {
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
  }

  // Render table rows
  tbody.innerHTML = '';
  tracks.forEach(t => {
    const fecha = new Date(t.fecha);
    const fechaStr = fecha.toLocaleDateString('es-ES', {
      day: '2-digit', month: '2-digit', year: 'numeric'
    });

    const cloudBadge = t.inCloud 
      ? `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-extrabold bg-blue-50 text-blue-600 border border-blue-200 shrink-0" title="Sincronizado en la nube">☁️ Nube</span>`
      : `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-extrabold bg-gray-100 text-gray-500 border border-gray-200 shrink-0" title="Guardado solo en este dispositivo">📱 Local</span>`;

    const tr = document.createElement('tr');
    tr.className = 'hover:bg-blue-50/60 cursor-pointer transition-colors group';
    tr.innerHTML = `
      <td class="px-4 py-3 whitespace-nowrap text-gray-400 text-xs">${fechaStr}</td>
      <td class="px-4 py-3 font-semibold text-gray-900 group-hover:text-blue-600 transition-colors">
        <div class="flex items-center justify-between gap-2">
          <span>${escapeHtml(t.nombre)}</span>
          ${cloudBadge}
        </div>
      </td>
      <td class="px-4 py-3 whitespace-nowrap text-right text-blue-600 font-bold tabular-nums">${(t.distancia || 0).toFixed(2)}</td>
      <td class="px-4 py-3 whitespace-nowrap text-right text-emerald-600 font-bold tabular-nums">+${(t.desnivelPositivo || 0).toLocaleString('es-ES')}m</td>
      <td class="px-4 py-3 whitespace-nowrap text-center text-xs">
        <div class="flex items-center justify-center gap-1.5">
          <button class="btn-edit p-1.5 text-amber-600 hover:text-amber-700 hover:bg-amber-50 rounded transition-colors" title="Editar en Creador">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
            </svg>
          </button>
          <button class="btn-reanalyze p-1.5 text-blue-600 hover:text-blue-700 hover:bg-blue-50 rounded transition-colors" title="Ver análisis">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          </button>
          <button class="btn-download p-1.5 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 rounded transition-colors" title="Descargar GPX">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          </button>
          <button class="btn-delete p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors" title="Eliminar">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </td>`;

    // Listeners
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.btn-download') || e.target.closest('.btn-delete') || e.target.closest('.btn-reanalyze') || e.target.closest('.btn-edit')) return;
      reanalyzeTrack(t);
    });

    tr.querySelector('.btn-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof editTrackInCreator === 'function') editTrackInCreator(t);
    });

    tr.querySelector('.btn-reanalyze').addEventListener('click', (e) => {
      e.stopPropagation();
      reanalyzeTrack(t);
    });

    tr.querySelector('.btn-download').addEventListener('click', (e) => {
      e.stopPropagation();
      downloadGPX(t.gpxContent, t.nombre + '.gpx');
    });

    tr.querySelector('.btn-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`¿Eliminar "${t.nombre}"?`)) {
        await deleteTrackFromDB(t.id);
        loadHistory();
      }
    });

    tbody.appendChild(tr);
  });
}

function mergeTracks(localList, cloudList) {
  const trackMap = new Map();
  (localList || []).forEach(t => { if (t && t.id) trackMap.set(t.id, t); });
  (cloudList || []).forEach(t => { 
    if (t && t.id) {
      const existing = trackMap.get(t.id);
      trackMap.set(t.id, { ...(existing || {}), ...t, inCloud: true });
    }
  });

  const merged = Array.from(trackMap.values());
  merged.sort((a, b) => new Date(b.fecha || 0) - new Date(a.fecha || 0));
  return merged;
}

async function loadHistory() {
  const syncStatus = document.getElementById('cloudSyncStatus');

  // 1. Instantly render local tracks first (0 delay!)
  let localTracks = [];
  try {
    localTracks = await getLocalTracks();
    renderHistoryTable(localTracks);
  } catch (err) {
    console.warn('Error loading local tracks:', err);
  }

  // 2. Show syncing status badge
  if (syncStatus) {
    syncStatus.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200 animate-pulse';
    syncStatus.innerHTML = `
      <svg class="animate-spin w-3 h-3 text-amber-600" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
      </svg>
      <span>Sincronizando...</span>`;
  }

  // 3. Fetch cloud tracks in background and MERGE
  try {
    const cloudTracks = await getCloudTracks();
    if (cloudTracks !== null) {
      const mergedTracks = mergeTracks(localTracks, cloudTracks);

      for (const t of mergedTracks) {
        if (t && t.id) await saveTrackToLocalDB(t);
      }

      // Sync combined list to cloud
      await syncTracksToCloud(mergedTracks);

      renderHistoryTable(mergedTracks);

      if (syncStatus) {
        syncStatus.className = 'inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200';
        syncStatus.innerHTML = `<span>☁️ Sincronizado</span>`;
      }
    } else {
      if (syncStatus) {
        syncStatus.className = 'inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-gray-100 text-gray-600 border border-gray-200';
        syncStatus.innerHTML = `<span>📱 Modo local</span>`;
      }
    }
  } catch (err) {
    if (syncStatus) {
      syncStatus.className = 'inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-gray-100 text-gray-600 border border-gray-200';
      syncStatus.innerHTML = `<span>📱 Modo local</span>`;
    }
  }
}

function ensureValidGPXContent(track) {
  if (!track) return '';

  // 1. Check if gpxContent has valid <trkpt> tags
  if (track.gpxContent && typeof track.gpxContent === 'string' && track.gpxContent.includes('<trkpt')) {
    return track.gpxContent;
  }

  // 2. If track has points array, generate fresh valid GPX XML
  if (track.points && Array.isArray(track.points) && track.points.length > 0) {
    track.gpxContent = generateGPXFromPoints(track.nombre, track.points);
    return track.gpxContent;
  }

  return track.gpxContent || '';
}

function reanalyzeTrack(track) {
  const safeGPX = ensureValidGPXContent(track);
  if (!safeGPX || !safeGPX.includes('<trkpt')) {
    alert('No se pudieron recuperar los puntos de la ruta.');
    return;
  }
  processAndDisplay(safeGPX, track.nombre + '.gpx');
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

  const activeClass = 'px-2.5 py-1 text-xs sm:px-4 sm:py-1.5 sm:text-sm font-bold rounded-md bg-blue-600 text-white transition-all duration-200';
  const inactiveClass = 'px-2.5 py-1 text-xs sm:px-4 sm:py-1.5 sm:text-sm font-bold rounded-md text-gray-300 hover:text-white hover:bg-slate-600 transition-all duration-200';

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

  // Background auto-sync history
  setTimeout(() => loadHistory(), 300);

  // File input
  document.getElementById('gpxFile').addEventListener('change', handleFileSelect);

  // Interval change
  document.getElementById('intervalSize').addEventListener('change', () => {
    if (parsedData) renderChart();
  });

  // Save button
  document.getElementById('btnGuardar').addEventListener('click', saveCurrentTrack);

  // Force sync button
  const forceSyncBtn = document.getElementById('btnForceSync');
  if (forceSyncBtn) forceSyncBtn.addEventListener('click', forceSyncAllToCloud);

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
