# Retro Rumble

Chaotic multiplayer quiz for sprint retros. One person hosts on the shared screen, everyone else plays from their phone.

**Play:** https://snowu.github.io/retro-rumble/

- 🎡 A chaos wheel before every question: Double Trouble, Speed Demon, Minefield, Heist, Jackpot, Contrarian, Opposite Day, Wobbly, Blurry, and a once-a-game Robin Hood that swaps first and last place
- 🗳️ "Who's most likely to…" vote rounds where your teammates are the answers; the winner is crowned with the title
- 🎲 All-in once per game, plus a prank card (🧊 Ice, 🍌 Banana, 🌫️ Fog or 🔄 Swap) that refills every 5 questions
- 🎤 The big screen roasts the room after each reveal
- 🏅 Special awards before the podium: Overconfident, Sloth, Lone Wolf, Keyboard Warrior, Ghost, Participation Trophy…
- 🔥 Streaks, live emoji reactions, podium and confetti

Two host modes, picked in the lobby:

- 🎮 **Play along**: the host plays too, by clicking the answer cards. Every game pulls fresh trivia, adds a few built-in trick questions and team votes.
- 🎛️ **Game master**: the host doesn't answer but controls everything: questions, answer time, which wheel modifiers are on, power-ups. During the game a **Control panel** (separate window, so answers never hit the shared screen) can queue or remove questions, change settings, reveal early, skip or end the game.

Game master questions are written in the lobby:

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

## Credits

Trivia questions come from [Open Trivia DB](https://opentdb.com), licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The Worker fetches them at `/api/trivia`; Play along falls back to the built-in questions if the API is unavailable.
