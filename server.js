import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { v4 as uuid } from 'uuid';

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

const PORT = process.env.PORT || 3000;

// Serve client
app.use(express.static('public'));

// Game constants
const BOARD_SIZE = 19;
const EMPTY = 0, BLACK = 1, WHITE = 2;

// Pretty room names
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

// Rooms
const rooms = new Map(); // id -> room

function createRoom(mode = 'pvp') {
  const id = uuid();
  const room = {
    id,
    name: randomRoomName(),
    mode, // 'pvp' or 'ai'
    board: makeBoard(),
    moves: [],
    nextTurn: BLACK,
    players: { [BLACK]: null, [WHITE]: null }, // { sessionId, ws }
    winner: 0,
    createdAt: Date.now()
  };
  // AI sits at WHITE immediately for AI rooms
  if (mode === 'ai') room.players[WHITE] = { sessionId: 'AI', ws: null };
  rooms.set(id, room);
  return room;
}

function assignToRoom(sessionId, ws, desiredMode) {
  for (const room of rooms.values()) {
    if (room.winner) continue;
    if (room.mode !== desiredMode) continue;

    if (desiredMode === 'ai') {
      if (!room.players[BLACK]) {
        room.players[BLACK] = { sessionId, ws };
        return { room, color: BLACK };
      }
      continue; // try another AI room
    }

    // PvP fill order
    if (!room.players[BLACK]) { room.players[BLACK] = { sessionId, ws }; return { room, color: BLACK }; }
    if (!room.players[WHITE]) { room.players[WHITE] = { sessionId, ws }; return { room, color: WHITE }; }
  }
  // No suitable room, create one
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
    if (p?.ws && p.ws.readyState === 1) {
      p.ws.send(JSON.stringify(payload));
    }
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

// --- Simple AI ---
function findFirstEmpty(board){ for(let y=0;y<BOARD_SIZE;y++){ for(let x=0;x<BOARD_SIZE;x++){ if(board[y][x]===EMPTY) return {x,y}; } } return null; }
function findWinningMove(board, color){
  for(let y=0;y<BOARD_SIZE;y++){ for(let x=0;x<BOARD_SIZE;x++){
    if(board[y][x]!==EMPTY) continue;
    board[y][x]=color; const w = checkWinner(board,x,y)===color; board[y][x]=EMPTY; if(w) return {x,y};
  }} return null;
}
function heuristicScore(board,x,y,me,opp){
  const centerBias = -(Math.abs(x-Math.floor(BOARD_SIZE/2))+Math.abs(y-Math.floor(BOARD_SIZE/2)));
  const dirs=[[1,0],[0,1],[1,1],[1,-1]];
  let score=centerBias*0.5;
  for(const [dx,dy] of dirs){ score += linePotential(board,x,y,dx,dy,me)*1.2 + linePotential(board,x,y,dx,dy,opp); }
  return score;
}
function linePotential(board,x,y,dx,dy,color){
  let count=1, open=0; let fx=x+dx, fy=y+dy; while(inBounds(fx,fy)&&board[fy][fx]===color){count++; fx+=dx; fy+=dy;} if(inBounds(fx,fy)&&board[fy][fx]===EMPTY) open++;
  let bx=x-dx, by=y-dy; while(inBounds(bx,by)&&board[by][bx]===color){count++; bx-=dx; by-=dy;} if(inBounds(bx,by)&&board[by][bx]===EMPTY) open++;
  if(count>=5) return 100000; if(count===4 && open>0) return 10000; if(count===3 && open===2) return 5000; if(count===3 && open===1) return 1000; if(count===2 && open===2) return 300; if(count===2 && open===1) return 100;
  return 10*count + 5*open;
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

// --- WebSocket handlers ---
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let msg=null;
    try { msg = JSON.parse(data); } catch { return ws.send(JSON.stringify({type:'error', message:'Invalid JSON'})); }

    if (msg.type === 'hello') {
      const sessionId = msg.sessionId || uuid();
      ws.sessionId = sessionId;
      const desiredMode = msg.mode === 'ai' ? 'ai' : 'pvp';

      let room=null, color=0;

      // Ignore provided roomId on mode change; always assign by desiredMode
      ({ room, color } = assignToRoom(sessionId, ws, desiredMode));

      ws.roomId = room.id;
      ws.color = color;

      ws.send(JSON.stringify({ type: 'hello_ack', sessionId, roomId: room.id, color }));
      ws.send(JSON.stringify(roomSnapshot(room, sessionId)));

      // Status/waiting cues
      if (room.mode === 'ai') {
        broadcast(room, { type: 'status', message: `AI ready in ${room.name}. Black moves first.`, waiting: false });
      } else {
        const both = Boolean(room.players[BLACK] && room.players[WHITE]);
        broadcast(room, { type: 'status', message: both ? `Both players connected in ${room.name}. Black moves first.` : `Waiting for another player to join ${room.name}…`, waiting: !both });
      }
      return;
    }

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

      // AI response if needed
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

    if (msg.type === 'newGame') {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      // Reset board immediately and notify both sides; client will reopen modal to choose mode
      room.board = makeBoard();
      room.moves = [];
      room.nextTurn = BLACK;
      room.winner = 0;
      broadcast(room, { type: 'state', ...roomSnapshot(room, ws.sessionId) });
      broadcast(room, { type: 'status', message: `New game requested. Board reset in ${room.name}. Choose a mode to continue.`, waiting: false });
      return;
    }

    ws.send(JSON.stringify({ type:'error', message:'Unknown message type' }));
  });

  ws.on('close', () => {
    // Keep room for refresh/matching; garbage collection could be added later
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
