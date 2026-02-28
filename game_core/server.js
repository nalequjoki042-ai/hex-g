// server.js — Hex Game с SQLite (вместо JSON)
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server, Room } = require('colyseus');
const { WebSocketTransport } = require('@colyseus/ws-transport');
const { Schema, MapSchema, type } = require('@colyseus/schema');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const Pathfinding = require('./pathfinding');

// ==========================================
// 1. ЛОГИРОВАНИЕ
// ==========================================
const LOG_FILE = path.join(__dirname, 'server.log');

function log(message) {
    const time = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const text = `[${time}] ${message}\n`;
    console.log(text.trim());
    fs.appendFileSync(LOG_FILE, text);
}

// ==========================================
// 2. БАЗА ДАННЫХ — SQLite
// ==========================================
const db = new Database(path.join(__dirname, 'game.db'));

// Включаем WAL режим — это ключ к скорости и надёжности.
// WAL позволяет читать и писать одновременно без блокировок.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL'); // Баланс между скоростью и надёжностью

// Создаём таблицы если их нет
db.exec(`
    CREATE TABLE IF NOT EXISTS hexes (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        color TEXT NOT NULL,
        type TEXT DEFAULT 'plain',
        captured_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS players (
        name TEXT PRIMARY KEY,
        color TEXT NOT NULL,
        total_captures INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
`);

log("База данных SQLite инициализирована.");

// Подготавливаем запросы заранее (prepared statements) — это быстрее
const stmts = {
    getHex:      db.prepare('SELECT * FROM hexes WHERE id = ?'),
    getAllHexes:  db.prepare('SELECT * FROM hexes'),
    setHex:      db.prepare('INSERT OR REPLACE INTO hexes (id, owner, color, type) VALUES (?, ?, ?, ?)'),
    
    getPlayer:   db.prepare('SELECT * FROM players WHERE name = ?'),
    setPlayer:   db.prepare('INSERT OR IGNORE INTO players (name, color) VALUES (?, ?)'),
    addCapture:  db.prepare('UPDATE players SET total_captures = total_captures + 1 WHERE name = ?'),
    
    getLeaders:  db.prepare(`
        SELECT p.name, p.color, COUNT(h.id) as hex_count 
        FROM players p
        LEFT JOIN hexes h ON h.owner = p.name
        GROUP BY p.name
        ORDER BY hex_count DESC
        LIMIT 10
    `),
};

// ==========================================
// 3. ЦВЕТА ИГРОКОВ
// ==========================================
const PLAYER_COLORS = [
    "#e94560", "#533483", "#4ecca3", 
    "#ff9a00", "#ff4d00", "#00d2ff",
    "#f5a623", "#7ed321", "#bd10e0"
];

function getRandomColor() {
    return PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
}

// ==========================================
// 4. СХЕМА ДАННЫХ COLYSEUS
// ==========================================
class HexData extends Schema {}
type("string")(HexData.prototype, "owner");
type("string")(HexData.prototype, "color");
type("string")(HexData.prototype, "type");
type("number")(HexData.prototype, "resourceAmount");
type("string")(HexData.prototype, "building"); // e.g. 'TC'
type("number")(HexData.prototype, "buildingHp");

class UnitData extends Schema {}
type("string")(UnitData.prototype, "id");
type("number")(UnitData.prototype, "x");
type("number")(UnitData.prototype, "y");
type("number")(UnitData.prototype, "hp");
type("number")(UnitData.prototype, "maxHp");
type("number")(UnitData.prototype, "inventory");
type("number")(UnitData.prototype, "maxInventory");
type("string")(UnitData.prototype, "type");
type("string")(UnitData.prototype, "color");
type("number")(UnitData.prototype, "targetHexQ");
type("number")(UnitData.prototype, "targetHexR");
type("string")(UnitData.prototype, "owner");
// Add path array to the unit to follow
type(["string"])(UnitData.prototype, "path");
type("string")(UnitData.prototype, "action"); // 'idle', 'moving', 'harvesting', 'returning'
type("string")(UnitData.prototype, "targetActionQ");
type("string")(UnitData.prototype, "targetActionR");


