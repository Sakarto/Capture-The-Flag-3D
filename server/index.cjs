// server/index.js (ESM)
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Game state ----
const players = new Map();

function makePlayer(id) {
  return {
    id,
    x: 0,
    z: 0,
    yaw: 0,
    speed: 0,
    steer: 0,
    inputs: { w: false, a: false, s: false, d: false },
  };
}

// ---- Physics params ----
const params = {
  accel: 22,
  brake: 40,
  maxSpeed: 55,
  maxReverse: 18,
  drag: 6.0,
  rolling: 0.35,
  steerMax: 0.9,
  steerResponse: 6.0,
  steerReturn: 7.0,
  turnStrength: 2.0,
};

// ---- HTTP: serve client/index.html ----
const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    const htmlPath = path.join(__dirname, "..", "client", "index.html");
    try {
      const html = fs.readFileSync(htmlPath, "utf8");
      res.writeHead(200, { "Content-Type": "text/html" });
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

wss.on("connection", (ws) => {
  const id = Math.random().toString(36).slice(2, 9);
  players.set(id, makePlayer(id));

  ws.send(JSON.stringify({ type: "welcome", id }));

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === "input") {
      const p = players.get(id);
      if (!p) return;
      p.inputs.w = !!msg.w;
      p.inputs.a = !!msg.a;
      p.inputs.s = !!msg.s;
      p.inputs.d = !!msg.d;
    }
  });

  ws.on("close", () => {
    players.delete(id);
  });
});

// ---- Sim loop ----
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  for (const p of players.values()) {
    if (p.inputs.w) p.speed += params.accel * dt;

    if (p.inputs.s) {
      if (p.speed > 1.0) p.speed -= params.brake * dt;
      else p.speed -= params.accel * 0.7 * dt;
    }

    p.speed = Math.min(params.maxSpeed, p.speed);
    p.speed = Math.max(-params.maxReverse, p.speed);

    if (!p.inputs.w && !p.inputs.s) {
      const sign = Math.sign(p.speed);
      const amount = params.drag * dt;
      if (Math.abs(p.speed) <= amount) p.speed = 0;
      else p.speed -= sign * amount;
    }

    p.speed *= Math.exp(-params.rolling * dt);

    const targetSteer =
      (p.inputs.a ? 1 : 0) * params.steerMax +
      (p.inputs.d ? -1 : 0) * params.steerMax;

    const rate = targetSteer !== 0 ? params.steerResponse : params.steerReturn;
    p.steer += (targetSteer - p.steer) * (1 - Math.exp(-rate * dt));

    const speedFactor = Math.min(1, Math.abs(p.speed) / params.maxSpeed);
    p.yaw +=
      p.steer *
      params.turnStrength *
      speedFactor *
      dt *
      (p.speed >= 0 ? 1 : -1);

    p.x += Math.sin(p.yaw) * (p.speed * dt);
    p.z += Math.cos(p.yaw) * (p.speed * dt);
  }

  const snapshot = {
    type: "state",
    players: Array.from(players.values()).map((p) => ({
      id: p.id,
      x: p.x,
      z: p.z,
      yaw: p.yaw,
      speed: p.speed,
    })),
  };

  const payload = JSON.stringify(snapshot);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}, 1000 / 60);

server.listen(8080, () =>
  console.log("Server running at http://localhost:8080")
);
