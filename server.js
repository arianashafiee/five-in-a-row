import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { v4 as uuid } from 'uuid';

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });
const PORT = process.env.PORT || 3000;

// Serve client
app.use(express.static('public'));

// --- Game constants & helpers ---
const BOARD_SIZE = 19;
const EMPTY = 0, BLACK = 1, WHITE = 2;

const ADJ = ['brisk','sunny','mellow','lucky','bold','quiet','swift','witty','cosmic','silver','crimson','jade','amber','violet'];
const NOUN = ['otter','falcon','comet','willow','acorn','nebula','lotus','maple','coral','ember','harbor','lynx','reef','thistle'];
function randomRoomName() {
  const a = ADJ[Math.floor(Math.random()*ADJ.length)];
  const n = NOUN[Math.floor(Math.random()*NOUN.length)];
  const t = Math.random().toString(36).slice(2,4);
  return `${a}-${n}-${t}`;
}

function makeBoard() {
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(EMPTY));
}
function inBounds(x, y) { return x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE; }

function checkWinner(board, x, y) {
  const color = board[y][x];
  if (!color) return 0;
  const dirs = [[1,0],[0,1],[1,1],[1,-1]];
  for (const [dx,dy] of dirs) {
    let count = 1;
    for (let s=1;s<=4;s++){ const nx=x+dx*s, ny=y+dy*s; if (inBounds(nx,ny)&&board[ny][nx]===color) count++; else break; }
    for (let s=1;s<=4;s++){ const nx=x-dx*s, ny=y-dy*s; if (inBounds(nx,ny)&&board[ny][nx]===color) count++; else break; }
    if (count >= 5) return color;
  }
  return 0;
}

// --- Rooms (support many concurrent games) ---
const rooms = new Map(); // id -> room

function createRoom(mode = 'pvp') {
  const id = uuid();
  const room = {
    id,
    name: randomRoomName(),
    mode, // 'pvp' | 'ai'
    board: makeBoard(),
    moves: [],
    nextTurn: BLACK,
    players: { [BLACK]: null, [WHITE]: null }, // { sessionId, ws }
    winner: 0,
    createdAt: Date.now()
  };
  if (mode === 'ai') room.players[WHITE] = { sessionId: 'AI', ws: null }; // AI is WHITE
  rooms.set(id, room);
  return room;
}

/** Assign player to a room of desiredMode, preferring rooms that are waiting for a second player. */
function assignToRoom(sessionId, ws, desiredMode) {
  let best = null;

  for (const room of rooms.values()) {
    if (room.winner) continue;
    if (room.mode !== desiredMode) continue;

    if (desiredMode === 'ai') {
        if (!room.players[BLACK]) {
          room.players[BLACK] = { sessionId, ws };
          // Do NOT reset board here — preserves AI game state across reloads (even after a win).
          return { room, color: BLACK };
        }
        continue;
      }
      

    // PvP: prefer rooms with exactly one seat filled
    const hasBlack = Boolean(room.players[BLACK]);
    const hasWhite = Boolean(room.players[WHITE]);
    if (!hasBlack && !hasWhite) { // empty room (keep as fallback)
      if (!best) best = { room, color: BLACK }; // fallback if no waiting rooms exist
      continue;
    }
    if (!hasBlack) { best = { room, color: BLACK }; break; }
    if (!hasWhite) { best = { room, color: WHITE }; break; }
  }

  if (best) {
    const { room, color } = best;
    room.players[color] = { sessionId, ws };
    return { room, color };
  }

  // No suitable room found; create a new one and seat as BLACK
  const room = createRoom(desiredMode);
  room.players[BLACK] = { sessionId, ws };
  return { room, color: BLACK };
}

function playerBySession(room, sessionId) {
  if (room.players[BLACK]?.sessionId === sessionId) return BLACK;
  if (room.players[WHITE]?.sessionId === sessionId) return WHITE;
  return 0;
}

function broadcast(room, payload) {
  [BLACK, WHITE].forEach(c => {
    const p = room.players[c];
    if (p?.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(payload));
  });
}

