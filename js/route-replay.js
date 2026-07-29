// =============================================
// GPX TRACKER - 3D ROUTE REPLAY
// MapLibre terrain animation for analyzed routes
// =============================================

let routeReplayMap = null;
let routeReplayFrame = null;
let routeReplayPlaying = false;
let routeReplayReady = false;
let routeReplayElapsed = 0;
let routeReplayStartedAt = 0;
let routeReplayDuration = 60000;
let routeReplaySpeed = 1;
let routeReplayPoints = [];
let routeReplayLastLineUpdate = 0;
let routeReplayCameraBearing = null;
let routeReplayLastCameraTime = 0;
let routeReplayShareToken = null;

function buildSharedReplayUrl(token) {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('replay', token);
  return url.href;
}

function setReplayShareStatus(message, isError = false) {
  const status = document.getElementById('replayShareStatus');
  if (!status) return;
  status.textContent = message;
  status.style.color = isError ? '#fecaca' : '#a5f3fc';
}

function resetRouteReplayShare() {
  routeReplayShareToken = null;
  document.getElementById('btnRevokeRouteReplay')?.classList.add('hidden');
  setReplayShareStatus('');
}

async function copyReplayLink(link) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(link);
    return;
  }
  const input = document.createElement('textarea');
  input.value = link;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  document.execCommand('copy');
  input.remove();
}

async function deliverReplayLink(token, name) {
  const link = buildSharedReplayUrl(token);
  const shareData = {
    title: `Recorrido 3D: ${name}`,
    text: `Mira el recorrido 3D de ${name}`,
    url: link
  };

  if (navigator.share) {
    try {
      await navigator.share(shareData);
      return { shared: true, link };
    } catch (error) {
      if (error?.name === 'AbortError') return { cancelled: true, link };
    }
  }

  await copyReplayLink(link);
  return { copied: true, link };
}

async function createSharedReplay() {
  if (!supabaseClient || !cloudSession?.user) {
    throw new Error('Conecta la nube en “Mis Tracks” antes de crear un enlace.');
  }
  if (!fileContent || !/<trkpt[\s>]/i.test(fileContent)) {
    throw new Error('No se encontró el GPX de esta ruta.');
  }

  const { data, error } = await supabaseClient
    .from('shared_replays')
    .insert({
      owner_id: cloudSession.user.id,
      name: (parsedData?.nombre || fileName || 'Ruta').slice(0, 200),
      gpx_content: fileContent,
      settings: { speed: routeReplaySpeed, autoplay: true }
    })
    .select('token')
    .single();

  if (error) throw error;
  routeReplayShareToken = data.token;
  document.getElementById('btnRevokeRouteReplay')?.classList.remove('hidden');
  loadSharedReplayList();
  return routeReplayShareToken;
}

