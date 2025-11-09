// ---- ユーティリティ ----
const setStatus = (ok,msg) => {
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = msg || "";
  el.className = ok ? "ok" : "err";
};

// ---- 地図 ----
const map = L.map("map").setView([45.4642, 9.19], 13);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19, attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

let lastLayer = null;
let lastFC = null;

// ---- 描画と表 ----
function render(fc){
  if (lastLayer) map.removeLayer(lastLayer);
  lastLayer = L.geoJSON(fc, {
    style: { color:"#3388ff", weight:1 },
    onEachFeature: (f, layer)=>{
      const p = f.properties||{};
      if (p.lat!=null && p.lon!=null && p.orientation_deg!=null){
        const len = 0.0015;
        const rad = p.orientation_deg*Math.PI/180;
        const lat2 = p.lat + len*Math.cos(rad);
        const lon2 = p.lon + len*Math.sin(rad);
        L.polyline([[p.lat,p.lon],[lat2,lon2]],{color:"#d33",weight:2}).addTo(map);
      }
      layer.bindPopup(`${p.name??"(no name)"}<br>lat:${p.lat?.toFixed?.(6)} lon:${p.lon?.toFixed?.(6)}<br>`+
                      `orientation:${p.orientation_deg?.toFixed?.(1)}° / deviation:${p.deviation_deg?.toFixed?.(1)}°`);
    }
  }).addTo(map);

  const tbody = document.getElementById("tbody");
  tbody.innerHTML = "";
  const feats = fc.features||[];
  if (!feats.length){
    const tr = document.createElement("tr");
    const td = document.createElement("td"); td.colSpan=5; td.textContent="No buildings found.";
    tr.appendChild(td); tbody.appendChild(tr);
  } else {
    for (const f of feats){
      const p = f.properties||{};
      const tr = document.createElement("tr");
      const cells = [
        p.name ?? "",
        p.lat?.toFixed?.(6) ?? p.lat ?? "",
        p.lon?.toFixed?.(6) ?? p.lon ?? "",
        p.orientation_deg?.toFixed?.(1) ?? p.orientation_deg ?? "",
        p.deviation_deg?.toFixed?.(1) ?? p.deviation_deg ?? ""
      ];
      for (const v of cells){ const td=document.createElement("td"); td.textContent=v; tr.appendChild(td); }
      tbody.appendChild(tr);
    }
  }
  lastFC = fc;
}

// ---- 都市検索（Nominatim） ----
async function searchCity(q){
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, {headers:{"Accept":"application/json"}});
  if (!r.ok) throw new Error(await r.text());
  const js = await r.json();
  if (!js.length) throw new Error("City not found");
  const hit = js[0];
  const bb = hit.boundingbox; // [south, north, west, east]
  const south=+bb[0], north=+bb[1], west=+bb[2], east=+bb[3];
  map.fitBounds([[south,west],[north,east]]);
  return [west,south,east,north]; // [minx, miny, maxx, maxy]
}

// ---- Overpass 取得（buildings=church/cathedral） ----
async function fetchChurchesBBox(bbox){
  const [minx,miny,maxx,maxy]=bbox;
  const south=miny, west=minx, north=maxy, east=maxx;
  const query = `
[out:json][timeout:50];
(
  way["building"~"^(church|cathedral)$"](${south},${west},${north},${east});
  relation["building"~"^(church|cathedral)$"](${south},${west},${north},${east});
);
out body; >; out skel qt;`;

  const url = "https://overpass-api.de/api/interpreter";
  const r = await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"application/x-www-form-urlencoded; charset=UTF-8" },
    body: new URLSearchParams({ data: query })
  });
  if (!r.ok) throw new Error(`Overpass ${r.status}`);
  return await r.json();
}

// ---- OSM JSON -> GeoJSON（簡易） + 方位計算 ----
// 近似方位：ポリゴン外周の「最長辺」の方位。東=90°、北=0°。
function edgeBearingDeg(a,b){
  // Leaflet/Turfは [lon,lat]
  const brg = turf.bearing(turf.point(a), turf.point(b)); // -180..180 (東=90 北=0)
  return (brg+360)%360;
}
function mainAxisDegFromRing(ring){
  let bestLen=-1, bestDeg=0;
  for (let i=0;i<ring.length-1;i++){
    const a=ring[i], b=ring[i+1];
    const d = turf.distance(turf.point(a), turf.point(b)); // km
    if (d>bestLen){ bestLen=d; bestDeg=edgeBearingDeg(a,b); }
  }
  return bestDeg;
}
function deviationFromEW(deg){
  return Math.min(Math.abs(deg-90), Math.abs(deg-270));
}
function pointOnSurface(poly){
  const c = turf.centerOfMass(poly).geometry.coordinates; // [lon,lat]
  return {lon:c[0], lat:c[1]};
}

