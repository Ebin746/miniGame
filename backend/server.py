"""
Monster Battle Arena — Authoritative WebSocket Game Server
FastAPI + asyncio game loop running at ~30 fps
Supports 1–4 players. First player to join is the ADMIN and controls the Start button.
"""

import asyncio
import json
import math
import random
import time
import uuid
from typing import Dict, Set, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

# ──────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────
MAP_W, MAP_H       = 1200, 800
PLAYER_SPEED       = 180          # px / sec
PLAYER_RADIUS      = 18
PLAYER_START_HP    = 100
BULLET_SPEED       = 320          # px / sec
BULLET_RADIUS      = 6
PLAYER_BULLET_DMG  = 10
MONSTER_BULLET_DMG = 15
MONSTER_HP         = 1000
MONSTER_RADIUS     = 48
MONSTER_X          = MAP_W // 2
MONSTER_Y          = MAP_H // 2
MONSTER_FIRE_INTERVAL = 0.6       # seconds between full attack volleys
TICK_RATE          = 30           # updates / sec
MIN_PLAYERS        = 1
MAX_PLAYERS        = 4

# Monster phase constants
MONSTER_MOVE_DELAY        = 10.0  # seconds until monster starts moving
MONSTER_EVOLVE_DELAY      = 20.0  # seconds until monster evolves
MONSTER_MOVE_SPEED        = 80    # px/sec during movement phase
MONSTER_EVOLVED_SPEED     = 220   # px/sec after evolution
MONSTER_EVOLVED_FIRE_INT  = 0.25  # fire interval after evolution
MONSTER_EVOLVED_BULLET_SPD = 600  # bullet speed after evolution
MONSTER_EVOLVED_BULLET_DMG = 40   # damage per bullet after evolution

SPAWN_POSITIONS = [
    (100, 100),
    (MAP_W - 100, 100),
    (100, MAP_H - 100),
    (MAP_W - 100, MAP_H - 100),
]

PLAYER_COLORS = ["#4fc3f7", "#81c784", "#ffb74d", "#ce93d8"]

# ──────────────────────────────────────────────
# Game State
# ──────────────────────────────────────────────
game_state: Dict = {
    "phase":   "lobby",   # lobby | playing | gameover
    "winner":  None,      # None | "players" | "monster"
    "players": {},        # id -> player dict
    "monster": {
        "x": MONSTER_X, "y": MONSTER_Y,
        "hp": MONSTER_HP, "max_hp": MONSTER_HP,
        "alive": True,
    },
    "bullets": [],        # list of bullet dicts
}

connections: Dict[str, WebSocket] = {}     # player_id -> websocket
used_spawns: Set[int] = set()
color_index = 0
last_monster_fire = 0.0
game_loop_task = None
admin_id: Optional[str] = None            # first player = admin
game_start_time: float = 0.0              # monotonic time when game started

# ──────────────────────────────────────────────
# FastAPI App
# ──────────────────────────────────────────────
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ──────────────────────────────────────────────
# Utility helpers
# ──────────────────────────────────────────────
def distance(ax, ay, bx, by) -> float:
    return math.sqrt((ax - bx) ** 2 + (ay - by) ** 2)


def normalize(dx, dy):
    mag = math.sqrt(dx * dx + dy * dy)
    if mag == 0:
        return 0, 0
    return dx / mag, dy / mag


def get_spawn():
    global used_spawns
    available = [i for i in range(len(SPAWN_POSITIONS)) if i not in used_spawns]
    if not available:
        return (random.randint(80, MAP_W - 80), random.randint(80, MAP_H - 80))
    idx = random.choice(available)
    used_spawns.add(idx)
    return SPAWN_POSITIONS[idx]


def get_color():
    global color_index
    c = PLAYER_COLORS[color_index % len(PLAYER_COLORS)]
    color_index += 1
    return c


def state_snapshot() -> dict:
    """Return a JSON-serialisable snapshot of the current game state."""
    elapsed = time.monotonic() - game_start_time if game_start_time else 0.0
    return {
        "type":     "state",
        "phase":    game_state["phase"],
        "winner":   game_state["winner"],
        "monster":  dict(game_state["monster"]),
        "players":  {pid: dict(p) for pid, p in game_state["players"].items()},
        "bullets":  [dict(b) for b in game_state["bullets"]],
        "admin_id": admin_id,
        "elapsed":  elapsed,
    }


