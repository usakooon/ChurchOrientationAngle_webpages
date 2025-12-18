/* ========= 設定 ========= */
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const OVERPASS = "https://overpass-api.de/api/interpreter";
// 必要に応じてミラー: https://overpass.kumi.systems/api/interpreter

// 先頭の定数定義（NOMINATIM, OVERPASS など）はそのまま残す
document.addEventListener('DOMContentLoaded', () => {

/* ========= DOM ========= */
const mapDiv = document.getElementById("map");
const cityInput = document.getElementById("city");
const cityBtn = document.getElementById("btn-city");
const bboxBtn = document.getElementById("btn-bbox");
const statusEl = document.getElementById("status");
const tableBody = document.getElementById("table-body");
const btnExportCsv = document.getElementById("btn-export-csv");
const btnExportGeojson = document.getElementById("btn-export-geojson");
const fileImport = document.getElementById("file-import");
const modeSelect = document.getElementById("mode");

/* ========= Leaflet ========= */
const map = L.map(mapDiv, { zoomControl: true }).setView([45.4642, 9.19], 13);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const polyLayer = L.geoJSON([], { style: { color: "#cc3333", weight: 1, fillOpacity: 0.2 }}).addTo(map);
const arrowLayer = L.layerGroup().addTo(map);
const pointLayer = L.layerGroup().addTo(map);
const entranceLayer = L.layerGroup().addTo(map);


let lastFeatures = []; // 計算済みのFeatureCollectionのfeatures配列
let selectedId = null;
let layerIndex = new Map(); // id -> { poly, pt, arrow, rowEl }

/* ========= ユーティリティ ========= */
// 文字列名をいい感じに（OSMタグ name / church, etc.）
function guessName(props = {}) {
  return props.name || props["name:en"] || props["name:it"] || props["name:ja"] || props["addr:housename"] || "(no name)";
}

// MultiPolygon / Polygon から全頂点を抽出（PCA用）
function collectCoords(geom) {
  const out = [];
  if (!geom) return out;
  if (geom.type === "Polygon") {
    geom.coordinates.forEach(ring => ring.forEach(([x,y]) => out.push([x,y])));
  } else if (geom.type === "MultiPolygon") {
    geom.coordinates.forEach(poly => poly.forEach(ring => ring.forEach(([x,y]) => out.push([x,y]))));
  }
  return out;
}

// PCA: 2D点群の共分散→最大固有ベクトルの角度（北=0°に合わせるため90°ずらす）
function pcaOrientationDeg(coordsLonLat) {
  // lon/lat をメートルに近い単位へ簡易換算（緯度経度のスケール差を軽減）
  // 近傍メルカトルっぽく：lon→cos(lat0)で補正
  if (coordsLonLat.length < 2) return 0;
  const lat0 = coordsLonLat.reduce((s, c) => s + c[1], 0) / coordsLonLat.length;
  const kx = Math.cos(lat0 * Math.PI / 180.0);

  const pts = coordsLonLat.map(([lon, lat]) => [lon * kx, lat]);
  const n = pts.length;
  let mx = 0, my = 0;
  pts.forEach(([x,y]) => { mx += x; my += y; });
  mx /= n; my /= n;

  let sxx=0, syy=0, sxy=0;
  pts.forEach(([x,y]) => {
    const dx = x - mx, dy = y - my;
    sxx += dx*dx; syy += dy*dy; sxy += dx*dy;
  });
  sxx /= n; syy /= n; sxy /= n;

  // 共分散行列 [[sxx, sxy],[sxy, syy]] の固有ベクトル（最大）
  const tr = sxx + syy;
  const det = sxx*syy - sxy*sxy;
  const tmp = Math.sqrt(Math.max(0, tr*tr/4 - det));
  const lambda1 = tr/2 + tmp; // 最大固有値
  // (A - λI)v = 0 → ベクトル
  let vx = (lambda1 - syy);
  let vy = sxy;
  if (Math.abs(vx) < 1e-9 && Math.abs(vy) < 1e-9) { vx = sxy; vy = (lambda1 - sxx); }
  const angRadX = Math.atan2(vy, vx); // x軸基準の角
  // 地図方位（北=0°, 東=90°）に合わせる：x(東)基準→北基準へ  角度(°)=90-θx
  let deg = (90 - (angRadX * 180/Math.PI)) % 360;
  if (deg < 0) deg += 360;
  return deg;
}

// deviation（東西からの偏差）
function eastWestDeviationDeg(theta) {
  const d1 = Math.abs(theta - 90);
  const d2 = Math.abs(theta - 270);
  return Math.min(d1, d2);
}

// 中心点（面の中心を安全に）
function safeCentroid(feature) {
  try {
    const c = turf.centerOfMass(feature);
    return c.geometry.coordinates; // [lon, lat]
  } catch {
    const b = turf.centroid(feature);
    return b.geometry.coordinates;
  }
}

// Simple arrow: 中心点から orientation 方向へ一定長のライン
function makeArrowLine([lon,lat], orientationDeg, scaleMeters=60) {
  // orientationDeg は北=0°。葉っぱにあわせて方位→dx,dy計算
  const rad = (90 - orientationDeg) * Math.PI/180.0; // 東基準へ換算
  // 緯度経度→メートル近似換算（小距離）
  const R = 6378137.0;
  const dLat = (scaleMeters * Math.sin(rad)) / R;
  const dLon = (scaleMeters * Math.cos(rad)) / (R * Math.cos(lat * Math.PI/180));
  const lat2 = lat + (dLat * 180/Math.PI);
  const lon2 = lon + (dLon * 180/Math.PI);
  return [[lat, lon], [lat2, lon2]]; // Leaflet polyline は [lat,lon]
}

// CSV文字列
function toCSV(rows) {
  const header = ["name","lat","lon","orientation_deg","deviation_deg"];
  const body = rows.map(r => [r.name, r.lat, r.lon, r.orientation_deg.toFixed(1), r.deviation_deg.toFixed(1)]);
  return [header, ...body].map(a => a.map(v => `"${String(v).replaceAll('"','""')}"`).join(",")).join("\n");
}

// ダウンロード
function downloadBlob(data, filename, mime) {
  const blob = new Blob([data], {type: mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  a.remove(); URL.revokeObjectURL(url);
}

// 2点間の方位角（北=0°, 東=90°）
function bearingDeg(lon1, lat1, lon2, lat2) {
  const toRad = (d) => d * Math.PI / 180;
  const toDeg = (r) => r * 180 / Math.PI;

  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  let θ = toDeg(Math.atan2(y, x)); // -180..180 (北基準)
  θ = (θ + 360) % 360;
  return θ;
}
  
/* ========= データ取得 ========= */
async function geocodeCity(q) {
  setStatus(`Nominatim検索中: ${q}…`);
  const url = new URL(NOMINATIM);
  url.search = new URLSearchParams({
    q, format: "json", addressdetails: 0, limit: 1, polygon_geojson: 0
  }).toString();
  const res = await fetch(url.toString(), { headers: { "Accept-Language": "en", "User-Agent": "church-orientation-explorer" } });
  const arr = await res.json();
  if (!arr.length) throw new Error("City not found");
  const item = arr[0];
  const lat = parseFloat(item.lat), lon = parseFloat(item.lon);
  // bbox: [w, s, e, n]
  const bbox = (item.boundingbox||[]).map(parseFloat);
  return { lat, lon, bbox: [parseFloat(item.boundingbox[2]), parseFloat(item.boundingbox[0]), parseFloat(item.boundingbox[3]), parseFloat(item.boundingbox[1])] };
}

function overpassQueryForBBox(bbox /* [s, w, n, e] ではなく Overpassは南,西,北,東 */) {
  const [south, west, north, east] = bbox;
  return `
[out:json][timeout:60];
(
  way["building"~"^(church|cathedral)$"](${south},${west},${north},${east});
  relation["building"~"^(church|cathedral)$"](${south},${west},${north},${east});
);
out body;
>;
out skel qt;
`;
}

async function fetchOverpass(bboxSWNE) {
  setStatus("Overpass取得中…");
  const q = overpassQueryForBBox(bboxSWNE);
  const res = await fetch(OVERPASS, {
    method: "POST",
    headers: {"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"},
    body: new URLSearchParams({ data: q }).toString()
  });
  if (!res.ok) throw new Error(`Overpass error: ${res.status}`);
  const json = await res.json();
  return osmtogeojson(json); // 下で定義
}

// ========= OSM JSON → GeoJSON（修正版） =========
// Overpassの出力（node / way / relation）を安全にGeoJSON化します
function osmtogeojson(osm) {
  const elements = Array.isArray(osm.elements) ? osm.elements : [];

  // --- node一覧をマップに登録 ---
  const nodes = new Map();
  for (const el of elements) {
    if (el.type === "node") nodes.set(el.id, [el.lon, el.lat]);
  }

  // --- way一覧をマップに登録 ---
  const ways = new Map();
  const wayTags = new Map();
  for (const el of elements) {
    if (el.type === "way") {
      const coords = (el.nodes || []).map(id => nodes.get(id)).filter(Boolean);
      ways.set(el.id, coords);
      wayTags.set(el.id, el.tags || {});
    }
  }

  // --- ヘルパー関数 ---
  const isClosed = (ring) => {
    if (!ring || ring.length < 4) return false;
    const a = ring[0], b = ring[ring.length - 1];
    return a && b && a[0] === b[0] && a[1] === b[1];
  };

  const isChurch = (tags) =>
    tags && typeof tags.building === "string" &&
    /^(church|cathedral)$/i.test(tags.building);

  const features = [];

  // --- 1) 単独のwayをPolygonに変換 ---
  for (const [id, ring] of ways) {
    const tags = wayTags.get(id) || {};
    if (!isChurch(tags)) continue;
    if (isClosed(ring)) {
      features.push({
        type: "Feature",
        properties: tags,
        geometry: { type: "Polygon", coordinates: [ring] }
      });
    }
  }

  // --- 2) relation(multipolygon)をMultiPolygonに変換 ---
  for (const el of elements) {
    if (el.type !== "relation") continue;
    const tags = el.tags || {};
    if (tags.type !== "multipolygon" || !isChurch(tags)) continue;

    const outers = [];
    for (const m of (el.members || [])) {
      if (m.type !== "way") continue;
      const ring = ways.get(m.ref); // refでwayを探す
      if (m.role === "outer" && isClosed(ring)) outers.push(ring);
    }

    if (outers.length) {
      features.push({
        type: "Feature",
        properties: tags,
        geometry: {
          type: "MultiPolygon",
          coordinates: outers.map(o => [o]) // innerは無視
        }
      });
    }
  }

  // --- 出力 ---
  return { type: "FeatureCollection", features };
}


/* ========= 計算・描画 ========= */
function computeOrientationFeatures(fc) {
  const mode = modeSelect?.value || "altar";
  const rows = [];

  fc.features.forEach(f => {
    const props = f.properties || {};
    const name = guessName(props);

    // 中心
    const center = safeCentroid(f); // [lon,lat]
    const lonC = center[0], latC = center[1];

    // PCA
    const coords = collectCoords(f.geometry);
    const pcaDeg = (coords.length >= 4) ? pcaOrientationDeg(coords) : 0;

    // 入口（もしあれば）
    const hasEntrance = Number.isFinite(+props.entrance_lon) && Number.isFinite(+props.entrance_lat);
    const entranceDeg = hasEntrance
      ? bearingDeg(lonC, latC, +props.entrance_lon, +props.entrance_lat)
      : null;

    // 祭壇（入口の反対）
    const altarDeg = (entranceDeg != null) ? (entranceDeg + 180) % 360 : null;

    // 採用する方位
    let theta;
    if (mode === "entrance" && entranceDeg != null) theta = entranceDeg;
    else if (mode === "altar" && altarDeg != null) theta = altarDeg;
    else theta = pcaDeg;

    const dev = eastWestDeviationDeg(theta);

    rows.push({
      id: props["@id"] || props.osm_id || `${name}-${lonC.toFixed(6)}-${latC.toFixed(6)}`,
      name,
      lat: latC,
      lon: lonC,
      orientation_deg: theta,
      deviation_deg: dev,
      entrance_deg: entranceDeg,
      altar_deg: altarDeg,
      pca_deg: pcaDeg,
      geometry: f.geometry,
      raw: f
    });
  });

  return rows;
}

function selectFeatureById(id) {
  selectedId = id;

  // 表の選択表示
  for (const [_, obj] of layerIndex) {
    if (obj.rowEl) obj.rowEl.classList.toggle("selected", obj.id === id);
  }

  // ポリゴン強調（該当だけスタイル変更）
  for (const [_, obj] of layerIndex) {
    if (obj.poly) {
      obj.poly.setStyle(obj.id === id
        ? { color: "#0066ff", weight: 3, fillOpacity: 0.25 }
        : { color: "#cc3333", weight: 1, fillOpacity: 0.2 }
      );
      if (obj.id === id) obj.poly.bringToFront();
    }
  }

  // ズーム＆ポップアップ/ツールチップ（任意）
  const hit = layerIndex.get(id);
  if (hit?.poly) map.fitBounds(hit.poly.getBounds(), { padding: [30, 30] });
}

function renderAll(rows) {
  // レイヤ初期化
  polyLayer.clearLayers();
  arrowLayer.clearLayers();
  pointLayer.clearLayers();
  entranceLayer.clearLayers();
  tableBody.innerHTML = "";
  layerIndex = new Map();

  const frag = document.createDocumentFragment();

  rows.forEach(r => {
    // --- Polygon（1件ずつ追加して参照を保持）---
    const poly = L.geoJSON({
      type: "Feature",
      properties: { id: r.id, name: r.name },
      geometry: r.geometry
    }, {
      style: { color: "#cc3333", weight: 1, fillOpacity: 0.2 }
    }).addTo(polyLayer);

    poly.on("click", () => selectFeatureById(r.id));

    // --- Arrow ---
    const line = makeArrowLine([r.lon, r.lat], r.orientation_deg, 70);
    const arrow = L.polyline(line, { color:"#d22", weight:2 }).addTo(arrowLayer);
    arrow.on("click", () => selectFeatureById(r.id));

    // --- Point + hover tooltip ---
    const label = [
      `<b>${r.name}</b>`,
      `θ: ${r.orientation_deg.toFixed(1)}°`,
      `dev: ${r.deviation_deg.toFixed(1)}°`
    ].join("<br/>");

    const pt = L.circleMarker([r.lat, r.lon], {
      radius: 4,
      color: "#204",
      fillColor: "#fff",
      fillOpacity: 1
    })

    .bindTooltip(label, { direction: "top", className: "mylabel", sticky: true })
    .addTo(pointLayer);

    pt.on("click", () => selectFeatureById(r.id));

    if (r.entrance_deg != null && Number.isFinite(r.raw?.properties?.entrance_lat) && Number.isFinite(r.raw?.properties?.entrance_lon)) {
    const elat = +r.raw.properties.entrance_lat;
    const elon = +r.raw.properties.entrance_lon;
  
    L.circleMarker([elat, elon], {
      radius: 4,
      color: "#00a000",
      fillColor: "#00ff00",
      fillOpacity: 0.9
    })
    .bindTooltip(`<b>Entrance</b><br/>${r.name}<br/>${r.entrance_deg.toFixed(1)}°`, {sticky:true})
    .addTo(entranceLayer);
   }

    // --- Table row ---
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.name}</td>
      <td>${r.lat.toFixed(6)}</td>
      <td>${r.lon.toFixed(6)}</td>
      <td>${r.orientation_deg.toFixed(1)}</td>
      <td>${r.deviation_deg.toFixed(1)}</td>
    `;
    tr.addEventListener("click", () => selectFeatureById(r.id));
    frag.appendChild(tr);

    // --- 参照を保存（選択時に使う）---
    layerIndex.set(r.id, { id: r.id, poly, pt, arrow, rowEl: tr });
  });

  tableBody.appendChild(frag);
  lastFeatures = rows;
}



function setStatus(msg, cls="") { statusEl.textContent = msg; statusEl.className = `status ${cls}`; }

/* ========= ハンドラ ========= */
async function searchByCity() {
  try {
    const q = cityInput.value.trim();
    if (!q) return;
    setStatus(`"${q}" を検索中…`, "info");
    const { lat, lon, bbox } = await geocodeCity(q);
    map.fitBounds([[bbox[1], bbox[0]],[bbox[3], bbox[2]]]); // [south,west]→[north,east]
    await runOverpassForCurrentView();
  } catch (e) {
    console.error(e);
    setStatus(`都市検索エラー: ${e.message || e}`, "error");
  }
}

async function runOverpassForCurrentView() {
  try {
    const b = map.getBounds();
    // Overpassのbboxは (south, west, north, east)
    const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
    const fc = await fetchOverpass(bbox);
    const rows = computeOrientationFeatures(fc);
    renderAll(rows);
    setStatus(`取得: ${rows.length} 件`, "success");
  } catch (e) {
    console.error(e);
    setStatus(`Overpass取得失敗: ${e.message || e}`, "error");
  }
}

function exportCSV() {
  if (!lastFeatures.length) return alert("データがありません。まず検索してください。");
  const csv = toCSV(lastFeatures);
  downloadBlob(csv, "church_orientation.csv", "text/csv;charset=utf-8");
}

function exportGeoJSON() {
  if (!lastFeatures.length) return alert("データがありません。まず検索してください。");
  const fc = {
    type: "FeatureCollection",
    features: lastFeatures.map(r => ({
      type:"Feature",
      properties: {
        name: r.name,
        lat: r.lat, lon: r.lon,
        orientation_deg: r.orientation_deg,
        deviation_deg: r.deviation_deg
      },
      geometry: r.geometry
    }))
  };
  downloadBlob(JSON.stringify(fc), "church_orientation.geojson", "application/geo+json");
}

function importGeoJSON(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const geo = JSON.parse(reader.result);
      if (geo.type !== "FeatureCollection") throw new Error("FeatureCollection が必要です");
      const polys = {
        type: "FeatureCollection",
        features: geo.features.filter(f => ["Polygon","MultiPolygon"].includes(f.geometry?.type))
      };
      const rows = computeOrientationFeatures(polys);
      renderAll(rows);
      if (rows.length) map.fitBounds(L.geoJSON(polys).getBounds());
      setStatus(`ローカルGeoJSONから ${rows.length} 件`, "success");
    } catch (e) {
      console.error(e);
      alert("インポート失敗: " + e.message);
    }
  };
  reader.readAsText(file, "utf-8");
}

/* ========= イベント ========= */
cityBtn.addEventListener("click", searchByCity);
bboxBtn.addEventListener("click", runOverpassForCurrentView);
cityInput.addEventListener("keydown", (e) => { if (e.key === "Enter") searchByCity(); });

btnExportCsv.addEventListener("click", exportCSV);
btnExportGeojson.addEventListener("click", exportGeoJSON);
fileImport.addEventListener("change", (e) => { const f = e.target.files?.[0]; if (f) importGeoJSON(f); });

/* 初期 */
setStatus("都市名を入れるか、地図を移動して『現在の表示範囲で検索』を押してください。");

}); // DOMContentLoaded end

modeSelect.addEventListener("change", () => {
  runOverpassForCurrentView(); // 表・矢印・ツールチップが新しいmodeで描画される
});

