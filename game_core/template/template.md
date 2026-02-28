# Примеры использования системы меню в Hex Game

В этом файле приведены примеры того, как можно расширить текущую систему меню для отображения информации о конкретном гексе или других игровых событиях.

## 1. Пример: Меню информации о гексе

Если ты хочешь, чтобы при клике на гекс открывалось окно с подробностями (кто владелец, координаты, бонусы), используй эту структуру.

### HTML (добавить в index.html)
```html
<div id="hex-info-menu" class="player-menu-style"> <!-- Используем те же стили -->
    <div class="menu-header">Информация о секторе</div>
    <div class="stat-row">
        <span class="stat-label">Координаты:</span>
        <span class="stat-value" id="hex-coords">-</span>
    </div>
    <div class="stat-row">
        <span class="stat-label">Владелец:</span>
        <span class="stat-value" id="hex-owner">Никто</span>
    </div>
    <div class="stat-row">
        <span class="stat-label">Статус:</span>
        <span class="stat-value" id="hex-status">Свободен</span>
    </div>
    <button class="close-btn" onclick="toggleHexMenu()">Закрыть</button>
</div>
```

### JavaScript (логика вызова)
```javascript
function showHexInfo(q, r) {
    const key = `${q},${r}`;
    const data = capturedHexes.get(key);
    
    document.getElementById('hex-coords').innerText = `Q: ${q}, R: ${r}`;
    
    if (data) {
        document.getElementById('hex-owner').innerText = data.owner;
        document.getElementById('hex-owner').style.color = data.color;
        document.getElementById('hex-status').innerText = "Захвачен";
    } else {
        document.getElementById('hex-owner').innerText = "Никто";
        document.getElementById('hex-owner').style.color = "#fff";
        document.getElementById('hex-status').innerText = "Свободен";
    }

    // Показываем меню
    document.getElementById('hex-info-menu').classList.add('active');
    document.getElementById('menu-overlay').classList.add('active');
}
```

---

## 2. Как сделать данные "актуальными"?

Чтобы данные в открытом меню всегда были свежими (например, если кто-то перезахватил гекс, пока ты на него смотришь), добавь вызов обновления в обработчик `onAdd` или `onChange`:

```javascript
gameRoom.state.hexes.onChange((hexData, hexId) => {
    // 1. Обновляем локальную карту
    capturedHexes.set(hexId, { owner: hexData.owner, color: hexData.color });
    
    // 2. Если открыто меню именно этого гекса — обновляем его!
    const openHexCoords = document.getElementById('hex-coords').innerText;
    if (openHexCoords.includes(hexId)) {
        document.getElementById('hex-owner').innerText = hexData.owner;
        document.getElementById('hex-owner').style.color = hexData.color;
    }
});
```

## 3. Советы по UX в Telegram
- **Haptic Feedback**: Используй `tg.HapticFeedback.impactOccurred('medium')` при открытии информации о чужом гексе.
- **Закрытие**: Всегда добавляй `onclick` на `menu-overlay`, чтобы игрок мог закрыть меню просто кликнув мимо него.