def lobby_snapshot() -> dict:
    return {
        "type":         "lobby",
        "player_count": len(connections),
        "min_players":  MIN_PLAYERS,
        "max_players":  MAX_PLAYERS,
        "admin_id":     admin_id,
        "players":      {pid: {"name": p["name"], "color": p["color"]}
                         for pid, p in game_state["players"].items()},
    }


async def broadcast(message: dict):
    payload = json.dumps(message)
    dead: list[str] = []
    for pid, ws in list(connections.items()):
        try:
            await ws.send_text(payload)
        except Exception:
            dead.append(pid)
    for pid in dead:
        connections.pop(pid, None)


# ──────────────────────────────────────────────
# Game Loop
# ──────────────────────────────────────────────
async def game_loop():
    global last_monster_fire
    dt = 1 / TICK_RATE
    last_monster_fire = time.monotonic()

    while game_state["phase"] == "playing":
        tick_start = time.monotonic()
        now = time.monotonic()
        elapsed = now - game_start_time

        gs = game_state
        monster = gs["monster"]
        players = gs["players"]
        bullets  = gs["bullets"]

        # ── Monster phase progression ──────────────
        if monster["alive"]:
            # Phase 2: Evolve into Retro Colosseum Dragon at 40 s
            if elapsed >= MONSTER_EVOLVE_DELAY and not monster.get("evolved", False):
                monster["evolved"] = True
                monster["radius"] = 64   # bigger hitbox for the dragon

            # Phase 1+: Move toward nearest alive player (starts at 20 s)
            if elapsed >= MONSTER_MOVE_DELAY:
                alive_players = [(p["x"], p["y"]) for p in players.values() if p["alive"]]
                if alive_players:
                    # Find nearest
                    nearest = min(
                        alive_players,
                        key=lambda pos: distance(monster["x"], monster["y"], pos[0], pos[1])
                    )
                    spd = MONSTER_EVOLVED_SPEED if monster.get("evolved") else MONSTER_MOVE_SPEED
                    dx, dy = normalize(nearest[0] - monster["x"], nearest[1] - monster["y"])
                    monster["x"] = max(MONSTER_RADIUS, min(MAP_W - MONSTER_RADIUS,
                                       monster["x"] + dx * spd * dt))
                    monster["y"] = max(MONSTER_RADIUS, min(MAP_H - MONSTER_RADIUS,
                                       monster["y"] + dy * spd * dt))

        # ── Move bullets ──────────────────────────
        for b in bullets:
            b["x"] += b["dx"] * dt
            b["y"] += b["dy"] * dt

        # ── Player bullets hitting monster ────────
        hit_radius = monster.get("radius", MONSTER_RADIUS)
        if monster["alive"]:
            surviving = []
            for b in bullets:
                if b["owner_type"] == "player":
                    if distance(b["x"], b["y"], monster["x"], monster["y"]) < BULLET_RADIUS + hit_radius:
                        monster["hp"] -= PLAYER_BULLET_DMG
                        if monster["hp"] <= 0:
                            monster["hp"] = 0
                            monster["alive"] = False
                        continue  # remove bullet
                surviving.append(b)
            bullets[:] = surviving

        # ── Monster bullets hitting players ───────
        bull_dmg = MONSTER_EVOLVED_BULLET_DMG if monster.get("evolved") else MONSTER_BULLET_DMG
        surviving = []
        for b in bullets:
            if b["owner_type"] == "monster":
                hit = False
                for pid, p in players.items():
                    if not p["alive"]:
                        continue
                    if distance(b["x"], b["y"], p["x"], p["y"]) < BULLET_RADIUS + PLAYER_RADIUS:
                        p["hp"] -= bull_dmg
                        if p["hp"] <= 0:
                            p["hp"] = 0
                            p["alive"] = False
                        hit = True
                        break
                if hit:
                    continue
            surviving.append(b)
        bullets[:] = surviving

        # ── Remove out-of-bounds bullets ──────────
        bullets[:] = [
            b for b in bullets
            if 0 <= b["x"] <= MAP_W and 0 <= b["y"] <= MAP_H
        ]

        # ── Monster fires at players ───────────────
        fire_interval = MONSTER_EVOLVED_FIRE_INT if monster.get("evolved") else MONSTER_FIRE_INTERVAL
        bull_speed    = MONSTER_EVOLVED_BULLET_SPD if monster.get("evolved") else BULLET_SPEED

        if monster["alive"] and (now - last_monster_fire) >= fire_interval:
            last_monster_fire = now
            evolved = monster.get("evolved", False)

            if evolved:
                # 6-way fire spread (dragon breath)
                # Base direction: toward nearest alive player, or straight right
                alive_players = [(p["x"], p["y"]) for p in players.values() if p["alive"]]
                if alive_players:
                    nearest = min(alive_players,
                                  key=lambda pos: distance(monster["x"], monster["y"], pos[0], pos[1]))
                    base_dx, base_dy = normalize(nearest[0] - monster["x"], nearest[1] - monster["y"])
                else:
                    base_dx, base_dy = 1.0, 0.0

                base_angle = math.atan2(base_dy, base_dx)
                spread_angles = [-0.5, -0.3, -0.1, 0.1, 0.3, 0.5]  # 6 projectiles spread
                for offset in spread_angles:
                    a = base_angle + offset
                    bullets.append({
                        "id":         str(uuid.uuid4()),
                        "x":          float(monster["x"]),
                        "y":          float(monster["y"]),
                        "dx":         math.cos(a) * bull_speed,
                        "dy":         math.sin(a) * bull_speed,
                        "owner_type": "monster",
                        "fire_type":  "dragon",   # flag for client rendering
                    })
            else:
                # Normal targeted shots at each alive player
                for pid, p in players.items():
                    if not p["alive"]:
                        continue
                    dx, dy = normalize(p["x"] - monster["x"], p["y"] - monster["y"])
                    angle_offset = random.uniform(-0.15, 0.15)
                    cos_a = math.cos(angle_offset)
                    sin_a = math.sin(angle_offset)
                    ndx = dx * cos_a - dy * sin_a
                    ndy = dx * sin_a + dy * cos_a
                    bullets.append({
                        "id":         str(uuid.uuid4()),
                        "x":          float(monster["x"]),
                        "y":          float(monster["y"]),
                        "dx":         ndx * bull_speed,
                        "dy":         ndy * bull_speed,
                        "owner_type": "monster",
                        "target_pid": pid,
                    })

        # ── Win / Lose check ──────────────────────
        all_dead = all(not p["alive"] for p in players.values()) and len(players) > 0
        if not monster["alive"]:
            gs["phase"]  = "gameover"
            gs["winner"] = "players"
        elif all_dead:
            gs["phase"]  = "gameover"
            gs["winner"] = "monster"

        # ── Broadcast ─────────────────────────────
        await broadcast(state_snapshot())

        # ── Pace to TICK_RATE ─────────────────────
        tick_elapsed = time.monotonic() - tick_start
        sleep_time = dt - tick_elapsed
        if sleep_time > 0:
            await asyncio.sleep(sleep_time)

    # Final state broadcast after game ends
    await broadcast(state_snapshot())


