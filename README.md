# Retro Rumble

Chaotic multiplayer quiz for sprint retros. One person hosts on the shared screen, everyone else plays from their phone.

**Play:** https://snowu.github.io/retro-rumble/

- 🎡 A chaos wheel before every question: Double Trouble, Speed Demon, Minefield, Heist, Scramble, Jackpot, Contrarian
- 🗳️ "Who's most likely to…" vote rounds where your teammates are the answers
- 🎲 All-in and 🧊 Ice the leader power-ups, once per game each
- 🔥 Streaks, live emoji reactions, podium and confetti

Questions are edited in the host lobby:

```
? In what year was Git first released?
2003
*2005
2008

vote: Who is most likely to push straight to main on a Friday?
```

## How it works

No database. The page (GitHub Pages) talks to a Cloudflare Worker; each room is a Durable Object that keeps the game in memory and pushes state to every client over WebSockets. When everyone leaves, the room is gone.

```
npm install
npm run dev      # http://localhost:8787 serves the page and the rooms
npm run deploy   # deploy the Worker
```

The GitHub Pages build points at `https://retro-rumble.zancato-t.workers.dev` (see `API` in `public/index.html`).
