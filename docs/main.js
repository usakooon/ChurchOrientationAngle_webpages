// docs/main.js
const map = L.map('map').setView([45.4642, 9.19], 14);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map);

const rows = document.getElementById('rows');
const statusEl = document.getElementById('status');
const btnCity = document.getElementById('btn-city');
const btnBbox = document.getElementById('btn-bbox');
const btnCsv = document.getElementById('btn-csv');
const btnGeo = document.getElementById('btn-geojson');
const inpCity = document.getElementById('city');
const chkEntrance = document.getElementById('chk-entrance');
const fileInput = document.getElementById('file');

let featureLayer = L.layerGroup().addTo(map);
let roadLayer = null;          // 入口推定用の道路
let lastFeatures = [];         // export 用

btnCity.addEventListener('click', searchCity);
btnBbox.addEventListener('click', fetchBbox);
btnCsv.addEventListener('click', exportCsv);
btnGeo.addEventListener('click', exportGeo);
fileInput.addEventListener('change', importGeoJSON);
inpCity.addEventListener('keydown', e => { if (e.key === 'Enter') searchCity(); });

function setStatus(t){ statusEl.textContent = t || ''; }

// ---- 1) 都市検索（Nominatim）
async function searchCity(){
  const q = inpCity.value.trim();
  if(!q) return;
  setStatus('都市検索中…');
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}`;
  const res = await fetch(url,{headers:{'Accept-Language':'ja'}});
  const js = await res.json();
  if(!js.length){ setStatus('見つかりません'); return; }
  const b = js[0].boundingbox.map(parseFloat); // [s,n,w,e]
  const south=b[0], north=b[1], west=b[2], east=b[3];
  map.fitBounds([[south,west],[north,east]]);
  setStatus('表示範囲で Overpass 取得中…');
  await fetchBbox();
}

// ---- 2) 表示範囲で Overpass
async function fetchBbox(){
  featureLayer.clearLayers(); rows.innerHTML=''; lastFeatures=[];
  const [[south,west],[north,east]] = [map.getBounds().getSouthWest(), map.getBounds().getNorthEast()]
    .map(c=>[c.lat,c.lng]);

  // 2-1 教会（way+relation）＋ place_of_worship 点 取得
  const overpass = `
    [out:json][timeout:40];
    (
      way["building"~"^(church|cathedral)$"](${south},${west},${north},${east});
      relation["building"~"^(church|cathedral)$"](${south},${west},${north},${east});
      node["amenity"="place_of_worship"](${south},${west},${north},${east});
    );
    out body; >; out skel qt;`;
  const gj = await overpassToGeoJSON(overpass);

  // 2-2 入口推定用：道路を取得（必要なときだけ）
  let roads = null;
  if (chkEntrance.checked){
    const overpassRoad = `
      [out:json][timeout:40];
      way["highway"](${south},${west},${north},${east});
      out geom;`;
    roads = await overpassToGeoJSON(overpassRoad);
    if(roadLayer) map.removeLayer(roadLayer);
    roadLayer = L.geoJSON(roads, {style:{color:'#999',weight:1,opacity:0.3}}).addTo(map);
  } else if (roadLayer){
    map.removeLayer(roadLayer); roadLayer=null;
  }

  // 2-3 可視化
  renderFeatures(gj, roads);
  setStatus(`取得：${lastFeatures.length} 件`);
}

// ---- OSM → GeoJSON
async function overpassToGeoJSON(query){
  const res = await fetch('https://overpass-api.de/api/interpreter',{
    method:'POST', headers:{'Content-Type':'text/plain'}, body:query
  });
  const data = await res.json();
  return osmtogeojson(data); // relations含む
}

// ---- 3) 主軸計算（PCA）と描画
function renderFeatures(gj, roads){
  L.geoJSON(gj, {
    filter: f => ['Polygon','MultiPolygon','Point'].includes(f.geometry.type),
    onEachFeature: (f, layer) => {
      if (f.geometry.type === 'Point') {
        // ポリゴンが無い場所は点で代替
        const p = f.geometry.coordinates;
        const name = (f.properties.tags&&f.properties.tags.name) || f.properties.name || '(no name)';
        const row = addRow({name, lat:p[1], lon:p[0], orientation:null, deviation:null});
        layer.bindPopup(name);
        lastFeatures.push({type:'Feature', geometry:f.geometry, properties:{name}});
        layer.addTo(featureLayer);
        return;
      }

      const poly = turf.booleanClockwise(f.geometry.coordinates[0]) ? f : f; // そのまま
      const center = turf.centerOfMass(poly).geometry.coordinates; // [lon,lat]
      const angle = principalAxisDeg(poly); // 0=東, 90=北のatan2系 → 後で北0°系に変換

      // 北0°（東=90°）に直す
      let orientation = (450 - angle) % 360; // 描画座標→方位角
      // 道路ヒューリスティックで入口/祭壇方向に回す（入口→祭壇を矢印に）
      if (roads) orientation = altarBearingByRoad(poly, roads, orientation);

      const deviation = Math.min(
        Math.abs(orientation - 90), Math.abs(orientation - 270)
      );

      // 短い矢印（建物面積に比例）
      const area = Math.max(turf.area(poly), 1);
      const len = Math.max(Math.sqrt(area) * 0.2, 12); // m相当→緯度経度へ簡易換算
      const seg = forwardSegment(center[1], center[0], orientation, len);

      // 描画
      L.geoJSON(poly,{style:{color:'#8b5',weight:1,fillOpacity:0.15}}).addTo(featureLayer);
      L.polyline(seg, {color:'red',weight:1.5,opacity:0.8}).addTo(featureLayer);

      const name = f.properties.name || (f.properties.tags && f.properties.tags.name) || '(no name)';
      addRow({name, lat:center[1].toFixed(6), lon:center[0].toFixed(6),
              orientation:orientation.toFixed(1), deviation:deviation.toFixed(1)});
      lastFeatures.push({type:'Feature', geometry:poly.geometry,
                         properties:{name, orientation_deg:orientation, deviation_deg:deviation}});
    }
  });
}

// ---- PCAで主軸角度（度）を返す：0=東向き
function principalAxisDeg(poly){
  const coords = (poly.geometry.type==='Polygon' ? poly.geometry.coordinates[0]
                    : poly.geometry.coordinates[0][0]); // MultiPolygon→最初の輪郭
  // 中心
  let cx=0, cy=0; for (const [x,y] of coords){ cx+=x; cy+=y; }
  cx/=coords.length; cy/=coords.length;
  // 共分散
  let sxx=0, syy=0, sxy=0;
  for (const [x,y] of coords){
    const dx=x-cx, dy=y-cy;
    sxx+=dx*dx; syy+=dy*dy; sxy+=dx*dy;
  }
  // 主成分（最大固有値）の角度
  const theta = 0.5*Math.atan2(2*sxy, (sxx - syy)); // ラジアン（x軸基準）
  const deg = (theta*180/Math.PI + 360)%360; // 0=東
  // 180°反転は同じ主軸なので0-180に折る
  return (deg>=180)?(deg-180):deg;
}

// ---- 入口/祭壇推定：道路に最も近い辺＝入口側 → 矢印は反対を向く
function altarBearingByRoad(poly, roads, fallback){
  try{
    const c = turf.centerOfMass(poly).geometry.coordinates;
    const base = principalAxisDeg(poly);
    const ortho = (base+90)%180; // 直交方向

    // 中心から主軸＆直交方向に小さな辺を2本ずつ（4辺候補）
    const candidates = [base, (base+180)%360, ortho, (ortho+180)%360].map(b=>{
      const seg = forwardSegment(c[1], c[0], (450-b)%360, 15); // 短辺
      return turf.lineString(seg.map(([lat,lon])=>[lon,lat]));
    });

    // 道路（LineString/MultiLineString）全体との最短距離
    let minDist=Infinity, bestIdx=0;
    turf.flattenEach(roads, g=>{
      for (let i=0;i<candidates.length;i++){
        const d = turf.pointToLineDistance(turf.center(candidates[i]), g, {units:'meters'});
        if (d<minDist){ minDist=d; bestIdx=i; }
      }
    });

    // bestIdx が入口側 → 反対を祭壇方向として採用
    const chosen = candidates[bestIdx];
    const coords = chosen.geometry.coordinates;
    const v = [coords[1][0]-coords[0][0], coords[1][1]-coords[0][1]]; // lon,lat差
    const bearEast0 = Math.atan2(v[1], v[0]) * 180/Math.PI;  // 東=0
    const cardinal = (450 - bearEast0 + 180) % 360; // 入口→祭壇（反対向き）
    return cardinal;
  }catch(e){
    return fallback;
  }
}

// ---- 中心(lat,lon)・方位角（北0°）・長さ(m) → 線分（Leaflet座標）
// 簡易換算：緯度1度 ≒ 111_000m、経度は緯度で補正
function forwardSegment(lat, lon, bearing, meters){
  const rad = Math.PI/180;
  const dLat = (meters/111000)*Math.cos(bearing*rad);
  const dLon = (meters/(111000*Math.cos(lat*rad)))*Math.sin(bearing*rad);
  return [[lat - dLat/2, lon - dLon/2], [lat + dLat/2, lon + dLon/2]];
}

// ---- 表の行追加
function addRow({name,lat,lon,orientation,deviation}){
  const tr = document.createElement('tr');
  const cells = [name, lat, lon, orientation ?? '-', deviation ?? '-'];
  cells.forEach(v=>{ const td=document.createElement('td'); td.textContent=v; tr.appendChild(td); });
  rows.appendChild(tr);
  return tr;
}

// ---- Export
function exportCsv(){
  if(!lastFeatures.length) return alert('データがありません');
  const header = ['name','lat','lon','orientation_deg','deviation_deg'];
  const lines = [header.join(',')];
  lastFeatures.forEach(f=>{
    const c = turf.centerOfMass(f).geometry.coordinates;
    lines.push([
      JSON.stringify(f.properties.name||''),
      c[1].toFixed(6), c[0].toFixed(6),
      (f.properties.orientation_deg??''),
      (f.properties.deviation_deg??'')
    ].join(','));
  });
  download('church_orientation.csv', lines.join('\n'));
}

function exportGeo(){
  if(!lastFeatures.length) return alert('データがありません');
  const blob = new Blob([JSON.stringify({type:'FeatureCollection',features:lastFeatures})],{type:'application/json'});
  download('church_orientation.geojson', blob);
}

function download(name, data){
  const blob = data instanceof Blob ? data : new Blob([data],{type:'text/plain'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download=name; a.click();
  URL.revokeObjectURL(url);
}

// ---- インポート（GeoJSON）
function importGeoJSON(ev){
  const f = ev.target.files[0]; if(!f) return;
  const r = new FileReader();
  r.onload = () => {
    const gj = JSON.parse(r.result);
    L.geoJSON(gj,{style:{color:'#36c',weight:1,fillOpacity:0.1}}).addTo(featureLayer);
    setStatus('インポート完了');
  };
  r.readAsText(f);
}
