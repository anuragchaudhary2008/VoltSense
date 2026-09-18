const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mqtt = require('mqtt');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ==================== DATA STORE & STATE REPOSITORY ====================
const state = {
  selectedVisualizerRoomId: "101",
  rooms: [
    {
      id: "101",
      name: "Hostel Q-Block 101 (6-Bed)",
      blockId: "qblock",
      presence: "occupied",
      capacity: 6,
      occupants: 6,
      unitType: "Bed",
      focalLabel: "HOSTEL COMMON ROOM & BALCONY",
      radarVitalDetected: true,
      unattendedMinutes: 0,
      appliances: [
        { id: "h1", name: "Water Geyser", icon: "♨️", baseWatts: 1800, on: true, type: "hazard" },
        { id: "h2", name: "Split AC (1.5 Ton)", icon: "❄️", baseWatts: 650, on: true, type: "ac" },
        { id: "h3", name: "Ceiling Fan & Lights", icon: "💡", baseWatts: 80, on: true, type: "ambient" }
      ]
    },
    {
      id: "204",
      name: "Electronics Lab 204 (TT Block)",
      blockId: "tt",
      presence: "occupied",
      capacity: 20,
      occupants: 10,
      unitType: "Seat",
      focalLabel: "OSCILLOSCOPE & INSTRUCTOR BENCH",
      radarVitalDetected: true,
      unattendedMinutes: 0,
      appliances: [
        { id: "l1", name: "Soldering Station & PSU", icon: "🔥", baseWatts: 950, on: true, type: "hazard" },
        { id: "l2", name: "Air Conditioner", icon: "❄️", baseWatts: 550, on: true, type: "ac" },
        { id: "l3", name: "Bench Illumination (LED)", icon: "💡", baseWatts: 40, on: true, type: "ambient" }
      ]
    },
    {
      id: "302",
      name: "Classroom 302 (SJT Block)",
      blockId: "sjt",
      presence: "occupied",
      capacity: 20,
      occupants: 12,
      unitType: "Seat",
      focalLabel: "BLACKBOARD / PODIUM",
      radarVitalDetected: true,
      unattendedMinutes: 0,
      appliances: [
        { id: "c1", name: "Ceiling Lights Array", icon: "💡", baseWatts: 160, on: true, type: "ambient" },
        { id: "c2", name: "Ductable AC (2.0 Ton)", icon: "❄️", baseWatts: 1200, on: true, type: "ac" },
        { id: "c3", name: "Smart Projector", icon: "📽️", baseWatts: 280, on: true, type: "ambient" },
        { id: "c4", name: "Water Geyser / Boiler", icon: "♨️", baseWatts: 1500, on: true, type: "hazard" }
      ]
    }
  ],
  leaderboard: [
    { id: "qblock", name: "Men's Hostel Q-Block", rawScore: 96.8, avoidedKwh: 124.8, prevRank: 1 },
    { id: "tt", name: "Technology Tower (TT)", rawScore: 94.5, avoidedKwh: 108.2, prevRank: 2 },
    { id: "sjt", name: "Silver Jubilee Tower (SJT)", rawScore: 92.1, avoidedKwh: 94.6, prevRank: 3 },
    { id: "pblock", name: "Men's Hostel P-Block", rawScore: 88.9, avoidedKwh: 76.4, prevRank: 4 },
    { id: "smv", name: "SMV Academic Complex", rawScore: 86.3, avoidedKwh: 61.2, prevRank: 5 }
  ],
  cutoffsCount: 14,
  logs: []
};

// ==================== MQTT BROKER INTEGRATION ====================
// Connects to EMQX or local Mosquitto broker (falls back safely if offline)
const mqttClient = mqtt.connect('mqtt://broker.emqx.io:1883');

mqttClient.on('connect', () => {
  console.log('Connected to MQTT Broker');
  mqttClient.subscribe('voltsense/+/telemetry');
  mqttClient.subscribe('voltsense/+/control');
});

function emitMqttLog(room, topic, action) {
  const logEntry = {
    timestamp: new Date().toLocaleTimeString(),
    room,
    topic,
    action
  };
  state.logs.unshift(logEntry);
  if (state.logs.length > 25) state.logs.pop();

  if (mqttClient.connected) {
    mqttClient.publish(`voltsense/${topic}`, JSON.stringify(logEntry));
  }
}