async function shareCurrentRouteReplay() {
  const button = document.getElementById('btnShareRouteReplay');
  const originalText = button?.textContent || '↗ Compartir enlace';
  if (button) {
    button.disabled = true;
    button.textContent = routeReplayShareToken ? 'Abriendo…' : 'Creando enlace…';
  }
  setReplayShareStatus('');

  try {
    const token = routeReplayShareToken || await createSharedReplay();
    const result = await deliverReplayLink(token, parsedData?.nombre || 'Ruta');
    if (result.shared) setReplayShareStatus('Enlace compartido.');
    else if (result.copied) setReplayShareStatus('Enlace copiado al portapapeles.');
    else setReplayShareStatus('Enlace creado y listo para compartir.');
  } catch (error) {
    console.warn('Replay sharing error:', error);
    setReplayShareStatus(error.message || 'No se pudo crear el enlace.', true);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function revokeSharedReplay(token = routeReplayShareToken) {
  if (!token || !supabaseClient || !cloudSession?.user) return false;
  if (!confirm('¿Desactivar este enlace? Dejará de abrir el recorrido.')) return false;

  const { error } = await supabaseClient
    .from('shared_replays')
    .delete()
    .eq('token', token);
  if (error) throw error;

  if (token === routeReplayShareToken) resetRouteReplayShare();
  await loadSharedReplayList();
  return true;
}

async function loadSharedReplayList() {
  const panel = document.getElementById('sharedReplaysPanel');
  const list = document.getElementById('sharedReplaysList');
  const status = document.getElementById('sharedReplaysStatus');
  if (!panel || !list || !cloudSession?.user || !supabaseClient) return;

  panel.classList.remove('hidden');
  if (status) status.textContent = 'Cargando…';
  const { data, error } = await supabaseClient
    .from('shared_replays')
    .select('token, name, created_at')
    .order('created_at', { ascending: false });

  if (error) {
    if (status) status.textContent = 'No disponible';
    return;
  }
  if (status) status.textContent = `${data.length} activo${data.length === 1 ? '' : 's'}`;

  if (!data.length) {
    list.innerHTML = '<p class="text-xs text-gray-400 py-2">Todavía no has compartido ningún recorrido.</p>';
    return;
  }

  list.innerHTML = data.map(replay => {
    const date = new Date(replay.created_at).toLocaleDateString('es-ES');
    return `<article class="shared-replay-item">
      <div class="min-w-0">
        <p class="shared-replay-item-name">${escapeHtml(replay.name)}</p>
        <p class="shared-replay-item-date">Creado el ${date}</p>
      </div>
      <div class="shared-replay-actions">
        <button type="button" class="share-existing-replay" data-token="${replay.token}" data-name="${escapeHtml(replay.name)}">↗ Compartir</button>
        <button type="button" class="revoke-shared-replay" data-token="${replay.token}">✕ Desactivar</button>
      </div>
    </article>`;
  }).join('');

  list.querySelectorAll('.share-existing-replay').forEach(button => {
    button.addEventListener('click', async () => {
      const result = await deliverReplayLink(button.dataset.token, button.dataset.name);
      if (status) status.textContent = result.copied ? 'Enlace copiado' : result.shared ? 'Compartido' : 'Enlace listo';
    });
  });
  list.querySelectorAll('.revoke-shared-replay').forEach(button => {
    button.addEventListener('click', async () => {
      try {
        await revokeSharedReplay(button.dataset.token);
      } catch (error) {
        if (status) status.textContent = 'Error al desactivar';
      }
    });
  });
}

async function loadSharedReplayFromURL() {
  const token = new URL(window.location.href).searchParams.get('replay');
  if (!token) return;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
    alert('El enlace del recorrido no es válido.');
    return;
  }

  const status = document.getElementById('saveStatus');
  if (status) {
    status.className = 'text-xs font-bold text-blue-600 animate-pulse h-4';
    status.textContent = 'Cargando recorrido compartido…';
  }

  try {
    const { data, error } = await supabaseClient.rpc('get_shared_replay', { p_token: token });
    if (error) throw error;
    const replay = data?.[0];
    if (!replay) throw new Error('Este enlace no existe o ha sido desactivado.');

    processAndDisplay(replay.gpx_content, `${replay.name}.gpx`);
    routeReplayShareToken = token;
    document.getElementById('btnRevokeRouteReplay')?.classList.add('hidden');
    const speed = Number(replay.settings?.speed);
    if ([0.5, 1, 2, 4].includes(speed)) {
      document.getElementById('routeReplaySpeed').value = String(speed);
    }
    switchToTab('analizar');
    document.title = `${replay.name} · Recorrido 3D`;
    setTimeout(openRouteReplay, 250);
  } catch (error) {
    console.warn('Shared replay loading error:', error);
    alert(error.message || 'No se pudo abrir el recorrido compartido.');
  } finally {
    if (status) {
      status.className = 'text-xs font-bold h-4';
      status.textContent = '';
    }
  }
}

function replayPointFeature(point) {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Point', coordinates: [point.lon, point.lat] }
  };
}

function replayLineFeature(points) {
  const safePoints = points.length > 1 ? points : [points[0], points[0]];
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'LineString',
      coordinates: safePoints.map(point => [point.lon, point.lat])
    }
  };
}

