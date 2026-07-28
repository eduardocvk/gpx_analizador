// =============================================
// GPX TRACKER - Track Creator Module
// Draws tracks on the map (manual or road-following)
// =============================================

// --- Creator State ---
const creator = {
  map: null,
  initialized: false,
  mode: 'road',                   // 'manual' | 'road'
  profile: 'cycling-road',
  apiKey: '',
  waypoints: [],                  // [{lat, lng}] user-placed points
  routeSegments: [],              // Arrays of [lat, lng, ele] between waypoints
  polyline: null,
  markers: [],
  midpointMarkers: [],
  undoStack: [],                  // Each entry: { waypoints, routeSegments } snapshot
  totalDistance: 0,
  isRouting: false                // Prevent double-clicks while routing
};

// =============================================
// 1. INITIALIZATION
// =============================================

function initCreator() {
  if (creator.initialized) {
    setTimeout(() => creator.map.invalidateSize(), 200);
    return;
  }

  // Load API key from localStorage
  creator.apiKey = localStorage.getItem('ors-api-key') || '';
  const keyInput = document.getElementById('orsApiKey');
  if (keyInput) keyInput.value = creator.apiKey;

  // Init map
  creator.map = L.map('mapCrear', {
    zoomControl: true,
    attributionControl: true
  }).setView([40.4167, -3.7033], 6);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
    maxZoom: 19
  }).addTo(creator.map);

  // Click handler
  creator.map.on('click', (e) => {
    if (creator.isRouting) return;
    addWaypoint(e.latlng);
  });

  // Setup event listeners
  setupCreatorEvents();

  creator.initialized = true;

  setTimeout(() => creator.map.invalidateSize(), 200);
}

function setupCreatorEvents() {
  // Mode toggle
  const modeToggle = document.getElementById('creatorModeToggle');
  if (modeToggle) {
    modeToggle.addEventListener('change', () => {
      creator.mode = modeToggle.checked ? 'road' : 'manual';
      document.getElementById('profileSelector').style.display =
        creator.mode === 'road' ? 'inline-block' : 'none';
      document.getElementById('apiKeyGroup').style.display =
        creator.mode === 'road' ? 'flex' : 'none';
    });
  }

  // Profile selector
  const profileSelect = document.getElementById('creatorProfile');
  if (profileSelect) {
    profileSelect.addEventListener('change', () => {
      creator.profile = profileSelect.value;
    });
  }

  // API key input
  const keyInput = document.getElementById('orsApiKey');
  if (keyInput) {
    keyInput.addEventListener('input', () => {
      creator.apiKey = keyInput.value.trim();
      localStorage.setItem('ors-api-key', creator.apiKey);
    });
  }

  // Buttons
  document.getElementById('btnUndo')?.addEventListener('click', undoLastAction);
  document.getElementById('btnReturnToStart')?.addEventListener('click', returnToStart);
  document.getElementById('btnClearTrack')?.addEventListener('click', clearCreatedTrack);
  document.getElementById('btnSaveCreated')?.addEventListener('click', saveCreatedTrack);
  document.getElementById('btnDownloadCreated')?.addEventListener('click', downloadCreatedTrack);

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const vistaCrear = document.getElementById('vistaCrear');
    if (vistaCrear && !vistaCrear.classList.contains('hidden')) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        undoLastAction();
      }
    }
  });
}


// =============================================
// 2. WAYPOINT MANAGEMENT
// =============================================

