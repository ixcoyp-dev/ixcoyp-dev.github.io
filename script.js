'use strict';

/*
  Mapa interactivo con Leaflet + OpenStreetMap.
  Carga datos desde un Google Sheets público (CSV), crea marcadores con tooltip y popup.
  Incluye opción "Cómo llegar" que abre Google Maps con la dirección precargada.

  Notas:
  - Si la hoja incluye columnas Latitud y Longitud, se usan directamente.
  - Si NO incluye coordenadas, se intenta geocodificar la Dirección con Nominatim (OSM),
    guardando resultados en localStorage y aplicando un retardo entre peticiones.
  - Para un rendimiento y fiabilidad óptimos, se recomienda añadir columnas Latitud/Longitud al Sheet.
*/

// =============== CONFIGURACIÓN ==================
const DATA_MODE = 'csv'; // 'wordpress' | 'opensheet' | 'csv'
const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSmJpHUjla_aC3_3PUrju45_EGkVzpel7GPXQpRHlbnt_00ECp-tzlBWKHBZX9JRq72-d87pPdYHL1M/pub?output=csv';

// Color del pin (SVG)
const PIN_COLOR = '#272556';

// Retardo (ms) entre geocodificaciones para respetar Nominatim
const GEOCODE_DELAY_MS = 900;

// Centro y zoom inicial (se ajusta luego a los marcadores)
const INITIAL_VIEW = { center: [19.4326, -99.1332], zoom: 5 }; // CDMX aprox.

// Número de candidatos a evaluar por geocodificación
const MAX_GEOCODER_RESULTS = 5;
// Código de país preferido (ISO 3166-1 alpha-2, ej. 'MX'); deja null si no aplica
const PREFERRED_COUNTRY_CODE = null;

// =================================================

// Aviso si se abre con file:// (origen null) — puede provocar bloqueos CORS en algunos servicios
if (location.protocol === 'file:') {
  console.warn('Estás abriendo el archivo con file://. Usa un servidor local (p. ej., "python3 -m http.server") para evitar CORS por origen null.');
}

document.addEventListener('DOMContentLoaded', async () => {
  const map = L.map('map', {
    scrollWheelZoom: true,
    zoomControl: true,
  });

  // Capa base OpenStreetMap
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  map.setView(INITIAL_VIEW.center, INITIAL_VIEW.zoom);

  // Contenedor de marcadores para calcular límites
  const markersGroup = L.featureGroup().addTo(map);
  const allMarkers = [];

  // Fijar el icono por defecto para TODOS los marcadores
  L.Marker.prototype.options.icon = generatePinIcon(PIN_COLOR);

  try {
    const rows = await loadRows();
    console.info(`[MAPA] Filas cargadas: ${rows.length}`);

    // Normaliza y mapea columnas esperadas
    const places = mapRowsToSchema(rows);
    console.info(`[MAPA] Registros normalizados: ${places.length}`);

    // Crea marcadores (geocodifica si hace falta)
    let created = 0, failed = 0, geocoded = 0, usedLatLng = 0, skipped = 0;
    for (const place of places) {
      const coords = await getCoordsForPlace(place);
      if (!coords) { skipped++; continue; }
      if (toNumberOrNull(place.latitud) != null && toNumberOrNull(place.longitud) != null) usedLatLng++; else geocoded++;

      const marker = L.marker(coords, { icon: generatePinIcon(PIN_COLOR) })
        .bindTooltip(place.nombre || place.direccion || 'Ubicación', {
          direction: 'top',
          offset: [0, -28]
        })
        .bindPopup(createPopupHtml(place), { closeButton: true });

      try {
        marker.addTo(markersGroup);
        allMarkers.push({ marker, place });
        created++;
      } catch (e) {
        failed++;
        console.warn('[MAPA] Falló al agregar marcador:', e);
      }
    }

    console.info(`[MAPA] Marcadores => creados: ${created}, geocodificados: ${geocoded}, con lat/lng: ${usedLatLng}, fallidos: ${failed}, sin coords: ${skipped}`);

    // Ajusta el mapa a los marcadores
    const bounds = markersGroup.getBounds();
    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.12));
    }

    // Arregla el tamaño del mapa si el contenedor cambia (p. ej., en WordPress)
    setTimeout(() => map.invalidateSize(), 100);
    window.addEventListener('resize', () => map.invalidateSize());

    // Wire del filtro de búsqueda
    const input = document.getElementById('searchInput');
    if (input) {
      input.addEventListener('input', () => applyFilter(input.value, markersGroup, allMarkers, map));
    }
  } catch (err) {
    console.error('Error cargando datos:', err);
    alert('No se pudieron cargar los datos. Revisa el modo de datos (wordpress/opensheet/csv) y la URL configurada.');
  }
});

