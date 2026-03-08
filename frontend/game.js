/**
 * Monster Battle Arena — Retro Edition
 * WebSocket client + Pixel-art Canvas renderer + Input handler
 */

// ──────────────────────────────────────────────
// DOM references
// ──────────────────────────────────────────────
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
const lobbyOverlay = document.getElementById('lobby-overlay');
const gameoverOverlay = document.getElementById('gameover-overlay');
const lobbyStatus = document.getElementById('lobby-status');
const lobbyPlayers = document.getElementById('lobby-players');
const joinBtn = document.getElementById('join-btn');
const nameInput = document.getElementById('name-input');
const serverInput = document.getElementById('server-url-input');
const gameoverTitle = document.getElementById('gameover-title');
const gameoverSub = document.getElementById('gameover-subtext');
const restartBtn = document.getElementById('restart-btn');
const hud = document.getElementById('hud');
const startBtn = document.getElementById('start-btn');
const adminNote = document.getElementById('admin-note');
const connectInfo = document.getElementById('connect-info');
const lanUrlSpan = document.getElementById('lan-url');

// ──────────────────────────────────────────────
// Client state
// ──────────────────────────────────────────────
let ws = null;
let myId = null;
let adminId = null;
let gameState = null;
let connected = false;
let phase = 'lobby';

// Input
const keys = { w: false, a: false, s: false, d: false };
const aim = { up: false, down: false, left: false, right: false };
let lastShootTime = 0;
const SHOOT_COOLDOWN = 600;

// Aim angle (radians)
let aimAngle = 0;

// Visual effects
let particles = [];
let screenShake = 0;
let shakeX = 0, shakeY = 0;

// Monster phase tracking (client-side)
let monsterMovedWarned = false;   // showed the "MONSTER MOVES!" flash
let monsterEvolvedWarned = false; // showed the "DRAGON AWAKENS!" flash
let phaseFlash = 0;               // 0-1, fades out
let phaseFlashColor = '#ff0000';
let phaseFlashText = '';
let phaseFlashTimer = 0;

// Retro color palette for players
const RETRO_COLORS = ['#ff2244', '#00ff66', '#ffdd00', '#00aaff', '#ff66ff', '#ff8800'];

// ──────────────────────────────────────────────
// Admin helpers
// ──────────────────────────────────────────────
function isAdmin() {
    if (adminId === null && myId) return true;
    return myId && myId === adminId;
}

function updateAdminUI() {
    if (!connected) {
        startBtn.style.display = 'none';
        adminNote.style.display = 'none';
        return;
    }
    if (isAdmin()) {
        startBtn.style.display = 'block';
        adminNote.style.display = 'block';
        startBtn.disabled = false;
    } else {
        startBtn.style.display = 'none';
        adminNote.style.display = 'none';
    }
}

function showConnectInfo() {
    connectInfo.style.display = 'block';
    const serverAddr = serverInput.value.trim() || window.location.host || 'localhost:8000';
    lanUrlSpan.textContent = `http://${serverAddr}`;
}

// ──────────────────────────────────────────────
// Connection
// ──────────────────────────────────────────────
function connect() {
    const name = nameInput.value.trim() || 'PLAYER';
    const server = serverInput.value.trim() || 'localhost:8000';
    const url = `ws://${server}/ws/${encodeURIComponent(name)}`;

    joinBtn.disabled = true;
    joinBtn.textContent = '[ CONNECTING... ]';

    ws = new WebSocket(url);

    ws.onopen = () => { connected = true; };

    ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        handleMessage(msg);
    };

    ws.onclose = () => {
        connected = false;
        joinBtn.disabled = false;
        joinBtn.textContent = '[ JOIN GAME ]';
        startBtn.style.display = 'none';
        adminNote.style.display = 'none';
        connectInfo.style.display = 'none';
        if (phase === 'playing') {
            showLobby();
            lobbyStatus.textContent = 'DISCONNECTED FROM SERVER.';
        }
    };

    ws.onerror = () => {
        joinBtn.disabled = false;
        joinBtn.textContent = '[ JOIN GAME ]';
        lobbyStatus.textContent = '!! CANNOT CONNECT — CHECK ADDRESS !!';
    };
}

// ──────────────────────────────────────────────
// Message Handler
// ──────────────────────────────────────────────
function handleMessage(msg) {
    switch (msg.type) {
        case 'rejected':
            lobbyStatus.textContent = `REJECTED: ${msg.reason.toUpperCase()}`;
            joinBtn.disabled = false;
            joinBtn.textContent = '[ JOIN GAME ]';
            break;

        case 'joined':
            myId = msg.your_id;
            adminId = msg.admin_id;
            nameInput.disabled = true;
            serverInput.disabled = true;
            if (!serverInput.value.trim()) serverInput.value = window.location.host || 'localhost:8000';
            joinBtn.style.display = 'none';
            showConnectInfo();
            updateAdminUI();
            break;

        case 'lobby':
            adminId = msg.admin_id;
            updateLobbyUI(msg);
            updateAdminUI();
            break;

        case 'game_start':
            phase = 'playing';
            showGame();
            break;

        case 'state':
            gameState = msg;
            adminId = msg.admin_id || adminId;
            phase = msg.phase;
            if (phase === 'gameover') showGameOver(msg.winner);
            updateHUD();
            // Check phase milestones
            if (msg.elapsed !== undefined) checkPhaseWarnings(msg.elapsed, msg.monster);
            break;

        case 'player_left':
            adminId = msg.admin_id || adminId;
            if (phase === 'lobby') {
                updateLobbyPlayersFromList(msg.players, adminId);
                updateAdminUI();
            }
            break;
    }
}

// ──────────────────────────────────────────────
// Phase Warning Logic
// ──────────────────────────────────────────────
function checkPhaseWarnings(elapsed, monster) {
    if (!monsterMovedWarned && elapsed >= 10) {
        monsterMovedWarned = true;
        triggerPhaseFlash('#ff2200', '!! MONSTER IS MOVING !!', 2.5);
        screenShake = 0.8;
    }
    if (!monsterEvolvedWarned && monster && monster.evolved && elapsed >= 20) {
        monsterEvolvedWarned = true;
        triggerPhaseFlash('#9900ff', 'DRAGON AWAKENS!!!', 3.5);
        screenShake = 2.0;
        // Burst of purple/orange particles at center
        for (let i = 0; i < 40; i++) {
            const colors = ['#ff6600', '#ffaa00', '#cc00ff', '#ff00aa', '#ffffff'];
            spawnParticles(MAP_W / 2, MAP_H / 2, colors[Math.floor(Math.random() * colors.length)], 1, 6 + Math.random() * 8);
        }
    }
}