function roomSnapshot(room, forSessionId) {
  return {
    type: 'state',
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

// --- AI logic (blocks, tries to win, center-biased heuristic) ---
function findFirstEmpty(board){ for(let y=0;y<BOARD_SIZE;y++){ for(let x=0;x<BOARD_SIZE;x++){ if(board[y][x]===EMPTY) return {x,y}; } } return null; }
function findWinningMove(board, color){ for(let y=0;y<BOARD_SIZE;y++){ for(let x=0;x<BOARD_SIZE;x++){ if(board[y][x]!==EMPTY) continue; board[y][x]=color; const w=checkWinner(board,x,y)===color; board[y][x]=EMPTY; if(w) return {x,y}; }} return null; }
function linePotential(board,x,y,dx,dy,color){
  let count=1, open=0; let fx=x+dx, fy=y+dy; while(inBounds(fx,fy)&&board[fy][fx]===color){count++; fx+=dx; fy+=dy;} if(inBounds(fx,fy)&&board[fy][fx]===EMPTY) open++;
  let bx=x-dx, by=y-dy; while(inBounds(bx,by)&&board[by][bx]===color){count++; bx-=dx; by-=dy;} if(inBounds(bx,by)&&board[by][bx]===EMPTY) open++;
  if(count>=5) return 100000; if(count===4&&open>0) return 10000; if(count===3&&open===2) return 5000; if(count===3&&open===1) return 1000; if(count===2&&open===2) return 300; if(count===2&&open===1) return 100;
  return 10*count + 5*open;
}
function heuristicScore(board,x,y,me,opp){
  const centerBias = -(Math.abs(x-Math.floor(BOARD_SIZE/2))+Math.abs(y-Math.floor(BOARD_SIZE/2)));
  const dirs=[[1,0],[0,1],[1,1],[1,-1]];
  let score = centerBias*0.5;
  for(const [dx,dy] of dirs){ score += linePotential(board,x,y,dx,dy,me)*1.2 + linePotential(board,x,y,dx,dy,opp); }
  return score;
}
function aiChooseMove(room){
  const me = room.nextTurn, opp = me===BLACK?WHITE:BLACK;
  const win = findWinningMove(room.board, me); if(win) return win;
  const block = findWinningMove(room.board, opp); if(block) return block;
  let best=null, bestScore=-Infinity;
  for(let y=0;y<BOARD_SIZE;y++){ for(let x=0;x<BOARD_SIZE;x++){
    if(room.board[y][x]!==EMPTY) continue;
    const s = heuristicScore(room.board,x,y,me,opp);
    if(s>bestScore){bestScore=s; best={x,y};}
  }} return best || findFirstEmpty(room.board);
}

// --- WebSocket handling ---
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let msg = null;
    try { msg = JSON.parse(data); } catch { return ws.send(JSON.stringify({ type:'error', message:'Invalid JSON' })); }

    // Handshake: restore if possible else assign by desired mode
    if (msg.type === 'hello') {
      const sessionId = msg.sessionId || uuid();
      ws.sessionId = sessionId;
      const desiredMode = msg.mode === 'ai' ? 'ai' : 'pvp';

      let room = null, color = 0;

      // Try to rejoin existing room first (state restore for reloads)
      if (msg.roomId && rooms.has(msg.roomId)) {
        const existing = rooms.get(msg.roomId);
        const seat = playerBySession(existing, sessionId);
        if (seat) {
          room = existing;
          color = seat;
          existing.players[seat].ws = ws; // reattach ws
        }
      }
      // Else assign a room by desired mode (default behavior)
      if (!room) ({ room, color } = assignToRoom(sessionId, ws, desiredMode));

      ws.roomId = room.id;
      ws.color = color;

      ws.send(JSON.stringify({ type: 'hello_ack', sessionId, roomId: room.id, color }));
      ws.send(JSON.stringify(roomSnapshot(room, sessionId)));

      // Announce status / waiting flag
      if (room.mode === 'ai') {
        broadcast(room, { type: 'status', message: `AI ready in ${room.name}. Black moves first.`, waiting: false });
      } else {
        const both = Boolean(room.players[BLACK] && room.players[WHITE]);
        broadcast(room, { type: 'status', message: both ? `Both players connected in ${room.name}. Black moves first.` : `Waiting for another player to join ${room.name}…`, waiting: !both });
      }
      return;
    }

    // Authoritative move handling
    if (msg.type === 'move') {
      const room = rooms.get(ws.roomId);
      if (!room) return ws.send(JSON.stringify({ type:'error', message:'Room not found' }));
      const sessionId = ws.sessionId;
      const playerColor = playerBySession(room, sessionId);
      if (!playerColor) return ws.send(JSON.stringify({ type:'error', message:'Not a player in this room' }));
      if (room.winner) return ws.send(JSON.stringify({ type:'error', message:'Game already finished' }));
      if (playerColor !== room.nextTurn) return ws.send(JSON.stringify({ type:'error', message:'Not your turn' }));

      const { x, y } = msg;
      if (!Number.isInteger(x) || !Number.isInteger(y) || !inBounds(x,y)) return ws.send(JSON.stringify({ type:'error', message:'Out-of-bounds move' }));
      if (room.board[y][x] !== EMPTY) return ws.send(JSON.stringify({ type:'error', message:'Intersection occupied' }));

      room.board[y][x] = playerColor;
      room.moves.push({ x, y, color: playerColor });

      const winner = checkWinner(room.board, x, y);
      if (winner) {
        room.winner = winner;
        broadcast(room, { type:'move', x, y, color: playerColor, nextTurn: 0 });
        broadcast(room, { type:'result', winner });
        return;
      }

      room.nextTurn = room.nextTurn === BLACK ? WHITE : BLACK;
      broadcast(room, { type:'move', x, y, color: playerColor, nextTurn: room.nextTurn });

      // AI reply if in AI room and it's AI's turn (WHITE)
      if (room.mode === 'ai' && room.nextTurn === WHITE && room.players[WHITE]?.sessionId === 'AI') {
        setTimeout(() => {
          const m = aiChooseMove(room);
          if (!m) return;
          if (room.board[m.y][m.x] !== EMPTY || room.winner || room.nextTurn !== WHITE) return;
          room.board[m.y][m.x] = WHITE;
          room.moves.push({ x: m.x, y: m.y, color: WHITE });
          const w = checkWinner(room.board, m.x, m.y);
          if (w) {
            room.winner = w;
            broadcast(room, { type:'move', x: m.x, y: m.y, color: WHITE, nextTurn: 0 });
            broadcast(room, { type:'result', winner: w });
            return;
          }
          room.nextTurn = BLACK;
          broadcast(room, { type:'move', x: m.x, y: m.y, color: WHITE, nextTurn: room.nextTurn });
        }, 200);
      }
      return;
    }
    if (msg.type === 'newAIGame') {
        const room = rooms.get(ws.roomId);
        if (!room || room.mode !== 'ai') return;
      
        // Only the human (BLACK) triggers a new AI game
        const seat = playerBySession(room, ws.sessionId);
        if (seat !== BLACK) return;
      
        room.board = makeBoard();
        room.moves = [];
        room.nextTurn = BLACK;
        room.winner = 0;
      
        broadcast(room, { type: 'state', ...roomSnapshot(room, ws.sessionId) });
        broadcast(room, { type: 'status', message: 'New AI game started. Black moves first.', waiting: false });
        return;
      }
    // New Multiplayer Game (reset board for both, notify; no popups)
    if (msg.type === 'newGame') {
      const room = rooms.get(ws.roomId);
      if (!room) return;

      room.board = makeBoard();
      room.moves = [];
      room.nextTurn = BLACK;
      room.winner = 0;

      broadcast(room, { type: 'state', ...roomSnapshot(room, ws.sessionId) });

      const starterColor = playerBySession(room, ws.sessionId);
      const otherColor = starterColor === BLACK ? WHITE : BLACK;
      const starter = room.players[starterColor];
      const other   = room.players[otherColor];

      if (starter?.ws && starter.ws.readyState === 1) {
        starter.ws.send(JSON.stringify({
          type: 'status',
          message: `New multiplayer game started in ${room.name}. Black moves first.`,
          waiting: !Boolean(room.players[BLACK] && room.players[WHITE])
        }));
      }
      if (other?.ws && other.ws.readyState === 1) {
        other.ws.send(JSON.stringify({
          type: 'status',
          message: `Your opponent started a new multiplayer game in ${room.name}.`,
          waiting: !Boolean(room.players[BLACK] && room.players[WHITE])
        }));
      }
      return;
    }

    // Switch to AI (this player only) — opponent stays in their PvP room and waits
    // Switch to AI or back to PvP (this player only)
if (msg.type === 'switchMode') {
    const wantAi = msg.mode === 'ai';
    const wantPvp = msg.mode === 'pvp';
    const room = rooms.get(ws.roomId);
    if (!room) return;
  
    const myColor = playerBySession(room, ws.sessionId);
    if (!myColor) return ws.send(JSON.stringify({ type: 'error', message: 'Not a player in this room' }));
  
    // --- SWITCH TO AI ---
    if (wantAi) {
      const otherColor = myColor === BLACK ? WHITE : BLACK;
      const other = room.players[otherColor];
  
      // Vacate my seat from current PvP room
      room.players[myColor] = null;
  
      // Remember the PvP room I left so I can return to it later
      ws.prevPvpRoomId = room.mode === 'pvp' ? room.id : (ws.prevPvpRoomId || null);
  
      // Reset old room for remaining opponent & set waiting
      if (other?.ws && other.ws.readyState === 1) {
        room.board = makeBoard();
        room.moves = [];
        room.nextTurn = BLACK;
        room.winner = 0;
        other.ws.send(JSON.stringify({ type: 'state', ...roomSnapshot(room, other.sessionId) }));
        other.ws.send(JSON.stringify({
          type: 'status',
          message: 'Your opponent switched to AI. Waiting for another player to join…',
          waiting: true
        }));
      }
  
      // Move me to an AI room as BLACK
      const { room: aiRoom, color } = assignToRoom(ws.sessionId, ws, 'ai');
      ws.roomId = aiRoom.id;
      ws.color = color;
  
      ws.send(JSON.stringify({ type: 'hello_ack', sessionId: ws.sessionId, roomId: aiRoom.id, color }));
      ws.send(JSON.stringify(roomSnapshot(aiRoom, ws.sessionId)));
      broadcast(aiRoom, { type: 'status', message: `AI ready in ${aiRoom.name}. Black moves first.`, waiting: false });
      return;
    }
  
    // --- SWITCH BACK TO PVP (triggered by "New Multiplayer Game" while in AI) ---
    if (wantPvp) {
      const preferRoomId = typeof msg.preferRoomId === 'string' ? msg.preferRoomId : (ws.prevPvpRoomId || null);
  
      // Leave current room seat if any
      const curRoom = rooms.get(ws.roomId);
if (curRoom) {
  const mySeat = playerBySession(curRoom, ws.sessionId);
  if (mySeat) curRoom.players[mySeat] = null;

  // If we are leaving an AI room, clear its state so it won't be resumed later
  if (curRoom.mode === 'ai') {
    curRoom.board = makeBoard();
    curRoom.moves = [];
    curRoom.nextTurn = BLACK;
    curRoom.winner = 0;
  }
}

  
      // Try to join the preferred PvP room (where opponent is waiting)
      let targetRoom = null, color = 0;
      if (preferRoomId && rooms.has(preferRoomId)) {
        const r = rooms.get(preferRoomId);
        if (r.mode === 'pvp') {
          // Seat me in the empty spot if available
          if (!r.players[BLACK]) { r.players[BLACK] = { sessionId: ws.sessionId, ws }; targetRoom = r; color = BLACK; }
          else if (!r.players[WHITE]) { r.players[WHITE] = { sessionId: ws.sessionId, ws }; targetRoom = r; color = WHITE; }
        }
      }
  
      // If preferred room not available, fall back to normal PvP matchmaking (fills waiting rooms first)
      if (!targetRoom) {
        const res = assignToRoom(ws.sessionId, ws, 'pvp');
        targetRoom = res.room; color = res.color;
      }
  
      ws.roomId = targetRoom.id;
      ws.color = color;
      ws.prevPvpRoomId = targetRoom.id; // keep latest PvP room reference
  
      ws.send(JSON.stringify({ type: 'hello_ack', sessionId: ws.sessionId, roomId: targetRoom.id, color }));
      ws.send(JSON.stringify(roomSnapshot(targetRoom, ws.sessionId)));
  
      const both = Boolean(targetRoom.players[BLACK] && targetRoom.players[WHITE]);
      broadcast(targetRoom, {
        type: 'status',
        message: both ? `Both players connected in ${targetRoom.name}. Black moves first.` : `Waiting for another player to join ${targetRoom.name}…`,
        waiting: !both
      });
      return;
    }
  
    // If neither ai nor pvp requested, ignore
    return;
  }
  

    ws.send(JSON.stringify({ type:'error', message:'Unknown message type' }));
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomId);
    if (!room) return;
  
    const seat = playerBySession(room, ws.sessionId);
    if (!seat) return;
  
    // ✅ Preserve the seat so the player can reattach on reload.
    // Just drop the socket reference; keep the sessionId and the board state.
    if (room.players[seat]) {
      room.players[seat].ws = null;
    }
  
    // Notify the remaining player and show waiting state
    const bothSocketsPresent =
      Boolean(room.players[BLACK]?.ws) && Boolean(room.players[WHITE]?.ws);
  
    if (!bothSocketsPresent) {
      broadcast(room, {
        type: 'status',
        message: 'Your opponent left the game. Waiting for them (or another player) to join…',
        waiting: true
      });
    }
  });
  
});

httpServer.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