// For global player inventory (TC storage)
class PlayerData extends Schema {}
type("number")(PlayerData.prototype, "wood");
type("number")(PlayerData.prototype, "stone");
type("number")(PlayerData.prototype, "scrap");

class GameState extends Schema {
    constructor() {
        super();
        this.hexes = new MapSchema();
        this.units = new MapSchema();
        this.players = new MapSchema();

        // Загружаем все гексы из SQLite при старте
        const allHexes = stmts.getAllHexes.all();
        for (const row of allHexes) {
            const hexData = new HexData();
            hexData.owner = row.owner;
            hexData.color = row.color;
            // Provide a default type if none exists in db
            hexData.type = row.type || 'plain';
            if (hexData.type === 'forest') hexData.resourceAmount = 500;
            else if (hexData.type === 'mountain') hexData.resourceAmount = 300;
            else if (hexData.type === 'ruins') hexData.resourceAmount = 100;

            this.hexes.set(row.id, hexData);
        }
        log(`Загружено ${allHexes.length} гексов из базы данных.`);
    }
}
const { filter } = require('@colyseus/schema');

type({ map: HexData })(GameState.prototype, "hexes");
type({ map: UnitData })(GameState.prototype, "units");
type({ map: PlayerData })(GameState.prototype, "players");

// Implement @filter on HexData and UnitData fields for Fog of War
// Colyseus schema @filter doesn't easily allow dynamic context like "who has units near this hex" without attaching visibility arrays to each object,
// which is expensive.
// An alternative is using client-side fog of war, where the server sends everything but the client only renders what is visible.
// For true server-side fog of war, we'd need to compute visible hexes per player.
// Given the requirements "Сервер отправляет игроку данные только о тех гексах, которые находятся в радиусе обзора...",
// we'll add a visible array to HexData and UnitData if needed, or use a custom patch algorithm.
// For simplicity in Colyseus, adding @filter to `owner`, `color`, `type` etc based on a `visibleTo` array is standard.

filter(function(client, value, root) {
    if (this.visibleTo && this.visibleTo.includes(client.userData.name)) {
        return true;
    }
    return false;
})(HexData.prototype, "owner");

filter(function(client, value, root) {
    if (this.visibleTo && this.visibleTo.includes(client.userData.name)) {
        return true;
    }
    return false;
})(HexData.prototype, "color");

filter(function(client, value, root) {
    if (this.visibleTo && this.visibleTo.includes(client.userData.name)) {
        return true;
    }
    return false;
})(HexData.prototype, "type");

filter(function(client, value, root) {
    if (this.visibleTo && this.visibleTo.includes(client.userData.name)) {
        return true;
    }
    return false;
})(HexData.prototype, "building");

filter(function(client, value, root) {
    // units
    if (this.visibleTo && this.visibleTo.includes(client.userData.name)) {
        return true;
    }
    return false;
})(UnitData.prototype, "type");

filter(function(client, value, root) {
    if (this.visibleTo && this.visibleTo.includes(client.userData.name)) {
        return true;
    }
    return false;
})(UnitData.prototype, "x");

filter(function(client, value, root) {
    if (this.visibleTo && this.visibleTo.includes(client.userData.name)) {
        return true;
    }
    return false;
})(UnitData.prototype, "y");