function triggerPhaseFlash(color, text, duration) {
    phaseFlashColor = color;
    phaseFlashText = text;
    phaseFlashTimer = duration;
    phaseFlash = 1.0;
}

// ──────────────────────────────────────────────
// UI helpers
// ──────────────────────────────────────────────
function showGame() {
    lobbyOverlay.classList.add('hidden');
    gameoverOverlay.classList.add('hidden');
}

function showLobby() {
    lobbyOverlay.classList.remove('hidden');
    gameoverOverlay.classList.add('hidden');
    hud.innerHTML = '';
}

function showGameOver(winner) {
    gameoverOverlay.classList.remove('hidden');
    if (winner === 'players') {
        gameoverOverlay.className = 'overlay victory';
        gameoverTitle.textContent = '* VICTORY! *';
        gameoverSub.textContent = 'THE MONSTER HAS BEEN DEFEATED!\nWELL PLAYED, HEROES!';
    } else {
        gameoverOverlay.className = 'overlay defeat';
        gameoverTitle.textContent = '* GAME OVER *';
        gameoverSub.textContent = 'THE MONSTER DESTROYED YOUR TEAM...\nCONTINUE?';
    }
}

function updateLobbyUI(msg) {
    const count = msg.player_count;
    const maxP = msg.max_players || 4;
    const players = msg.players || {};
    lobbyStatus.textContent = `PLAYERS: ${count} / ${maxP}`;
    updateLobbyPlayersFromList(players, msg.admin_id);
}

function updateLobbyPlayersFromList(players, currentAdminId) {
    lobbyPlayers.innerHTML = '';
    for (const [pid, p] of Object.entries(players)) {
        const tag = document.createElement('span');
        tag.className = 'lobby-player-tag' + (pid === currentAdminId ? ' admin-tag' : '');
        tag.textContent = p.name.toUpperCase();
        tag.style.color = p.color;
        tag.style.borderColor = p.color;
        lobbyPlayers.appendChild(tag);
    }
}

function updateHUD() {
    if (!gameState) return;
    const players = gameState.players;
    hud.innerHTML = '';
    for (const [pid, p] of Object.entries(players)) {
        const pct = Math.max(0, p.hp / p.max_hp * 100);
        const card = document.createElement('div');
        card.className = 'hud-card';
        const isMe = pid === myId;
        card.innerHTML = `
      <div class="hud-bar-bg">
        <div class="hud-bar-fill" style="width:${pct}%;background:${p.alive ? p.color : '#330011'}"></div>
      </div>
      <div class="hud-name" style="color:${p.color}">${isMe ? '>> ' : ''}${p.name.toUpperCase()}</div>
      <div class="hud-hp-text">${p.alive ? `HP ${p.hp}/${p.max_hp}` : '!! DEAD !!'}</div>
    `;
        hud.appendChild(card);
    }
}

// ──────────────────────────────────────────────
// Input
// ──────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'w') keys.w = true;
    if (k === 'a') keys.a = true;
    if (k === 's') keys.s = true;
    if (k === 'd') keys.d = true;
    if (e.key === 'ArrowUp') { aim.up = true; e.preventDefault(); }
    if (e.key === 'ArrowDown') { aim.down = true; e.preventDefault(); }
    if (e.key === 'ArrowLeft') { aim.left = true; e.preventDefault(); }
    if (e.key === 'ArrowRight') { aim.right = true; e.preventDefault(); }
    if (k === ' ') { e.preventDefault(); shoot(); }
    if (k === 'enter' && phase === 'lobby') joinGame();
});

document.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'w') keys.w = false;
    if (k === 'a') keys.a = false;
    if (k === 's') keys.s = false;
    if (k === 'd') keys.d = false;
    if (e.key === 'ArrowUp') aim.up = false;
    if (e.key === 'ArrowDown') aim.down = false;
    if (e.key === 'ArrowLeft') aim.left = false;
    if (e.key === 'ArrowRight') aim.right = false;
});

canvas.addEventListener('click', () => { if (phase === 'playing') shoot(); });

function sendMove() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const dx = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
    const dy = (keys.s ? 1 : 0) - (keys.w ? 1 : 0);
    if (dx !== 0 || dy !== 0) ws.send(JSON.stringify({ type: 'move', dx, dy }));
}

function getAimVector(me) {
    // 1. Check direct aim keys (Arrows)
    let adx = (aim.right ? 1 : 0) - (aim.left ? 1 : 0);
    let ady = (aim.down ? 1 : 0) - (aim.up ? 1 : 0);
    if (adx !== 0 || ady !== 0) {
        const mag = Math.sqrt(adx * adx + ady * ady);
        return { dx: adx / mag, dy: ady / mag };
    }

    // 2. Check movement keys (WASD / D-pad)
    let mdx = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
    let mdy = (keys.s ? 1 : 0) - (keys.w ? 1 : 0);
    if (mdx !== 0 || mdy !== 0) {
        const mag = Math.sqrt(mdx * mdx + mdy * mdy);
        return { dx: mdx / mag, dy: mdy / mag };
    }

    // 3. Fallback to last used aim angle
    return { dx: Math.cos(aimAngle), dy: Math.sin(aimAngle) };
}

function shoot() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!myId || !gameState) return;
    const me = gameState.players[myId];
    if (!me || !me.alive) return;
    const now = performance.now();
    if (now - lastShootTime < SHOOT_COOLDOWN) return;
    lastShootTime = now;

    // Update aimAngle for visual feedback (facing the monster)
    const monster = gameState.monster;
    if (monster && monster.alive) {
        aimAngle = Math.atan2(monster.y - me.y, monster.x - me.x);
    }

    // AUTO-AIM: We no longer send aim_dx/dy. 
    // The server will automatically aim at the monster if these are missing.
    ws.send(JSON.stringify({ type: 'shoot' }));

    // Retro shoot sparks
    spawnParticles(me.x, me.y, '#ffdd00', 6, 3, 'square');
}

