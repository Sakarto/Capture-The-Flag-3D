// server/index.js (ESM)
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Field (must match client) ----
const FIELD_SIZE = 500; // ✅ must match client FIELD_SIZE
const HALF = FIELD_SIZE / 2;
const WALL_THICK = 4;
const CAR_R = 1;
const ZONE_WIDTH = 25; // must match client yellow end zone width
const CAR_HX = 1; // half width in XZ plane (2 / 2)
const CAR_HZ = 1; // half depth in XZ plane (2 / 2)

const RED_SAFE_X = -HALF + ZONE_WIDTH;
const BLUE_SAFE_X = HALF - ZONE_WIDTH;
const TAG_EPS = 0.75;

function respawn(p) {
  const s = p.team === "red" ? SPAWN_RED : SPAWN_BLUE;
  p.x = s.x;
  p.z = s.z;
  p.yaw = s.yaw;

  p.vx = 0;
  p.vz = 0;
  p.speed = 0;
  p.steer = 0;

  p.spawnLockUntil = Date.now() / 1000 + 3;
  dropFlagsIfCarrying(p.id);
}

function shouldTag(runner, tagger) {
  if (!runner.team || !tagger.team) return false;
  if (runner.team === tagger.team) return false;

  // runner is on enemy half BUT not in enemy yellow zone (with epsilon so the line is safe)
  if (runner.team === "blue") {
    const onRedHalf = runner.x < 0;
    const inRedYellow = runner.x <= RED_SAFE_X + TAG_EPS;
    return onRedHalf && !inRedYellow;
  }

  if (runner.team === "red") {
    const onBlueHalf = runner.x > 0;
    const inBlueYellow = runner.x >= BLUE_SAFE_X - TAG_EPS;
    return onBlueHalf && !inBlueYellow;
  }

  return false;
}
// ✅ add bounce back (like before)
const BOUNCE = 1;
const WALL_FRICTION = 0.9;

// --- Player-player collision tuning ---
const PLAYER_BOUNCE = 0.35; // 0..1  (how bouncy car-to-car is)
const PLAYER_FRICTION = 0.92; // 0..1  (tangent damping on contact)
// ---- Spawn points (must match client visuals) ----
const YELLOW_DEPTH = 50;
const FRONT_OFFSET = 5; // where your checkerboards are placed from yellow zone
const SPAWN_OFFSET = 30; // ✅ spawn 30 blocks toward midline from checkerboard

const redCheckX = -(HALF - YELLOW_DEPTH) + FRONT_OFFSET;
const blueCheckX = +(HALF - YELLOW_DEPTH) - FRONT_OFFSET;

const SPAWN_RED = { x: redCheckX + SPAWN_OFFSET, z: 0, yaw: Math.PI / 2 }; // face +X (toward midline)
const SPAWN_BLUE = { x: blueCheckX - SPAWN_OFFSET, z: 0, yaw: -Math.PI / 2 }; // face -X (toward midline)
// inner playable boundary
const INNER = HALF - WALL_THICK / 2;
const MIN_B = -INNER + Math.max(CAR_HX, CAR_HZ);
const MAX_B = +INNER - Math.max(CAR_HX, CAR_HZ);

// --- Minecraft-style look ---
let pointerLocked = false;
let viewYaw = 0; // radians
let viewPitch = 0; // radians
const PITCH_LIMIT = Math.PI / 2 - 0.08; // keep from flipping
const MOUSE_SENS = 0.0022; // tune

// ---- Game state ----
const players = new Map();
// ---- Scores + Flags ----
const scores = { red: 0, blue: 0 };
let phase = "lobby"; // "lobby" | "running"
let countdownEndAt = 0; // unix seconds when countdown hits 0
const COUNTDOWN_SECONDS = 5;
// flag bases are the checkerboards
const FLAG_HOME = {
  red: { x: redCheckX, z: 0 },
  blue: { x: blueCheckX, z: 0 },
};

const PICKUP_R = 2.2;
const CAPTURE_R = 3.2;
// --- Checkerboard pickup area (must match client visuals) ---
const TILE = 1;
const CHECK_SIZE = 5;
const CHECK_HALF = (CHECK_SIZE * TILE) / 2; // 2.5