// ==========================================
// 5. ИГРОВАЯ КОМНАТА
// ==========================================
class HexRoom extends Room {
    onCreate(options) {
        this.setState(new GameState());
        log("Игровая комната создана.");

        this.generateMap();

        // visibleTo Arrays
        this.state.hexes.forEach(hex => { hex.visibleTo = []; });
        this.state.units.forEach(unit => { unit.visibleTo = []; });

        // Helper function for pathfinding cost
        // We need the unit's owner to determine if a building is allied or enemy
        const getHexCost = (q, r, unitOwner) => {
            const hexId = `${q},${r}`;
            const hex = this.state.hexes.get(hexId);
            if (!hex) return 1; // Default plain cost

            // Impassable logic: enemy buildings are impassable
            if (hex.building) {
                if (hex.owner !== unitOwner) {
                    return Infinity; // Impassable for enemies
                }
                // Allied buildings are passable (doors open automatically)
            }

            switch (hex.type) {
                case 'plain': return 1;
                case 'forest': return 1 / 0.8; // speed 0.8 => cost 1.25
                case 'mountain': return 1 / 0.5; // speed 0.5 => cost 2
                case 'ruins': return 1 / 0.5;
                default: return 1;
            }
        };

        // Регенерация энергии и игровой цикл каждую секунду (для простоты)
        // В реальном времени нужно обновлять чаще, но для RTS движения
        // можно сделать 10 тиков в секунду
        this.setSimulationInterval(() => {
            // Энергия (каждую секунду)
            this.clients.forEach(client => {
                if (client.userData && client.userData.energy < 10) {
                    client.userData.energy = Math.min(10, client.userData.energy + 0.02); // 0.02 * 10 = 0.2
                    // Отправляем реже чтобы не спамить
                    if (Math.random() < 0.1) {
                        client.send("energyUpdate", {
                            energy: Math.floor(client.userData.energy)
                        });
                    }
                }
            });

            // Update Fog of War
            this.updateVisibility();

            // Движение юнитов
            this.state.units.forEach(unit => {
                // If unit has a path, move towards the next hex
                if (unit.path && unit.path.length > 0) {
                    const nextHexId = unit.path[0];
                    const [nextQ, nextR] = nextHexId.split(',').map(Number);

                    const hSize = 35;
                    const targetX = hSize * Math.sqrt(3) * (nextQ + nextR / 2);
                    const targetY = hSize * 3 / 2 * nextR;

                    const dx = targetX - unit.x;
                    const dy = targetY - unit.y;
                    const dist = Math.sqrt(dx*dx + dy*dy);

                    // Base speed per tick
                    let speed = 2;
                    if (unit.type === 'fighter') speed = 1.5;

                    // Apply terrain modifier of the hex we are entering
                    const targetHex = this.state.hexes.get(nextHexId);
                    let terrainSpeed = 1;
                    if (targetHex) {
                        if (targetHex.type === 'forest') terrainSpeed = 0.8;
                        else if (targetHex.type === 'mountain' || targetHex.type === 'ruins') terrainSpeed = 0.5;
                    }
                    speed *= terrainSpeed;

                    if (dist > speed) {
                        unit.x += (dx / dist) * speed;
                        unit.y += (dy / dist) * speed;
                    } else {
                        // Reached the center of the next hex
                        unit.x = targetX;
                        unit.y = targetY;
                        unit.path.shift(); // Remove the reached hex

                        if (unit.path.length === 0) {
                            // Reached final destination
                            unit.targetHexQ = null;
                            unit.targetHexR = null;
                            // Reached destination logic
                            unit.targetActionQ = null;
                            unit.targetActionR = null;

                            const arrivedQ = nextQ;
                            const arrivedR = nextR;
                            const currentHexId = `${arrivedQ},${arrivedR}`;
                            const currentHex = this.state.hexes.get(currentHexId);

                            // Save current position for harvesting logic
                            unit.targetHexQ = arrivedQ;
                            unit.targetHexR = arrivedR;

                            if (currentHex && (currentHex.type === 'forest' || currentHex.type === 'mountain')) {
                                if (currentHex.resourceAmount > 0 && unit.inventory < unit.maxInventory) {
                                    unit.action = 'harvesting';
                                    log(`Unit ${unit.id} started harvesting at ${currentHexId}`);
                                } else {
                                    unit.action = 'idle';
                                }
                            } else {
                                unit.action = 'idle';
                            }
                        }
                    }
                } else if (unit.action === 'harvesting') {
                    // Logic for harvesting
                    // targetHexQ/R has been set to the hex we arrived at
                    const currentQ = unit.targetHexQ;
                    const currentR = unit.targetHexR;
                    const currentHexId = `${currentQ},${currentR}`;
                    const currentHex = this.state.hexes.get(currentHexId);

                    if (currentHex && currentHex.resourceAmount > 0) {
                        // Harvest amount per tick
                        let harvestAmount = 2; // Default for founder
                        if (unit.type === 'farmer') harvestAmount = 6;

                        // Limit by remaining resources in hex and remaining capacity
                        const remainingCapacity = unit.maxInventory - unit.inventory;
                        const actualHarvest = Math.min(harvestAmount, currentHex.resourceAmount, remainingCapacity);

                        unit.inventory += actualHarvest;
                        currentHex.resourceAmount -= actualHarvest;

                        // Send VFX to owner
                        const ownerClient = this.clients.find(c => c.userData.name === unit.owner);
                        if (ownerClient) {
                            let resIcon = currentHex.type === 'forest' ? '🪵' : '🪨';
                            ownerClient.send("vfx", {
                                q: unit.targetHexQ,
                                r: unit.targetHexR,
                                text: `+${actualHarvest} ${resIcon}`,
                                color: '#4ecca3'
                            });
                        }

                        if (currentHex.resourceAmount <= 0) {
                            // Depleted
                            currentHex.type = 'plain'; // Turn into plain
                            currentHex.resourceAmount = 0;
                            stmts.setHex.run(currentHexId, currentHex.owner, currentHex.color, currentHex.type);
                        }

                        if (unit.inventory >= unit.maxInventory || currentHex.resourceAmount <= 0) {
                            // Find nearest TC of the owner
                            let nearestTC = null;
                            let minDist = Infinity;

                            this.state.hexes.forEach((hex, id) => {
                                if (hex.building === 'TC' && hex.owner === unit.owner) {
                                    const [hq, hr] = id.split(',').map(Number);
                                    const dist = Pathfinding.distance(unit.targetHexQ, unit.targetHexR, hq, hr);
                                    if (dist < minDist) {
                                        minDist = dist;
                                        nearestTC = { q: hq, r: hr };
                                    }
                                }
                            });

                            if (nearestTC) {
                                const path = Pathfinding.findPath(unit.targetHexQ, unit.targetHexR, nearestTC.q, nearestTC.r, (q, r) => getHexCost(q, r, unit.owner));
                                if (path && path.length > 0) {
                                    unit.action = 'returning';
                                    const { ArraySchema } = require('@colyseus/schema');
                                    unit.path = new ArraySchema();
                                    let startIndex = (path[0].q === unit.targetHexQ && path[0].r === unit.targetHexR) ? 1 : 0;
                                    for (let i = startIndex; i < path.length; i++) {
                                        unit.path.push(`${path[i].q},${path[i].r}`);
                                    }
                                    log(`Unit ${unit.id} returning to TC at ${nearestTC.q},${nearestTC.r}`);
                                } else {
                                    unit.action = 'idle';
                                }
                            } else {
                                unit.action = 'idle';
                            }
                        }
                    } else {
                        unit.action = 'idle';
                    }
                } else if (unit.action === 'returning' && (!unit.path || unit.path.length === 0)) {
                    // Assuming arrived at TC
                    const currentHexId = `${unit.targetHexQ},${unit.targetHexR}`;
                    const currentHex = this.state.hexes.get(currentHexId);

                    if (currentHex && currentHex.building === 'TC' && currentHex.owner === unit.owner) {
                        const playerState = this.state.players.get(unit.owner);
                        if (playerState) {
                            const deposited = unit.inventory;
                            playerState.wood += deposited;
                            log(`Unit ${unit.id} deposited ${deposited} wood to TC. Total: ${playerState.wood}`);
                            unit.inventory = 0;
                            unit.action = 'idle';

                            const ownerClient = this.clients.find(c => c.userData.name === unit.owner);
                            if (ownerClient && deposited > 0) {
                                ownerClient.send("vfx", {
                                    q: unit.targetHexQ,
                                    r: unit.targetHexR,
                                    text: `+${deposited} 🪵 В шкаф`,
                                    color: '#f5a623'
                                });
                            }
                        }
                    } else {
                        unit.action = 'idle'; // TC was destroyed or something
                    }
                }
            });

        }, 100);

        // Перемещение юнита
        this.onMessage("moveUnit", (client, message) => {
            const { unitId, q, r } = message;
            const unit = this.state.units.get(unitId);

            if (unit && unit.owner === client.userData.name) {
                // Find current Q and R of the unit based on its x/y
                const hSize = 35;
                const q_raw = (Math.sqrt(3) / 3 * unit.x - 1 / 3 * unit.y) / hSize;
                const r_raw = (2 / 3 * unit.y) / hSize;

                // Hex round function inline
                let s = -q_raw - r_raw;
                let rq = Math.round(q_raw);
                let rr = Math.round(r_raw);
                let rs = Math.round(s);
                const qDiff = Math.abs(rq - q_raw);
                const rDiff = Math.abs(rr - r_raw);
                const sDiff = Math.abs(rs - s);
                if (qDiff > rDiff && qDiff > sDiff) { rq = -rr - rs; }
                else if (rDiff > sDiff) { rr = -rq - rs; }
                else { rs = -rq - rr; }

                const startQ = rq;
                const startR = rr;

                // Calculate path using A*
                const path = Pathfinding.findPath(startQ, startR, q, r, (qx, rx) => getHexCost(qx, rx, unit.owner));

                if (path && path.length > 0) {
                    // Cancel current actions
                    unit.action = 'moving';


                    // Convert path objects to ArraySchema of strings
                    const { ArraySchema } = require('@colyseus/schema');
                    unit.path = new ArraySchema();

                    // Skip the first node if it's the current hex to prevent snapping back
                    let startIndex = 0;
                    if (path[0].q === startQ && path[0].r === startR) {
                        startIndex = 1;
                    }

                    for (let i = startIndex; i < path.length; i++) {
                        unit.path.push(`${path[i].q},${path[i].r}`);
                    }
                } else {
                    client.send("error", { message: "Путь не найден!" });
                }
            }
        });

        // Создание здания (TC)
        this.onMessage("buildTC", (client, message) => {
            const { unitId, q, r } = message;
            const unit = this.state.units.get(unitId);
            const playerName = client.userData.name;

            if (unit && unit.owner === playerName) {
                // Ensure unit is at the target hex
                const hSize = 35;
                const q_raw = (Math.sqrt(3) / 3 * unit.x - 1 / 3 * unit.y) / hSize;
                const r_raw = (2 / 3 * unit.y) / hSize;
                const rq = Math.round(q_raw); // simplified rounding for check

                // Let's just trust q, r from client for now, or calculate distance
                const hexId = `${q},${r}`;
                const hex = this.state.hexes.get(hexId);

                if (hex && hex.building === undefined && hex.type === 'plain') {
                    // Cost: 200 wood. Check player inventory.
                    const playerState = this.state.players.get(playerName);
                    if (playerState && playerState.wood >= 200) {
                        playerState.wood -= 200;
                        hex.building = 'TC';
                        hex.buildingHp = 1000;
                        hex.owner = playerName;
                        hex.color = client.userData.color;
                        stmts.setHex.run(hexId, playerName, hex.color, hex.type);
                        log(`${playerName} built a TC at ${hexId}`);
                        client.send("success", { message: "Шкаф построен!" });
                        this.updateTerritory();
                    } else {
                        client.send("error", { message: "Недостаточно дерева (Нужно 200)!" });
                    }
                } else {
                    client.send("error", { message: "Здесь нельзя строить!" });
                }
            }
        });

        // Обработка захвата гекса
        this.onMessage("claimHex", (client, message) => {
            const { q, r } = message;

            // Валидация входных данных
            if (typeof q !== 'number' || typeof r !== 'number') return;
            if (!isFinite(q) || !isFinite(r)) return;
            if (Math.abs(q) > 200 || Math.abs(r) > 200) return; // Ограничение карты

            const hexId = `${Math.round(q)},${Math.round(r)}`;
            const playerName = client.userData.name;
            const playerColor = client.userData.color;

            // Проверка энергии
            if (client.userData.energy < 1) {
                client.send("error", { message: "Недостаточно энергии! Подождите восполнения." });
                return;
            }

            const currentHex = this.state.hexes.get(hexId);

            // Если гекс свободен или принадлежит другому — захватываем
            if (!currentHex || currentHex.owner !== playerName) {
                
                // Тратим энергию
                client.userData.energy -= 1;
                client.send("energyUpdate", { energy: Math.floor(client.userData.energy) });

                // Обновляем состояние Colyseus (синхронизация с клиентами)
                const hexData = new HexData();
                hexData.owner = playerName;
                hexData.color = playerColor;
                this.state.hexes.set(hexId, hexData);

                // Сохраняем в SQLite (атомарная операция — данные не потеряются)
                stmts.setHex.run(hexId, playerName, playerColor, currentHex ? currentHex.type : 'plain');
                stmts.addCapture.run(playerName);

                log(`[Захват] ${playerName} → гекс (${hexId})`);
            }
        });
    }