// ------------------- Utilidades principales -------------------

async function fetchCsv(url) {
  const res = await fetch(url, { mode: 'cors', redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentType = res.headers.get('content-type') || '';
  const text = await res.text();
  // Si Google devuelve HTML (login/preview) en lugar de CSV, avisamos claramente
  if (!contentType.includes('text/csv') && text.trim().startsWith('<')) {
    throw new Error('La respuesta no es CSV (¿usaste el enlace de "Publicar en la web" o "export?format=csv"?).');
  }
  return text;
}

async function fetchJson(url) {
  const res = await fetch(url, { mode: 'cors', redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function loadRows() {
  if (DATA_MODE === 'wordpress') {
    const csvText = await fetchCsv(WP_PROXY_URL);
    return parseCsvToObjects(csvText);
  }
  if (DATA_MODE === 'opensheet') {
    const arr = await fetchJson(OPENSHEET_URL);
    if (!Array.isArray(arr)) throw new Error('OpenSheet no devolvió un arreglo JSON');
    // Normaliza claves a lower+sin tildes
    return arr.map(rec => {
      const norm = {};
      Object.keys(rec).forEach(k => {
        norm[normalizeHeader(k)] = String(rec[k] ?? '').trim();
      });
      return norm;
    });
  }
  // DATA_MODE === 'csv'
  const csvText = await fetchCsv(SHEET_CSV_URL);
  return parseCsvToObjects(csvText);
}

function parseCsvToObjects(csvText) {
  const rows = parseCSV(csvText);
  if (rows.length === 0) return [];

  const rawHeaders = rows[0];
  const dataRows = rows.slice(1);
  const normalizedHeaders = rawHeaders.map(h => normalizeHeader(h));

  return dataRows
    .filter(r => r.some(cell => String(cell || '').trim().length > 0))
    .map(row => {
      const obj = {};
      row.forEach((cell, idx) => {
        obj[normalizedHeaders[idx] || `col_${idx}`] = String(cell || '').trim();
      });
      return obj;
    });
}

function mapRowsToSchema(objs) {
  // Mapeo flexible de encabezados -> campos esperados
  const headerMap = {
    nombre: ['nombre', 'name'],
    direccion: ['direccion', 'dirección', 'address', 'ubicacion', 'ubicación'],
    contacto: ['contacto', 'contact', 'telefono', 'teléfono', 'email', 'correo', 'web', 'sitio', 'sitio web'],
    horarios: ['horarios', 'horario', 'hours', 'schedule'],
    horarios2: ['horarios 2', 'horarios2', 'hours 2', 'schedule 2'],
    tarifaAdultos: ['tarifa adultos', 'adultos', 'tarifa general', 'precio adultos'],
    tarifaExtranjeros: ['tarifa extranjeros', 'extranjeros', 'precio extranjeros'],
    tarifaEstudiantes: ['tarifa estudiantes', 'estudiantes', 'precio estudiantes'],
    latitud: ['latitud', 'lat', 'latitude'],
    longitud: ['longitud', 'lng', 'long', 'longitude']
  };

  function pick(obj, keys) {
    for (const k of keys) {
      const nk = normalizeHeader(k);
      if (obj[nk] != null && String(obj[nk]).trim() !== '') return String(obj[nk]).trim();
    }
    return '';
  }

  return objs.map(o => ({
    nombre: pick(o, headerMap.nombre),
    direccion: pick(o, headerMap.direccion),
    contacto: pick(o, headerMap.contacto),
    horarios: pick(o, headerMap.horarios),
    horarios2: pick(o, headerMap.horarios2),
    tarifaAdultos: pick(o, headerMap.tarifaAdultos),
    tarifaExtranjeros: pick(o, headerMap.tarifaExtranjeros),
    tarifaEstudiantes: pick(o, headerMap.tarifaEstudiantes),
    latitud: pick(o, headerMap.latitud),
    longitud: pick(o, headerMap.longitud)
  }));
}

async function getCoordsForPlace(place) {
  // Usa lat/lng si están disponibles
  const lat = toNumberOrNull(place.latitud);
  const lng = toNumberOrNull(place.longitud);
  if (lat != null && lng != null) return [lat, lng];

  // Si no hay coords, intenta geocodificar la dirección
  const addr = (place.direccion || '').trim();
  if (!addr) return null;

  // Construye consulta combinando nombre + dirección para mayor contexto
  const namePart = String(place.nombre || '').trim();
  const combinedQuery = [namePart, addr].filter(Boolean).join(' ');

  const cached = getCachedGeocode(combinedQuery);
  if (cached) {
    console.log(`[MAPA] Usando coordenadas cacheadas para ${place.nombre}: ${cached.lat},${cached.lng}`);
    // Asegura el orden correcto para Leaflet
    return [cached.lat, cached.lng];
  }

  console.log(`[MAPA] Geocodificando (mejorado) para ${place.nombre}: ${combinedQuery}`);
  const geo = await geocodeBestCandidate(place, combinedQuery, { maxResults: MAX_GEOCODER_RESULTS });
  if (!geo) {
    console.warn(`[MAPA] Falló la geocodificación para: ${place.nombre}`);
    return null;
  }

  setCachedGeocode(combinedQuery, geo.lat, geo.lng);
  // Pequeño retardo entre peticiones para respetar al servicio
  await sleep(GEOCODE_DELAY_MS);
  return [geo.lat, geo.lng];
}

function createPopupHtml(place) {
  const nombreRaw = String(place.nombre || '').trim();
  const direccionRaw = String(place.direccion || '').trim();
  const contactoRaw = String(place.contacto || '').trim();
  const horariosRaw = String(place.horarios || '').trim();
  const horarios2Raw = String(place.horarios2 || '').trim();
  const taRaw = String(place.tarifaAdultos || '').trim();
  const teRaw = String(place.tarifaExtranjeros || '').trim();
  const tsRaw = String(place.tarifaEstudiantes || '').trim();

  const nombre = nombreRaw ? escapeHtml(nombreRaw) : '';
  const direccion = direccionRaw ? escapeHtml(direccionRaw) : '';
  const contacto = contactoRaw ? formatContact(contactoRaw) : '';
  const horarios = horariosRaw ? escapeHtml(horariosRaw) : '';
  const horarios2Block = horarios2Raw
    ? `<div><span class="label">Horarios 2</span><span class="value"> ${escapeHtml(horarios2Raw)}</span></div>`
    : '';
  const ta = taRaw ? escapeHtml(taRaw) : '';
  const te = teRaw ? escapeHtml(teRaw) : '';
  const ts = tsRaw ? escapeHtml(tsRaw) : '';

  const rows = [];
  if (direccion) rows.push(`<div><span class="label">Dirección</span><span class="value"> ${direccion}</span></div>`);
  if (contacto) rows.push(`<div><span class="label">Contacto</span><span class="value"> ${contacto}</span></div>`);
  if (horarios) rows.push(`<div><span class="label">Horarios</span><span class="value"> ${horarios}</span></div>`);
  if (horarios2Block) rows.push(horarios2Block);
  if (ta) rows.push(`<div><span class="label">Tarifa Adultos</span><span class="value"> ${ta}</span></div>`);
  if (te) rows.push(`<div><span class="label">Tarifa Extranjeros</span><span class="value"> ${te}</span></div>`);
  if (ts) rows.push(`<div><span class="label">Tarifa Estudiantes</span><span class="value"> ${ts}</span></div>`);

  const destinationBase = direccionRaw || nombreRaw || '';
  const destination = encodeURIComponent(destinationBase);
  const routeBtn = destinationBase
    ? `<a class="route-btn" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${destination}">Cómo llegar</a>`
    : '';

  return `
    <div class="popup-content">
      ${nombre ? `<h3>${nombre}</h3>` : ''}
      ${rows.length ? `<div class="popup-table">${rows.join('')}</div>` : ''}
      ${routeBtn}
    </div>
  `;
}

// ------------------- Geocodificación (Nominatim) -------------------

async function geocodeAddressNominatim(address) {
  try {
    const params = new URLSearchParams({
      format: 'json',
      q: address,
      addressdetails: '0',
      limit: '1'
      // Nota: Nominatim recomienda identificar la app (header User-Agent). En navegador no es posible fijarlo.
      // Usa este geocoder con moderación. Para producción, considera un servicio con API key.
    });
    const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    const best = data[0];
    const lat = toNumberOrNull(best.lat);
    const lng = toNumberOrNull(best.lon);
    if (lat == null || lng == null) return null;
    return { lat, lng };
  } catch (e) {
    console.warn('Geocoding error:', e);
    return null;
  }
}

// Geocodificación avanzada: trae varios candidatos y elige el mejor por puntuación
async function geocodeBestCandidate(place, query, { maxResults = 5 } = {}) {
  try {
    const params = new URLSearchParams({
      format: 'json',
      q: query,
      addressdetails: '1',
      limit: String(maxResults)
    });
    // Si hay BOUNDS_HINT, usar viewbox y bounded=1 para restringir resultados
    if (BOUNDS_HINT) {
      // Nominatim viewbox: left(minLon), top(maxLat), right(maxLon), bottom(minLat)
      params.set('viewbox', `${BOUNDS_HINT.minLng},${BOUNDS_HINT.maxLat},${BOUNDS_HINT.maxLng},${BOUNDS_HINT.minLat}`);
      params.set('bounded', '1');
    }
    const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;

    // Pre-procesa entrada para comparación
    const nameNorm = normalizeHeader(String(place.nombre || ''));
    const addrNorm = normalizeHeader(String(place.direccion || ''));
    const latHint = toNumberOrNull(place.latitud);
    const lngHint = toNumberOrNull(place.longitud);

    let best = null;
    let bestScore = -Infinity;
    for (const cand of data) {
      const lat = toNumberOrNull(cand.lat);
      const lng = toNumberOrNull(cand.lon);
      if (lat == null || lng == null) continue;

      const disp = String(cand.display_name || '');
      const dispNorm = normalizeHeader(disp);

      // Similitud de texto (nombre + dirección vs display_name)
      const simName = nameNorm ? jaccardSimilarity(tokenizeNormalized(nameNorm), tokenizeNormalized(dispNorm)) : 0;
      const simAddr = addrNorm ? jaccardSimilarity(tokenizeNormalized(addrNorm), tokenizeNormalized(dispNorm)) : 0;
      const textSim = Math.max(simName, simAddr);

      // Boost por país preferido
      let countryBoost = 0;
      const countryCode = String(cand?.address?.country_code || '').toUpperCase();
      if (PREFERRED_COUNTRY_CODE && countryCode === String(PREFERRED_COUNTRY_CODE).toUpperCase()) {
        countryBoost = 0.15;
      }

      // Boost por estar dentro de los límites
      let boundsBoost = 0;
      if (BOUNDS_HINT && isInsideBounds(lat, lng, BOUNDS_HINT)) {
        boundsBoost = 0.15;
      }

      // Importancia del candidato (valor de Nominatim ~ [0..1+])
      const importance = Number(cand.importance || 0);
      const importanceBoost = Math.min(Math.max(importance, 0), 1) * 0.15;

      // Si había coordenadas explícitas (lat/lng) en la fila, preferir cercanía
      let coordProximityBoost = 0;
      if (isValidLat(latHint) && isValidLng(lngHint)) {
        const km = haversineDistanceKm(latHint, lngHint, lat, lng);
        // 0km => +0.3, 50km => ~0, >100km => negativo leve
        const prox = Math.max(0, 1 - (km / 50));
        coordProximityBoost = (prox * 0.3) - (km > 100 ? 0.05 : 0);
      }

      // Puntuación final
      const score = (textSim * 0.55) + countryBoost + boundsBoost + importanceBoost + coordProximityBoost;

      if (score > bestScore) {
        bestScore = score;
        best = { lat, lng, score, raw: cand };
      }
    }

    return best ? { lat: best.lat, lng: best.lng } : null;
  } catch (e) {
    console.warn('Geocoding (bestCandidate) error:', e);
    return null;
  }
}

function getCachedGeocode(address) {
  try {
    const key = `geocodeCache::${address}`;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (typeof obj?.lat === 'number' && typeof obj?.lng === 'number') return obj;
    return null;
  } catch { return null; }
}

function setCachedGeocode(address, lat, lng) {
  try {
    const key = `geocodeCache::${address}`;
    localStorage.setItem(key, JSON.stringify({ lat, lng }));
  } catch { /* almacenamiento puede fallar en modo privado */ }
}

// ------------------- Helpers -------------------

function generatePinIcon(hexColor) {
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="25" height="41" viewBox="0 0 25 41">
  <defs>
    <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="1.5"/>
      <feOffset dx="0" dy="1" result="offsetblur"/>
      <feComponentTransfer>
        <feFuncA type="linear" slope="0.35"/>
      </feComponentTransfer>
      <feMerge>
        <feMergeNode/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  <path filter="url(#shadow)" fill="${hexColor}" d="M12.5 0C5.596 0 0 5.596 0 12.5 0 20.938 12.5 41 12.5 41S25 20.938 25 12.5C25 5.596 19.404 0 12.5 0z"/>
  <circle cx="12.5" cy="12.5" r="5.5" fill="#ffffff"/>
</svg>`;
  const url = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  return L.icon({
    iconUrl: url,
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [0, -34]
  });
}

function parseCSV(text) {
  const rows = [];
  let i = 0, field = '', row = [], inQuotes = false;
  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { // doble comilla => comilla escapada
          field += '"';
          i += 2;
          continue;
        } else {
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        field += char;
        i++;
        continue;
      }
    } else {
      if (char === '"') {
        inQuotes = true; i++; continue;
      }
      if (char === ',') {
        row.push(field); field = ''; i++; continue;
      }
      if (char === '\n') {
        row.push(field); rows.push(row); field = ''; row = []; i++; continue;
      }
      if (char === '\r') { // Windows CRLF
        i++;
        continue;
      }
      field += char; i++;
    }
  }
  // último campo/registro si termina sin salto de línea
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function normalizeHeader(h) {
  return String(h || '')
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ');
}

function toNumberOrNull(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function isValidLat(n) { return typeof n === 'number' && n >= -90 && n <= 90; }
function isValidLng(n) { return typeof n === 'number' && n >= -180 && n <= 180; }

function isInsideBounds(lat, lng, b) {
  if (!b) return true;
  return lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;
}

function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function isLikelyUrl(s) {
  try { const u = new URL(s.startsWith('http') ? s : `https://${s}`); return !!u.host; } catch { return false; }
}

function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s));
}

function telSanitize(s) {
  return String(s).replace(/[^+\d]/g, '');
}

function formatContact(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (isEmail(v)) return `<a href="mailto:${escapeHtml(v)}">${escapeHtml(v)}</a>`;
  if (isLikelyUrl(v)) {
    const href = v.startsWith('http') ? v : `https://${v}`;
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(v)}</a>`;
  }
  if (/\d{6,}/.test(v)) {
    const tel = telSanitize(v);
    return `<a href="tel:${tel}">${escapeHtml(v)}</a>`;
  }
  return escapeHtml(v);
}

// ------------------- Filtro de búsqueda -------------------

function applyFilter(query, group, allMarkers, map) {
  const q = normalizeHeader(String(query || ''));
  let visible = 0;
  const tempGroup = L.featureGroup();

  for (const { marker, place } of allMarkers) {
    const haystack = normalizeHeader(`${place.nombre || ''} ${place.direccion || ''}`);
    const match = q.length === 0 || haystack.includes(q);
    if (match) {
      tempGroup.addLayer(marker);
      visible++;
    }
  }

  // Reemplaza el contenido del grupo con los visibles
  group.clearLayers();
  tempGroup.eachLayer(l => group.addLayer(l));

  // Ajusta vista
  const b = group.getBounds();
  if (visible > 0 && b.isValid()) {
    map.fitBounds(b.pad(0.12));
  } else {
    map.setView(INITIAL_VIEW.center, INITIAL_VIEW.zoom);
  }
}

// ------------------- Similaridad de texto -------------------

function tokenizeNormalized(s) {
  return String(s)
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length > 1);
}

function jaccardSimilarity(tokensA, tokensB) {
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}