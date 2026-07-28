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
// CLOUD SYNC & DATABASE (IndexedDB + Supabase)
// =============================================

const SUPABASE_URL = 'https://ketihpjheglbplwdswfq.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_G9meSMRexP5YKaam18BbPA_E9eyOxNr';
const supabaseClient = window.supabase?.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY) || null;
let cloudSession = null;

function updateCloudAccountUI() {
  const signedOutPanel = document.getElementById('cloudSignedOut');
  const signedInPanel = document.getElementById('cloudSignedIn');
  const accountEmail = document.getElementById('cloudAccountEmail');
  const forceSyncBtn = document.getElementById('btnForceSync');
  const isSignedIn = Boolean(cloudSession?.user);

  signedOutPanel?.classList.toggle('hidden', isSignedIn);
  signedInPanel?.classList.toggle('hidden', !isSignedIn);
  if (accountEmail) accountEmail.textContent = cloudSession?.user?.email || '';
  if (forceSyncBtn) forceSyncBtn.disabled = !isSignedIn;
}

async function initializeCloudAuth() {
  localStorage.removeItem('gpx_cloud_url');
  if (!supabaseClient) {
    updateCloudAccountUI();
    const message = document.getElementById('cloudAuthMessage');
    if (message) message.textContent = 'La nube no está disponible sin conexión.';
    return;
  }

  const { data, error } = await supabaseClient.auth.getSession();
  if (error) console.warn('Could not restore Supabase session:', error.message);
  cloudSession = data?.session || null;
  updateCloudAccountUI();

  supabaseClient.auth.onAuthStateChange((_event, session) => {
    cloudSession = session;
    updateCloudAccountUI();
    setTimeout(() => loadHistory(), 0);
  });
}

async function sendCloudMagicLink() {
  const emailInput = document.getElementById('cloudEmail');
  const message = document.getElementById('cloudAuthMessage');
  if (!supabaseClient) {
    if (message) message.textContent = 'Conéctate a Internet para acceder a la nube.';
    return;
  }
  const email = (emailInput?.value || '').trim();
  if (!email || !email.includes('@')) {
    if (message) {
      message.className = 'text-xs font-bold text-red-600';
      message.textContent = 'Introduce un correo válido.';
    }
    return;
  }

  if (message) {
    message.className = 'text-xs font-bold text-blue-600 animate-pulse';
    message.textContent = 'Enviando enlace seguro...';
  }

  const redirectTo = `${window.location.origin}${window.location.pathname}`;
  const { error } = await supabaseClient.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectTo }
  });

  if (message) {
    message.className = error ? 'text-xs font-bold text-red-600' : 'text-xs font-bold text-emerald-600';
    message.textContent = error
      ? `No se pudo enviar: ${error.message}`
      : 'Revisa tu correo y abre el enlace para conectar este dispositivo.';
  }
}

async function signOutFromCloud() {
  if (!supabaseClient) return;
  const { error } = await supabaseClient.auth.signOut();
  if (error) alert(`No se pudo cerrar la sesión: ${error.message}`);
}

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

  // Supabase can store the original GPX, so cross-device downloads keep every point.
  // The parsed `puntos` array is redundant and much heavier than the source XML.
  if (!copy.gpxContent && (!copy.points || copy.points.length === 0) && Array.isArray(copy.puntos)) {
    copy.points = copy.puntos.map(p => [p.lat, p.lon, p.ele || 0]);
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
  if (!supabaseClient || !cloudSession?.user) return null;

  try {
    const { data, error } = await supabaseClient
      .from('tracks')
      .select('data, updated_at')
      .order('updated_at', { ascending: false });

    if (error) throw error;
    return (data || []).map(row => restoreCloudTrack({
      ...(row.data || {}),
      updatedAt: row.data?.updatedAt || row.updated_at
    }));
  } catch (err) {
    console.warn('Supabase fetch warning:', err);
    return null;
  }
}