    updateVisibility() {
        // Collect all units and buildings
        const playerViews = new Map(); // playerName -> Set of visible hex ids

        this.clients.forEach(client => {
            playerViews.set(client.userData.name, new Set());
        });

        // Add vision from units
        this.state.units.forEach(unit => {
            const owner = unit.owner;
            if (playerViews.has(owner)) {
                const viewSet = playerViews.get(owner);

                // Calculate unit's current hex
                const hSize = 35;
                const q_raw = (Math.sqrt(3) / 3 * unit.x - 1 / 3 * unit.y) / hSize;
                const r_raw = (2 / 3 * unit.y) / hSize;
                let s = -q_raw - r_raw;
                let rq = Math.round(q_raw);
                let rr = Math.round(r_raw);
                let rs = Math.round(s);
                const qDiff = Math.abs(rq - q_raw);
                const rDiff = Math.abs(rr - r_raw);
                const sDiff = Math.abs(rs - s);
                if (qDiff > rDiff && qDiff > sDiff) { rq = -rr - rs; }
                else if (rDiff > sDiff) { rr = -rq - rs; }
                else { rs = -rq - rr; }

                const uq = rq;
                const ur = rr;

                // Vision radius 2
                for (let dq = -2; dq <= 2; dq++) {
                    for (let dr = -2; dr <= 2; dr++) {
                        if (Math.abs(-dq - dr) <= 2) {
                            viewSet.add(`${uq + dq},${ur + dr}`);
                        }
                    }
                }
            }
        });

        // Add vision from TCs
        this.state.hexes.forEach((hex, id) => {
            if (hex.building === 'TC' && playerViews.has(hex.owner)) {
                const viewSet = playerViews.get(hex.owner);
                const [q, r] = id.split(',').map(Number);
                // TC vision radius 3
                for (let dq = -3; dq <= 3; dq++) {
                    for (let dr = -3; dr <= 3; dr++) {
                        if (Math.abs(-dq - dr) <= 3) {
                            viewSet.add(`${q + dq},${r + dr}`);
                        }
                    }
                }
            }
        });

        // Update hexes and units visibleTo arrays and force sync if changed
        this.state.hexes.forEach((hex, id) => {
            const visibleTo = [];
            playerViews.forEach((viewSet, playerName) => {
                if (viewSet.has(id)) visibleTo.push(playerName);
            });

            // Check if arrays changed
            if (JSON.stringify(hex.visibleTo) !== JSON.stringify(visibleTo)) {
                hex.visibleTo = visibleTo;
                // Force sync for filters by touching a dummy property, but better just reassigning object
                hex._forceSync = (hex._forceSync || 0) + 1; // Needs field
                // Re-setting schema values will trigger the sync for the client
                const oldOwner = hex.owner;
                hex.owner = oldOwner; // dirty property so @filter runs
            }
        });

        this.state.units.forEach(unit => {
            const visibleTo = [];

            const hSize = 35;
            const q_raw = (Math.sqrt(3) / 3 * unit.x - 1 / 3 * unit.y) / hSize;
            const r_raw = (2 / 3 * unit.y) / hSize;
            let s = -q_raw - r_raw;
            let rq = Math.round(q_raw);
            let rr = Math.round(r_raw);
            let rs = Math.round(s);
            const qDiff = Math.abs(rq - q_raw);
            const rDiff = Math.abs(rr - r_raw);
            const sDiff = Math.abs(rs - s);
            if (qDiff > rDiff && qDiff > sDiff) { rq = -rr - rs; }
            else if (rDiff > sDiff) { rr = -rq - rs; }
            else { rs = -rq - rr; }

            const hexId = `${rq},${rr}`;

            playerViews.forEach((viewSet, playerName) => {
                if (viewSet.has(hexId)) visibleTo.push(playerName);
            });

            if (JSON.stringify(unit.visibleTo) !== JSON.stringify(visibleTo)) {
                unit.visibleTo = visibleTo;
                unit.x = unit.x; // Force dirty to trigger @filter
            }
        });
    }