function buildSlopeRouteFeatures(points) {
  const maxSegments = 700;
  const totalDistance = points[points.length - 1].distance || 1;
  const targetSegmentKm = Math.max(0.2, totalDistance / maxSegments);
  const features = [];

  for (let index = 0; index < points.length - 1;) {
    let endIndex = index + 1;
    while (
      endIndex < points.length - 1 &&
      points[endIndex].distance - points[index].distance < targetSegmentKm
    ) {
      endIndex++;
    }
    const start = points[index];
    const end = points[endIndex];
    const runKm = Math.max(end.distance - start.distance, 0.001);
    const slope = ((end.ele - start.ele) / (runKm * 1000)) * 100;
    features.push({
      type: 'Feature',
      properties: { color: getSlopeColor(slope) },
      geometry: {
        type: 'LineString',
        coordinates: points.slice(index, endIndex + 1).map(point => [point.lon, point.lat])
      }
    });
    index = endIndex;
  }

  return { type: 'FeatureCollection', features };
}

function calculateReplayBearing(current, next) {
  const lat1 = current.lat * Math.PI / 180;
  const lat2 = next.lat * Math.PI / 180;
  const deltaLon = (next.lon - current.lon) * Math.PI / 180;
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function findReplayIndexAtDistance(distance) {
  let low = 0;
  let high = routeReplayPoints.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (routeReplayPoints[middle].distance < distance) low = middle + 1;
    else high = middle;
  }
  return low;
}

function calculateReplayDirection(targetDistance, currentPoint) {
  const points = routeReplayPoints;
  const totalDistance = points[points.length - 1].distance || 1;
  const lookAheadKm = Math.max(0.6, Math.min(1.5, totalDistance * 0.015));
  const behindDistance = Math.max(0, targetDistance - lookAheadKm * 0.25);
  const aheadDistance = Math.min(totalDistance, targetDistance + lookAheadKm);
  const behind = points[findReplayIndexAtDistance(behindDistance)] || currentPoint;
  const ahead = points[findReplayIndexAtDistance(aheadDistance)] || currentPoint;

  if (aheadDistance - behindDistance < 0.05) {
    return calculateReplayBearing(points[Math.max(0, points.length - 2)], points[points.length - 1]);
  }
  return calculateReplayBearing(behind, ahead);
}

function shortestBearingDelta(target, current) {
  return ((target - current + 540) % 360) - 180;
}

function stabilizeReplayBearing(targetBearing, timestamp = 0) {
  if (routeReplayCameraBearing === null || !timestamp) {
    routeReplayCameraBearing = targetBearing;
    routeReplayLastCameraTime = timestamp || performance.now();
    return routeReplayCameraBearing;
  }

  const delta = shortestBearingDelta(targetBearing, routeReplayCameraBearing);
  const absoluteDelta = Math.abs(delta);
  const deadZone = 14;
  const elapsedSeconds = Math.max(1 / 120, Math.min((timestamp - routeReplayLastCameraTime) / 1000, 0.1));
  routeReplayLastCameraTime = timestamp;

  // Small bends and GPS noise do not rotate the camera at all. Genuine changes
  // of direction rotate progressively, with U-turns allowed to settle faster.
  if (absoluteDelta <= deadZone) return routeReplayCameraBearing;
  const degreesPerSecond = absoluteDelta > 110 ? 65 : absoluteDelta > 55 ? 34 : 16;
  const usefulDelta = delta - Math.sign(delta) * deadZone;
  const maxStep = degreesPerSecond * elapsedSeconds;
  const step = Math.max(-maxStep, Math.min(usefulDelta, maxStep));
  routeReplayCameraBearing = (routeReplayCameraBearing + step + 360) % 360;
  return routeReplayCameraBearing;
}