function osmToOrientedGeoJSON(osm){
  const nodes = {};
  for (const el of osm.elements||[]){
    if (el.type==="node"){ nodes[el.id]=[el.lon, el.lat]; }
  }
  const features = [];

  const addPoly = (coords, name) => {
    if (!coords || coords.length<4) return;
    const poly = turf.polygon([coords]);
    const ring = coords;
    const orientation = mainAxisDegFromRing(ring);
    const {lat,lon} = pointOnSurface(poly);
    features.push({
      type:"Feature",
      geometry: poly.geometry,
      properties:{
        name: name||"(church)",
        lat, lon,
        orientation_deg: orientation,
        deviation_deg: deviationFromEW(orientation)
      }
    });
  };

  for (const el of osm.elements||[]){
    if (el.type==="way"){
      const pts = (el.nodes||[]).map(id=>nodes[id]).filter(Boolean);
      if (pts.length>=3 && (pts[0][0]!==pts[pts.length-1][0] || pts[0][1]!==pts[pts.length-1][1])){
        pts.push(pts[0]);
      }
      addPoly(pts, el.tags?.name);
    }
    // relation( multipolygon ) は簡易対応：outerメンバに対応するwayがelementsに含まれている前提
    // 厳密にやるなら osm2geojson をブラウザ側で使う手もあります（今回は軽量実装）。
  }
  return { type:"FeatureCollection", features };
}

// ---- 検索連動 ----
async function searchByCityFlow(q){
  try{
    setStatus(true,"都市検索中…");
    const bbox = await searchCity(q);
    await searchByBBoxFlow(bbox);
  }catch(e){
    console.error(e);
    setStatus(false, e.message||"City search failed");
  }
}
async function searchByBBoxFlow(bbox){
  try{
    setStatus(true,"Overpass 取得中…");
    const osm = await fetchChurchesBBox(bbox);
    const fc  = osmToOrientedGeoJSON(osm);
    render(fc);
    setStatus(true, `取得: ${fc.features.length} 件`);
  }catch(e){
    console.error(e);
    setStatus(false,"Overpass fetch failed");
  }
}

// ---- エクスポート/インポート ----
function exportCSV(){
  if (!lastFC || !lastFC.features?.length){ setStatus(false,"データがありません"); return; }
  const rows = [["name","lat","lon","orientation_deg","deviation_deg"]];
  for (const f of lastFC.features){
    const p=f.properties||{};
    rows.push([p.name??"", p.lat??"", p.lon??"", p.orientation_deg??"", p.deviation_deg??""]);
  }
  const csv = rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
  const blob = new Blob([csv],{type:"text/csv"});
  const url = URL.createObjectURL(blob);
  const a=document.createElement("a"); a.href=url; a.download="church_orientation.csv"; a.click();
  URL.revokeObjectURL(url);
}
function exportGeoJSON(){
  if (!lastFC){ setStatus(false,"データがありません"); return; }
  const blob = new Blob([JSON.stringify(lastFC)],{type:"application/geo+json"});
  const url = URL.createObjectURL(blob);
  const a=document.createElement("a"); a.href=url; a.download="church_orientation.geojson"; a.click();
  URL.revokeObjectURL(url);
}
async function importGeoJSON(file){
  try{
    const text = await file.text();
    const fc = JSON.parse(text);
    render(fc);
    setStatus(true,"Imported GeoJSON");
  }catch(e){
    console.error(e);
    setStatus(false,"Import failed");
  }
}

// ---- イベント配線 ----
document.getElementById("search-form")
  .addEventListener("submit",(e)=>{e.preventDefault(); const q=document.getElementById("city").value.trim(); if(q) searchByCityFlow(q);});
document.getElementById("btn-view")
  .addEventListener("click",()=>{
    const b=map.getBounds(), sw=b.getSouthWest(), ne=b.getNorthEast();
    searchByBBoxFlow([sw.lng, sw.lat, ne.lng, ne.lat]);
  });
document.getElementById("btn-csv").addEventListener("click", exportCSV);
document.getElementById("btn-geo").addEventListener("click", exportGeoJSON);
document.getElementById("file-import")?.addEventListener("change",(ev)=>{
  const f=ev.target.files?.[0]; if (f) importGeoJSON(f); ev.target.value="";
});
