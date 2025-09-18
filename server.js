import express from "express";
import helmet from "helmet";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { v4 as uuid } from "uuid";

const app = express();
app.disable("x-powered-by");

// Security headers (CSP allows our WS)
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'"],
        "img-src": ["'self'"],
        "connect-src": ["'self'", "ws:", "wss:"]
      }
    }
  })
);

// Static client
app.use(express.static("public", { immutable: true, maxAge: "1h" }));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, maxPayload: 1024 });
const PORT = process.env.PORT || 3000;

// --- Game constants & helpers ---
const BOARD_SIZE = 19;
const EMPTY = 0,
  BLACK = 1,
  WHITE = 2;

const ADJ = [
  "brisk",
  "sunny",
  "mellow",
  "lucky",
  "bold",
  "quiet",
  "swift",
  "witty",
  "cosmic",
  "silver",
  "crimson",
  "jade",
  "amber",
  "violet"
];
const NOUN = [
  "otter",
  "falcon",
  "comet",
  "willow",
  "acorn",
  "nebula",
  "lotus",
  "maple",
  "coral",
  "ember",
  "harbor",
  "lynx",
  "reef",
  "thistle"
];
function randomRoomName() {
  const a = ADJ[Math.floor(Math.random() * ADJ.length)];
  const n = NOUN[Math.floor(Math.random() * NOUN.length)];
  const t = Math.random().toString(36).slice(2, 4);
  return `${a}-${n}-${t}`;
}

function makeBoard() {
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(EMPTY));
}
function inBounds(x, y) {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE;
}

function checkWinner(board, x, y) {
  const color = board[y][x];
  if (!color) return 0;
  const dirs = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1]
  ];
  for (const [dx, dy] of dirs) {
    let count = 1;
    for (let s = 1; s <= 4; s++) {
      const nx = x + dx * s,
        ny = y + dy * s;
      if (inBounds(nx, ny) && board[ny][nx] === color) count++;
      else break;
    }
    for (let s = 1; s <= 4; s++) {
      const nx = x - dx * s,
        ny = y - dy * s;
      if (inBounds(nx, ny) && board[ny][nx] === color) count++;
      else break;
    }
    if (count >= 5) return color;
  }
  return 0;
}

// --- Rooms (support many concurrent games) ---
/** Room shape:
 * { id, name, mode, board, moves, nextTurn, players:{1:{sessionId,ws}|null,2:{…}|null}, winner, createdAt }
 */
const rooms = new Map();

function createRoom(mode = "pvp") {
  const id = uuid();
  const room = {
    id,
    name: randomRoomName(),
    mode, // 'pvp' | 'ai'
    board: makeBoard(),
    moves: [],
    nextTurn: BLACK,
    players: { [BLACK]: null, [WHITE]: null },
    winner: 0,
    createdAt: Date.now()
  };
  if (mode === "ai") room.players[WHITE] = { sessionId: "AI", ws: null }; // AI is WHITE
  rooms.set(id, room);
  return room;
}

function playerBySession(room, sessionId) {
  if (!sessionId) return 0;
  if (room.players[BLACK]?.sessionId === sessionId) return BLACK;
  if (room.players[WHITE]?.sessionId === sessionId) return WHITE;
  return 0;
}

function broadcast(room, payload) {
  // WHY: Only send to real sockets; AI has no socket.
  [BLACK, WHITE].forEach((c) => {
    const p = room.players[c];
    if (p?.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(payload));
  });
}

function roomSnapshot(room, forSessionId) {
  return {
    type: "state",
    roomId: room.id,
    roomName: room.name,
    board: room.board,
    moves: room.moves,
    nextTurn: room.nextTurn,
    youAre: playerBySession(room, forSessionId),
    players: { black: Boolean(room.players[BLACK]), white: Boolean(room.players[WHITE]) },
    winner: room.winner,
    mode: room.mode
  };
}

function assignToRoom(sessionId, ws, desiredMode) {
  let best = null;
  for (const room of rooms.values()) {
    if (room.winner) continue;
    if (room.mode !== desiredMode) continue;

    if (desiredMode === "ai") {
      if (!room.players[BLACK]) {
        room.players[BLACK] = { sessionId, ws };
        return { room, color: BLACK };
      }
      continue;
    }

    const hasBlack = Boolean(room.players[BLACK]);
    const hasWhite = Boolean(room.players[WHITE]);

    if (!hasBlack && !hasWhite) {
      if (!best) best = { room, color: BLACK };
      continue;
    }
    if (!hasBlack) {
      best = { room, color: BLACK };
      break;
    }
    if (!hasWhite) {
      best = { room, color: WHITE };
      break;
    }
  }

  if (best) {
    const { room, color } = best;
    room.players[color] = { sessionId, ws };
    return { room, color };
  }

  const room = createRoom(desiredMode);
  room.players[BLACK] = { sessionId, ws };
  return { room, color: BLACK };
}

