@echo off
chcp 65001 >nul
title Hex Game Server Launcher
cd /d "%~dp0"

echo [INFO] Проверка и установка библиотек...
call npm install

echo [INFO] Запуск сервера...
npm start
pause