// server.js
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server, Room } = require('colyseus');
const { WebSocketTransport } = require('@colyseus/ws-transport');
const { Schema, MapSchema, type } = require('@colyseus/schema');
const fs = require('fs');
const path = require('path');

// ==========================================
// 1. СИСТЕМА ЛОГИРОВАНИЯ
// ==========================================
const LOG_FILE = path.join(__dirname, 'server.log');

function log(message) {
    const time = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const text = `[${time}] ${message}\n`;
    console.log(text.trim()); // Выводим в консоль
    fs.appendFileSync(LOG_FILE, text); // Сохраняем в файл
}

// ==========================================
// 2. БАЗА ДАННЫХ (Локальное сохранение)
// ==========================================
const DB_FILE = path.join(__dirname, 'database.json');
// Базовая структура: hexes (id -> {owner, color}), players (name -> {color})
let dbData = { hexes: {}, players: {} };

function loadDB() {
    if (fs.existsSync(DB_FILE)) {
        try {
            dbData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            // Миграция старых данных если нужно
            if (!dbData.players) dbData.players = {};
            log("Данные игры успешно загружены из database.json");
        } catch (e) {
            log("Ошибка чтения database.json, создаем новую базу.");
            saveDB();
        }
    } else {
        log("Файл database.json не найден. Создаем новую базу...");
        saveDB();
    }
}

function saveDB() {
    fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2));
}

loadDB(); // Загружаем данные при старте сервера

// Вспомогательная функция для цветов
const PLAYER_COLORS = [
    "#e94560", "#0f3460", "#533483", "#16213e", 
    "#4ecca3", "#ff9a00", "#ff4d00", "#00d2ff"
];

function getRandomColor() {
    return PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
}

// ==========================================
// 3. СХЕМА ДАННЫХ (Для синхронизации с клиентом)
// ==========================================
class HexData extends Schema {}
type("string")(HexData.prototype, "owner");
type("string")(HexData.prototype, "color");

class GameState extends Schema {
    constructor() {
        super();
        this.hexes = new MapSchema();

        // Восстанавливаем гексы из нашей базы данных
        for (let key in dbData.hexes) {
            const hexInfo = dbData.hexes[key];
            const hexData = new HexData();
            // Поддержка старого формата (строка) и нового (объект)
            if (typeof hexInfo === 'string') {
                hexData.owner = hexInfo;
                hexData.color = dbData.players[hexInfo]?.color || "#e94560";
            } else {
                hexData.owner = hexInfo.owner;
                hexData.color = hexInfo.color;
            }
            this.hexes.set(key, hexData);
        }
    }
}
type({ map: HexData })(GameState.prototype, "hexes");

// ==========================================
// 4. ИГРОВАЯ КОМНАТА
// ==========================================
class HexRoom extends Room {
    onCreate(options) {
        this.setState(new GameState());
        log("Игровая комната создана и ждет игроков.");

        // Регенерация энергии для всех игроков каждую секунду
        this.setSimulationInterval(() => {
            this.clients.forEach(client => {
                if (client.userData.energy < 10) {
                    client.userData.energy += 0.2;
                    // Отправляем текущую энергию игроку
                    client.send("energyUpdate", { energy: Math.floor(client.userData.energy) });
                }
            });
        }, 1000);

        this.onMessage("claimHex", (client, message) => {
            const hexId = `${message.q},${message.r}`;
            const playerName = client.userData.name;
            const playerColor = client.userData.color;

            // Проверка энергии
            if (client.userData.energy < 1) {
                client.send("error", { message: "Недостаточно энергии!" });
                return;
            }

            const currentHex = this.state.hexes.get(hexId);
            
            // Если гекс пустой ИЛИ принадлежит другому игроку (перезахват)
            if (!currentHex || currentHex.owner !== playerName) {
                
                // Тратим энергию
                client.userData.energy -= 1;
                client.send("energyUpdate", { energy: Math.floor(client.userData.energy) });

                const hexData = new HexData();
                hexData.owner = playerName;
                hexData.color = playerColor;

                // 1. Состояние
                this.state.hexes.set(hexId, hexData);

                // 2. База
                dbData.hexes[hexId] = { owner: playerName, color: playerColor };
                saveDB();

                log(`[Действие] Игрок ${playerName} захватил гекс (${hexId}) цветом ${playerColor}`);
            } else {
                log(`[Инфо] Гекс ${hexId} уже принадлежит игроку ${playerName}`);
            }
        });
    }

    onJoin(client, options) {
        const name = options.name || "Аноним";
        
        if (!dbData.players[name]) {
            dbData.players[name] = { color: getRandomColor() };
            saveDB();
        }
        
        client.userData = { 
            name: name, 
            color: dbData.players[name].color,
            energy: 10 // Начальная энергия
        };
        
        log(`[Подключение] Зашел игрок: ${client.userData.name} (Цвет: ${client.userData.color})`);
        
        // Отправляем начальную энергию
        client.send("energyUpdate", { energy: client.userData.energy });
    }

    onLeave(client, consented) {
        log(`[Отключение] Игрок ${client.userData.name} вышел из игры.`);
    }
}

// ==========================================
// 5. ЗАПУСК СЕРВЕРА
// ==========================================
const app = express();
app.use(cors());
app.use(express.static(__dirname)); // Раздаем index.html из этой же папки!

const server = http.createServer(app);
const gameServer = new Server({
    transport: new WebSocketTransport({
        server: server
    })
});

// Регистрируем нашу комнату
gameServer.define('hex_game', HexRoom);

// ==========================================
// 6. ТЕСТОВЫЙ БЛОК (API)
// ==========================================
// Проверка работы сервера: http://localhost:2567/test
app.get('/test', (req, res) => {
    log("Получен запрос на /test! Все системы в норме.");
    res.json({
        status: "OK",
        message: "Сервер Hex Game работает!",
        capturedHexes: Object.keys(dbData.hexes).length
    });
});

// Запускаем сервер на порту 2567
server.listen(2567, () => {
    log("=====================================");
    log("🚀 CORE СЕРВЕР ЗАПУЩЕН НА ПОРТУ 2567");
    log("=====================================");
    console.log("\n[TEST] Привет! Это тестовое сообщение прямо в консоль вашей IDE.\n");
});
