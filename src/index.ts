import { DurableObject } from "cloudflare:workers";

interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
}

type Phase = "lobby" | "spin" | "question" | "reveal" | "end";
type ModId = "vanilla" | "double" | "speed" | "mines" | "heist" | "scramble" | "jackpot" | "contrarian";
// play: the host is also a player and can't edit questions. gm: the host runs everything and doesn't answer.
type Mode = "play" | "gm";

interface Settings {
  seconds: number;
  mods: ModId[];
  powerups: boolean;
}

interface Question {
  kind: "quiz" | "vote";
  text: string;
  options: string[];
  correct: number;
}

interface Player {
  id: string;
  name: string;
  emoji: string;
  ws: WebSocket | null;
  score: number;
  streak: number;
  answer: number | null;
  answeredAt: number;
  perm: number[] | null;
  allInUsed: boolean;
  allInActive: boolean;
  iceUsed: boolean;
  frozenUntil: number;
  frozenBy: string;
  lastReact: number;
}

interface Result {
  delta: number;
  correct: boolean | null;
  note: string;
}

interface Reveal {
  counts: number[];
  winners: number[];
  headline: string;
  results: Record<string, Result>;
  rankBefore: Record<string, number>;
  picks: Record<string, number | null>;
}

const MODS: Record<ModId, { label: string; emoji: string; desc: string; color: string }> = {
  vanilla: { label: "Vanilla", emoji: "🍦", desc: "A perfectly normal question. Suspicious.", color: "#f5e6c8" },
  double: { label: "Double Trouble", emoji: "✌️", desc: "All points ×2", color: "#ff3d9a" },
  speed: { label: "Speed Demon", emoji: "⚡", desc: "Way less time. Go.", color: "#ffd23f" },
  mines: { label: "Minefield", emoji: "💣", desc: "Wrong or no answer: −300", color: "#ff4d4d" },
  heist: { label: "Heist", emoji: "🦹", desc: "Fastest correct answer steals 20% from the leader", color: "#8b5cf6" },
  scramble: { label: "Scramble", emoji: "🌀", desc: "Every phone's buttons are shuffled. Read!", color: "#2de2e6" },
  jackpot: { label: "Jackpot", emoji: "🎰", desc: "Only the fastest correct answer scores: 2000", color: "#3ef08a" },
  contrarian: { label: "Contrarian", emoji: "🙃", desc: "The LEAST picked answer wins", color: "#ff8a3d" },
};
const QUIZ_MODS: ModId[] = ["vanilla", "double", "speed", "mines", "heist", "scramble", "jackpot"];
const VOTE_MODS: ModId[] = ["vanilla", "double", "speed", "contrarian"];

const SECONDS = [15, 20, 30, 45, 60];
const DEFAULT_SETTINGS: Settings = { seconds: 30, mods: [...QUIZ_MODS, "contrarian"], powerups: true };
const speedMs = (s: Settings) => Math.max(5, Math.round(s.seconds * 0.4)) * 1000;

function cleanSettings(raw: unknown, prev: Settings): Settings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Settings>;
  return {
    seconds: SECONDS.includes(Number(r.seconds)) ? Number(r.seconds) : prev.seconds,
    mods: Array.isArray(r.mods) ? r.mods.filter((m): m is ModId => m in MODS) : prev.mods,
    powerups: typeof r.powerups === "boolean" ? r.powerups : prev.powerups,
  };
}