async function addWaypoint(latlng) {
  // Save snapshot for undo
  pushUndoState();

  creator.waypoints.push(latlng);

  if (creator.waypoints.length === 1) {
    // First point — just add marker
    addWaypointMarker(latlng, 0);
    updateCreatorStats();
    return;
  }

  const prevWp = creator.waypoints[creator.waypoints.length - 2];

  if (creator.mode === 'road') {
    if (!creator.apiKey) {
      alert('Introduce una API key de OpenRouteService para usar el modo carretera.');
      creator.waypoints.pop();
      creator.undoStack.pop();
      return;
    }

    creator.isRouting = true;
    showRoutingSpinner(true);

    try {
      const segment = await fetchRoute(prevWp, latlng);
      if (segment && segment.length > 0) {
        creator.routeSegments.push(segment);
        addWaypointMarker(latlng, creator.waypoints.length - 1);
        rebuildPolyline();
        updateMidpoints();
        updateCreatorStats();
      } else {
        // Routing failed, remove waypoint
        creator.waypoints.pop();
        creator.undoStack.pop();
      }
    } catch (err) {
      console.error('Routing error:', err);
      alert('Error al calcular la ruta: ' + err.message);
      creator.waypoints.pop();
      creator.undoStack.pop();
    } finally {
      creator.isRouting = false;
      showRoutingSpinner(false);
    }
  } else {
    // Manual mode — straight line
    creator.routeSegments.push([[prevWp.lat, prevWp.lng, 0], [latlng.lat, latlng.lng, 0]]);
    addWaypointMarker(latlng, creator.waypoints.length - 1);
    rebuildPolyline();
    updateMidpoints();
    updateCreatorStats();
  }
}

function addWaypointMarker(latlng, index) {
  const isFirst = index === 0;
  const color = isFirst ? '#10b981' : '#3b82f6';
  const label = isFirst ? 'A' : (index + 1).toString();

  const icon = L.divIcon({
    html: `<div style="background:${color};color:white;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:11px;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3);cursor:grab;">${label}</div>`,
    className: '',
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });

  const marker = L.marker(latlng, { icon, draggable: true }).addTo(creator.map);

  marker.on('dragend', async () => {
    pushUndoState();
    const newPos = marker.getLatLng();
    creator.waypoints[index] = newPos;
    await recalculateSegmentsAround(index);
  });

  creator.markers.push(marker);
}

function rebuildAllMarkers() {
  // Remove all markers
  creator.markers.forEach(m => creator.map.removeLayer(m));
  creator.markers = [];

  // Recreate
  creator.waypoints.forEach((wp, i) => addWaypointMarker(wp, i));
}


// =============================================
// 3. ROUTING (OpenRouteService)
// =============================================

async function fetchRoute(from, to) {
  const url = `https://api.openrouteservice.org/v2/directions/${creator.profile}?api_key=${creator.apiKey}&start=${from.lng},${from.lat}&end=${to.lng},${to.lat}&elevation=true`;

  const response = await fetch(url);

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error?.message || `HTTP ${response.status}`);
  }

  const data = await response.json();

  if (!data.features || data.features.length === 0) {
    throw new Error('No se encontró ruta');
  }

  const coords = data.features[0].geometry.coordinates;
  // ORS returns [lon, lat, ele] — convert to [lat, lon, ele]
  return coords.map(c => [c[1], c[0], c[2] || 0]);
}

async function recalculateSegmentsAround(index) {
  if (creator.mode === 'manual') {
    // Manual: rebuild simple segments
    if (index > 0) {
      const prev = creator.waypoints[index - 1];
      const curr = creator.waypoints[index];
      creator.routeSegments[index - 1] = [[prev.lat, prev.lng, 0], [curr.lat, curr.lng, 0]];
    }
    if (index < creator.waypoints.length - 1) {
      const curr = creator.waypoints[index];
      const next = creator.waypoints[index + 1];
      creator.routeSegments[index] = [[curr.lat, curr.lng, 0], [next.lat, next.lng, 0]];
    }
    rebuildPolyline();
    updateMidpoints();
    updateCreatorStats();
    return;
  }

  // Road mode: re-route affected segments
  creator.isRouting = true;
  showRoutingSpinner(true);

  try {
    if (index > 0) {
      const segment = await fetchRoute(creator.waypoints[index - 1], creator.waypoints[index]);
      if (segment) creator.routeSegments[index - 1] = segment;
    }
    if (index < creator.waypoints.length - 1) {
      const segment = await fetchRoute(creator.waypoints[index], creator.waypoints[index + 1]);
      if (segment) creator.routeSegments[index] = segment;
    }
    rebuildPolyline();
    updateMidpoints();
    updateCreatorStats();
  } catch (err) {
    console.error('Recalculate error:', err);
    alert('Error recalculando ruta: ' + err.message);
  } finally {
    creator.isRouting = false;
    showRoutingSpinner(false);
  }
}


