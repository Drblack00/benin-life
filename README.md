# Benin Life — Multiplayer 🌆

A real-time multiplayer life simulator set in Benin City, Nigeria.
Players create accounts, walk around a shared 2D Benin City, work jobs,
eat, hustle, pay rent, chat live, and see each other moving in real time.

## What's inside

- **Accounts** — register/login with bcrypt-hashed passwords, token sessions (7 days)
- **Shared world** — 2000×1400 Benin City map: Ring Road, Oba Market,
  New Benin Market, UNIBEN, Ogba Zoo, Kada Cinema, Housing Estate
- **Live presence** — every player's movement broadcasts to everyone (~10/sec)
- **Live chat** — global city chat with rate limiting + profanity filter,
  speech bubbles over nearby players
- **Server-authoritative economy** — jobs, food, fun, study, sleep, housing
  all validated on the server (clients can't fake cash)
- **Game-day loop** — 1 game day = 5 real minutes; rent auto-deducted,
  3 missed rents = eviction to under the bridge
- **Persistence** — SQLite database (no native dependencies)

## Run it locally

```bash
npm install
npm start
# open http://localhost:3000
```

Open two browser windows (or a phone + laptop) with different accounts
to see multiplayer in action.

## Deploy it free (Render) — ~10 minutes

1. Push this folder to a GitHub repo.
2. Go to [render.com](https://render.com) → **New +** → **Blueprint**,
   point it at your repo (or use `render.yaml` in this folder).
3. Render reads `render.yaml`: builds with `npm install`, starts with `npm start`,
   and auto-generates a `SESSION_SECRET`.
4. When it's live you get a URL like `https://benin-life.onrender.com`
   — share it, anyone with the link can create an account and play.

> **Free-tier notes**
> - The free instance sleeps after ~15 min idle; the first visit wakes it (slow once).
> - SQLite lives on the instance disk, so player accounts reset if Render
>   restarts/redeploys the service. For permanent accounts, add a Render
>   **PostgreSQL** free database later and point the app at it (ask for the upgrade).

## Controls

| Action | Desktop | Mobile |
|---|---|---|
| Move | WASD / arrows / click map | On-screen D-pad |
| Chat | Type + Enter | 💬 button opens chat |
| Interact | Walk into a zone | Walk into a zone |

## API / protocol (for developers)

- `POST /api/register` `{username, password}` → `{token, username}`
- `POST /api/login` `{username, password}` → `{token, username}`
- `GET /api/health` → `{ok, online, day}`
- `WS /ws?token=…` messages are JSON:
  - → `{t:'move', x, y, d}` · `{t:'chat', text}` · `{t:'act', a:'work'|'eat'|'fun'|'study'|'sleep'|'rent', …}`
  - ← `{t:'init'|'join'|'leave'|'mv'|'chat'|'you'|'sys'|'err'|'day', …}`

## Project layout

```
server.js          — Express + WebSocket server, game logic, SQLite
public/
  index.html       — login + game screens
  style.css        — dark mobile-first UI
  client.js        — canvas map, movement, chat, zone panels
render.yaml        — one-click Render blueprint
```