const SPIN_MS = 6500;
const FREEZE_MS = 5000;
const AVATARS = ["🦊", "🐸", "🐙", "🦄", "🐼", "🦖", "🐝", "🦉", "🐧", "🦀", "🐯", "🐨", "🦦", "🐳", "🦩", "🐲", "🦔", "🐌", "👾", "🤖"];
const REACTIONS = ["🔥", "😂", "👏", "😱", "💀", "🎉", "🤡", "🧠"];

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const randomCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// "? question" starts a quiz question, the next lines are options, "*" marks the right one.
// "vote: prompt" is a who-on-the-team vote where the players are the options.
function parseQuestions(text: string): Question[] {
  const out: Question[] = [];
  let cur: Question | null = null;
  const lines = text.split("\n").map((l) => l.trim());
  lines.push("?"); // sentinel flushes the last question
  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    const vote = line.match(/^vote:\s*(.+)$/i);
    if (vote || line.startsWith("?")) {
      if (cur && cur.options.length >= 2 && cur.correct >= 0) out.push(cur);
      cur = null;
      if (vote) out.push({ kind: "vote", text: vote[1].slice(0, 200), options: [], correct: -1 });
      else if (line.length > 1) cur = { kind: "quiz", text: line.slice(1).trim().slice(0, 200), options: [], correct: -1 };
      continue;
    }
    if (cur && cur.options.length < 4) {
      const right = line.startsWith("*");
      if (right) cur.correct = cur.options.length;
      cur.options.push((right ? line.slice(1) : line).trim().slice(0, 80));
    }
  }
  return out.slice(0, 200);
}

// Open Trivia DB (opentdb.com, CC BY-SA 4.0): free, no key, 50 per request, ~1 request per 5s per IP.
interface OtdbItem {
  difficulty: string;
  category: string;
  question: string;
  correct_answer: string;
  incorrect_answers: string[];
}
const OTDB_SKIP = /Anime|Video Games|Cartoon|Comics|Board Games|Musicals|Television/;
const DIFFICULTIES = ["any", "easy", "medium", "hard"];

// "mix" pulls a big batch and keeps the friendlier categories, easy and medium first.
async function fetchTrivia(amount: number, category = "mix", difficulty = "any"): Promise<Question[]> {
  const mix = category === "mix";
  const url = new URL("https://opentdb.com/api.php");
  url.searchParams.set("amount", String(mix ? 50 : Math.min(amount, 50)));
  url.searchParams.set("type", "multiple");
  url.searchParams.set("encode", "url3986");
  if (!mix) url.searchParams.set("category", category);
  if (difficulty !== "any") url.searchParams.set("difficulty", difficulty);
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url.toString()).catch(() => null);
    const data = res?.ok ? await res.json<{ response_code: number; results: OtdbItem[] }>().catch(() => null) : null;
    if (data?.response_code === 5 && attempt === 0) {
      await new Promise((r) => setTimeout(r, 5200)); // rate limited, try once more
      continue;
    }
    if (!data || data.response_code !== 0) return [];
    const d = (x: string) => decodeURIComponent(x).trim();
    let items = data.results;
    if (mix) {
      items = items.filter((it) => !OTDB_SKIP.test(d(it.category)));
      items.sort((a, b) => Number(a.difficulty === "hard") - Number(b.difficulty === "hard"));
    }
    return items.slice(0, amount).map((it): Question => {
      const right = d(it.correct_answer).slice(0, 80);
      const options = shuffle([right, ...it.incorrect_answers.map((o) => d(o).slice(0, 80))]);
      return { kind: "quiz", text: d(it.question).slice(0, 200), options, correct: options.indexOf(right) };
    });
  }
  return [];
}

// Two questions are duplicates when most of their meaningful words match,
// so "How many bones are in the adult human body?" catches "How many bones are in the human body?".
const STOPWORDS = new Set(["the", "and", "for", "are", "was", "were", "which", "what", "who", "this", "that", "with", "from", "these", "following", "has", "have", "does", "did", "how", "many", "much", "when", "where", "year", "name", "called"]);
const words = (t: string) => new Set(t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => (w.length > 2 || /\d|^[ivx]+$/.test(w)) && !STOPWORDS.has(w)));
function similar(a: string, b: string): boolean {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return a.trim().toLowerCase() === b.trim().toLowerCase();
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared) >= 0.75;
}
// Keeps the questions in `add` that don't duplicate `existing` or each other.
function dedupe(add: Question[], existing: string[]): Question[] {
  const seen = [...existing];
  return add.filter((q) => {
    if (seen.some((t) => similar(t, q.text))) return false;
    seen.push(q.text);
    return true;
  });
}

