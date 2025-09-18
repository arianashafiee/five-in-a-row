(() => {
    "use strict";
  
    // --- Constants ---
    const BOARD_SIZE = 19;
    const EMPTY = 0,
      BLACK = 1,
      WHITE = 2;
  
    // --- Canvas ---
    const canvas = document.getElementById("board");
    const ctx = canvas.getContext("2d", { alpha: false });
    const padding = 30;
    const gridSize = canvas.width - padding * 2;
    const cell = gridSize / (BOARD_SIZE - 1);
  
    // --- UI elements (guarded) ---
    const statusEl = document.getElementById("status");
    const yourColorEl = document.getElementById("yourColor");
    const nextTurnEl = document.getElementById("nextTurn");
    const roomPill = document.getElementById("roomPill");
    const newGameBtn = document.getElementById("newGameBtn");
    const playAiBtn = document.getElementById("playAiBtn");
  
    // Welcome modal
    const welcomeModal = document.getElementById("welcomeModal");
    const choosePvp = document.getElementById("choosePvp");
    const chooseAi = document.getElementById("chooseAi");
    const chooseLocal = document.getElementById("chooseLocal");
  
    // Waiting overlay
    const waitingOverlay = document.getElementById("waitingOverlay");
    const playAiBtnOverlay = document.getElementById("playAiBtnOverlay");
  
    // New AI Game button (visible only in AI mode)
    const newAiBtn = document.getElementById("newAiBtn");
  
    // --- State ---
    let ws = null;
    const blankBoard = () => Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(EMPTY));
  
    let state = {
      sessionId: sessionStorage.getItem("sessionId") || null,
      roomId: sessionStorage.getItem("roomId") || null,
      roomName: sessionStorage.getItem("roomName") || "—",
      color: 0,
      nextTurn: BLACK,
      winner: 0,
      board: blankBoard(),
      mode: sessionStorage.getItem("mode") || null // 'pvp' | 'ai' | 'local' | null
    };
  
    // --- Helpers ---
    const show = (el) => el && el.classList.add("show");
    const hide = (el) => el && el.classList.remove("show");
    const showModal = () => show(welcomeModal);
    const hideModal = () => hide(welcomeModal);
    const showWaiting = () => waitingOverlay && waitingOverlay.classList.remove("hidden");
    const hideWaiting = () => waitingOverlay && waitingOverlay.classList.add("hidden");
    const setStatus = (msg) => statusEl && (statusEl.textContent = msg);
    const colorName = (c) => (c === BLACK ? "Black" : c === WHITE ? "White" : "–");
  
    function saveSession() {
      if (state.sessionId) sessionStorage.setItem("sessionId", state.sessionId);
      if (state.roomId) sessionStorage.setItem("roomId", state.roomId);
      if (state.roomName) sessionStorage.setItem("roomName", state.roomName);
      if (state.mode) sessionStorage.setItem("mode", state.mode);
    }
  
    function getWsURL() {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      return `${proto}://${location.host}`;
    }
  
    // --- Drawing ---
    function drawBoard() {
      ctx.fillStyle = "#fdf6e3";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
  
      ctx.strokeStyle = "#b58900";
      ctx.lineWidth = 1;
      for (let i = 0; i < BOARD_SIZE; i++) {
        const x = padding + i * cell;
        const y = padding + i * cell;
        ctx.beginPath();
        ctx.moveTo(x, padding);
        ctx.lineTo(x, canvas.height - padding);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(padding, y);
        ctx.lineTo(canvas.width - padding, y);
        ctx.stroke();
      }
  
      const stars = [3, 9, 15];
      ctx.fillStyle = "#444";
      for (const sy of stars)
        for (const sx of stars) {
          const cx = padding + sx * cell,
            cy = padding + sy * cell;
          ctx.beginPath();
          ctx.arc(cx, cy, 3, 0, Math.PI * 2);
          ctx.fill();
        }
  
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
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.closePath();
      ctx.fillStyle = color === BLACK ? "#111" : "#fff";
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = "#0005";
      ctx.stroke();
    }
  
    function canvasToCell(mx, my) {
      return {
        x: Math.round((mx - padding) / cell),
        y: Math.round((my - padding) / cell)
      };
    }
  
    // --- Local winner check (client-only mode) ---
    function localCheckWinner(x, y) {
      const color = state.board[y][x];
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
          if (nx < 0 || ny < 0 || nx >= BOARD_SIZE || ny >= BOARD_SIZE) break;
          if (state.board[ny][nx] === color) count++;
          else break;
        }
        for (let s = 1; s <= 4; s++) {
          const nx = x - dx * s,
            ny = y - dy * s;
          if (nx < 0 || ny < 0 || nx >= BOARD_SIZE || ny >= BOARD_SIZE) break;
          if (state.board[ny][nx] === color) count++;
          else break;
        }
        if (count >= 5) return color;
      }
      return 0;
    }
  
    // --- Input: place stone (handles all modes) ---
    canvas.addEventListener("click", (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left,
        my = e.clientY - rect.top;
      const { x, y } = canvasToCell(mx, my);
      if (x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE) return;
      if (state.winner) return;
  
      // Local mode: alternate turns on-device
      if (state.mode === "local") {
        if (state.board[y][x] !== EMPTY) {
          setStatus("That intersection is occupied.");
          return;
        }
        state.board[y][x] = state.nextTurn;
        const w = localCheckWinner(x, y);
        if (w) {
          state.winner = w;
          updateHud();
          drawBoard();
          setStatus(`${colorName(state.winner)} wins! Start a new game or switch to online/AI.`);
          return;
        }
        state.nextTurn = state.nextTurn === BLACK ? WHITE : BLACK;
        updateHud();
        drawBoard();
        return;
      }
  
      // PvP/AI: client checks minimal constraints; server is authoritative
      if (!ws || ws.readyState !== 1) return;
      if (state.nextTurn !== state.color) {
        setStatus("Wait for your turn.");
        return;
      }
      if (state.board[y][x] !== EMPTY) {
        setStatus("That intersection is occupied.");
        return;
      }
      ws.send(JSON.stringify({ type: "move", x, y }));
    });
  
    // New AI game button
    newAiBtn?.addEventListener("click", () => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "newAIGame" }));
    });
  
    // --- Buttons ---
    newGameBtn?.addEventListener("click", () => {
      if (state.mode === "local") {
        // reset local
        state.board = blankBoard();
        state.nextTurn = BLACK;
        state.winner = 0;
        setStatus("Local game reset. Black moves first.");
        updateHud();
        drawBoard();
        return;
      }
      if (!ws || ws.readyState !== 1) return;
      if (state.mode === "ai") {
        const preferRoomId = sessionStorage.getItem("lastPvpRoomId") || null;
        state.mode = "pvp";
        saveSession();
        if (newAiBtn) newAiBtn.style.display = "none";
        ws.send(JSON.stringify({ type: "switchMode", mode: "pvp", preferRoomId }));
      } else {
        ws.send(JSON.stringify({ type: "newGame" }));
      }
    });
  
    function switchToAi() {
      if (state.mode === "pvp" && state.roomId) sessionStorage.setItem("lastPvpRoomId", state.roomId);
      state.mode = "ai";
      saveSession();
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "switchMode", mode: "ai" }));
      if (newAiBtn) newAiBtn.style.display = "inline-block";
      if (playAiBtn) playAiBtn.style.display = "none";
    }
  
    playAiBtn?.addEventListener("click", () => {
      if (state.mode === "local") connectAs("ai");
      else switchToAi();
    });
    playAiBtnOverlay?.addEventListener("click", () => {
      if (state.mode === "local") connectAs("ai");
      else switchToAi();
    });
  
    // --- Welcome modal choices ---
    function startPvp() {
      connectAs("pvp");
    }
    function startAi() {
      connectAs("ai");
    }
    function startLocal() {
      state.mode = "local";
      state.board = blankBoard();
      state.nextTurn = BLACK;
      state.winner = 0;
      saveSession();
      hideModal();
      hideWaiting();
      yourColorEl && (yourColorEl.textContent = "— (Local)");
      roomPill && (roomPill.textContent = "Room: Local");
      setStatus("Local game: Black moves first.");
      drawBoard();
      updateHud();
    }
  
    choosePvp?.addEventListener("click", startPvp);
    chooseAi?.addEventListener("click", startAi);
    chooseLocal?.addEventListener("click", startLocal);
  
    // --- Connection / matchmaking ---
    function connectAs(mode) {
      state.mode = mode;
      saveSession();
      hideModal();
      connect();
      if (mode === "pvp") showWaiting();
      else hideWaiting();
    }
  
    function connect() {
      if (ws && ws.readyState === 1) {
        try {
          ws.close();
        } catch {}
      }
      ws = new WebSocket(getWsURL());
      setStatus("Connecting…");
  
      ws.onopen = () => {
        setStatus("Connected.");
        ws.send(
          JSON.stringify({
            type: "hello",
            sessionId: state.sessionId,
            roomId: state.roomId,
            mode: state.mode || "pvp"
          })
        );
        if ((state.mode || "pvp") === "pvp") showWaiting();
  
        if (newAiBtn) newAiBtn.style.display = state.mode === "ai" ? "inline-block" : "none";
        if (playAiBtn) playAiBtn.style.display = state.mode === "ai" ? "none" : "inline-block";
      };
  
      ws.onmessage = (ev) => {
        let msg = null;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
  
        if (msg.type === "hello_ack") {
          state.sessionId = msg.sessionId;
          state.roomId = msg.roomId;
          state.color = msg.color;
          saveSession();
          yourColorEl && (yourColorEl.textContent = colorName(state.color));
          // room id is not shown raw; use friendly name when we receive it
          return;
        }
  
        if (msg.type === "state") {
          if (Array.isArray(msg.board)) state.board = msg.board;
          state.nextTurn = msg.nextTurn;
          state.winner = msg.winner;
          state.mode = msg.mode || state.mode || "pvp";
          if (msg.roomName) {
            state.roomName = msg.roomName;
            roomPill && (roomPill.textContent = `Room: ${state.roomName}`);
            saveSession();
          }
          updateHud();
          drawBoard();
  
          if (newAiBtn) newAiBtn.style.display = state.mode === "ai" ? "inline-block" : "none";
          if (playAiBtn) playAiBtn.style.display = state.mode === "ai" ? "none" : "inline-block";
  
          return;
        }
  
        if (msg.type === "move") {
          const { x, y, color, nextTurn } = msg;
          if (Number.isInteger(x) && Number.isInteger(y)) state.board[y][x] = color;
          if (typeof nextTurn === "number") state.nextTurn = nextTurn;
          updateHud();
          drawBoard();
          return;
        }
  
        if (msg.type === "result") {
          state.winner = msg.winner;
          updateHud();
          setStatus(`${colorName(state.winner)} wins! Start a new multiplayer game or switch to AI.`);
          return;
        }
  
        if (msg.type === "status") {
          setStatus(msg.message);
          if (msg.waiting === true) showWaiting();
          if (msg.waiting === false) hideWaiting();
          return;
        }
  
        if (msg.type === "error") {
          console.warn("Server error:", msg.message);
          setStatus(`Error: ${msg.message}`);
          return;
        }
      };
  
      ws.onclose = () => {
        setStatus("Disconnected.");
        if ((state.mode || "pvp") === "pvp") showWaiting();
      };
    }
  
    function updateHud() {
      nextTurnEl && (nextTurnEl.textContent = state.winner ? "—" : colorName(state.nextTurn));
      yourColorEl && (yourColorEl.textContent = state.mode === "local" ? "— (Local)" : colorName(state.color));
    }
  
    // --- First load behavior ---
    window.addEventListener("load", () => {
      drawBoard();
  
      const hasSession = Boolean(sessionStorage.getItem("sessionId"));
      const hasRoom = Boolean(sessionStorage.getItem("roomId"));
      const savedMode = sessionStorage.getItem("mode"); // 'pvp' | 'ai' | 'local' | null
  
      if (savedMode === "local") {
        // restore local game
        hideModal();
        setStatus("Local game: resume.");
        updateHud();
        drawBoard();
        return;
      }
  
      if (hasRoom || hasSession || (savedMode && savedMode !== "local")) {
        state.mode = savedMode || "pvp";
        connect();
      } else {
        showModal();
      }
    });
  })();