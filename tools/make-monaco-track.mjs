// tools/make-monaco-track.mjs
// Run: node tools/make-monaco-track.mjs
// Outputs: JS arrays you can paste into server + client.

const GEOJSON_URL =
  "https://raw.githubusercontent.com/bacinger/f1-circuits/master/f1-circuits.geojson";
const TARGET_ID = "mc-1929"; // Monaco in that dataset

function llToXZ(lat, lon, lat0, lon0) {
  const R = 6378137;
  const dLat = ((lat - lat0) * Math.PI) / 180;
  const dLon = ((lon - lon0) * Math.PI) / 180;
  const x = dLon * Math.cos((lat0 * Math.PI) / 180) * R;
  const z = dLat * R;
  return { x, z };
}

function resampleEveryN(points, n) {
  const out = [];
  for (let i = 0; i < points.length; i += n) out.push(points[i]);
  // ensure closed loop for your code (last connects to first)
  if (
    out.length &&
    (out[0].x !== out[out.length - 1].x || out[0].z !== out[out.length - 1].z)
  ) {
    out.push(out[0]);
  }
  return out;
}

const res = await fetch(GEOJSON_URL);
if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
const gj = await res.json();

const feat =
  gj.features.find((f) => f?.properties?.id === TARGET_ID) ??
  gj.features.find((f) =>
    (f?.properties?.name || "").toLowerCase().includes("monaco")
  );

if (!feat) throw new Error("Could not find Monaco feature in GeoJSON.");

const geom = feat.geometry;
if (!geom) throw new Error("No geometry found for Monaco feature.");

let coordsLL = null;

// Most datasets store centerline as LineString; sometimes MultiLineString
if (geom.type === "LineString") coordsLL = geom.coordinates;
else if (geom.type === "MultiLineString") {
  // choose the longest segment so points are in order
  let best = geom.coordinates[0];
  let bestLen = 0;
  for (const line of geom.coordinates) {
    let len = 0;
    for (let i = 0; i < line.length - 1; i++) {
      const [lonA, latA] = line[i];
      const [lonB, latB] = line[i + 1];
      const dx = lonB - lonA;
      const dz = latB - latA;
      len += Math.hypot(dx, dz);
    }
    if (len > bestLen) {
      bestLen = len;
      best = line;
    }
  }
  coordsLL = best;
} else throw new Error(`Unsupported geometry type: ${geom.type}`);

if (!coordsLL?.length) throw new Error("No coordinates for Monaco.");

const [lon0, lat0] = coordsLL[0];

// Convert to local XZ, then scale down to fit your world.
// Tweak SCALE until it “feels right” in your scene.
const SCALE = 0.3;

let pts = coordsLL.map(([lon, lat]) => {
  const { x, z } = llToXZ(lat, lon, lat0, lon0);
  return { x: x * SCALE, z: z * SCALE };
});

// Downsample: Monaco has lots of points; start with every 8–15.
pts = resampleEveryN(pts, 6);

console.log("// ---- server/index.js trackPoints ----");
console.log("const trackPoints = [");
for (const p of pts)
  console.log(`  { x: ${p.x.toFixed(2)}, z: ${p.z.toFixed(2)} },`);
console.log("];\n");

console.log("// ---- client/index.html trackPoints ----");
console.log("const trackPoints = [");
for (const p of pts)
  console.log(`  new THREE.Vector3(${p.x.toFixed(2)}, 0, ${p.z.toFixed(2)}),`);
console.log("];");