function findReplayPosition(progress) {
  const points = routeReplayPoints;
  const totalDistance = points[points.length - 1].distance || 0;
  const targetDistance = totalDistance * Math.max(0, Math.min(progress, 1));
  let low = 0;
  let high = points.length - 1;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].distance < targetDistance) low = middle + 1;
    else high = middle;
  }

  const nextIndex = Math.min(Math.max(low, 1), points.length - 1);
  const previousIndex = nextIndex - 1;
  const previous = points[previousIndex];
  const next = points[nextIndex];
  const segmentDistance = Math.max(next.distance - previous.distance, 0.000001);
  const fraction = Math.max(0, Math.min((targetDistance - previous.distance) / segmentDistance, 1));
  const point = {
    lat: previous.lat + (next.lat - previous.lat) * fraction,
    lon: previous.lon + (next.lon - previous.lon) * fraction,
    ele: previous.ele + (next.ele - previous.ele) * fraction,
    distance: targetDistance
  };
  let slopeStartIndex = previousIndex;
  let slopeEndIndex = nextIndex;
  while (slopeStartIndex > 0 && points[slopeStartIndex].distance > targetDistance - 0.1) slopeStartIndex--;
  while (slopeEndIndex < points.length - 1 && points[slopeEndIndex].distance < targetDistance + 0.1) slopeEndIndex++;
  const slopeStart = points[slopeStartIndex];
  const slopeEnd = points[slopeEndIndex];
  const slopeRun = Math.max(slopeEnd.distance - slopeStart.distance, 0.001);
  const slope = ((slopeEnd.ele - slopeStart.ele) / (slopeRun * 1000)) * 100;
  return { point, slope, bearing: calculateReplayDirection(targetDistance, point), nextIndex };
}

function setReplayButtonState() {
  const button = document.getElementById('btnReplayToggle');
  if (button) button.textContent = routeReplayPlaying ? '⏸ Pausa' : '▶ Reproducir';
}

function updateReplayAt(progress, timestamp = 0) {
  if (!routeReplayReady || !routeReplayMap || routeReplayPoints.length < 2) return;
  const position = findReplayPosition(progress);
  const cameraBearing = stabilizeReplayBearing(position.bearing, timestamp);
  const percent = Math.round(progress * 100);
  const markerSource = routeReplayMap.getSource('replay-marker');
  const progressSource = routeReplayMap.getSource('replay-progress');

  markerSource?.setData(replayPointFeature(position.point));
  if (!timestamp || timestamp - routeReplayLastLineUpdate > 90 || progress >= 1) {
    progressSource?.setData(replayLineFeature([
      ...routeReplayPoints.slice(0, position.nextIndex),
      position.point
    ]));
    routeReplayLastLineUpdate = timestamp;
  }

  routeReplayMap.jumpTo({
    center: [position.point.lon, position.point.lat],
    elevation: position.point.ele,
    bearing: cameraBearing,
    pitch: 67,
    zoom: window.innerWidth < 640 ? 12.9 : 13.5
  });

  document.getElementById('routeReplayProgress').value = String(Math.round(progress * 1000));
  document.getElementById('replayKm').textContent = position.point.distance.toFixed(1);
  document.getElementById('replayElevation').textContent = `${Math.round(position.point.ele)} m`;
  const slopeElement = document.getElementById('replaySlope');
  slopeElement.textContent = `${position.slope >= 0 ? '+' : ''}${position.slope.toFixed(1)}%`;
  slopeElement.style.color = getSlopeColor(position.slope);
  document.getElementById('replayPercent').textContent = `${percent}%`;
}

function replayAnimationFrame(timestamp) {
  if (!routeReplayPlaying) return;
  if (!routeReplayStartedAt) routeReplayStartedAt = timestamp;
  const frameElapsed = (timestamp - routeReplayStartedAt) * routeReplaySpeed;
  const progress = Math.min((routeReplayElapsed + frameElapsed) / routeReplayDuration, 1);
  updateReplayAt(progress, timestamp);

  if (progress >= 1) {
    routeReplayPlaying = false;
    routeReplayElapsed = routeReplayDuration;
    routeReplayStartedAt = 0;
    setReplayButtonState();
    return;
  }

  routeReplayFrame = requestAnimationFrame(replayAnimationFrame);
}

function pauseRouteReplay() {
  if (!routeReplayPlaying) return;
  const now = performance.now();
  routeReplayElapsed = Math.min(
    routeReplayElapsed + (now - routeReplayStartedAt) * routeReplaySpeed,
    routeReplayDuration
  );
  routeReplayPlaying = false;
  routeReplayStartedAt = 0;
  if (routeReplayFrame) cancelAnimationFrame(routeReplayFrame);
  routeReplayFrame = null;
  setReplayButtonState();
}