    updateTerritory() {
        // Collect all TCs and set ownership radius
        const tcs = [];
        this.state.hexes.forEach((hex, id) => {
            if (hex.building === 'TC') {
                const [q, r] = id.split(',').map(Number);
                tcs.push({ q, r, owner: hex.owner, color: hex.color });
            }
        });

        tcs.forEach(tc => {
            // Give 3 hex radius
            for (let dq = -3; dq <= 3; dq++) {
                for (let dr = -3; dr <= 3; dr++) {
                    if (Math.abs(-dq - dr) <= 3) {
                        const nq = tc.q + dq;
                        const nr = tc.r + dr;
                        const hexId = `${nq},${nr}`;
                        const hex = this.state.hexes.get(hexId);

                        // We do not overwrite other buildings or resources for now
                        // Just set territory owner
                        if (hex && hex.type === 'plain' && hex.building !== 'TC') {
                            hex.owner = tc.owner;
                            hex.color = tc.color;
                            stmts.setHex.run(hexId, hex.owner, hex.color, hex.type);
                        }
                    }
                }
            }
        });
    }

    generateMap() {
        // Простая генерация карты: добавляем леса и горы на свободные гексы
        // в радиусе 50
        let generated = 0;
        for (let q = -50; q <= 50; q++) {
            for (let r = -50; r <= 50; r++) {
                if (Math.abs(-q - r) > 50) continue;

                const hexId = `${q},${r}`;
                if (!this.state.hexes.has(hexId)) {
                    let rNum = Math.random();
                    let type = 'plain';
                    if (rNum < 0.15) type = 'forest';
                    else if (rNum < 0.25) type = 'mountain';
                    else if (rNum < 0.26) type = 'ruins';

                    if (type !== 'plain') {
                        const hexData = new HexData();
                        hexData.owner = "server";
                        hexData.color = "#222222";
                        hexData.type = type;
                        if (type === 'forest') hexData.resourceAmount = 500;
                        else if (type === 'mountain') hexData.resourceAmount = 300;
                        else if (type === 'ruins') hexData.resourceAmount = 100;

                        this.state.hexes.set(hexId, hexData);
                        stmts.setHex.run(hexId, hexData.owner, hexData.color, hexData.type);
                        generated++;
                    }
                }
            }
        }
        if (generated > 0) log(`Сгенерировано ${generated} новых гексов с ресурсами.`);
    }