// ──────────────────────────────────────────────
// Particles (pixel-style)
// ──────────────────────────────────────────────
function spawnParticles(x, y, color, count, speed, shape = 'circle') {
    for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        particles.push({
            x, y,
            vx: Math.cos(angle) * speed * (0.5 + Math.random()),
            vy: Math.sin(angle) * speed * (0.5 + Math.random()),
            life: 1,
            maxLife: 0.35 + Math.random() * 0.3,
            size: 4 + Math.floor(Math.random() * 4),
            color,
            shape,
        });
    }
}

function updateParticles(dt) {
    for (const p of particles) {
        p.x += p.vx * dt * 60;
        p.y += p.vy * dt * 60;
        p.life -= dt / p.maxLife;
        p.vx *= 0.9;
        p.vy *= 0.9;
    }
    particles = particles.filter(p => p.life > 0);
}

// ──────────────────────────────────────────────
// Pixel art drawing helpers
// ──────────────────────────────────────────────
/**
 * Draw a pixel-art sprite defined as a grid of characters:
 *   '.' = transparent, any other char = filled with color
 * @param {number} x - center x
 * @param {number} y - center y
 * @param {string[]} rows - array of strings (each char = 1 pixel)
 * @param {Object} palette - char → color mapping
 * @param {number} scale - pixel size
 */
function drawPixelSprite(x, y, rows, palette, scale = 4) {
    const W = rows[0].length;
    const H = rows.length;
    const ox = x - (W * scale) / 2;
    const oy = y - (H * scale) / 2;
    for (let row = 0; row < H; row++) {
        for (let col = 0; col < W; col++) {
            const ch = rows[row][col];
            if (ch === '.') continue;
            ctx.fillStyle = palette[ch] || '#ffffff';
            ctx.fillRect(
                Math.floor(ox + col * scale),
                Math.floor(oy + row * scale),
                scale,
                scale
            );
        }
    }
}

// ──────────────────────────────────────────────
// Rendering
// ──────────────────────────────────────────────
const MAP_W = 1200;
const MAP_H = 800;

// Retro grid — brick/dungeon floor tiles
function drawBackground() {
    const TILE = 40;
    // Base dark floor
    ctx.fillStyle = '#0d0208';
    ctx.fillRect(0, 0, MAP_W, MAP_H);

    // Tile pattern - alternating subtle dark red / darker
    for (let gy = 0; gy * TILE < MAP_H; gy++) {
        for (let gx = 0; gx * TILE < MAP_W; gx++) {
            const isOdd = (gx + gy) % 2;
            ctx.fillStyle = isOdd ? '#110308' : '#0d0208';
            ctx.fillRect(gx * TILE, gy * TILE, TILE, TILE);
        }
    }

    // Grid lines - retro neon red tint
    ctx.strokeStyle = '#2a0010';
    ctx.lineWidth = 1;
    for (let x = 0; x <= MAP_W; x += TILE) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, MAP_H); ctx.stroke();
    }
    for (let y = 0; y <= MAP_H; y += TILE) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(MAP_W, y); ctx.stroke();
    }

    // Corner accent dots
    ctx.fillStyle = '#440022';
    for (let x = 0; x <= MAP_W; x += TILE) {
        for (let y = 0; y <= MAP_H; y += TILE) {
            ctx.fillRect(x - 1, y - 1, 2, 2);
        }
    }

    // Arena border (pixel style — double border)
    ctx.strokeStyle = '#ff2244';
    ctx.lineWidth = 4;
    ctx.strokeRect(4, 4, MAP_W - 8, MAP_H - 8);
    ctx.strokeStyle = '#660011';
    ctx.lineWidth = 2;
    ctx.strokeRect(10, 10, MAP_W - 20, MAP_H - 20);
}

// Retro pixel-art health bar
function drawHealthBar(x, y, w, hp, maxHp, color, label) {
    const barY = y - 40;
    const pct = Math.max(0, hp / maxHp);
    const barW = w;

    ctx.save();

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(x - barW / 2 - 2, barY - 12, barW + 4, 12);

    // Background
    ctx.fillStyle = '#1a0008';
    ctx.fillRect(x - barW / 2, barY - 11, barW, 10);

    // Segments — pixel block style
    const hue = pct > 0.6 ? '#00ff44' : pct > 0.3 ? '#ffdd00' : '#ff2244';
    const segments = Math.floor(pct * (barW / 4));
    for (let i = 0; i < segments; i++) {
        ctx.fillStyle = hue;
        ctx.fillRect(x - barW / 2 + i * 4, barY - 10, 3, 8);
    }

    // Border
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(x - barW / 2, barY - 11, barW, 10);

    if (label) {
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 9px "Press Start 2P", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(label, x, barY - 14);
    }
    ctx.restore();
}

// ── Monster sprite (pixel art ogre/demon) ──
const MONSTER_SPRITE = [
    '..RRRRRRR..',  // 0
    '.RRRRRRRRRR.', // 1 - horns start
    'RRRRRRRRRRRR', // 2
    'RRDDRRRRRDD.',  // 3  - eyes row
    'RRRRRRRRRRR.',  // 4
    '.RDDRDDRRD..',  // 5  - mouth row
    '..RRRRRRR...',  // 6
    '.DRRRRRRRD..',  // 7  - body
    'RRRRRRRRRRRR',  // 8
    'RRRRRRRRRRR.',  // 9
    '.RRRRRRRRRR.',  // 10 - arms
    '..RRRRRRR...',  // 11 - legs
    '...RRRRRR...',  // 12
];

const MONSTER_PALETTE = {
    'R': '#cc1133',   // body red
    'D': '#000000',   // dark (eyes/mouth)
    'H': '#7700aa',   // highlight/horn
};

// Retro blob monster — branches to dragon after evolution
function drawMonster(m) {
    if (!m.alive) return;
    if (m.evolved) {
        drawDragon(m);
    } else {
        drawOgre(m);
    }
}

