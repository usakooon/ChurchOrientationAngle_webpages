# 🕍 Church Orientation Angle — Web Edition  
*教会建築の方位角をWeb上で可視化するアプリケーション*

---

## 🌐 Overview / 概要  

**Church Orientation Angle** is a fully client-side web application that analyzes and visualizes the **orientation (azimuth)** of church buildings using data from **OpenStreetMap (OSM)**.  
Pythonなどのバックエンドを使わず、**HTML / CSS / JavaScriptだけで構成されたWebアプリ**です。  
GitHub Pages上で直接動作し、都市を検索して地図上に教会の建物の向きを自動表示します。  

---

## 🧭 Main Features / 主な機能  

- 🌍 **City Search / 都市検索**  
  Search for a city (e.g., *Milano*, *Rome*, *Tokyo*) using the **Nominatim API**, and automatically zoom to it.  
  → Nominatim APIを利用して都市名から地図中心を取得。  

- 🕋 **Building Extraction & Orientation Analysis / 教会建物の抽出と方位角解析**  
  - Retrieves polygons tagged as `building=church` or `building=cathedral` from the **Overpass API**.  
  - 各建物のポリゴン形状から**長辺方向（主軸）を算出**し、北を0°とした時計回りの角度を求めます。  
  - Calculates `orientation_deg` (0° = north) and deviation from east–west axis (`deviation_deg`).  

- 🧮 **Map Visualization / 地図上での可視化**  
  - Displays each church footprint as a polygon with a **red directional arrow** showing its dominant axis.  
  - 表の中で、名称・緯度経度・方位角・東西偏差を一覧で表示。  

- 📂 **Data Import & Export / データの入出力**  
  - Export analyzed data as **CSV** or **GeoJSON**.  
  - Import your own **GeoJSON** to visualize and analyze your dataset directly.  

- 💻 **Runs Entirely in the Browser / 完全フロントエンド実装**  
  - Works on GitHub Pages — no server, no installation required.  
  - FastAPIなどのバックエンドは不要。すべてブラウザ上で処理します。  

---

## ⚙️ Technologies / 使用技術  

| Category / 分野 | Library / 使用技術 |
|------------------|--------------------|
| Map Rendering / 地図描画 | [Leaflet.js](https://leafletjs.com/) |
| Geometric Computation / 幾何計算 | [Turf.js](https://turfjs.org/) |
| Geocoding / ジオコーディング | [Nominatim API](https://nominatim.org/release-docs/latest/api/Search/) |
| Data Source / データ取得 | [Overpass API](https://overpass-api.de/) |
| Hosting / ホスティング | [GitHub Pages](https://pages.github.com/) |
| Language / 言語 | HTML5, CSS3, Vanilla JavaScript |

---

## 🧠 Research Background / 研究背景  

In Christian architectural tradition, churches are often designed so that the **altar faces east** — symbolizing sunrise and resurrection.  
キリスト教建築では、**祭壇が東を向く**ように建てられることが多いですが、  
都市の地形や道路網などの制約によって、必ずしも東向きにならないケースも存在します。  

This project aims to explore **how urban form affects church orientation**,  
都市構造が宗教建築の方位にどのような影響を与えているのかを可視化するために開発されました。  

例えば、街路に面した教会はその方向を入口としており、祭壇方向が変化することもあります。  
このWebアプリでは、そうした**都市と信仰の空間的関係性**を定量的に観察できます。  

---

## 📊 Methodology / 解析手法  

1. **Retrieve / 取得** — Overpass APIから`building=church`と`building=cathedral`を抽出  
2. **Analyze / 解析** — 建物ポリゴンの点群を主成分分析（PCA）して主軸方向を求める  
3. **Compute / 計算** — 北を0°として方位角(`orientation_deg`)を算出  
4. **Deviation / 偏差** — 東西軸(90°/270°)からの偏差(`deviation_deg`)を計算  
5. **Visualize / 表示** — ポリゴンと赤い矢印で地図上に描画  

---

## 🗺️ Demo / デモ  

👉 **Live Web App:**  
[https://usakooon.github.io/ChurchOrientationAngle_webpages/](https://usakooon.github.io/ChurchOrientationAngle_webpages/)

---

## 💡 Future Work / 今後の展望  

- 🚪 Estimate **entrance–altar direction / 入口と祭壇方向の自動推定**（道路近接方向などから）  
- 🧱 Improve polygon accuracy for complex churches（ポリゴンの精度補正）  
- 📈 Visualize **orientation distributions** per city using rose diagrams（都市ごとの方位分布図）  
 
---

## 📄 License  

This project uses **OpenStreetMap** data, licensed under the **ODbL (Open Database License)**.  
All code in this repository is available under the MIT License.  