function dist2(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

// Each baseTeam has a flag that the ENEMY can pick up
const flags = {
  red: {
    baseTeam: "red", // red base has the RED flag
    stealTeam: "blue", // blue can steal it
    x: FLAG_HOME.red.x,
    z: FLAG_HOME.red.z,
    carrier: null,
  },
  blue: {
    baseTeam: "blue", // blue base has the BLUE flag
    stealTeam: "red", // red can steal it
    x: FLAG_HOME.blue.x,
    z: FLAG_HOME.blue.z,
    carrier: null,
  },
};

function resetFlag(baseTeam) {
  const f = flags[baseTeam];
  if (!f) return;
  f.carrier = null;
  f.x = FLAG_HOME[baseTeam].x;
  f.z = FLAG_HOME[baseTeam].z;
}

function dropFlagsIfCarrying(playerId) {
  for (const f of Object.values(flags)) {
    if (f.carrier === playerId) resetFlag(f.baseTeam);
  }
}

function resetRound() {
  // return flags
  resetFlag("red");
  resetFlag("blue");

  // respawn everyone (this will also drop flags, but flags already reset)
  for (const p of players.values()) {
    if (!p.team) continue;
    respawn(p);
  }
}
function resetMatchToLobby() {
  // reset match state
  scores.red = 0;
  scores.blue = 0;

  phase = "lobby";
  countdownEndAt = 0;

  // reset flags back to bases
  resetFlag("red");
  resetFlag("blue");

  // reset any remaining connected players (spectators etc.)
  for (const p of players.values()) {
    p.spawned = false;
    p.ready = false;

    p.vx = 0;
    p.vz = 0;
    p.speed = 0;
    p.steer = 0;

    p.spawnLockUntil = 0;

    // optional: reset stats when match fully resets
    p.kills = 0;
    p.captures = 0;
    p.points = 0;
  }
}
function makePlayer(id) {
  return {
    id,
    name: "Player",
    team: null,
    spawned: false,
    x: -200,
    z: 0,
    yaw: Math.PI / 2,
    speed: 0,
    steer: 0,
    vx: 0,
    vz: 0,
    vz: 0,
    inputs: { w: false, a: false, s: false, d: false, r: false },
    spawnLockUntil: 0,
    ready: false,
    lastSeen: Date.now(),

    // ✅ leaderboard stats
    kills: 0,
    captures: 0,
    points: 0,
    
    // ✅ Dash state
    lastDashTime: -100, // allow dash immediately
    dashUntil: 0, 
  };
}

// ---- Physics params ----
// ---- Movement params (top-down "2D block in 3D") ----
const MOVE = {
  accelFwd: 105,
  accelRev: 75,
  brake: 150,

  // ✅ half-based max speeds
  maxHome: 75, // in your own half
  maxAway: 50, // in enemy half (attacking)

  maxRev: 45,
  drag: 1.5,
  stopEps: 0.02,
};

const TURN = {
  rate: 5, // rad/sec at speed (tune 2.3–3.4)
  minTurnSpeed: 0.2, // allow a bit of steering at low speed
};

// ---- Dash Params ----
const DASH = {
  cooldown: 5.0, // seconds
  duration: 0.5, // seconds (speed boost duration)
  impulse: 80,   // instant velocity add
  maxSpeedBoost: 100, // relaxed max speed during dash
};

// ---- HTTP: serve client/index.html ----
const server = http.createServer((req, res) => {
  const urlPath = (req.url || "/").split("?")[0]; // ✅ strip query string

  if (urlPath === "/" || urlPath === "/index.html") {
    const htmlPath = path.join(__dirname, "..", "client", "index.html");

    try {
      const html = fs.readFileSync(htmlPath, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Could not read client/index.html\n" + err.message);
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

// ---- WebSocket ----
const wss = new WebSocketServer({ server });
function cleanupPlayer(id) {
  dropFlagsIfCarrying(id);
  players.delete(id);

  // ✅ if nobody is actively on a team anymore, reset the match
  const teamCount = Array.from(players.values()).filter((p) => p.team).length;
  if (teamCount === 0) resetMatchToLobby();
}
wss.on("connection", (ws) => {
  const id = Math.random().toString(36).slice(2, 9);
  ws._pid = id; // <-- store player id on socket
  ws.isAlive = true;

  players.set(id, makePlayer(id));
  ws.send(JSON.stringify({ type: "welcome", id, name: players.get(id).name }));

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const p = players.get(id);
    if (!p) return;
    if (msg.type === "spawn") {
      // only allow spawning when match is running
      if (phase !== "running") return;
      if (!p.team) return;

      // spawn (or re-spawn) this player
      p.spawned = true;
      respawn(p);
      return;
    }
    p.lastSeen = Date.now();

    if (msg.type === "hello") {
      const name =
        String(msg.name ?? "Player")
          .trim()
          .slice(0, 18) || "Player";
      const newTeam =
        msg.team === "red" || msg.team === "blue" ? msg.team : null;

      p.name = name;

      if (p.team && newTeam && p.team !== newTeam) p.ready = false;
      p.team = newTeam;

      if (phase === "lobby") {
        p.spawned = false;
      }

      if (phase === "running" && p.team && !p.spawned) {
        p.spawned = true;
        respawn(p);
      }
      return;
    }

    if (msg.type === "ready") {
      if (!p.team) {
        p.ready = false;
        return;
      }
      p.ready = !!msg.ready;

      if (!p.ready && countdownEndAt) countdownEndAt = 0;
      return;
    }

    if (msg.type === "input") {
      if (typeof msg.yaw === "number" && Number.isFinite(msg.yaw)) {
        p.yaw = msg.yaw;
      }
      if (phase !== "running") return;
      if (!p.team || !p.spawned) return;

      p.inputs.w = !!msg.w;
      p.inputs.a = !!msg.a;
      p.inputs.a = !!msg.a;
      p.inputs.s = !!msg.s;
      p.inputs.d = !!msg.d;
      p.inputs.r = !!msg.r; // Dash
      return;
    }
  });

  ws.on("close", () => cleanupPlayer(id));
  ws.on("error", () => cleanupPlayer(id)); // <-- important for abrupt disconnects
});
const IDLE_KICK_MS = 60000; // 60s (tune)

setInterval(() => {
  const now = Date.now();

  for (const ws of wss.clients) {
    const id = ws._pid;
    const p = id ? players.get(id) : null;

    // if player object is missing, just kill socket
    if (!p) {
      ws.terminate();
      continue;
    }

    if (now - (p.lastSeen ?? 0) > IDLE_KICK_MS) {
      cleanupPlayer(id);
      ws.terminate();
    }
  }
}, 1000);

// existing ping/pong logic...
const HEARTBEAT_MS = 2000;

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      const id = ws._pid;
      if (id) cleanupPlayer(id);
      ws.terminate();
      continue;
    }

    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

function maxSpeedForPlayer(p) {
  // own half is based on TEAM and the midline at x = 0
  const inOwnHalf =
    (p.team === "red" && p.x <= 0) || (p.team === "blue" && p.x >= 0);

  return inOwnHalf ? MOVE.maxHome : MOVE.maxAway;
}
function topNBy(stat, n = 3) {
  return Array.from(players.values())
    .filter((p) => p.team)
    .map((p) => ({
      name: p.name ?? "Player",
      team: p.team ?? null,
      value: Number(p[stat] ?? 0),
    }))
    .sort(
      (a, b) =>
        b.value - a.value || String(a.name).localeCompare(String(b.name))
    )
    .slice(0, n);
}
// ---- Sim loop ----
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  let dt = (now - last) / 1000;
  last = now;
  // cap big spikes (tab switch etc.)
  dt = Math.min(dt, 0.1);
  let lobbyCountdown = 0; // ✅ define in the right scope
  const STEP = 1 / 120; // 120Hz physics
  while (dt > 0) {
    const h = Math.min(STEP, dt);
    dt -= h;

    // ---- Per-player movement (car throttle + brake + reverse) ----
    const vels = new Map(); // id -> { vx, vz }

    for (const p of players.values()) {
      if (!p.team) continue;

      const nowS = Date.now() / 1000;
      if (nowS < (p.spawnLockUntil ?? 0)) {
        p.vx = 0;
        p.vz = 0;
        p.speed = 0;
        vels.set(p.id, { vx: 0, vz: 0 });
        continue;
      }

      // inputs -> wish direction in camera yaw space
      const forwardIn = (p.inputs.w ? 1 : 0) - (p.inputs.s ? 1 : 0); // W/S
      const strafeIn = (p.inputs.a ? 1 : 0) - (p.inputs.d ? 1 : 0); // A = left

      // camera forward/right on XZ plane from yaw
      const fx = Math.sin(p.yaw);
      const fz = Math.cos(p.yaw);
      const rx = Math.cos(p.yaw);
      const rz = -Math.sin(p.yaw);

      // combine
      let dxWish = fx * forwardIn + rx * strafeIn;
      let dzWish = fz * forwardIn + rz * strafeIn;

      // normalize so diagonal isn't faster
      const mag = Math.hypot(dxWish, dzWish);
      if (mag > 0) {
        dxWish /= mag;
        dzWish /= mag;

        // accelerate toward wish dir
        p.vx += dxWish * MOVE.accelFwd * dt;
        p.vz += dzWish * MOVE.accelFwd * dt;
      }

      // drag (same as you already do)
      const dragFactor = Math.exp(-MOVE.drag * dt);
      p.vx *= dragFactor;
      p.vz *= dragFactor;

      // ✅ Dash Logic
      const isDashing = nowS < p.dashUntil;
      
      if (p.inputs.r && !isDashing) {
         // check cooldown
         if (nowS - p.lastDashTime >= DASH.cooldown) {
            // check if in own half
            const inOwnHalf = (p.team === 'red' && p.x < 0) || (p.team === 'blue' && p.x > 0);
            if (inOwnHalf) {
               // Perform Dash
               p.lastDashTime = nowS;
               p.dashUntil = nowS + DASH.duration;
               
               // Apply impulse in facing direction
               const fx = Math.sin(p.yaw);
               const fz = Math.cos(p.yaw);
               p.vx += fx * DASH.impulse;
               p.vz += fz * DASH.impulse;
            }
         }
      }

      // ✅ clamp max speed based on half (own half = 60, enemy half = 50)
      const sp = Math.hypot(p.vx, p.vz);
      let maxSp = maxSpeedForPlayer(p);
      
      // relax max speed if dashing
      if (nowS < p.dashUntil) {
          maxSp = Math.max(maxSp, DASH.maxSpeedBoost);
      }

      if (sp > maxSp) {
        const s = maxSp / sp;
        p.vx *= s;
        p.vz *= s;
      }

      // kill tiny drift
      if (Math.abs(p.vx) < MOVE.stopEps) p.vx = 0;
      if (Math.abs(p.vz) < MOVE.stopEps) p.vz = 0;

      // integrate position
      let nextX = p.x + p.vx * dt;
      let nextZ = p.z + p.vz * dt;

      // wall clamp + bounce
      let hit = false;
      if (nextX < MIN_B) {
        nextX = MIN_B;
        p.vx = -p.vx * BOUNCE;
        hit = true;
      } else if (nextX > MAX_B) {
        nextX = MAX_B;
        p.vx = -p.vx * BOUNCE;
        hit = true;
      }

      if (nextZ < MIN_B) {
        nextZ = MIN_B;
        p.vz = -p.vz * BOUNCE;
        hit = true;
      } else if (nextZ > MAX_B) {
        nextZ = MAX_B;
        p.vz = -p.vz * BOUNCE;
        hit = true;
      }

      if (hit) {
        p.vx *= WALL_FRICTION;
        p.vz *= WALL_FRICTION;
      }

      p.x = nextX;
      p.z = nextZ;

      p.speed = Math.hypot(p.vx, p.vz);
      vels.set(p.id, { vx: p.vx, vz: p.vz });
    }

    // ---- Player-player collisions (OBB vs OBB in XZ) ----
    function axesFromYaw(yaw) {
      // forward matches your movement basis
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      // right is perpendicular
      const rx = Math.cos(yaw);
      const rz = -Math.sin(yaw);
      return { fx, fz, rx, rz };
    }

    function projectRadiusOnAxis(obb, ax, az) {
      // radius = sum of half-extents projected onto axis
      // using obb local right/forward axes
      const r =
        obb.hx * Math.abs(ax * obb.rx + az * obb.rz) +
        obb.hz * Math.abs(ax * obb.fx + az * obb.fz);
      return r;
    }

    // SAT overlap test + MTV (minimum translation vector)
    function obbMTV(a, b) {
      const A = {
        ...axesFromYaw(a.yaw),
        hx: CAR_HX,
        hz: CAR_HZ,
        cx: a.x,
        cz: a.z,
      };
      const B = {
        ...axesFromYaw(b.yaw),
        hx: CAR_HX,
        hz: CAR_HZ,
        cx: b.x,
        cz: b.z,
      };

      const dx = B.cx - A.cx;
      const dz = B.cz - A.cz;

      // test axes: A.right, A.forward, B.right, B.forward
      const axes = [
        { x: A.rx, z: A.rz },
        { x: A.fx, z: A.fz },
        { x: B.rx, z: B.rz },
        { x: B.fx, z: B.fz },
      ];

      let bestOverlap = Infinity;
      let bestAx = 0;
      let bestAz = 0;
      let bestSign = 1;

      for (const axis of axes) {
        const ax = axis.x;
        const az = axis.z;

        // signed distance of centers along axis
        const t = dx * ax + dz * az;

        const ra = projectRadiusOnAxis(A, ax, az);
        const rb = projectRadiusOnAxis(B, ax, az);

        const overlap = ra + rb - Math.abs(t);
        if (overlap <= 0) return null; // separating axis found

        if (overlap < bestOverlap) {
          bestOverlap = overlap;
          bestAx = ax;
          bestAz = az;
          bestSign = t >= 0 ? 1 : -1; // direction from A to B along axis
        }
      }

      // MTV points from A to push away from B (so A moves -mtv, B moves +mtv)
      return {
        nx: bestAx * bestSign,
        nz: bestAz * bestSign,
        depth: bestOverlap,
      };
    }

    const nowS2 = Date.now() / 1000;
    const arr = Array.from(players.values()).filter(
      (p) => p.team && p.spawned && nowS2 >= (p.spawnLockUntil ?? 0)
    );

    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i];
        const b = arr[j];

        const mtv = obbMTV(a, b);
        const TAG_R = CAR_R * 2 + 0.35; // tune
        const close = dist2(a.x, a.z, b.x, b.z) <= TAG_R * TAG_R;

        if (close) {
          const tagA = shouldTag(a, b); // b tags a
          const tagB = shouldTag(b, a); // a tags b

          if (tagA) {
            b.kills++;
            respawn(a);
          }
          if (tagB) {
            a.kills++;
            respawn(b);
          }
        }
        if (!mtv) continue;

        const nx = mtv.nx;
        const nz = mtv.nz;

        // --- separation ---
        const push = mtv.depth;
        a.x -= nx * (push / 2);
        a.z -= nz * (push / 2);
        b.x += nx * (push / 2);
        b.z += nz * (push / 2);

        // --- impulse (bounce/friction) same as before ---
        let va = vels.get(a.id) ?? { vx: a.vx, vz: a.vz };
        let vb = vels.get(b.id) ?? { vx: b.vx, vz: b.vz };

        const rvx = vb.vx - va.vx;
        const rvz = vb.vz - va.vz;
        const relN = rvx * nx + rvz * nz;

        if (relN < 0) {
          const jImpulse = (-(1 + PLAYER_BOUNCE) * relN) / 2;
          va.vx -= jImpulse * nx;
          va.vz -= jImpulse * nz;
          vb.vx += jImpulse * nx;
          vb.vz += jImpulse * nz;

          const tx = -nz;
          const tz = nx;
          const relT = (vb.vx - va.vx) * tx + (vb.vz - va.vz) * tz;
          const tImpulse = (relT * (1 - PLAYER_FRICTION)) / 2;

          va.vx += tImpulse * tx;
          va.vz += tImpulse * tz;
          vb.vx -= tImpulse * tx;
          vb.vz -= tImpulse * tz;
        }

        // --- tagging AFTER collision (tags from any side/back/front) ---
        const tagA = shouldTag(a, b); // b tags a
        const tagB = shouldTag(b, a); // a tags b

        if (tagA) {
          b.kills = (b.kills ?? 0) + 1;
          respawn(a);
          va = { vx: 0, vz: 0 };
        }

        if (tagB) {
          a.kills = (a.kills ?? 0) + 1;
          respawn(b);
          vb = { vx: 0, vz: 0 };
        }

        vels.set(a.id, va);
        vels.set(b.id, vb);
      }
    }

    // ---- Apply updated velocities back to players ----
    for (const p of players.values()) {
      if (!p.team) continue;
      // optional but recommended: align yaw slightly toward movement direction
      // ✅ only align yaw toward velocity when moving forward (not reversing)
      if (p.speed > 0.5) {
        const fx = Math.sin(p.yaw);
        const fz = Math.cos(p.yaw);
        const vForward = p.vx * fx + p.vz * fz; // signed forward speed
      }
      const v = vels.get(p.id);
      if (!v) continue;

      p.vx = v.vx;
      p.vz = v.vz;

      p.speed = Math.hypot(p.vx, p.vz);
    }
    // ---- Flag pickup / carry / capture ----

    // 1) pickup (this one is per-player)
    for (const p of players.values()) {
      if (!p.team) continue;

      for (const f of Object.values(flags)) {
        if (f.carrier) continue;
        if (p.team !== f.stealTeam) continue;

        const dx = Math.abs(p.x - f.x);
        const dz = Math.abs(p.z - f.z);
        if (dx > CHECK_HALF + CAR_R) continue;
        if (dz > CHECK_HALF + CAR_R) continue;

        f.carrier = p.id;
        p.captures = (p.captures ?? 0) + 1;
      }
    }

    // 2) carry + capture (this is global, not per-player)
    for (const f of Object.values(flags)) {
    }

    // 2) carry follows player + check capture
    for (const f of Object.values(flags)) {
      if (!f.carrier) continue;

      const carrier = players.get(f.carrier);
      if (!carrier || !carrier.team) {
        resetFlag(f.baseTeam);
        continue;
      }

      // follow carrier
      f.x = carrier.x;
      f.z = carrier.z;

      // carrier scores ONLY if they are carrying ENEMY flag and reach THEIR home base
      const carryingEnemyFlag = f.baseTeam !== carrier.team;
      if (!carryingEnemyFlag) continue;

      const home = FLAG_HOME[carrier.team];
      if (
        dist2(carrier.x, carrier.z, home.x, home.z) <=
        CAPTURE_R * CAPTURE_R
      ) {
        scores[carrier.team] += 1;

        carrier.points = (carrier.points ?? 0) + 1;

        resetRound();
        break; // stop processing flags this tick
      }
    }

    const nowS = Date.now() / 1000;
    const teamPlayers = Array.from(players.values()).filter((p) => p.team);
    const everyoneReady =
      teamPlayers.length > 0 && teamPlayers.every((p) => p.ready);

    // start countdown if all ready and not already counting down and still in lobby
    if (phase === "lobby") {
      if (everyoneReady && !countdownEndAt) {
        countdownEndAt = nowS + COUNTDOWN_SECONDS;
      }
      if (!everyoneReady && countdownEndAt) {
        countdownEndAt = 0;
      }

      // when countdown finishes -> start game
      if (countdownEndAt && nowS >= countdownEndAt) {
        phase = "running";
        countdownEndAt = 0;

        // spawn everyone together + apply spawn lock
        for (const p of teamPlayers) {
          p.spawned = true;
          respawn(p);
        }
      }
    }
  }
  const nowS = Date.now() / 1000;
  if (phase === "lobby" && countdownEndAt) {
    lobbyCountdown = Math.max(1, Math.ceil(countdownEndAt - nowS));
  } else {
    lobbyCountdown = 0;
  }
  const snapshot = {
    phase,
    lobbyCountdown,
    roster: Array.from(players.values())
      .filter((p) => p.team)
      .map((p) => ({ id: p.id, name: p.name, team: p.team, ready: !!p.ready })),
    leaders: {
      kills: topNBy("kills", 3),
      captures: topNBy("captures", 3),
      points: topNBy("points", 3),
    },
    type: "state",
    t: Date.now() / 1000,
    scores,
    flags: Object.values(flags).map((f) => ({
      baseTeam: f.baseTeam,
      x: f.x,
      z: f.z,
      carrier: f.carrier,
    })),
    players:
      phase === "running"
        ? Array.from(players.values())
            .filter((p) => p.team && p.spawned)
            .map((p) => ({
              id: p.id,
              name: p.name,
              team: p.team,
              x: p.x,
              z: p.z,
              yaw: p.yaw,
              speed: p.speed,
              lock: p.spawnLockUntil ?? 0,
            }))
        : [],
  };

  const payload = JSON.stringify(snapshot);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}, 1000 / 60);

const PORT = Number(process.env.PORT) || 8080;

server.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});