async function syncTracksToCloud(tracksArray) {
  if (!supabaseClient || !cloudSession?.user) {
    return { ok: false, signedOut: true, message: 'Inicia sesión para sincronizar.' };
  }
  if (!tracksArray || tracksArray.length === 0) return { ok: true };

  try {
    const now = new Date().toISOString();
    const rows = tracksArray
      .filter(t => t?.id !== undefined && t?.id !== null)
      .map(t => ({
        user_id: cloudSession.user.id,
        id: String(t.id),
        data: prepareTrackForCloud({
          ...t,
          updatedAt: t.updatedAt || t.fecha || now
        }),
        updated_at: t.updatedAt || t.fecha || now
      }));

    const { error } = await supabaseClient
      .from('tracks')
      .upsert(rows, { onConflict: 'user_id,id' });

    if (error) throw error;

    for (const t of tracksArray) {
      if (t?.id !== undefined && t?.id !== null) {
        await saveTrackToLocalDB({ ...t, inCloud: true });
      }
    }
    return { ok: true };
  } catch (err) {
    console.error('Supabase save error:', err);
    return { ok: false, message: err.message || 'Error de conexión con Supabase' };
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
    if (!cloudSession?.user) {
      document.getElementById('cloudEmail')?.focus();
      throw new Error('Inicia sesión con tu correo antes de subir los tracks.');
    }

    const localTracks = await getLocalTracks();
    const cloudTracks = await getCloudTracks();
    const mergedTracks = mergeTracks(localTracks, cloudTracks || []);

    const result = await syncTracksToCloud(mergedTracks);

    if (result.ok) {
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
      alert('Detalle del error al subir a la nube: ' + (result.message || 'Error de red'));
    }
  } catch (err) {
    alert('Error al forzar la subida: ' + err.message);
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
  track.updatedAt = new Date().toISOString();

  // Save to local IndexedDB
  await saveTrackToLocalDB(track);

  // Sync current list when the user has connected this device.
  if (cloudSession?.user) {
    const allLocal = await getLocalTracks();
    const result = await syncTracksToCloud(allLocal);
    if (!result.ok) throw new Error(result.message || 'No se pudo sincronizar');
  }

  return { cloudSaved: Boolean(cloudSession?.user) };
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

  // 2. Delete the same track in Supabase. Other cloud tracks are untouched.
  const remaining = await getLocalTracks();

  if (cloudSession?.user) {
    const { error } = await supabaseClient
      .from('tracks')
      .delete()
      .eq('id', String(id));
    if (error) throw error;
  }

  // 3. Re-render table
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
  const trackElement = xmlDoc.getElementsByTagName('trk')[0];
  const metadataElement = xmlDoc.getElementsByTagName('metadata')[0];
  const nameTag = trackElement?.getElementsByTagName('name')[0]
    || metadataElement?.getElementsByTagName('name')[0]
    || xmlDoc.getElementsByTagName('name')[0];
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
    radius: 8,
    color: '#ffffff',
    fillColor: '#2563eb',
    fillOpacity: 1,
    weight: 3,
    interactive: false
  }).bindTooltip('', {
    direction: 'top',
    offset: [0, -8],
    opacity: 0.95,
    className: 'profile-map-tooltip'
  });
}

function updateMap(points) {
  const latLngs = points.map(p => [p.lat, p.lon]);
  if (mapPolyline) map.removeLayer(mapPolyline);
  clearProfileMapMarker();

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

function findNearestTrackPoint(dist) {
  if (!parsedData?.puntos?.length) return null;
  const points = parsedData.puntos;
  let low = 0;
  let high = points.length - 1;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (points[mid].distance < dist) low = mid + 1;
    else high = mid;
  }

  if (low === 0) return points[0];
  const before = points[low - 1];
  const after = points[low];
  return Math.abs(after.distance - dist) < Math.abs(before.distance - dist) ? after : before;
}

function updateMarkerFromChart(dist, slope = null) {
  if (!map || !mapMarker) return;
  const p = findNearestTrackPoint(dist);
  if (!p) return;

  mapMarker.setLatLng([p.lat, p.lon]);
  const slopeLine = Number.isFinite(slope) ? `<br><b>Pendiente:</b> ${slope.toFixed(1)}%` : '';
  mapMarker.setTooltipContent(`<b>${p.distance.toFixed(2)} km</b><br>${Math.round(p.ele)} m${slopeLine}`);
  if (!map.hasLayer(mapMarker)) mapMarker.addTo(map);
  mapMarker.openTooltip();
}

function clearProfileMapMarker() {
  if (map && mapMarker && map.hasLayer(mapMarker)) {
    map.removeLayer(mapMarker);
  }
}