    onJoin(client, options) {
        const name = (options.name || "Аноним").substring(0, 30); // Ограничение длины имени

        // Регистрируем игрока если новый
        const existing = stmts.getPlayer.get(name);
        if (!existing) {
            const color = getRandomColor();
            stmts.setPlayer.run(name, color);
            log(`[Новый игрок] ${name} зарегистрирован с цветом ${color}`);
        }

        const player = stmts.getPlayer.get(name);

        client.userData = {
            name: name,
            color: player.color,
            energy: 10
        };

        if (!this.state.players.has(name)) {
            const pData = new PlayerData();
            // Start with some resources to build the first TC or let them gather
            pData.wood = 0;
            pData.stone = 0;
            pData.scrap = 0;
            this.state.players.set(name, pData);
        }

        // Отправляем начальные данные
        client.send("energyUpdate", { energy: 10 });
        client.send("playerInfo", { 
            name: name,
            color: player.color,
            totalCaptures: player.total_captures
        });

        // Спавн "Основателя" если у игрока еще нет юнитов
        let hasUnits = false;
        this.state.units.forEach(u => {
            if (u.owner === name) hasUnits = true;
        });

        if (!hasUnits) {
            const unit = new UnitData();
            unit.id = Math.random().toString(36).substr(2, 9);
            // Spawn far away from center (e.g., q=40, r=0)
            const q = 40;
            const r = 0;
            const hSize = 35;
            unit.x = hSize * Math.sqrt(3) * (q + r / 2);
            unit.y = hSize * 3 / 2 * r;
            unit.hp = 100;
            unit.maxHp = 100;
            unit.inventory = 0;
            unit.maxInventory = 500;
            unit.type = 'founder';
            unit.color = player.color;
            unit.owner = name;
            unit.action = 'idle';
            this.state.units.set(unit.id, unit);
            log(`[Спавн] Основатель для ${name} на (${q}, ${r})`);
        }

        log(`[Подключение] ${name} (цвет: ${player.color}) | Онлайн: ${this.clients.length}`);
    }