// =============================================
// 4. POLYLINE & MIDPOINTS
// =============================================

function rebuildPolyline() {
  if (creator.polyline) creator.map.removeLayer(creator.polyline);

  const allPoints = getAllFlatPoints();
  if (allPoints.length < 2) {
    creator.polyline = null;
    return;
  }

  creator.polyline = L.polyline(allPoints.map(p => [p[0], p[1]]), {
    color: '#ef4444',
    weight: 4,
    opacity: 0.85
  }).addTo(creator.map);
}

function getAllFlatPoints() {
  const flat = [];
  for (let i = 0; i < creator.routeSegments.length; i++) {
    const seg = creator.routeSegments[i];
    for (let j = 0; j < seg.length; j++) {
      // Avoid duplicates at segment joins
      if (flat.length > 0 && j === 0) {
        const last = flat[flat.length - 1];
        if (Math.abs(last[0] - seg[0][0]) < 0.00001 && Math.abs(last[1] - seg[0][1]) < 0.00001) {
          continue;
        }
      }
      flat.push(seg[j]);
    }
  }
  return flat;
}

function updateMidpoints() {
  // Remove existing midpoints
  creator.midpointMarkers.forEach(m => creator.map.removeLayer(m));
  creator.midpointMarkers = [];

  if (creator.waypoints.length < 2) return;

  for (let i = 0; i < creator.waypoints.length - 1; i++) {
    const a = creator.waypoints[i];
    const b = creator.waypoints[i + 1];
    const midLat = (a.lat + b.lat) / 2;
    const midLng = (a.lng + b.lng) / 2;

    const ghostIcon = L.divIcon({
      html: '<div class="ghost-marker"></div>',
      className: '',
      iconSize: [16, 16],
      iconAnchor: [8, 8]
    });

    const midMarker = L.marker([midLat, midLng], {
      icon: ghostIcon,
      draggable: true,
      opacity: 0.7
    }).addTo(creator.map);

    const segIndex = i; // Capture for closure
    midMarker.on('dragend', async () => {
      pushUndoState();
      const newPos = midMarker.getLatLng();
      insertWaypointAt(segIndex + 1, newPos);
    });

    creator.midpointMarkers.push(midMarker);
  }
}

async function insertWaypointAt(index, latlng) {
  creator.waypoints.splice(index, 0, latlng);

  if (creator.mode === 'road' && creator.apiKey) {
    creator.isRouting = true;
    showRoutingSpinner(true);
    try {
      // Remove old segment and replace with two new routed segments
      const segBefore = await fetchRoute(creator.waypoints[index - 1], latlng);
      const segAfter = await fetchRoute(latlng, creator.waypoints[index + 1]);
      creator.routeSegments.splice(index - 1, 1, segBefore, segAfter);
    } catch (err) {
      console.error('Insert routing error:', err);
      alert('Error calculando ruta para el punto insertado: ' + err.message);
      // Rollback
      creator.waypoints.splice(index, 1);
      creator.isRouting = false;
      showRoutingSpinner(false);
      return;
    }
    creator.isRouting = false;
    showRoutingSpinner(false);
  } else {
    // Manual: replace segment with two straight lines
    const prev = creator.waypoints[index - 1];
    const next = creator.waypoints[index + 1];
    const segBefore = [[prev.lat, prev.lng, 0], [latlng.lat, latlng.lng, 0]];
    const segAfter = [[latlng.lat, latlng.lng, 0], [next.lat, next.lng, 0]];
    creator.routeSegments.splice(index - 1, 1, segBefore, segAfter);
  }

  rebuildAllMarkers();
  rebuildPolyline();
  updateMidpoints();
  updateCreatorStats();
}