// =============================================
// 4. CHART (ECharts)
// =============================================

function initChart() {
  chart = echarts.init(document.getElementById('chartContainer'));
  window.addEventListener('resize', () => chart.resize());
  chart.getZr().on('globalout', clearProfileMapMarker);
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
  const interval = Math.max(parseFloat(document.getElementById('intervalSize').value) || 1, 0.1);
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

  // Calculate one slope value for each selected distance interval.
  const slopeSegments = [];

  for (let i = 0; i < intervals.length - 1; i++) {
    const run = intervals[i + 1].distance - intervals[i].distance;
    const rise = intervals[i + 1].ele - intervals[i].ele;
    const slope = run > 0 ? (rise / (run * 1000)) * 100 : 0;
    slopeSegments.push({
      start: intervals[i].distance,
      end: intervals[i + 1].distance,
      slope
    });
  }

  const slopePieces = slopeSegments.map((segment, index) => ({
    ...(index === 0 ? { gte: segment.start } : { gt: segment.start }),
    lte: segment.end,
    color: getSlopeColor(segment.slope)
  }));

  let segmentIndex = 0;
  const chartData = points.map(p => {
    while (segmentIndex < slopeSegments.length - 1 && p.distance > slopeSegments[segmentIndex].end) {
      segmentIndex++;
    }
    return [p.distance, p.ele, slopeSegments[segmentIndex]?.slope || 0];
  });

  // The translucent area follows the creator style; the foreground line is
  // coloured independently using the slope stored in the third dimension.
  chart.setOption({
    animationDuration: 350,
    grid: { left: 52, right: 22, bottom: 58, top: 18, containLabel: false },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: 'rgba(255, 255, 255, 0.95)',
      borderColor: '#e2e8f0',
      textStyle: { fontSize: 12, fontFamily: 'Inter' },
      axisPointer: {
        type: 'line',
        snap: true,
        lineStyle: { color: '#2563eb', width: 1.5, type: 'dashed' }
      },
      formatter: (params) => {
        const profilePoint = params.find(item => item.seriesName === 'Perfil');
        if (!profilePoint) return '';
        const [d, elevation, slope] = profilePoint.value;
        updateMarkerFromChart(d, slope);
        return `<b>${d.toFixed(2)} km</b><br>Altitud: ${elevation.toFixed(0)} m<br> Pendiente: <span style="color:${getSlopeColor(slope)};font-weight:800">${slope.toFixed(1)}%</span>`;
      }
    },
    xAxis: {
      type: 'value',
      name: 'km',
      min: 0,
      max: maxDist,
      boundaryGap: false,
      axisLine: { lineStyle: { color: '#cbd5e1' } },
      splitLine: { show: false },
      axisLabel: { fontSize: 10, fontFamily: 'Inter', color: '#64748b' },
      nameTextStyle: { color: '#64748b', fontWeight: 700 }
    },
    yAxis: {
      type: 'value',
      name: 'm',
      scale: true,
      axisLine: { show: false },
      splitLine: { lineStyle: { color: '#e2e8f0', type: 'dashed' } },
      axisLabel: { fontSize: 10, fontFamily: 'Inter', color: '#64748b' },
      nameTextStyle: { color: '#64748b', fontWeight: 700 }
    },
    dataZoom: [
      {
        type: 'inside',
        xAxisIndex: 0,
        filterMode: 'none',
        zoomOnMouseWheel: true,
        moveOnMouseMove: true,
        moveOnMouseWheel: true
      },
      {
        type: 'slider',
        xAxisIndex: 0,
        filterMode: 'none',
        bottom: 8,
        height: 22,
        borderColor: 'transparent',
        backgroundColor: '#f1f5f9',
        fillerColor: 'rgba(37, 99, 235, 0.16)',
        handleStyle: { color: '#2563eb', borderColor: '#ffffff' },
        dataBackground: {
          lineStyle: { color: '#94a3b8' },
          areaStyle: { color: '#cbd5e1' }
        }
      }
    ],
    visualMap: {
      show: false,
      type: 'piecewise',
      seriesIndex: 1,
      dimension: 0,
      pieces: slopePieces
    },
    series: [
      {
        name: 'Área',
        type: 'line',
        data: chartData.map(item => [item[0], item[1]]),
        symbol: 'none',
        smooth: 0.12,
        silent: true,
        tooltip: { show: false },
        lineStyle: { width: 0, opacity: 0 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(16, 185, 129, 0.38)' },
            { offset: 1, color: 'rgba(16, 185, 129, 0.02)' }
          ])
        }
      },
      {
        name: 'Perfil',
        type: 'line',
        data: chartData,
        encode: { x: 0, y: 1, tooltip: [0, 1, 2] },
        symbol: 'none',
        smooth: 0.12,
        lineStyle: { width: 3 },
        emphasis: { lineStyle: { width: 4 } }
      }
    ]
  }, true);
}