// ── Original Ogre Monster ──
function drawOgre(m) {
    const { x, y } = m;
    const t = performance.now() / 1000;
    const bobY = Math.sin(t * 2) * 4;
    const scale = 1 + Math.sin(t * 3) * 0.02;

    ctx.save();
    ctx.translate(x, y + bobY);
    ctx.scale(scale, scale);

    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath();
    ctx.ellipse(0, 52, 36, 10, 0, 0, Math.PI * 2);
    ctx.fill();

    for (let r = 80; r > 40; r -= 8) {
        ctx.strokeStyle = `rgba(220,0,40,${0.04 * (80 - r) / 40})`;
        ctx.lineWidth = 8;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.stroke();
    }

    const PS = 8;
    const bodyPixels = [
        [-16, -24], [-8, -24], [0, -24], [8, -24], [16, -24],
        [-24, -16], [-16, -16], [-8, -16], [0, -16], [8, -16], [16, -16], [24, -16],
        [-24, -8], [-16, -8], [-8, -8], [0, -8], [8, -8], [16, -8], [24, -8],
        [-24, 0], [-16, 0], [-8, 0], [0, 0], [8, 0], [16, 0], [24, 0],
        [-16, 8], [-8, 8], [0, 8], [8, 8], [16, 8],
        [-16, 16], [-8, 16], [0, 16], [8, 16], [16, 16],
        [-16, 24], [-8, 24], [0, 24], [8, 24], [16, 24],
        [-8, 32], [0, 32], [8, 32],
    ];
    ctx.fillStyle = '#aa0022';
    for (const [px, py] of bodyPixels) ctx.fillRect(px - PS / 2, py - PS / 2, PS, PS);

    const hi = [[-16, -24], [-8, -24], [0, -24], [-24, -16], [-16, -16], [-8, -16], [-24, -8], [-16, -8]];
    ctx.fillStyle = '#ff3355';
    for (const [px, py] of hi) ctx.fillRect(px - PS / 2, py - PS / 2, PS - 2, PS - 2);

    ctx.fillStyle = '#880022';
    ctx.beginPath(); ctx.moveTo(-20, -24); ctx.lineTo(-28, -48); ctx.lineTo(-12, -24); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(12, -24); ctx.lineTo(28, -48); ctx.lineTo(20, -24); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#cc0033';
    ctx.beginPath(); ctx.moveTo(-20, -28); ctx.lineTo(-22, -40); ctx.lineTo(-14, -28); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(14, -28); ctx.lineTo(22, -40); ctx.lineTo(20, -28); ctx.closePath(); ctx.fill();

    const blink = Math.floor(t * 3) % 10 === 0;
    if (!blink) {
        ctx.fillStyle = '#ffdd00'; ctx.fillRect(-18, -12, 12, 12); ctx.fillStyle = '#ff8800'; ctx.fillRect(-14, -8, 8, 8);
        ctx.fillStyle = '#000'; ctx.fillRect(-12, -6, 6, 6);
        ctx.fillStyle = 'rgba(255,220,0,0.3)'; ctx.beginPath(); ctx.arc(-12, -6, 10, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ffdd00'; ctx.fillRect(6, -12, 12, 12); ctx.fillStyle = '#ff8800'; ctx.fillRect(6, -8, 8, 8);
        ctx.fillStyle = '#000'; ctx.fillRect(6, -6, 6, 6);
        ctx.fillStyle = 'rgba(255,220,0,0.3)'; ctx.beginPath(); ctx.arc(12, -6, 10, 0, Math.PI * 2); ctx.fill();
    } else {
        ctx.fillStyle = '#ffdd00'; ctx.fillRect(-18, -7, 12, 3); ctx.fillRect(6, -7, 12, 3);
    }

    ctx.fillStyle = '#330000';
    for (const [px, py] of [[-16, 16], [-8, 16], [0, 16], [8, 16], [16, 16]]) ctx.fillRect(px - 4, py - 4, 8, 12);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(-16, 16, 4, 8); ctx.fillRect(-4, 16, 4, 8); ctx.fillRect(8, 16, 4, 8); ctx.fillRect(14, 16, 4, 6);

    ctx.fillStyle = '#aa0022';
    ctx.fillRect(-40, -4, 16, 12); ctx.fillRect(-48, 4, 12, 8);
    ctx.fillStyle = '#660011';
    ctx.fillRect(-52, 0, 8, 4); ctx.fillRect(-52, 8, 8, 4); ctx.fillRect(-52, 16, 6, 4);
    ctx.fillStyle = '#aa0022';
    ctx.fillRect(24, -4, 16, 12); ctx.fillRect(36, 4, 12, 8);
    ctx.fillStyle = '#660011';
    ctx.fillRect(44, 0, 8, 4); ctx.fillRect(44, 8, 8, 4); ctx.fillRect(46, 16, 6, 4);

    ctx.fillStyle = '#880022';
    ctx.fillRect(-16, 32, 10, 16); ctx.fillRect(6, 32, 10, 16);
    ctx.fillStyle = '#550011';
    ctx.fillRect(-18, 44, 14, 8); ctx.fillRect(4, 44, 14, 8);

    ctx.restore();

    const ragePct = 1 - (m.hp / m.max_hp);
    if (ragePct > 0.5) {
        ctx.save();
        ctx.strokeStyle = `rgba(255,0,0,${(ragePct - 0.5) * 0.6})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y + bobY, 60 + Math.sin(t * 20) * 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }
}

// ── Retro Colosseum Dragon ──
function drawDragon(m) {
    const { x, y } = m;
    const t = performance.now() / 1000;
    const bobY = Math.sin(t * 1.5) * 6;
    const breathe = 1 + Math.sin(t * 4) * 0.03;
    const roarFlap = Math.sin(t * 6);   // wing flap

    ctx.save();
    ctx.translate(x, y + bobY);
    ctx.scale(breathe, breathe);

    // ── Shadow ──
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath(); ctx.ellipse(0, 72, 60, 14, 0, 0, Math.PI * 2); ctx.fill();

    // ── Purple/gold aura ──
    for (let r = 110; r > 60; r -= 10) {
        const a = 0.05 * (110 - r) / 50;
        ctx.strokeStyle = `rgba(180,0,255,${a})`;
        ctx.lineWidth = 10;
        ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
    }

    // ── LEFT WING (swept back, large) ──
    ctx.save();
    ctx.translate(-30, -10);
    ctx.rotate(-0.3 + roarFlap * 0.15);
    ctx.fillStyle = '#330044';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-90, -60 + roarFlap * 10);
    ctx.lineTo(-80, 10);
    ctx.lineTo(-50, 30);
    ctx.closePath();
    ctx.fill();
    // Wing membrane veins
    ctx.strokeStyle = '#660088';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-85, -55 + roarFlap * 10); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-70, 5); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-45, 28); ctx.stroke();
    // Wing highlight edge
    ctx.strokeStyle = '#9900cc';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-90, -60 + roarFlap * 10);
    ctx.lineTo(-80, 10);
    ctx.stroke();
    ctx.restore();

    // ── RIGHT WING ──
    ctx.save();
    ctx.translate(30, -10);
    ctx.rotate(0.3 - roarFlap * 0.15);
    ctx.fillStyle = '#330044';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(90, -60 - roarFlap * 10);
    ctx.lineTo(80, 10);
    ctx.lineTo(50, 30);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#660088';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(85, -55 - roarFlap * 10); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(70, 5); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(45, 28); ctx.stroke();
    ctx.strokeStyle = '#9900cc';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(90, -60 - roarFlap * 10); ctx.lineTo(80, 10); ctx.stroke();
    ctx.restore();

    // ── TAIL (long, segmented) ──
    const tailSegs = 6;
    ctx.strokeStyle = '#4a0066';
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 32);
    for (let i = 1; i <= tailSegs; i++) {
        const tx = Math.sin(t * 2 + i * 0.8) * 12 * i / tailSegs;
        ctx.lineTo(tx, 32 + i * 14);
    }
    ctx.stroke();
    // Tail highlight
    ctx.strokeStyle = '#7700aa';
    ctx.lineWidth = 6;
    ctx.stroke();
    // Tail spike
    const tailTip = { x: Math.sin(t * 2 + tailSegs * 0.8) * 12, y: 32 + tailSegs * 14 };
    ctx.fillStyle = '#cc00ff';
    ctx.beginPath();
    ctx.moveTo(tailTip.x, tailTip.y);
    ctx.lineTo(tailTip.x - 6, tailTip.y - 10);
    ctx.lineTo(tailTip.x + 6, tailTip.y - 10);
    ctx.closePath();
    ctx.fill();

    // ── BODY — armoured torso ──
    const PS = 10;
    const dragonBody = [
        [0, -32], [10, -32], [-10, -32],
        [-20, -22], [-10, -22], [0, -22], [10, -22], [20, -22],
        [-28, -12], [-18, -12], [-8, -12], [0, -12], [8, -12], [18, -12], [28, -12],
        [-28, -2], [-18, -2], [-8, -2], [0, -2], [8, -2], [18, -2], [28, -2],
        [-24, 8], [-14, 8], [-4, 8], [4, 8], [14, 8], [24, 8],
        [-20, 18], [-10, 18], [0, 18], [10, 18], [20, 18],
        [-14, 28], [-4, 28], [4, 28], [14, 28],
    ];
    // Base dark purple armour
    ctx.fillStyle = '#2a0044';
    for (const [px, py] of dragonBody) ctx.fillRect(px - PS / 2, py - PS / 2, PS, PS);
    // Gold armour plates (top rows)
    ctx.fillStyle = '#886600';
    for (const [px, py] of dragonBody.slice(0, 8)) ctx.fillRect(px - PS / 2 + 1, py - PS / 2 + 1, PS - 3, PS - 3);
    // Highlight
    ctx.fillStyle = '#ccaa00';
    for (const [px, py] of [[-20, -22], [0, -32], [-28, -12]]) ctx.fillRect(px - 3, py - 3, 5, 5);

    // ── FRONT LEGS / CLAWS ──
    ctx.fillStyle = '#4a0066';
    ctx.fillRect(-36, 10, 14, 20);
    ctx.fillRect(22, 10, 14, 20);
    ctx.fillStyle = '#220033';
    // Left claws
    ctx.fillRect(-42, 28, 6, 4); ctx.fillRect(-38, 32, 5, 4); ctx.fillRect(-32, 28, 6, 4);
    // Right claws
    ctx.fillRect(36, 28, 6, 4); ctx.fillRect(31, 32, 5, 4); ctx.fillRect(26, 28, 6, 4);

    // ── NECK ──
    ctx.fillStyle = '#3a0055';
    ctx.fillRect(-10, -44, 20, 16);
    ctx.fillStyle = '#660088';
    ctx.fillRect(-6, -44, 4, 14);

    // ── HEAD ──
    // Snout / jaw
    ctx.fillStyle = '#2a0044';
    ctx.fillRect(-22, -72, 44, 32);
    // Armour plating on head
    ctx.fillStyle = '#664400';
    ctx.fillRect(-20, -72, 40, 10);
    ctx.fillStyle = '#aa7700';
    ctx.fillRect(-18, -72, 36, 6);

    // Dragon horns (large swept back)
    ctx.fillStyle = '#440066';
    ctx.beginPath(); ctx.moveTo(-16, -72); ctx.lineTo(-28, -106); ctx.lineTo(-6, -72); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(6, -72); ctx.lineTo(28, -106); ctx.lineTo(16, -72); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#880099';
    ctx.beginPath(); ctx.moveTo(-14, -74); ctx.lineTo(-22, -100); ctx.lineTo(-8, -74); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(8, -74); ctx.lineTo(22, -100); ctx.lineTo(14, -74); ctx.closePath(); ctx.fill();

    // Eyes — glowing red/orange
    const blink = Math.floor(t * 2) % 12 === 0;
    if (!blink) {
        // Left eye
        ctx.fillStyle = '#ff2200'; ctx.fillRect(-18, -62, 14, 14);
        ctx.fillStyle = '#ff6600'; ctx.fillRect(-16, -60, 10, 10);
        ctx.fillStyle = '#000'; ctx.fillRect(-14, -58, 7, 7);
        ctx.fillStyle = 'rgba(255,80,0,0.4)';
        ctx.beginPath(); ctx.arc(-11, -54, 12, 0, Math.PI * 2); ctx.fill();
        // Right eye
        ctx.fillStyle = '#ff2200'; ctx.fillRect(4, -62, 14, 14);
        ctx.fillStyle = '#ff6600'; ctx.fillRect(6, -60, 10, 10);
        ctx.fillStyle = '#000'; ctx.fillRect(7, -58, 7, 7);
        ctx.fillStyle = 'rgba(255,80,0,0.4)';
        ctx.beginPath(); ctx.arc(11, -54, 12, 0, Math.PI * 2); ctx.fill();
    } else {
        ctx.fillStyle = '#ff4400';
        ctx.fillRect(-18, -56, 14, 4);
        ctx.fillRect(4, -56, 14, 4);
    }

    // Jaw / teeth
    ctx.fillStyle = '#1a0028';
    ctx.fillRect(-18, -46, 36, 8);
    ctx.fillStyle = '#dddddd';
    for (let i = -16; i <= 14; i += 8) {
        ctx.fillRect(i, -46, 5, 7);
    }
    // Fire-glow inside mouth
    const fireFlicker = 0.5 + 0.5 * Math.sin(t * 15);
    ctx.fillStyle = `rgba(255,${100 + Math.floor(fireFlicker * 80)},0,0.7)`;
    ctx.fillRect(-14, -45, 28, 5);

    // ── ANIMATED FIRE BREATH at mouth ──
    ctx.save();
    ctx.translate(0, -40);
    for (let i = 0; i < 5; i++) {
        const fAngle = -Math.PI / 2 + (i - 2) * 0.18 + Math.sin(t * 8 + i) * 0.05;
        const fLen = 30 + Math.sin(t * 10 + i * 1.3) * 12;
        const grad = ctx.createLinearGradient(0, 0, Math.cos(fAngle) * fLen, Math.sin(fAngle) * fLen);
        grad.addColorStop(0, 'rgba(255,200,0,0.9)');
        grad.addColorStop(0.5, 'rgba(255,80,0,0.6)');
        grad.addColorStop(1, 'rgba(255,0,0,0)');
        ctx.strokeStyle = grad;
        ctx.lineWidth = 5 + i;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(fAngle) * fLen, Math.sin(fAngle) * fLen);
        ctx.stroke();
    }
    ctx.restore();

    ctx.restore();

    // Dragon name tag
    ctx.save();
    ctx.font = 'bold 9px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#cc00ff';
    ctx.shadowColor = '#cc00ff';
    ctx.shadowBlur = 8;
    ctx.fillText('COLOSSEUM DRAGON', x, y + bobY + 120);
    ctx.restore();
}

// ── Player sprite (8-bit hero) ──
// Pixel-art player character — uses player color
function drawBossHUD(m) {
    if (!m || !m.alive) return;
    const padding = 100;
    const barW = MAP_W - padding * 2;
    const barH = 20;
    const x = padding;
    const y = 35;

    ctx.save();
    // Shadow/Black background
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillRect(x - 4, y - 4, barW + 8, barH + 8);

    // Border based on phase
    ctx.strokeStyle = m.evolved ? '#cc00ff' : '#ff2244';
    ctx.lineWidth = 3;
    ctx.strokeRect(x - 4, y - 4, barW + 8, barH + 8);

    // Background fill
    ctx.fillStyle = '#1a0008';
    ctx.fillRect(x, y, barW, barH);

    // HP Bar
    const pct = Math.max(0, m.hp / m.max_hp);
    const hue = m.evolved ? '#cc00ff' : (pct > 0.5 ? '#00ff66' : pct > 0.25 ? '#ffdd00' : '#ff2244');
    ctx.fillStyle = hue;
    ctx.fillRect(x, y, barW * pct, barH);

    // Boss Name
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 11px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = '#000';
    ctx.shadowBlur = 4;
    const bossName = m.evolved ? '!!! COLOSSEUM DRAGON !!!' : '--- ANCIENT OGRE ---';
    ctx.fillText(bossName, MAP_W / 2, y + barH / 2);
    ctx.restore();
}

function drawPlayerPixels(x, y, color, isMe, scale = 4) {
    const S = scale;
    ctx.save();
    ctx.translate(x, y);

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath();
    ctx.ellipse(0, S * 5, S * 3, S, 0, 0, Math.PI * 2);
    ctx.fill();

    // "Me" glow ring
    if (isMe) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.shadowColor = color;
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(0, 0, S * 5.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.shadowBlur = 0;
    }

    // HEAD (3x3 pixels)
    ctx.fillStyle = lighten(color);
    ctx.fillRect(-S * 1.5, -S * 6, S * 3, S * 3);
    // head shadow side
    ctx.fillStyle = darken(color);
    ctx.fillRect(S * 1, -S * 6, S * 0.5, S * 3);
    ctx.fillRect(-S * 1.5, -S * 3.5, S * 3, S * 0.5);

    // Visor / face
    ctx.fillStyle = '#88ddff';
    ctx.fillRect(-S * 1, -S * 5.5, S * 2, S);
    // Visor shine
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(-S * 0.8, -S * 5.3, S * 0.4, S * 0.4);

    // BODY (armor)
    ctx.fillStyle = color;
    ctx.fillRect(-S * 2, -S * 3, S * 4, S * 4);
    // Armor highlight
    ctx.fillStyle = lighten(color);
    ctx.fillRect(-S * 2, -S * 3, S * 0.5, S * 4);
    ctx.fillRect(-S * 2, -S * 3, S * 4, S * 0.5);
    // Armor shadow
    ctx.fillStyle = darken(color);
    ctx.fillRect(S * 1.5, -S * 3, S * 0.5, S * 4);
    ctx.fillRect(-S * 2, S * 0.5, S * 4, S * 0.5);

    // Chest detail
    ctx.fillStyle = darken(color);
    ctx.fillRect(-S * 0.5, -S * 2, S, S);

    // LEGS
    ctx.fillStyle = darken(color);
    ctx.fillRect(-S * 2, S, S * 1.5, S * 3);
    ctx.fillRect(S * 0.5, S, S * 1.5, S * 3);
    // Boot highlight
    ctx.fillStyle = '#555566';
    ctx.fillRect(-S * 2, S * 3, S * 1.5, S);
    ctx.fillRect(S * 0.5, S * 3, S * 1.5, S);

    // ARMS
    ctx.fillStyle = color;
    ctx.fillRect(-S * 3, -S * 3, S, S * 3);
    ctx.fillRect(S * 2, -S * 3, S, S * 3);
    // Gun/weapon on right arm
    ctx.fillStyle = '#888899';
    ctx.fillRect(S * 2.5, -S * 2, S * 2, S);
    ctx.fillStyle = '#555566';
    ctx.fillRect(S * 4, -S * 2.2, S * 0.5, S * 1.5);

    ctx.restore();
}

function drawPlayer(p, isMe) {
    const { x, y, color, alive } = p;

    if (!alive) {
        ctx.save();
        ctx.globalAlpha = 0.35;
        // Dead sprite — greyed out pixel cross
        ctx.fillStyle = '#334433';
        ctx.fillRect(x - 16, y - 4, 32, 8);
        ctx.fillRect(x - 4, y - 16, 8, 32);
        ctx.fillStyle = '#ffffff';
        ctx.font = '12px "Press Start 2P", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('X', x, y);
        ctx.restore();
        return;
    }

    // Draw pixel art character
    drawPlayerPixels(x, y, color, isMe, 4);

    // Name tag — retro style
    ctx.save();
    const nameTag = (isMe ? '> ' : '') + p.name.toUpperCase();
    const tagW = nameTag.length * 6 + 8;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(x - tagW / 2, y - 52, tagW, 12);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(x - tagW / 2, y - 52, tagW, 12);
    ctx.fillStyle = isMe ? '#ffffff' : color;
    ctx.font = '7px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(nameTag, x, y - 46);
    ctx.restore();

    drawHealthBar(x, y - 38, 48, p.hp, p.max_hp, color);
}

function drawAimIndicator(p) {
    if (!p.alive) return;
    const { dx, dy } = getAimVector(p);
    const startDist = 24;
    const len = 48;

    ctx.save();
    // Retro dotted line — pixel blocks
    ctx.strokeStyle = '#ffdd00';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.shadowColor = '#ffdd00';
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.moveTo(p.x + dx * startDist, p.y + dy * startDist);
    ctx.lineTo(p.x + dx * (startDist + len), p.y + dy * (startDist + len));
    ctx.stroke();

    // Arrowhead (pixel style — 3 squares)
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
    const ex = p.x + dx * (startDist + len);
    const ey = p.y + dy * (startDist + len);
    const angle = Math.atan2(dy, dx);
    ctx.translate(ex, ey);
    ctx.rotate(angle);
    ctx.fillStyle = '#ffdd00';
    ctx.fillRect(0, -3, 8, 6);
    ctx.fillRect(8, -5, 4, 10);
    ctx.restore();
}

function drawBullet(b) {
    const { x, y, owner_type } = b;
    ctx.save();
    if (owner_type === 'player') {
        // Yellow pixel bullet
        ctx.fillStyle = '#ffdd00';
        ctx.fillRect(x - 4, y - 4, 8, 8);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x - 2, y - 2, 4, 4);
        ctx.fillStyle = 'rgba(255,220,0,0.3)';
        ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.fill();
    } else if (b.fire_type === 'dragon') {
        // Dragon fire breath — wide flame streak
        const angle = Math.atan2(b.dy, b.dx);
        ctx.translate(x, y);
        ctx.rotate(angle);
        // Outer flame
        const grad = ctx.createLinearGradient(-18, 0, 14, 0);
        grad.addColorStop(0, 'rgba(255,50,0,0)');
        grad.addColorStop(0.4, 'rgba(255,120,0,0.8)');
        grad.addColorStop(1, 'rgba(255,220,0,0.95)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.ellipse(0, 0, 14, 7, 0, 0, Math.PI * 2);
        ctx.fill();
        // Inner hot core
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(-2, -2, 6, 4);
        // Particle trail (spawn on client)
        if (Math.random() < 0.4) {
            const trailColors = ['#ff6600', '#ff3300', '#ffaa00'];
            const tc = trailColors[Math.floor(Math.random() * trailColors.length)];
            ctx.restore();
            spawnParticles(x - Math.cos(angle) * 10, y - Math.sin(angle) * 10, tc, 1, 1.5);
            return; // already restored
        }
    } else {
        // Normal monster fireball
        const angle = Math.atan2(b.dy, b.dx);
        ctx.translate(x, y);
        ctx.rotate(angle);
        ctx.fillStyle = '#ff4400'; ctx.fillRect(-6, -4, 12, 8);
        ctx.fillStyle = '#ff8800'; ctx.fillRect(-4, -2, 8, 4);
        ctx.fillStyle = '#ffdd00'; ctx.fillRect(-2, -1, 4, 2);
        ctx.fillStyle = 'rgba(255,68,0,0.4)'; ctx.fillRect(-12, -3, 8, 6);
    }
    ctx.restore();
}

function drawParticles() {
    for (const p of particles) {
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.life) * 0.9;
        ctx.fillStyle = p.color;
        if (p.shape === 'square') {
            const s = Math.max(1, Math.floor(p.size * p.life));
            ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
        } else {
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }
}

// Color utilities
function lighten(hex) { return blendHex(hex, '#ffffff', 0.38); }
function darken(hex) { return blendHex(hex, '#000000', 0.45); }
function blendHex(hex, with2, t) {
    const a = hexToRgb(hex);
    const b = hexToRgb(with2);
    if (!a || !b) return hex;
    return `rgb(${Math.round(a[0] * (1 - t) + b[0] * t)},${Math.round(a[1] * (1 - t) + b[1] * t)},${Math.round(a[2] * (1 - t) + b[2] * t)})`;
}
function hexToRgb(hex) {
    const m = hex.replace('#', '').match(/../g);
    if (!m) return null;
    return m.map(x => parseInt(x, 16));
}

// Retro scroll text at the bottom of the arena
const scrollMsg = '  *** MONSTER BATTLE ARENA ***   DEFEAT THE BOSS   COOPERATE TO SURVIVE   GOOD LUCK HEROES   *** ';
let scrollX = MAP_W;
function drawScrollText() {
    ctx.save();
    ctx.font = '10px "Press Start 2P", monospace';
    ctx.fillStyle = '#330010';
    ctx.fillRect(0, MAP_H - 22, MAP_W, 22);
    ctx.strokeStyle = '#660022';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, MAP_H - 22); ctx.lineTo(MAP_W, MAP_H - 22); ctx.stroke();
    ctx.fillStyle = '#ff2244';
    ctx.textBaseline = 'middle';
    ctx.fillText(scrollMsg, scrollX, MAP_H - 11);
    ctx.restore();
    scrollX -= 1.5;
    const msgW = scrollMsg.length * 10;
    if (scrollX < -msgW) scrollX = MAP_W;
}

// ──────────────────────────────────────────────
// Main game loop
// ──────────────────────────────────────────────
let lastTime = 0;

function renderLoop(ts) {
    const dt = Math.min((ts - lastTime) / 1000, 0.05);
    lastTime = ts;

    if (phase === 'playing') sendMove();

    updateParticles(dt);

    // Decay phase flash
    if (phaseFlashTimer > 0) {
        phaseFlashTimer -= dt;
        phaseFlash = Math.max(0, phaseFlashTimer / 2.0);
    }

    if (screenShake > 0) {
        screenShake = Math.max(0, screenShake - dt * 8);
        shakeX = (Math.random() - 0.5) * screenShake * 14;
        shakeY = (Math.random() - 0.5) * screenShake * 14;
    } else {
        shakeX = shakeY = 0;
    }

    ctx.clearRect(0, 0, MAP_W, MAP_H);
    ctx.save();
    ctx.translate(shakeX, shakeY);

    drawBackground();

    if (gameState && (phase === 'playing' || phase === 'gameover')) {
        drawMonster(gameState.monster);
        drawBossHUD(gameState.monster);

        for (const b of gameState.bullets) drawBullet(b);

        for (const [pid, p] of Object.entries(gameState.players)) {
            drawPlayer(p, pid === myId);
        }

        if (myId && gameState.players[myId]) {
            drawAimIndicator(gameState.players[myId]);
        }

        drawParticles();

        // Phase flash overlay
        if (phaseFlash > 0.01) {
            const alpha = Math.min(0.45, phaseFlash * 0.5);
            ctx.save();
            ctx.fillStyle = phaseFlashColor.replace(')', `,${alpha})`).replace('rgb', 'rgba');
            // Build rgba manually for hex colors
            const hex = phaseFlashColor;
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const bv = parseInt(hex.slice(5, 7), 16);
            ctx.fillStyle = `rgba(${r},${g},${bv},${alpha})`;
            ctx.fillRect(0, 0, MAP_W, MAP_H);
            // Big center text
            if (phaseFlashTimer > 0.5) {
                const textAlpha = Math.min(1, phaseFlash * 2);
                ctx.globalAlpha = textAlpha;
                ctx.font = 'bold 28px "Press Start 2P", monospace';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.shadowColor = phaseFlashColor;
                ctx.shadowBlur = 24;
                ctx.fillStyle = '#ffffff';
                ctx.fillText(phaseFlashText, MAP_W / 2, MAP_H / 2);
                ctx.shadowBlur = 0;
                ctx.globalAlpha = 1;
            }
            ctx.restore();
        }
    }

    drawScrollText();
    ctx.restore();

    requestAnimationFrame(renderLoop);
}

requestAnimationFrame(renderLoop);

// ──────────────────────────────────────────────
// Event wiring
// ──────────────────────────────────────────────
function joinGame() {
    if (!nameInput.value.trim()) { nameInput.focus(); return; }
    connect();
}

joinBtn.addEventListener('click', joinGame);

startBtn.addEventListener('click', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        lobbyStatus.textContent = '!! NOT CONNECTED — REJOIN !!';
        return;
    }
    if (!isAdmin()) {
        lobbyStatus.textContent = '!! ONLY THE HOST CAN START !!';
        return;
    }
    ws.send(JSON.stringify({ type: 'start_game' }));
    startBtn.disabled = true;
    startBtn.textContent = '[ STARTING... ]';
    lobbyStatus.textContent = 'LOADING GAME...';
});

restartBtn.addEventListener('click', () => {
    // Return to lobby UI without closing the connection
    phase = 'lobby';
    particles = [];
    monsterMovedWarned = false;
    monsterEvolvedWarned = false;
    phaseFlash = 0;
    phaseFlashTimer = 0;
    hud.innerHTML = '';
    gameoverOverlay.classList.add('hidden');
    lobbyOverlay.classList.remove('hidden');

    // Update lobby UI to show current players
    if (gameState && gameState.players) {
        updateLobbyPlayersFromList(gameState.players, adminId);
    }

    lobbyStatus.textContent = 'WAITING FOR PLAYERS (CONNECTED)...';
    // Re-enable start button if admin
    updateAdminUI();
});

// ──────────────────────────────────────────────
// Mobile Controls Logic
// ──────────────────────────────────────────────
const btnUp = document.getElementById('btn-up');
const btnDown = document.getElementById('btn-down');
const btnLeft = document.getElementById('btn-left');
const btnRight = document.getElementById('btn-right');
const btnShoot = document.getElementById('btn-shoot');

function handleBtn(btn, key, obj) {
    const start = (e) => {
        e.preventDefault();
        obj[key] = true;
    };
    const end = (e) => {
        e.preventDefault();
        obj[key] = false;
    };
    btn.addEventListener('touchstart', start);
    btn.addEventListener('touchend', end);
    btn.addEventListener('mousedown', start);
    btn.addEventListener('mouseup', end);
    btn.addEventListener('mouseleave', end);
}

if (btnUp) {
    handleBtn(btnUp, 'w', keys);
    handleBtn(btnDown, 's', keys);
    handleBtn(btnLeft, 'a', keys);
    handleBtn(btnRight, 'd', keys);

    // Shoot button logic
    const shootStart = (e) => {
        e.preventDefault();
        shoot(); // First shot
        // Continuous shooting while held
        btnShoot.shootInterval = setInterval(shoot, 100);
    };
    const shootEnd = (e) => {
        e.preventDefault();
        clearInterval(btnShoot.shootInterval);
    };

    btnShoot.addEventListener('touchstart', shootStart);
    btnShoot.addEventListener('touchend', shootEnd);
    btnShoot.addEventListener('mousedown', shootStart);
    btnShoot.addEventListener('mouseup', shootEnd);
    btnShoot.addEventListener('mouseleave', shootEnd);
}