// =============================================
// 5. UNDO
// =============================================

function pushUndoState() {
  creator.undoStack.push({
    waypoints: creator.waypoints.map(wp => L.latLng(wp.lat, wp.lng)),
    routeSegments: creator.routeSegments.map(seg => seg.map(p => [...p]))
  });

  // Limit undo stack
  if (creator.undoStack.length > 50) creator.undoStack.shift();
}

function undoLastAction() {
  if (creator.undoStack.length === 0) return;

  const state = creator.undoStack.pop();
  creator.waypoints = state.waypoints;
  creator.routeSegments = state.routeSegments;

  // Rebuild everything
  rebuildAllMarkers();
  rebuildPolyline();
  updateMidpoints();
  updateCreatorStats();
}


// =============================================
// 6. RETURN TO START
// =============================================

async function returnToStart() {
  if (creator.waypoints.length < 2) {
    alert('Necesitas al menos 2 puntos para crear el regreso.');
    return;
  }

  const lastWp = creator.waypoints[creator.waypoints.length - 1];
  const firstWp = creator.waypoints[0];

  // Check if already closed
  if (Math.abs(lastWp.lat - firstWp.lat) < 0.0001 && Math.abs(lastWp.lng - firstWp.lng) < 0.0001) {
    alert('El track ya está cerrado.');
    return;
  }

  pushUndoState();

  if (creator.mode === 'road' && creator.apiKey) {
    creator.isRouting = true;
    showRoutingSpinner(true);
    try {
      const segment = await fetchRoute(lastWp, firstWp);
      if (segment && segment.length > 0) {
        creator.routeSegments.push(segment);
        creator.waypoints.push(L.latLng(firstWp.lat, firstWp.lng));
        rebuildAllMarkers();
        rebuildPolyline();
        updateMidpoints();
        updateCreatorStats();
      }
    } catch (err) {
      console.error('Return routing error:', err);
      alert('Error calculando la vuelta: ' + err.message);
      creator.undoStack.pop(); // Rollback undo
    } finally {
      creator.isRouting = false;
      showRoutingSpinner(false);
    }
  } else {
    // Manual: straight line back
    const seg = [[lastWp.lat, lastWp.lng, 0], [firstWp.lat, firstWp.lng, 0]];
    creator.routeSegments.push(seg);
    creator.waypoints.push(L.latLng(firstWp.lat, firstWp.lng));
    rebuildAllMarkers();
    rebuildPolyline();
    updateMidpoints();
    updateCreatorStats();
  }
}


// =============================================
// 7. CLEAR
// =============================================

function clearCreatedTrack() {
  if (creator.waypoints.length === 0) return;
  if (!confirm('¿Borrar el track actual?')) return;

  pushUndoState();

  creator.waypoints = [];
  creator.routeSegments = [];

  // Remove all from map
  creator.markers.forEach(m => creator.map.removeLayer(m));
  creator.markers = [];
  creator.midpointMarkers.forEach(m => creator.map.removeLayer(m));
  creator.midpointMarkers = [];
  if (creator.polyline) {
    creator.map.removeLayer(creator.polyline);
    creator.polyline = null;
  }

  updateCreatorStats();
}


// =============================================
// 8. STATS
// =============================================

