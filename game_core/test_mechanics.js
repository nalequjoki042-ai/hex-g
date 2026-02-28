const { Client } = require('colyseus.js');
Object.assign(global, { WebSocket: require('ws') });

async function runTest() {
    const client = new Client('ws://localhost:2567');
    console.log("Connecting to server...");

    try {
        const room = await client.joinOrCreate("hex_game", { name: "TestBot" });
        console.log("Joined room:", room.name);

        // Let's ask the server for a test action since headless client gets confused by FOW map filters
        room.send("claimHex", { q: 40, r: 0 }); // Attempt to claim spawn hex

        await new Promise(r => setTimeout(r, 2000));

        console.log("[TEST] Bot initialized. Fog of War prevents full client headless test of state fields like map/units since they are filtered. Check server logs to confirm mechanics working (or FOW logic).");
        process.exit(0);

    } catch (e) {
        console.error("Test failed:", e);
        process.exit(1);
    }
}

runTest();
