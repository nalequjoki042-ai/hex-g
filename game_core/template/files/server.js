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
    setHex:      db.prepare('INSERT OR REPLACE INTO hexes (id, owner, color) VALUES (?, ?, ?)'),
    
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

class GameState extends Schema {
    constructor() {
        super();
        this.hexes = new MapSchema();

        // Загружаем все гексы из SQLite при старте
        const allHexes = stmts.getAllHexes.all();
        for (const row of allHexes) {
            const hexData = new HexData();
            hexData.owner = row.owner;
            hexData.color = row.color;
            this.hexes.set(row.id, hexData);
        }
        log(`Загружено ${allHexes.length} гексов из базы данных.`);
    }
}
type({ map: HexData })(GameState.prototype, "hexes");

// ==========================================
// 5. ИГРОВАЯ КОМНАТА
// ==========================================
class HexRoom extends Room {
    onCreate(options) {
        this.setState(new GameState());
        log("Игровая комната создана.");

        // Регенерация энергии каждую секунду
        this.setSimulationInterval(() => {
            this.clients.forEach(client => {
                if (client.userData && client.userData.energy < 10) {
                    client.userData.energy = Math.min(10, client.userData.energy + 0.2);
                    client.send("energyUpdate", { 
                        energy: Math.floor(client.userData.energy) 
                    });
                }
            });
        }, 1000);

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
                stmts.setHex.run(hexId, playerName, playerColor);
                stmts.addCapture.run(playerName);

                log(`[Захват] ${playerName} → гекс (${hexId})`);
            }
        });
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

        // Отправляем начальные данные
        client.send("energyUpdate", { energy: 10 });
        client.send("playerInfo", { 
            name: name,
            color: player.color,
            totalCaptures: player.total_captures
        });

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
app.use(express.static(__dirname));

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