// Broadcasts updated state to all connected WebSockets
function broadcastState() {
  const payload = JSON.stringify({ type: 'STATE_UPDATE', data: state });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// ==================== CORE AUTOMATION & BUSINESS LOGIC ====================
function updateLeaderboardDynamically(blockId, savedWatts) {
  const addedKwh = parseFloat(((savedWatts * 0.5) / 1000).toFixed(2));
  state.leaderboard.forEach(item => {
    if (item.id === blockId) {
      item.avoidedKwh = parseFloat((item.avoidedKwh + addedKwh).toFixed(1));
      item.rawScore = Math.min(99.9, parseFloat((item.rawScore + (addedKwh * 0.4)).toFixed(1)));
    } else {
      const ambientStep = (Math.random() * 0.08);
      item.avoidedKwh = parseFloat((item.avoidedKwh + ambientStep).toFixed(1));
      item.rawScore = Math.min(99.9, Math.max(70.0, parseFloat((item.rawScore + (Math.random() * 0.04 - 0.02)).toFixed(1))));
    }
  });
  state.leaderboard.sort((a, b) => (b.rawScore + b.avoidedKwh) - (a.rawScore + a.avoidedKwh));
}

function evaluateWatchdogRules() {
  let actionsTaken = 0;
  state.rooms.forEach(room => {
    if (room.presence === 'vacant') {
      room.appliances.forEach(app => {
        if (app.on) {
          let triggered = false;
          let ruleLabel = "";

          if (app.type === 'hazard' && room.unattendedMinutes >= 5) {
            ruleLabel = "HAZARD_TIMEOUT_5M";
            triggered = true;
          } else if (app.type === 'ac' && room.unattendedMinutes >= 15) {
            ruleLabel = "AC_TIMEOUT_15M";
            triggered = true;
          } else if (app.type === 'ambient' && room.unattendedMinutes >= 20) {
            ruleLabel = "LIGHT_FAN_TIMEOUT_20M";
            triggered = true;
          }

          if (triggered) {
            emitMqttLog(room.name, `watchdog/auto_kill/${app.id}`, `${ruleLabel} (${app.baseWatts}W)`);
            app.on = false;
            state.cutoffsCount++;
            actionsTaken++;
            updateLeaderboardDynamically(room.blockId, app.baseWatts);
          }
        }
      });
    }
  });
  if (actionsTaken > 0) broadcastState();
}

// Background radar presence tick (every 10s)
setInterval(() => {
  state.rooms.forEach(room => {
    if (room.presence === 'vacant') {
      room.unattendedMinutes += 1;
      emitMqttLog(room.name, `telemetry/${room.id}/occupancy_timer`, `Vacant=${room.unattendedMinutes}m`);
    } else {
      room.unattendedMinutes = 0;
    }
  });
  evaluateWatchdogRules();
  broadcastState();
}, 10000);

// Background campus micro-fluctuations (every 14s)
setInterval(() => {
  updateLeaderboardDynamically(null, 0);
  broadcastState();
}, 14000);

// ==================== WEBSOCKET MESSAGE DISPATCHER ====================
wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'STATE_UPDATE', data: state }));

  ws.on('message', message => {
    try {
      const { action, payload } = JSON.parse(message);

      if (action === 'TOGGLE_APPLIANCE') {
        const room = state.rooms.find(r => r.id === payload.roomId);
        const app = room.appliances.find(a => a.id === payload.applianceId);
        app.on = !app.on;
        emitMqttLog(room.name, `cmd/${room.id}/relay/${app.id}`, app.on ? "RELAY_ENGAGED" : "RELAY_OPENED");
      } 
      else if (action === 'CUTOFF_ROOM') {
        const room = state.rooms.find(r => r.id === payload.roomId);
        let wattsCut = 0;
        room.appliances.forEach(a => {
          if (a.on) {
            wattsCut += a.baseWatts;
            a.on = false;
          }
        });
        state.cutoffsCount++;
        emitMqttLog(room.name, `cmd/${room.id}/kill_switch`, "FORCE_ISOLATE_ALL");
        updateLeaderboardDynamically(room.blockId, wattsCut);
      } 
      else if (action === 'FORCE_PRESENCE') {
        const room = state.rooms.find(r => r.id === payload.roomId);
        const wasVacant = room.presence === 'vacant';
        room.presence = payload.newState;
        room.unattendedMinutes = 0;
        room.radarVitalDetected = (payload.newState === 'occupied');

        emitMqttLog(room.name, `telemetry/${room.id}/radar`, `Presence=${payload.newState.toUpperCase()} (Manual Override)`);

        if (payload.newState === 'occupied' && wasVacant) {
          room.appliances.forEach(app => {
            if (app.type === 'ac' || app.type === 'ambient') {
              if (!app.on) {
                app.on = true;
                emitMqttLog(room.name, `cmd/${room.id}/auto_restore/${app.id}`, `PRESENCE_RESUMED_ON (${app.baseWatts}W)`);
              }
            }
          });
          if (room.occupants === 0) room.occupants = room.capacity;
        } else if (payload.newState === 'vacant') {
          room.occupants = 0;
        }
      } 
      else if (action === 'ADJUST_OCCUPANTS') {
        const room = state.rooms.find(r => r.id === payload.roomId);
        room.occupants = Math.max(0, Math.min(room.capacity, room.occupants + payload.delta));
        if (room.occupants === 0 && room.presence === 'occupied') {
          room.presence = 'vacant';
          room.radarVitalDetected = false;
        } else if (room.occupants > 0 && room.presence === 'vacant') {
          room.presence = 'occupied';
          room.radarVitalDetected = true;
          room.unattendedMinutes = 0;
        }
      }
      else if (action === 'ADVANCE_TIME') {
        state.rooms.forEach(r => {
          if (r.presence === 'vacant') r.unattendedMinutes += payload.minutes;
        });
        evaluateWatchdogRules();
      }
      else if (action === 'SELECT_VISUALIZER_ROOM') {
        state.selectedVisualizerRoomId = payload.roomId;
      }

      broadcastState();
    } catch (err) {
      console.error('Action error:', err);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`VoltSense Server listening on http://localhost:${PORT}`);
});