// Play along: fresh trivia plus a few built-in trick questions, a team vote every 4th round.
function playSet(builtin: Question[], trivia: Question[], asked: Set<string>): Question[] {
  const fresh = (qs: Question[]) => (qs.filter((q) => !asked.has(q.text)).length >= 4 ? qs.filter((q) => !asked.has(q.text)) : qs);
  const votes = shuffle(builtin.filter((q) => q.kind === "vote")).slice(0, 4);
  const classics = shuffle(fresh(builtin.filter((q) => q.kind === "quiz")));
  const picked = classics.slice(0, 4);
  const extra = dedupe(trivia, [...asked, ...picked.map((q) => q.text)]).slice(0, 12);
  const quiz = extra.length >= 8 ? shuffle([...extra, ...picked]) : classics;
  const out: Question[] = [];
  quiz.forEach((q, i) => {
    out.push(q);
    if (i % 4 === 3 && votes.length) out.push(votes.shift()!);
  });
  return [...out, ...votes];
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api/room" && req.method === "POST") {
      for (let attempt = 0; attempt < 10; attempt++) {
        const code = randomCode();
        const res = await env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(`https://room/create?code=${code}`, { method: "POST" });
        if (res.ok) return new Response(res.body, { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
      }
      return new Response("no free room codes", { status: 503 });
    }
    if (url.pathname === "/api/trivia") {
      const amount = Math.min(20, Math.max(1, Number(url.searchParams.get("amount")) || 10));
      const category = /^(\d+|mix)$/.test(url.searchParams.get("category") ?? "") ? url.searchParams.get("category")! : "mix";
      const difficulty = DIFFICULTIES.includes(url.searchParams.get("difficulty") ?? "") ? url.searchParams.get("difficulty")! : "any";
      const qs = await fetchTrivia(amount, category, difficulty);
      return Response.json(qs, { headers: { "Access-Control-Allow-Origin": "*" } });
    }
    const m = url.pathname.match(/^\/ws\/([A-Z]{4})$/);
    if (m) {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
};

// One room per Durable Object. Everything lives in memory: when the last socket leaves
// and the object is evicted, the room is gone.
export class Room extends DurableObject<Env> {
  code = "";
  hostKey = "";
  created = false;
  phase: Phase = "lobby";
  mode: Mode = "gm";
  settings: Settings = DEFAULT_SETTINGS;
  questions: Question[] = [];
  qi = -1;
  cur: Question | null = null;
  players = new Map<string, Player>();
  hosts = new Set<WebSocket>();
  mod: ModId = "vanilla";
  modPool: ModId[] = QUIZ_MODS;
  modIndex = 0;
  qStart = 0;
  qDuration = DEFAULT_SETTINGS.seconds * 1000;
  timer: ReturnType<typeof setTimeout> | null = null;
  reveal: Reveal | null = null;
  starting = false;
  asked = new Set<string>(); // question texts already played in this room, so reruns stay fresh

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/create") {
      if (this.created) return new Response("taken", { status: 409 });
      this.created = true;
      this.code = url.searchParams.get("code") ?? "";
      this.hostKey = crypto.randomUUID();
      return Response.json({ code: this.code, hostKey: this.hostKey });
    }

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    if (!this.created) {
      server.close(4004, "room not found");
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.searchParams.get("role") === "host") {
      if (url.searchParams.get("key") !== this.hostKey) {
        server.close(4003, "bad host key");
        return new Response(null, { status: 101, webSocket: client });
      }
      this.hosts.add(server);
      server.addEventListener("message", (e) => this.onHost(e.data));
      server.addEventListener("close", () => this.hosts.delete(server));
      this.send(server, this.hostView());
      return new Response(null, { status: 101, webSocket: client });
    }

    const id = (url.searchParams.get("pid") ?? "").slice(0, 64);
    const name = (url.searchParams.get("name") ?? "").trim().slice(0, 16);
    if (!id || !name) {
      server.close(4000, "missing name");
      return new Response(null, { status: 101, webSocket: client });
    }
    let p = this.players.get(id);
    if (p) {
      try { p.ws?.close(4001, "replaced"); } catch {}
      p.ws = server;
      p.name = name;
    } else {
      const used = new Set([...this.players.values()].map((o) => o.emoji));
      p = {
        id, name, ws: server,
        emoji: pick(AVATARS.filter((a) => !used.has(a)).concat(used.size >= AVATARS.length ? AVATARS : [])),
        score: 0, streak: 0, answer: null, answeredAt: 0, perm: null,
        allInUsed: false, allInActive: false, iceUsed: false, frozenUntil: 0, frozenBy: "", lastReact: 0,
      };
      this.players.set(id, p);
    }
    const player = p;
    server.addEventListener("message", (e) => this.onPlayer(player, e.data));
    server.addEventListener("close", () => {
      if (player.ws === server) {
        player.ws = null;
        this.broadcast();
      }
    });
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  private parse(data: unknown): Record<string, unknown> | null {
    if (typeof data !== "string" || data.length > 20000) return null;
    try { return JSON.parse(data); } catch { return null; }
  }

  private async onHost(data: unknown) {
    const msg = this.parse(data);
    if (!msg) return;
    if (msg.t === "start" && this.phase === "lobby" && !this.starting) {
      const qs = parseQuestions(String(msg.questions ?? ""));
      if (!qs.length) return this.toHosts({ t: "event", text: "No valid questions found — check the format" });
      this.mode = msg.mode === "play" ? "play" : "gm";
      this.settings = this.mode === "gm" ? cleanSettings(msg.settings, this.settings) : DEFAULT_SETTINGS;
      if (this.mode === "play") {
        this.starting = true;
        this.toHosts({ t: "event", text: "🌐 Fetching fresh trivia…" });
        const trivia = await fetchTrivia(20);
        this.starting = false;
        if (!this.created || this.phase !== "lobby") return; // closed while we waited
        if (trivia.length < 8) this.toHosts({ t: "event", text: "Open Trivia DB didn't answer, using the built-in questions" });
        this.questions = playSet(qs, trivia, this.asked);
      } else {
        this.questions = qs;
      }
      this.qi = -1;
      this.nextQuestion();
    } else if (msg.t === "skip" && this.phase === "question") {
      this.doReveal();
    } else if (msg.t === "next" && this.phase === "reveal") {
      this.nextQuestion();
    } else if (msg.t === "settings" && this.mode === "gm") {
      this.settings = cleanSettings(msg.settings, this.settings);
      this.broadcast();
    } else if (msg.t === "queueAdd" && this.mode === "gm" && this.phase !== "lobby") {
      const parsed = parseQuestions(String(msg.questions ?? ""));
      if (!parsed.length) return this.toHosts({ t: "event", text: "No valid questions found — check the format" });
      const qs = dedupe(parsed, [...this.asked, ...this.questions.map((q) => q.text)]);
      const skipped = parsed.length - qs.length;
      this.questions.push(...qs);
      this.toHosts({ t: "event", text: `➕ ${qs.length} question${qs.length === 1 ? "" : "s"} queued${skipped ? ` (${skipped} duplicate${skipped > 1 ? "s" : ""} skipped)` : ""}` });
      this.broadcast();
    } else if (msg.t === "queueRemove" && this.mode === "gm") {
      const i = Number(msg.i);
      if (!Number.isInteger(i) || i <= this.qi || i >= this.questions.length) return;
      this.questions.splice(i, 1);
      this.broadcast();
    } else if (msg.t === "end" && this.mode === "gm" && this.phase !== "lobby" && this.phase !== "end") {
      this.clearTimer();
      this.phase = "end";
      this.cur = null;
      this.broadcast();
    } else if (msg.t === "close") {
      // Forget everything; the code can be handed out again once the object is idle.
      this.clearTimer();
      const sockets = [...this.hosts, ...[...this.players.values()].map((p) => p.ws)];
      Object.assign(this, { created: false, phase: "lobby", questions: [], qi: -1, cur: null, reveal: null, asked: new Set() });
      this.players.clear();
      this.hosts.clear();
      for (const ws of sockets) try { ws?.close(4005, "room closed"); } catch {}
    } else if (msg.t === "again" && this.phase === "end") {
      for (const p of this.players.values()) {
        Object.assign(p, { score: 0, streak: 0, answer: null, allInUsed: false, allInActive: false, iceUsed: false, frozenUntil: 0 });
      }
      this.phase = "lobby";
      this.qi = -1;
      this.reveal = null;
      this.cur = null;
      this.broadcast();
    }
  }

  private onPlayer(p: Player, data: unknown) {
    const msg = this.parse(data);
    if (!msg) return;
    const now = Date.now();
    if (msg.t === "answer") {
      const i = Number(msg.i);
      if (this.phase !== "question" || !this.cur || p.answer !== null || now < p.frozenUntil) return;
      if (!Number.isInteger(i) || i < 0 || i >= this.cur.options.length) return;
      p.answer = i;
      p.answeredAt = now - this.qStart;
      this.broadcast();
      const live = [...this.players.values()].filter((o) => o.ws);
      if (live.every((o) => o.answer !== null)) {
        this.clearTimer();
        this.timer = setTimeout(() => this.doReveal(), 800);
      }
    } else if (msg.t === "allin") {
      if (this.phase !== "question" || !this.settings.powerups || p.allInUsed || p.answer !== null) return;
      p.allInUsed = true;
      p.allInActive = true;
      this.event(`🎲 ${p.name} went ALL-IN`);
      this.broadcast();
    } else if (msg.t === "ice") {
      if (this.phase !== "question" || !this.settings.powerups || p.iceUsed) return;
      const target = this.ranked().find((o) => o.id !== p.id && o.ws && o.answer === null && o.frozenUntil < now);
      if (!target) return this.send(p.ws, { t: "event", text: "Nobody left to freeze 🤷" });
      p.iceUsed = true;
      target.frozenUntil = now + FREEZE_MS;
      target.frozenBy = p.name;
      this.event(`🧊 ${p.name} froze ${target.name}!`);
      this.broadcast();
    } else if (msg.t === "react") {
      const e = String(msg.e);
      if (!REACTIONS.includes(e) || now - p.lastReact < 250) return;
      p.lastReact = now;
      this.toHosts({ t: "react", e });
    }
  }

  private nextQuestion(): void {
    this.clearTimer();
    this.qi++;
    if (this.qi >= this.questions.length) {
      this.phase = "end";
      this.cur = null;
      return this.broadcast();
    }
    const q = this.questions[this.qi];
    this.asked.add(q.text);
    if (q.kind === "vote") {
      const names = [...this.players.values()].map((p) => `${p.emoji} ${p.name}`);
      if (names.length < 2) return this.nextQuestion();
      this.cur = { ...q, options: names };
    } else {
      this.cur = q;
    }
    const pool = (q.kind === "quiz" ? QUIZ_MODS : VOTE_MODS).filter((m) => this.settings.mods.includes(m));
    this.modPool = pool.length ? pool : ["vanilla"];
    this.modIndex = Math.floor(Math.random() * this.modPool.length);
    this.mod = this.modPool[this.modIndex];
    for (const p of this.players.values()) {
      Object.assign(p, { answer: null, answeredAt: 0, perm: null, allInActive: false, frozenUntil: 0 });
    }
    this.reveal = null;
    this.phase = "spin";
    this.broadcast();
    this.timer = setTimeout(() => this.startQuestion(), SPIN_MS);
  }

  private startQuestion() {
    this.phase = "question";
    this.qDuration = this.mod === "speed" ? speedMs(this.settings) : this.settings.seconds * 1000;
    this.qStart = Date.now();
    this.broadcast();
    this.timer = setTimeout(() => this.doReveal(), this.qDuration + 300);
  }

  private doReveal() {
    if (this.phase !== "question" || !this.cur) return;
    this.clearTimer();
    const q = this.cur;
    const everyone = [...this.players.values()];
    const ranked = this.ranked();
    const rankBefore = Object.fromEntries(ranked.map((p) => [p.id, this.rankOf(p)]));
    const leader = ranked[0];
    const counts = q.options.map(() => 0);
    for (const p of everyone) if (p.answer !== null) counts[p.answer]++;
    const mult = this.mod === "double" ? 2 : 1;
    const results: Record<string, Result> = {};
    let winners: number[] = [];
    let headline: string;

    if (q.kind === "quiz") {
      winners = [q.correct];
      const right = everyone.filter((p) => p.answer === q.correct).sort((a, b) => a.answeredAt - b.answeredAt);
      const fastest = right[0];
      for (const p of everyone) {
        const correct = p.answer === q.correct;
        p.streak = correct ? p.streak + 1 : 0;
        let delta = 0;
        const notes: string[] = [];
        if (correct) {
          if (this.mod === "jackpot") {
            delta = p === fastest ? 2000 : 0;
            notes.push(p === fastest ? "🎰 JACKPOT" : "too slow for the jackpot");
          } else {
            delta = Math.round(1000 * (1 - (0.5 * Math.min(p.answeredAt, this.qDuration)) / this.qDuration));
            if (p.streak >= 2) {
              delta += 100 * Math.min(p.streak - 1, 5);
              notes.push(`🔥 ${p.streak} streak`);
            }
          }
          delta *= mult;
        } else if (this.mod === "mines") {
          delta -= 300;
          notes.push("💣 boom");
        }
        if (p.allInActive) {
          if (correct) { delta *= 2; notes.push("🎲 all-in paid off"); }
          else { delta -= 500; notes.push("🎲 all-in busted"); }
        }
        results[p.id] = { delta, correct, note: notes.join(" · ") };
      }
      headline = right.length === 0
        ? "Nobody got it 💀"
        : `${right.length}/${everyone.length} got it · fastest: ${fastest.emoji} ${fastest.name}`;
      if (this.mod === "heist" && fastest && leader && leader !== fastest && leader.score > 0) {
        const loot = Math.round(leader.score * 0.2);
        results[leader.id].delta -= loot;
        results[leader.id].note = [results[leader.id].note, `🦹 robbed of ${loot}`].filter(Boolean).join(" · ");
        results[fastest.id].delta += loot;
        results[fastest.id].note = [results[fastest.id].note, `🦹 stole ${loot}`].filter(Boolean).join(" · ");
        headline = `🦹 ${fastest.name} stole ${loot} points from ${leader.name}!`;
      }
    } else {
      const picked = counts.map((c, i) => [c, i]).filter(([c]) => c > 0);
      if (picked.length) {
        const target = this.mod === "contrarian" ? Math.min(...picked.map(([c]) => c)) : Math.max(...picked.map(([c]) => c));
        winners = picked.filter(([c]) => c === target).map(([, i]) => i);
      }
      for (const p of everyone) {
        const won = p.answer !== null && winners.includes(p.answer);
        let delta = won ? 500 * mult : 0;
        let note = won ? "you read the room" : p.answer === null ? "didn't vote" : "outvoted";
        if (p.allInActive) {
          if (won) { delta *= 2; note += " · 🎲 all-in paid off"; }
          else { delta -= 500; note += " · 🎲 all-in busted"; }
        }
        results[p.id] = { delta, correct: null, note };
      }
      const names = winners.map((i) => q.options[i]).join(" & ");
      headline = !winners.length
        ? "Nobody voted. Cowards."
        : this.mod === "contrarian" ? `🙃 Minority wins: ${names}` : `The team has spoken: ${names}`;
    }

    for (const p of everyone) p.score += results[p.id].delta;
    const picks = Object.fromEntries(everyone.map((p) => [p.id, p.answer]));
    this.reveal = { counts, winners, headline, results, rankBefore, picks };
    this.phase = "reveal";
    this.broadcast();
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private ranked(): Player[] {
    return [...this.players.values()].sort((a, b) => b.score - a.score);
  }

  private rankOf(p: Player): number {
    let r = 1;
    for (const o of this.players.values()) if (o.score > p.score) r++;
    return r;
  }

  private modInfo(id: ModId) {
    return { id, ...MODS[id], ...(id === "speed" ? { desc: `${speedMs(this.settings) / 1000} seconds. Go.` } : {}) };
  }

  private common() {
    return {
      t: "state",
      code: this.code,
      phase: this.phase,
      qi: this.qi,
      total: this.questions.length,
      mode: this.mode,
      powerups: this.settings.powerups,
      mod: this.modInfo(this.mod),
      deadline: this.qStart + this.qDuration,
      duration: this.qDuration,
      wheel: this.modPool.map((id) => this.modInfo(id)),
      modIndex: this.modIndex,
      now: Date.now(),
    };
  }

  private hostView() {
    const q = this.cur;
    const gm = this.mode === "gm";
    return {
      ...this.common(),
      role: "host",
      players: this.ranked().map((p) => ({
        id: p.id, name: p.name, emoji: p.emoji, score: p.score, streak: p.streak,
        connected: !!p.ws, answered: p.answer !== null, allIn: p.allInActive, rank: this.rankOf(p),
      })),
      // Answers and the queue only go out in gm mode, where the host isn't playing.
      q: q ? { kind: q.kind, text: q.text, options: q.options, correct: gm ? q.correct : -1 } : null,
      settings: this.settings,
      allMods: (Object.keys(MODS) as ModId[]).map((id) => this.modInfo(id)),
      queue: gm ? this.questions.map((q, i) => ({ i, ...q })).slice(this.qi + 1) : [],
      reveal: this.phase === "reveal" ? this.reveal : null,
    };
  }

  private playerView(p: Player) {
    const q = this.cur;
    let options: { i: number; text: string }[] = [];
    if (q && (this.phase === "question" || this.phase === "reveal")) {
      if (!p.perm) p.perm = this.mod === "scramble" ? shuffle(q.options.map((_, i) => i)) : q.options.map((_, i) => i);
      options = p.perm.map((i) => ({ i, text: q.options[i] }));
    }
    const r = this.reveal;
    return {
      ...this.common(),
      role: "player",
      me: {
        id: p.id, name: p.name, emoji: p.emoji, score: p.score, streak: p.streak, rank: this.rankOf(p),
        answer: p.answer, allInUsed: p.allInUsed, allInActive: p.allInActive, iceUsed: p.iceUsed,
        frozenUntil: p.frozenUntil, frozenBy: p.frozenBy,
      },
      playerCount: this.players.size,
      q: q && options.length ? { kind: q.kind, text: q.text, options } : null,
      result: this.phase === "reveal" && r ? r.results[p.id] ?? null : null,
      winners: this.phase === "reveal" && r ? r.winners : [],
    };
  }

  private send(ws: WebSocket | null, msg: unknown) {
    if (!ws) return;
    try { ws.send(JSON.stringify(msg)); } catch {}
  }

  private toHosts(msg: unknown) {
    for (const h of this.hosts) this.send(h, msg);
  }

  private event(text: string) {
    this.toHosts({ t: "event", text });
    for (const p of this.players.values()) this.send(p.ws, { t: "event", text });
  }

  private broadcast() {
    const hv = this.hostView();
    for (const h of this.hosts) this.send(h, hv);
    for (const p of this.players.values()) this.send(p.ws, this.playerView(p));
  }
}