    onLeave(client, consented) {
        if (client.userData) {
            log(`[Отключение] ${client.userData.name} | Онлайн: ${this.clients.length - 1}`);
        }
    }

    onDispose() {
        log("Комната закрыта.");
    }
}

// ==========================================
// 6. ЗАПУСК СЕРВЕРА
// ==========================================
const app = express();
app.use(cors());

// Безопасная отдача статических файлов (только index.html)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const server = http.createServer(app);
const gameServer = new Server({
    transport: new WebSocketTransport({ server })
});

gameServer.define('hex_game', HexRoom);

// --- API эндпоинты ---

// Проверка сервера
app.get('/health', (req, res) => {
    const hexCount = db.prepare('SELECT COUNT(*) as count FROM hexes').get();
    const playerCount = db.prepare('SELECT COUNT(*) as count FROM players').get();
    res.json({
        status: "OK",
        hexes: hexCount.count,
        players: playerCount.count,
        uptime: Math.floor(process.uptime()) + 's'
    });
});

// Топ игроков (для внешнего использования)
app.get('/leaderboard', (req, res) => {
    const leaders = stmts.getLeaders.all();
    res.json(leaders);
});

// Запуск
const PORT = process.env.PORT || 2567;
server.listen(PORT, () => {
    log("=====================================");
    log(`🚀 СЕРВЕР ЗАПУЩЕН НА ПОРТУ ${PORT}`);
    log(`📊 База данных: SQLite (WAL режим)`);
    log(`🌐 Здоровье: http://localhost:${PORT}/health`);
    log("=====================================");
});

// Корректное завершение — закрываем БД при остановке сервера
process.on('SIGINT', () => {
    log("Сервер останавливается...");
    db.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    log("Сервер останавливается (SIGTERM)...");
    db.close();
    process.exit(0);
});
