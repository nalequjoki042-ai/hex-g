@echo off
setlocal
chcp 65001 >nul
title Hex Game Server Launcher
pushd "%~dp0"

echo [INFO] Installing dependencies...
call npm install

echo [INFO] Starting server...
call npm start

popd
pause