def do_start_game():
    """Reset and start the game. Called by admin."""
    global game_loop_task, game_start_time
    game_state["phase"] = "playing"
    game_state["winner"] = None
    num_players = len(game_state["players"])
    dynamic_hp = max(1000, 1000 * num_players)
    game_state["monster"] = {
        "x": float(MONSTER_X), "y": float(MONSTER_Y),
        "hp": dynamic_hp, "max_hp": dynamic_hp,
        "alive": True,
        "evolved": False,
    }
    game_state["bullets"] = []
    
    # Reset all players for the new game
    for p in game_state["players"].values():
        p["hp"] = PLAYER_START_HP
        p["alive"] = True
        # Optionally reset positions to spawns, but keeping current is fine too
        # If we want to reset positions:
        # sx, sy = SPAWN_POSITIONS[random.randint(0, len(SPAWN_POSITIONS)-1)] 
        # p["x"], p["y"] = float(sx), float(sy)

    game_start_time = time.monotonic()
    game_loop_task = asyncio.create_task(game_loop())


# ──────────────────────────────────────────────
# WebSocket Endpoint
# ──────────────────────────────────────────────
@app.websocket("/ws/{player_name}")
async def websocket_endpoint(websocket: WebSocket, player_name: str):
    global game_loop_task, color_index, admin_id

    # Reject if game is already in progress or lobby is full
    phase = game_state["phase"]
    if phase == "playing" or (phase == "lobby" and len(connections) >= MAX_PLAYERS):
        await websocket.accept()
        await websocket.send_text(json.dumps({"type": "rejected", "reason": "Game full or in progress"}))
        await websocket.close()
        return

    await websocket.accept()
    player_id = str(uuid.uuid4())
    sx, sy = get_spawn()

    player = {
        "id":     player_id,
        "name":   player_name[:16],
        "x":      float(sx),
        "y":      float(sy),
        "hp":     PLAYER_START_HP,
        "max_hp": PLAYER_START_HP,
        "alive":  True,
        "color":  get_color(),
    }
    game_state["players"][player_id] = player
    connections[player_id] = websocket

    # First player becomes admin
    if admin_id is None:
        admin_id = player_id

    # Acknowledge join — tell client their id and whether they're admin
    await websocket.send_text(json.dumps({
        "type":     "joined",
        "your_id":  player_id,
        "admin_id": admin_id,
    }))

    # Let everyone know current lobby state
    await broadcast(lobby_snapshot())

    # Handle incoming messages from this client
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            mtype = msg.get("type")

            # ── Admin can start game from lobby or gameover ───────
            if mtype == "start_game":
                if player_id == admin_id and (game_state["phase"] == "lobby" or game_state["phase"] == "gameover"):
                    if len(connections) >= MIN_PLAYERS:
                        do_start_game()
                        await broadcast({"type": "game_start"})
                continue

            # ── In-game messages ──────────────────────
            if game_state["phase"] != "playing":
                continue

            p = game_state["players"].get(player_id)
            if not p or not p["alive"]:
                continue

            if mtype == "move":
                dx = float(msg.get("dx", 0))
                dy = float(msg.get("dy", 0))
                mag = math.sqrt(dx * dx + dy * dy)
                if mag > 0:
                    dx /= mag
                    dy /= mag
                step = PLAYER_SPEED / TICK_RATE
                p["x"] = max(PLAYER_RADIUS, min(MAP_W - PLAYER_RADIUS, p["x"] + dx * step))
                p["y"] = max(PLAYER_RADIUS, min(MAP_H - PLAYER_RADIUS, p["y"] + dy * step))

            elif mtype == "shoot":
                monster = game_state["monster"]
                # Use client-supplied aim direction if provided, else auto-aim at monster
                cdx = msg.get("aim_dx")
                cdy = msg.get("aim_dy")
                if cdx is not None and cdy is not None:
                    dx, dy = normalize(float(cdx), float(cdy))
                else:
                    if not monster["alive"]:
                        continue
                    dx, dy = normalize(
                        monster["x"] - p["x"],
                        monster["y"] - p["y"],
                    )
                if dx == 0 and dy == 0:
                    continue
                game_state["bullets"].append({
                    "id":         str(uuid.uuid4()),
                    "x":          p["x"],
                    "y":          p["y"],
                    "dx":         dx * BULLET_SPEED,
                    "dy":         dy * BULLET_SPEED,
                    "owner_type": "player",
                    "owner_id":   player_id,
                })

    except WebSocketDisconnect:
        pass
    finally:
        # Clean up on disconnect
        connections.pop(player_id, None)
        used_spawns.discard(next(
            (i for i, sp in enumerate(SPAWN_POSITIONS) if sp == (int(sx), int(sy))), None
        ))
        game_state["players"].pop(player_id, None)

        # If admin left, assign next player as admin
        if player_id == admin_id:
            if connections:
                admin_id = next(iter(connections))
            else:
                admin_id = None

        # If lobby empties reset
        if not connections:
            color_index = 0
            used_spawns.clear()
            admin_id = None

        if connections:
            await broadcast({
                "type":     "player_left",
                "id":       player_id,
                "admin_id": admin_id,
                "players":  {pid: {"name": p["name"], "color": p["color"]}
                             for pid, p in game_state["players"].items()},
            })

        # If all disconnected during lobby, reset
        if not connections and game_state["phase"] == "lobby":
            game_state["players"].clear()
            game_state["bullets"].clear()
            game_state["monster"] = {
                "x": MONSTER_X, "y": MONSTER_Y,
                "hp": MONSTER_HP, "max_hp": MONSTER_HP,
                "alive": True,
            }
            game_state["phase"] = "lobby"
            game_state["winner"] = None


# ──────────────────────────────────────────────
# Serve frontend statically (optional helper)
# ──────────────────────────────────────────────
from fastapi.staticfiles import StaticFiles
import os

frontend_dir = os.path.join(os.path.dirname(__file__), "..", "frontend")
if os.path.isdir(frontend_dir):
    app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")


# ──────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────
if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)