function updateCreatorStats() {
  const allPoints = getAllFlatPoints();
  let dist = 0;

  for (let i = 1; i < allPoints.length; i++) {
    dist += haversineDistanceCreator(allPoints[i - 1][0], allPoints[i - 1][1], allPoints[i][0], allPoints[i][1]);
  }

  creator.totalDistance = dist;

  const distEl = document.getElementById('creatorDistance');
  if (distEl) distEl.textContent = dist.toFixed(2) + ' km';

  const pointsEl = document.getElementById('creatorPoints');
  if (pointsEl) pointsEl.textContent = creator.waypoints.length;

  // Enable/disable buttons
  const hasPoints = creator.waypoints.length > 0;
  const hasTrack = creator.waypoints.length >= 2;
  document.getElementById('btnUndo').disabled = creator.undoStack.length === 0;
  document.getElementById('btnReturnToStart').disabled = !hasTrack;
  document.getElementById('btnClearTrack').disabled = !hasPoints;
  document.getElementById('btnSaveCreated').disabled = !hasTrack;
  document.getElementById('btnDownloadCreated').disabled = !hasTrack;
}

function haversineDistanceCreator(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}


// =============================================
// 9. GPX GENERATION
// =============================================

function generateCreatorGPX(name) {
  const allPoints = getAllFlatPoints();
  if (allPoints.length < 2) return null;

  const now = new Date().toISOString();
  let trkpts = '';

  for (const p of allPoints) {
    const lat = p[0].toFixed(7);
    const lon = p[1].toFixed(7);
    const ele = (p[2] || 0).toFixed(1);
    trkpts += `      <trkpt lat="${lat}" lon="${lon}"><ele>${ele}</ele></trkpt>\n`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GPX Tracker Creator"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${escapeXml(name)}</name>
    <time>${now}</time>
  </metadata>
  <trk>
    <name>${escapeXml(name)}</name>
    <trkseg>
${trkpts}    </trkseg>
  </trk>
</gpx>`;
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


// =============================================
// 10. SAVE & DOWNLOAD
// =============================================

async function saveCreatedTrack() {
  if (creator.waypoints.length < 2) return;

  const nameInput = document.getElementById('creatorTrackName');
  const name = (nameInput?.value || '').trim() || 'Track creado ' + new Date().toLocaleDateString('es-ES');

  const gpxContent = generateCreatorGPX(name);
  if (!gpxContent) return;

  const btn = document.getElementById('btnSaveCreated');
  const statusEl = document.getElementById('creatorSaveStatus');
  btn.disabled = true;
  if (statusEl) {
    statusEl.className = 'text-xs font-bold text-blue-600 animate-pulse';
    statusEl.textContent = 'Guardando...';
  }

  try {
    // Parse the generated GPX to get stats (reuse global parseGPX)
    const parsed = parseGPX(gpxContent);

    await saveTrackToDB({
      fecha: new Date().toISOString(),
      nombre: parsed.nombre,
      distancia: parsed.distancia,
      desnivelPositivo: parsed.desnivelPositivo,
      desnivelNegativo: parsed.desnivelNegativo,
      altitudMax: parsed.altitudMax,
      altitudMin: parsed.altitudMin,
      gpxContent: gpxContent
    });

    if (statusEl) {
      statusEl.className = 'text-xs font-bold text-green-600';
      statusEl.textContent = '✓ Guardado en Mis Tracks';
      setTimeout(() => { statusEl.textContent = ''; }, 3000);
    }
    btn.disabled = false;
  } catch (err) {
    console.error('Save error:', err);
    if (statusEl) {
      statusEl.className = 'text-xs font-bold text-red-600';
      statusEl.textContent = '✕ Error al guardar';
    }
    btn.disabled = false;
  }
}

function downloadCreatedTrack() {
  if (creator.waypoints.length < 2) return;

  const nameInput = document.getElementById('creatorTrackName');
  const name = (nameInput?.value || '').trim() || 'Track creado ' + new Date().toLocaleDateString('es-ES');

  const gpxContent = generateCreatorGPX(name);
  if (!gpxContent) return;

  // Reuse global downloadGPX function
  downloadGPX(gpxContent, name + '.gpx');
}


// =============================================
// 11. UI HELPERS
// =============================================

function showRoutingSpinner(show) {
  const spinner = document.getElementById('routingSpinner');
  if (spinner) {
    spinner.classList.toggle('hidden', !show);
  }
}