function playRouteReplay() {
  if (!routeReplayReady) return;
  if (routeReplayElapsed >= routeReplayDuration) routeReplayElapsed = 0;
  routeReplayPlaying = true;
  routeReplayStartedAt = performance.now();
  routeReplayLastCameraTime = routeReplayStartedAt;
  setReplayButtonState();
  routeReplayFrame = requestAnimationFrame(replayAnimationFrame);
}

function toggleRouteReplay() {
  if (routeReplayPlaying) pauseRouteReplay();
  else playRouteReplay();
}

function restartRouteReplay() {
  pauseRouteReplay();
  routeReplayElapsed = 0;
  updateReplayAt(0);
  playRouteReplay();
}

function seekRouteReplay(value) {
  const shouldResume = routeReplayPlaying;
  pauseRouteReplay();
  const progress = Math.max(0, Math.min(Number(value) / 1000, 1));
  routeReplayElapsed = routeReplayDuration * progress;
  updateReplayAt(progress);
  if (shouldResume) playRouteReplay();
}

function initializeReplayMap() {
  const first = routeReplayPoints[0];
  const last = routeReplayPoints[routeReplayPoints.length - 1];
  const initialBearing = findReplayPosition(0).bearing;

  routeReplayMap = new maplibregl.Map({
    container: 'route3DMap',
    center: [first.lon, first.lat],
    elevation: first.ele,
    zoom: 12,
    pitch: 68,
    bearing: initialBearing,
    maxPitch: 85,
    attributionControl: true,
    style: {
      version: 8,
      sources: {
        osm: {
          type: 'raster',
          tiles: [
            'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
            'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
            'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png'
          ],
          tileSize: 256,
          maxzoom: 19,
          attribution: '© OpenStreetMap contributors'
        },
        terrainSource: {
          type: 'raster-dem',
          url: 'https://tiles.mapterhorn.com/tilejson.json'
        },
        hillshadeSource: {
          type: 'raster-dem',
          url: 'https://tiles.mapterhorn.com/tilejson.json'
        }
      },
      layers: [
        { id: 'osm', type: 'raster', source: 'osm' },
        {
          id: 'terrain-hillshade',
          type: 'hillshade',
          source: 'hillshadeSource',
          paint: {
            'hillshade-shadow-color': '#3f3528',
            'hillshade-highlight-color': '#ffffff',
            'hillshade-exaggeration': 0.35
          }
        }
      ],
      terrain: { source: 'terrainSource', exaggeration: 1.35 },
      sky: {}
    }
  });

  routeReplayMap.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  routeReplayMap.on('load', () => {
    routeReplayMap.addSource('replay-route', {
      type: 'geojson',
      data: buildSlopeRouteFeatures(routeReplayPoints)
    });
    routeReplayMap.addSource('replay-progress', {
      type: 'geojson',
      data: replayLineFeature([first, first])
    });
    routeReplayMap.addSource('replay-marker', {
      type: 'geojson',
      data: replayPointFeature(first)
    });

    routeReplayMap.addLayer({
      id: 'replay-route-casing',
      type: 'line',
      source: 'replay-route',
      paint: {
        'line-color': '#ffffff',
        'line-width': 8,
        'line-opacity': 0.9
      }
    });
    routeReplayMap.addLayer({
      id: 'replay-route-colored',
      type: 'line',
      source: 'replay-route',
      paint: {
        'line-color': ['get', 'color'],
        'line-width': 5,
        'line-opacity': 0.95
      }
    });
    routeReplayMap.addLayer({
      id: 'replay-progress-line',
      type: 'line',
      source: 'replay-progress',
      paint: {
        'line-color': '#22d3ee',
        'line-width': 2.5,
        'line-opacity': 1
      }
    });
    routeReplayMap.addLayer({
      id: 'replay-marker-glow',
      type: 'circle',
      source: 'replay-marker',
      paint: {
        'circle-radius': 13,
        'circle-color': '#22d3ee',
        'circle-opacity': 0.28
      }
    });
    routeReplayMap.addLayer({
      id: 'replay-marker-dot',
      type: 'circle',
      source: 'replay-marker',
      paint: {
        'circle-radius': 6,
        'circle-color': '#ffffff',
        'circle-stroke-color': '#0891b2',
        'circle-stroke-width': 3
      }
    });

    routeReplayReady = true;
    document.getElementById('routeReplayLoading').classList.add('hidden');
    updateReplayAt(0);
    setTimeout(playRouteReplay, 250);
  });

  routeReplayMap.on('error', event => {
    if (!routeReplayReady) {
      const loading = document.getElementById('routeReplayLoading');
      loading.innerHTML = '<strong>No se pudo cargar el relieve 3D. Comprueba tu conexión.</strong>';
    }
    console.warn('3D replay map error:', event.error?.message || event);
  });

  const bounds = new maplibregl.LngLatBounds([first.lon, first.lat], [first.lon, first.lat]);
  routeReplayPoints.forEach(point => bounds.extend([point.lon, point.lat]));
  routeReplayMap.fitBounds(bounds, {
    padding: window.innerWidth < 640 ? 60 : 100,
    pitch: 55,
    bearing: initialBearing,
    duration: 0
  });
}

