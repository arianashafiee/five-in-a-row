(() => {
    'use strict';
  
    const BOARD_SIZE = 19;
    const EMPTY = 0, BLACK = 1, WHITE = 2;
  
    // Canvas & layout
    const canvas = document.getElementById('board');
    const ctx = canvas.getContext('2d', { alpha: false });
    const padding = 30;
    const gridSize = canvas.width - padding * 2;
    const cell = gridSize / (BOARD_SIZE - 1);
  
    // UI
    const statusEl = document.getElementById('status');
    const yourColorEl = document.getElementById('yourColor');
    const nextTurnEl = document.getElementById('nextTurn');
    const roomIdEl = document.getElementById('roomId');
    const roomPill = document.getElementById('roomPill');
    const newGameBtn = document.getElementById('newGameBtn');
  
    // Modal / overlay
    const welcomeModal = document.getElementById('welcomeModal');
    const choosePvp = document.getElementById('choosePvp');
    const chooseAi = document.getElementById('chooseAi');
    const waitingOverlay = document.getElementById('waitingOverlay');
  
    let ws = null;
    let state = {
      sessionId: localStorage.getItem('sessionId') || null,
      roomId: localStorage.getItem('roomId') || null,
      roomName: localStorage.getItem('roomName') || '—',
      color: 0,
      nextTurn: BLACK,
      winner: 0,
      board: Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(EMPTY)),
      mode: null // 'pvp' | 'ai'
    };
  
    // ---- UI helpers ----
    function setStatus(msg) { statusEl.textContent = msg; }
    function colorName(c) { return c === BLACK ? 'Black' : (c === WHITE ? 'White' : '–'); }
    function showModal() { welcomeModal.classList.add('show'); }
    function hideModal() { welcomeModal.classList.remove('show'); }
    function showWaiting() { waitingOverlay.classList.remove('hidden'); }
    function hideWaiting() { waitingOverlay.classList.add('hidden'); }
  
    function saveSession() {
      if (state.sessionId) localStorage.setItem('sessionId', state.sessionId);
      if (state.roomId) localStorage.setItem('roomId', state.roomId);
      if (state.roomName) localStorage.setItem('roomName', state.roomName);
    }
  
    // ---- Drawing ----
    function drawBoard() {
      // background
      ctx.fillStyle = '#fdf6e3';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
  
      // grid
      ctx.strokeStyle = '#b58900';
      ctx.lineWidth = 1;
      for (let i = 0; i < BOARD_SIZE; i++) {
        const x = padding + i * cell;
        const y = padding + i * cell;
        ctx.beginPath(); ctx.moveTo(x, padding); ctx.lineTo(x, canvas.height - padding); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(padding, y); ctx.lineTo(canvas.width - padding, y); ctx.stroke();
      }
  
      // star points
      const stars = [3, 9, 15];
      ctx.fillStyle = '#444';
      for (const sy of stars) for (const sx of stars) {
        const cx = padding + sx * cell, cy = padding + sy * cell;
        ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
      }
  
      // stones
      for (let y = 0; y < BOARD_SIZE; y++) {
        for (let x = 0; x < BOARD_SIZE; x++) {
          const v = state.board[y][x];
          if (v !== EMPTY) drawStone(x, y, v);
        }
      }
    }
  
    function drawStone(x, y, color) {
      const cx = padding + x * cell;
      const cy = padding + y * cell;
      const r = Math.max(10, cell * 0.45);
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.closePath();
      ctx.fillStyle = (color === BLACK) ? '#111' : '#fff';
      ctx.fill(); ctx.lineWidth = 1.2; ctx.strokeStyle = '#0005'; ctx.stroke();
    }
  
    function canvasToCell(mx, my) {
      return {
        x: Math.round((mx - padding) / cell),
        y: Math.round((my - padding) / cell),
      };
    }
  
    // ---- Input: place stone ----
    canvas.addEventListener('click', (e) => {
      if (!ws || ws.readyState !== 1) return;
      if (state.winner) return;
      if (state.nextTurn !== state.color) { setStatus('Wait for your turn.'); return; }
  
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const { x, y } = canvasToCell(mx, my);
      if (x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE) return;
      if (state.board[y][x] !== EMPTY) { setStatus('That intersection is occupied.'); return; }
  
      ws.send(JSON.stringify({ type: 'move', x, y }));
    });
  
    // ---- Connection flow ----
    function connect(mode) {
      state.mode = mode;
  
      // When choosing a mode, don't reuse old room; we’ll either rejoin properly or get a new one
      state.roomId = null;
      state.roomName = '—';
      localStorage.removeItem('roomId');
      localStorage.removeItem('roomName');
  
      if (ws && ws.readyState === 1) try { ws.close(); } catch {}
      ws = new WebSocket(getWsURL());
      setStatus('Connecting…');
  
      ws.onopen = () => {
        setStatus('Connected. Pairing…');
        ws.send(JSON.stringify({
          type: 'hello',
          sessionId: state.sessionId,
          roomId: null,
          mode // 'pvp' | 'ai'
        }));
      };
  
      ws.onmessage = (ev) => {
        let msg = null;
        try { msg = JSON.parse(ev.data); } catch { return; }
  
        if (msg.type === 'hello_ack') {
          state.sessionId = msg.sessionId;
          state.roomId = msg.roomId;
          state.color = msg.color;
          saveSession();
          yourColorEl.textContent = colorName(state.color);
          roomIdEl.textContent = state.roomId.slice(0, 8) + '…';
          return;
        }
  
        if (msg.type === 'state') {
          if (Array.isArray(msg.board)) state.board = msg.board;
          state.nextTurn = msg.nextTurn;
          state.winner = msg.winner;
          state.mode = msg.mode || state.mode;
          if (msg.roomName) {
            state.roomName = msg.roomName;
            roomPill.textContent = `Room: ${state.roomName}`;
            saveSession();
          }
          updateHud();
          drawBoard();
          return;
        }
  
        if (msg.type === 'move') {
          const { x, y, color, nextTurn } = msg;
          if (Number.isInteger(x) && Number.isInteger(y)) state.board[y][x] = color;
          if (typeof nextTurn === 'number') state.nextTurn = nextTurn;
          updateHud();
          drawBoard();
          return;
        }
  
        if (msg.type === 'result') {
          state.winner = msg.winner;
          updateHud();
          setStatus(`${colorName(state.winner)} wins!`);
          return;
        }
  
        if (msg.type === 'status') {
          setStatus(msg.message);
          if (msg.waiting === true) showWaiting(); else hideWaiting();
          return;
        }
  
        if (msg.type === 'error') {
          console.warn('Server error:', msg.message);
          setStatus(`Error: ${msg.message}`);
          return;
        }
      };
  
      ws.onclose = () => {
        setStatus('Disconnected.');
        hideWaiting();
      };
    }
  
    function updateHud() {
      nextTurnEl.textContent = state.winner ? '—' : colorName(state.nextTurn);
      yourColorEl.textContent = colorName(state.color);
    }
  
    function getWsURL() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      return `${proto}://${location.host}`;
    }
  
    // ---- New Game behavior ----
    newGameBtn.addEventListener('click', () => {
      // Immediately clear board & notify opponent via server
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'newGame' }));
      }
      // Locally show popup to choose next mode
      showModal();
    });
  
    // ---- Modal choices ----
    choosePvp.addEventListener('click', () => {
      hideModal();
      connect('pvp');
      // In PvP, show waiting overlay until both players are present
      showWaiting();
    });
  
    chooseAi.addEventListener('click', () => {
      hideModal();
      connect('ai');
      hideWaiting();
    });
  
    // ---- Auto open modal on first load ----
    window.addEventListener('load', () => {
      drawBoard();
      showModal();
    });
  })();
  