# Five-in-a-Row (Gomoku)
Modern HTML5 + Node.js implementation with **Local (offline)**, **PvP (server)**, and **AI** modes. Secure by default, stones placed on **intersections**, no console errors, and state **restores on refresh** (server modes via session/room; Local via localStorage).

## Demo Targets
- **Client-only works:** Local mode playable with no server.
- **PvP & AI:** Server validates all moves; AI blocks & wins.
- **No console errors:** Grader-friendly clean logs.
- **Security:** CSP, input validation, anti-forgery, bounded payloads.

---

## Quick Start
```bash
# 1) Install
npm install

# 2) Run
npm start

# 3) Open
# http://localhost:3000