function openRouteReplay() {
  if (!parsedData?.puntos?.length || parsedData.puntos.length < 2) {
    alert('Carga o abre un track antes de iniciar el recorrido 3D.');
    return;
  }
  const webglCanvas = document.createElement('canvas');
  const supportsWebGL = Boolean(window.maplibregl?.Map && webglCanvas.getContext('webgl2'));
  if (!supportsWebGL) {
    alert('Este dispositivo no admite el mapa 3D. Prueba con Chrome actualizado.');
    return;
  }

  closeRouteReplay(false);
  routeReplayPoints = parsedData.puntos;
  const totalKm = routeReplayPoints[routeReplayPoints.length - 1].distance || 1;
  routeReplayDuration = Math.max(45000, Math.min(120000, (45 + totalKm * 0.5) * 1000));
  routeReplayElapsed = 0;
  routeReplaySpeed = Number(document.getElementById('routeReplaySpeed').value) || 1;
  routeReplayReady = false;
  routeReplayCameraBearing = null;
  routeReplayLastCameraTime = 0;
  document.getElementById('routeReplayTitle').textContent = parsedData.nombre || fileName || 'Ruta';
  document.getElementById('routeReplayLoading').classList.remove('hidden');
  document.getElementById('routeReplayLoading').innerHTML = '<span class="route-replay-spinner"></span><strong>Preparando el terreno…</strong>';
  document.getElementById('routeReplayModal').classList.remove('hidden');
  document.body.classList.add('route-replay-open');
  initializeReplayMap();
}

function closeRouteReplay(hideModal = true) {
  pauseRouteReplay();
  routeReplayReady = false;
  routeReplayCameraBearing = null;
  routeReplayLastCameraTime = 0;
  if (routeReplayMap) {
    routeReplayMap.remove();
    routeReplayMap = null;
  }
  if (hideModal) {
    document.getElementById('routeReplayModal')?.classList.add('hidden');
    document.body.classList.remove('route-replay-open');
  }
}

function initRouteReplayUI() {
  document.getElementById('btnOpenRouteReplay')?.addEventListener('click', openRouteReplay);
  document.getElementById('btnCloseRouteReplay')?.addEventListener('click', () => closeRouteReplay());
  document.getElementById('btnReplayToggle')?.addEventListener('click', toggleRouteReplay);
  document.getElementById('btnReplayRestart')?.addEventListener('click', restartRouteReplay);
  document.getElementById('btnShareRouteReplay')?.addEventListener('click', shareCurrentRouteReplay);
  document.getElementById('btnRevokeRouteReplay')?.addEventListener('click', () => {
    revokeSharedReplay().catch(error => setReplayShareStatus(error.message || 'No se pudo desactivar el enlace.', true));
  });
  document.getElementById('routeReplayProgress')?.addEventListener('input', event => seekRouteReplay(event.target.value));
  document.getElementById('routeReplaySpeed')?.addEventListener('change', event => {
    const wasPlaying = routeReplayPlaying;
    pauseRouteReplay();
    routeReplaySpeed = Number(event.target.value) || 1;
    if (wasPlaying) playRouteReplay();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !document.getElementById('routeReplayModal')?.classList.contains('hidden')) {
      closeRouteReplay();
    }
  });
  loadSharedReplayFromURL();
}