// --- AI logic ---
function findFirstEmpty(board) {
  for (let y = 0; y < BOARD_SIZE; y++) for (let x = 0; x < BOARD_SIZE; x++) if (board[y][x] === EMPTY) return { x, y };
  return null;
}
function findWinningMove(board, color) {
  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      if (board[y][x] !== EMPTY) continue;
      board[y][x] = color;
      const w = checkWinner(board, x, y) === color;
      board[y][x] = EMPTY;
      if (w) return { x, y };
    }
  }
  return null;
}
function linePotential(board, x, y, dx, dy, color) {
  let count = 1,
    open = 0;
  let fx = x + dx,
    fy = y + dy;
  while (inBounds(fx, fy) && board[fy][fx] === color) {
    count++;
    fx += dx;
    fy += dy;
  }
  if (inBounds(fx, fy) && board[fy][fx] === EMPTY) open++;
  let bx = x - dx,
    by = y - dy;
  while (inBounds(bx, by) && board[by][bx] === color) {
    count++;
    bx -= dx;
    by -= dy;
  }
  if (inBounds(bx, by) && board[by][bx] === EMPTY) open++;
  if (count >= 5) return 100000;
  if (count === 4 && open > 0) return 10000;
  if (count === 3 && open === 2) return 5000;
  if (count === 3 && open === 1) return 1000;
  if (count === 2 && open === 2) return 300;
  if (count === 2 && open === 1) return 100;
  return 10 * count + 5 * open;
}
function heuristicScore(board, x, y, me, opp) {
  const centerBias = -(Math.abs(x - Math.floor(BOARD_SIZE / 2)) + Math.abs(y - Math.floor(BOARD_SIZE / 2)));
  const dirs = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1]
  ];
  let score = centerBias * 0.5;
  for (const [dx, dy] of dirs) {
    score += linePotential(board, x, y, dx, dy, me) * 1.2 + linePotential(board, x, y, dx, dy, opp);
  }
  return score;
}
function aiChooseMove(room) {
  const me = room.nextTurn,
    opp = me === BLACK ? WHITE : BLACK;
  const win = findWinningMove(room.board, me);
  if (win) return win;
  const block = findWinningMove(room.board, opp);
  if (block) return block;
  let best = null,
    bestScore = -Infinity;
  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      if (room.board[y][x] !== EMPTY) continue;
      const s = heuristicScore(room.board, x, y, me, opp);
      if (s > bestScore) {
        bestScore = s;
        best = { x, y };
      }
    }
  }
  return best || findFirstEmpty(room.board);
}

// --- Strict message guards ---
function safeString(v, max = 64) {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}
function safeMode(v) {
  return v === "ai" ? "ai" : "pvp";
}