function resetChartZoom() {
  if (!chart) return;
  chart.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
}

function toggleChartFullscreen(forceExpanded = null) {
  const card = document.getElementById('profileCard');
  const button = document.getElementById('btnToggleChartFullscreen');
  if (!card || !button) return;

  const shouldExpand = forceExpanded === null
    ? !card.classList.contains('profile-expanded')
    : forceExpanded;

  card.classList.toggle('profile-expanded', shouldExpand);
  document.body.classList.toggle('profile-modal-open', shouldExpand);
  button.querySelector('.expand-icon')?.classList.toggle('hidden', shouldExpand);
  button.querySelector('.collapse-icon')?.classList.toggle('hidden', !shouldExpand);
  button.title = shouldExpand ? 'Reducir perfil' : 'Ampliar perfil';
  button.setAttribute('aria-label', button.title);
  setTimeout(() => chart?.resize(), 60);
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
    const saveResult = await saveTrackToDB({
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
    status.textContent = saveResult.cloudSaved ? '✓ Guardado en la nube' : '✓ Guardado local';
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
  (localList || []).forEach(t => {
    if (t?.id !== undefined && t?.id !== null) trackMap.set(String(t.id), t);
  });
  (cloudList || []).forEach(t => { 
    if (t?.id !== undefined && t?.id !== null) {
      const key = String(t.id);
      const existing = trackMap.get(key);
      const localTime = new Date(existing?.updatedAt || existing?.fecha || 0).getTime();
      const cloudTime = new Date(t.updatedAt || t.fecha || 0).getTime();
      const newest = !existing || cloudTime >= localTime
        ? { ...(existing || {}), ...t }
        : { ...t, ...existing };
      trackMap.set(key, { ...newest, inCloud: true });
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

  // Restore the Supabase session before the first cloud sync.
  initializeCloudAuth()
    .then(() => loadHistory())
    .catch(err => {
      console.warn('Cloud auth initialization error:', err);
      loadHistory();
    });

  // File input
  document.getElementById('gpxFile').addEventListener('change', handleFileSelect);

  // Interval change
  document.getElementById('intervalSize').addEventListener('change', () => {
    if (parsedData) renderChart();
  });

  const resetChartZoomBtn = document.getElementById('btnResetChartZoom');
  const toggleChartFullscreenBtn = document.getElementById('btnToggleChartFullscreen');
  if (resetChartZoomBtn) resetChartZoomBtn.addEventListener('click', resetChartZoom);
  if (toggleChartFullscreenBtn) toggleChartFullscreenBtn.addEventListener('click', () => toggleChartFullscreen());
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('profileCard')?.classList.contains('profile-expanded')) {
      toggleChartFullscreen(false);
    }
  });

  // Save button
  document.getElementById('btnGuardar').addEventListener('click', saveCurrentTrack);

  // Force sync button
  const forceSyncBtn = document.getElementById('btnForceSync');
  if (forceSyncBtn) forceSyncBtn.addEventListener('click', forceSyncAllToCloud);

  const cloudLoginBtn = document.getElementById('btnCloudLogin');
  const cloudLogoutBtn = document.getElementById('btnCloudLogout');
  const cloudEmail = document.getElementById('cloudEmail');
  if (cloudLoginBtn) cloudLoginBtn.addEventListener('click', sendCloudMagicLink);
  if (cloudLogoutBtn) cloudLogoutBtn.addEventListener('click', signOutFromCloud);
  if (cloudEmail) cloudEmail.addEventListener('keydown', e => {
    if (e.key === 'Enter') sendCloudMagicLink();
  });

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