// --- WS handling ---
wss.on("connection", (ws, req) => {
  // OPTIONAL: basic origin check (same-origin dev use)
  const origin = req.headers.origin || "";
  if (origin && !origin.startsWith("http://") && !origin.startsWith("https://")) {
    ws.close();
    return;
  }

  ws.on("message", (data) => {
    let msg = null;
    try {
      // WHY: Prevent prototype pollution via JSON.parse + primitive-only checks
      msg = JSON.parse(data);
    } catch {
      return ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
    }
    if (!msg || typeof msg !== "object") return ws.send(JSON.stringify({ type: "error", message: "Invalid message" }));

    const t = safeString(msg.type, 20);
    if (!t) return ws.send(JSON.stringify({ type: "error", message: "Invalid type" }));

    // --- Handshake / restore ---
    if (t === "hello") {
      const sessionId = safeString(msg.sessionId, 60) || uuid();
      ws.sessionId = sessionId;

      const desiredMode = safeMode(msg.mode);
      let room = null,
        color = 0;

      const requestedRoomId = safeString(msg.roomId, 60);
      if (requestedRoomId && rooms.has(requestedRoomId)) {
        const existing = rooms.get(requestedRoomId);
        const seat = playerBySession(existing, sessionId);
        if (seat) {
          room = existing;
          color = seat;
          existing.players[seat].ws = ws; // reattach for restore
        }
      }

      if (!room) ({ room, color } = assignToRoom(sessionId, ws, desiredMode));

      ws.roomId = room.id;
      ws.color = color;

      ws.send(JSON.stringify({ type: "hello_ack", sessionId, roomId: room.id, color }));
      ws.send(JSON.stringify(roomSnapshot(room, sessionId)));

      if (room.mode === "ai") {
        broadcast(room, { type: "status", message: `AI ready in ${room.name}. Black moves first.`, waiting: false });
      } else {
        const both = Boolean(room.players[BLACK] && room.players[WHITE]);
        broadcast(room, {
          type: "status",
          message: both ? `Both players connected in ${room.name}. Black moves first.` : `Waiting for another player to join ${room.name}…`,
          waiting: !both
        });
      }
      return;
    }

    // --- Moves are authoritative on server ---
    if (t === "move") {
      const room = rooms.get(ws.roomId);
      if (!room) return ws.send(JSON.stringify({ type: "error", message: "Room not found" }));
      const sessionId = ws.sessionId;
      const playerColor = playerBySession(room, sessionId);
      if (!playerColor) return ws.send(JSON.stringify({ type: "error", message: "Not a player in this room" }));
      if (room.winner) return ws.send(JSON.stringify({ type: "error", message: "Game already finished" }));
      if (playerColor !== room.nextTurn) return ws.send(JSON.stringify({ type: "error", message: "Not your turn" }));

      const x = Number.isInteger(msg.x) ? msg.x : NaN;
      const y = Number.isInteger(msg.y) ? msg.y : NaN;
      if (!inBounds(x, y)) return ws.send(JSON.stringify({ type: "error", message: "Out-of-bounds move" }));
      if (room.board[y][x] !== EMPTY) return ws.send(JSON.stringify({ type: "error", message: "Intersection occupied" }));

      room.board[y][x] = playerColor;
      room.moves.push({ x, y, color: playerColor });

      const winner = checkWinner(room.board, x, y);
      if (winner) {
        room.winner = winner;
        broadcast(room, { type: "move", x, y, color: playerColor, nextTurn: 0 });
        broadcast(room, { type: "result", winner });
        return;
      }

      room.nextTurn = room.nextTurn === BLACK ? WHITE : BLACK;
      broadcast(room, { type: "move", x, y, color: playerColor, nextTurn: room.nextTurn });

      if (room.mode === "ai" && room.nextTurn === WHITE && room.players[WHITE]?.sessionId === "AI") {
        setTimeout(() => {
          const m = aiChooseMove(room);
          if (!m) return;
          if (room.board[m.y][m.x] !== EMPTY || room.winner || room.nextTurn !== WHITE) return;
          room.board[m.y][m.x] = WHITE;
          room.moves.push({ x: m.x, y: m.y, color: WHITE });
          const w = checkWinner(room.board, m.x, m.y);
          if (w) {
            room.winner = w;
            broadcast(room, { type: "move", x: m.x, y: m.y, color: WHITE, nextTurn: 0 });
            broadcast(room, { type: "result", winner: w });
            return;
          }
          room.nextTurn = BLACK;
          broadcast(room, { type: "move", x: m.x, y: m.y, color: WHITE, nextTurn: room.nextTurn });
        }, 200);
      }
      return;
    }

    // New AI game (human is BLACK)
    if (t === "newAIGame") {
      const room = rooms.get(ws.roomId);
      if (!room || room.mode !== "ai") return;
      const seat = playerBySession(room, ws.sessionId);
      if (seat !== BLACK) return;
      room.board = makeBoard();
      room.moves = [];
      room.nextTurn = BLACK;
      room.winner = 0;
      broadcast(room, roomSnapshot(room, ws.sessionId));
      broadcast(room, { type: "status", message: "New AI game started. Black moves first.", waiting: false });
      return;
    }

    // Reset PvP game for both
    if (t === "newGame") {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      room.board = makeBoard();
      room.moves = [];
      room.nextTurn = BLACK;
      room.winner = 0;

      broadcast(room, roomSnapshot(room, ws.sessionId));

      const both = Boolean(room.players[BLACK] && room.players[WHITE]);
      broadcast(room, {
        type: "status",
        message: `New multiplayer game started in ${room.name}. Black moves first.`,
        waiting: !both
      });
      return;
    }

    // Mode switching
    if (t === "switchMode") {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      const myColor = playerBySession(room, ws.sessionId);
      if (!myColor) return ws.send(JSON.stringify({ type: "error", message: "Not a player in this room" }));

      const want = safeMode(msg.mode);

      // → AI
      if (want === "ai") {
        const otherColor = myColor === BLACK ? WHITE : BLACK;
        const other = room.players[otherColor];

        // unseat me
        room.players[myColor] = null;

        // remember previous PvP room id for quick return
        ws.prevPvpRoomId = room.mode === "pvp" ? room.id : ws.prevPvpRoomId || null;

        // reset old room for remaining
        if (other?.ws && other.ws.readyState === 1) {
          room.board = makeBoard();
          room.moves = [];
          room.nextTurn = BLACK;
          room.winner = 0;
          other.ws.send(JSON.stringify(roomSnapshot(room, other.sessionId)));
          other.ws.send(
            JSON.stringify({
              type: "status",
              message: "Your opponent switched to AI. Waiting for another player to join…",
              waiting: true
            })
          );
        }

        const { room: aiRoom, color } = assignToRoom(ws.sessionId, ws, "ai");
        ws.roomId = aiRoom.id;
        ws.color = color;

        ws.send(JSON.stringify({ type: "hello_ack", sessionId: ws.sessionId, roomId: aiRoom.id, color }));
        ws.send(JSON.stringify(roomSnapshot(aiRoom, ws.sessionId)));
        broadcast(aiRoom, { type: "status", message: `AI ready in ${aiRoom.name}. Black moves first.`, waiting: false });
        return;
      }

      // → PvP
      if (want === "pvp") {
        const preferRoomId = safeString(msg.preferRoomId, 60) || ws.prevPvpRoomId || null;

        const curRoom = rooms.get(ws.roomId);
        if (curRoom) {
          const mySeat = playerBySession(curRoom, ws.sessionId);
          if (mySeat) curRoom.players[mySeat] = null;
          if (curRoom.mode === "ai") {
            curRoom.board = makeBoard();
            curRoom.moves = [];
            curRoom.nextTurn = BLACK;
            curRoom.winner = 0;
          }
        }

        let targetRoom = null,
          color = 0;
        if (preferRoomId && rooms.has(preferRoomId)) {
          const r = rooms.get(preferRoomId);
          if (r.mode === "pvp") {
            if (!r.players[BLACK]) {
              r.players[BLACK] = { sessionId: ws.sessionId, ws };
              targetRoom = r;
              color = BLACK;
            } else if (!r.players[WHITE]) {
              r.players[WHITE] = { sessionId: ws.sessionId, ws };
              targetRoom = r;
              color = WHITE;
            }
          }
        }

        if (!targetRoom) {
          const res = assignToRoom(ws.sessionId, ws, "pvp");
          targetRoom = res.room;
          color = res.color;
        }

        ws.roomId = targetRoom.id;
        ws.color = color;
        ws.prevPvpRoomId = targetRoom.id;

        ws.send(JSON.stringify({ type: "hello_ack", sessionId: ws.sessionId, roomId: targetRoom.id, color }));
        ws.send(JSON.stringify(roomSnapshot(targetRoom, ws.sessionId)));

        const both = Boolean(targetRoom.players[BLACK] && targetRoom.players[WHITE]);
        broadcast(targetRoom, {
          type: "status",
          message: both ? `Both players connected in ${targetRoom.name}. Black moves first.` : `Waiting for another player to join ${targetRoom.name}…`,
          waiting: !both
        });
        return;
      }

      return;
    }

    ws.send(JSON.stringify({ type: "error", message: "Unknown message type" }));
  });

  ws.on("close", () => {
    const room = rooms.get(ws.roomId);
    if (!room) return;
    const seat = playerBySession(room, ws.sessionId);
    if (!seat) return;

    // WHY: preserve seat for reload-based restore; just drop the socket.
    if (room.players[seat]) room.players[seat].ws = null;

    const bothSocketsPresent = Boolean(room.players[BLACK]?.ws) && Boolean(room.players[WHITE]?.ws);
    if (!bothSocketsPresent) {
      broadcast(room, {
        type: "status",
        message: "Your opponent left the game. Waiting for them (or another player) to join…",
        waiting: true
      });
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});