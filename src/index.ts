import { DurableObject } from "cloudflare:workers";

interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
}

type Phase = "lobby" | "spin" | "question" | "reveal" | "end";
type ModId = "vanilla" | "double" | "speed" | "mines" | "heist" | "scramble" | "jackpot" | "contrarian" | "opposite" | "wobbly" | "upside" | "blurry" | "robin";
type PrankId = "ice" | "banana" | "fog" | "swap";
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
  prank: PrankId | null; // one prank card in hand, refilled every few questions
  frozenUntil: number;
  frozenBy: string;
  fogUntil: number;
  fogBy: string;
  banana: boolean; // buttons reshuffled this question
  swapPending: boolean;
  lastReact: number;
  titles: string[]; // won team votes
  stats: Stats;
}

// Collected over a game for the silly awards at the end.
interface Stats {
  allInLost: number;
  slowestRight: number;
  loneWolf: number;
  reacts: number;
  pranked: number;
  ghost: number;
}
const freshStats = (): Stats => ({ allInLost: 0, slowestRight: 0, loneWolf: 0, reacts: 0, pranked: 0, ghost: 0 });

interface Award {
  emoji: string;
  title: string;
  desc: string;
  id: string;
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
  roast: string;
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
  opposite: { label: "Opposite Day", emoji: "🔄", desc: "Wrong answers score. The right one costs you 300.", color: "#5b8cff" },
  wobbly: { label: "Wobbly", emoji: "🫨", desc: "The buttons have had a few drinks", color: "#ff9ff3" },
  upside: { label: "Upside Down", emoji: "🤸", desc: "Australian edition", color: "#7bed9f" },
  blurry: { label: "Blurry", emoji: "👓", desc: "Lost my glasses. It sharpens up. Eventually.", color: "#c8d6e5" },
  robin: { label: "Robin Hood", emoji: "🏹", desc: "After this one, first and last place SWAP scores", color: "#2ecc71" },
};
const QUIZ_MODS: ModId[] = ["vanilla", "double", "speed", "mines", "heist", "scramble", "jackpot", "opposite", "wobbly", "upside", "blurry", "robin"];
const VOTE_MODS: ModId[] = ["vanilla", "double", "speed", "contrarian", "wobbly", "upside", "robin"];
const PRANKS: PrankId[] = ["ice", "banana", "fog", "swap"];
const FOG_MS = 6000;
const isHostSeat = (p: Player) => p.id.startsWith("host-"); // the host's own seat answers on the big screen

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

// "Who is most likely to push to main?" becomes "most likely to push to main".
function voteTitle(text: string): string {
  return text.trim().replace(/\?+$/, "").replace(/^who(?:'s|\s+is|\s+will be)?\s+/i, "") || text;
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
  voteIds: string[] = []; // player ids behind the current vote's options
  robinUsed = false;

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
        allInUsed: false, allInActive: false, prank: pick(PRANKS), frozenUntil: 0, frozenBy: "",
        fogUntil: 0, fogBy: "", banana: false, swapPending: false, lastReact: 0, titles: [], stats: freshStats(),
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
      this.robinUsed = false;
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
        Object.assign(p, { score: 0, streak: 0, answer: null, allInUsed: false, allInActive: false, prank: pick(PRANKS), frozenUntil: 0, titles: [], stats: freshStats() });
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
    } else if (msg.t === "prank") {
      if (this.phase !== "question" || !this.settings.powerups || !p.prank) return;
      const open = [...this.players.values()].filter((o) => o.id !== p.id && o.ws && o.answer === null);
      if (p.prank === "swap") {
        if (p.swapPending) return;
        p.swapPending = true;
        p.prank = null;
        this.event(`🔄 ${p.name} is planning a swap 👀`);
        return this.broadcast();
      }
      const target =
        p.prank === "ice" ? this.ranked().find((o) => open.includes(o) && o.frozenUntil < now)
        : p.prank === "banana" ? pick(open.filter((o) => !o.banana && !isHostSeat(o)))
        : pick(open.filter((o) => o.fogUntil < now && !isHostSeat(o)));
      if (!target) return this.send(p.ws, { t: "event", text: "Nobody left to prank 🤷 Keep it for later" });
      target.stats.pranked++;
      if (p.prank === "ice") {
        target.frozenUntil = now + FREEZE_MS;
        target.frozenBy = p.name;
        this.event(`🧊 ${p.name} froze ${target.name}!`);
      } else if (p.prank === "banana") {
        target.banana = true;
        const perm = target.perm ?? this.cur!.options.map((_, i) => i);
        let next = shuffle(perm);
        while (perm.length > 1 && next.every((v, k) => v === perm[k])) next = shuffle(perm);
        target.perm = next;
        this.event(`🍌 ${p.name} banana'd ${target.name}'s buttons!`);
      } else {
        target.fogUntil = now + FOG_MS;
        target.fogBy = p.name;
        this.event(`🌫️ ${p.name} fogged up ${target.name}'s screen!`);
      }
      p.prank = null;
      this.broadcast();
    } else if (msg.t === "react") {
      const e = String(msg.e);
      if (!REACTIONS.includes(e) || now - p.lastReact < 250) return;
      p.lastReact = now;
      p.stats.reacts++;
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
      const ps = [...this.players.values()];
      if (ps.length < 2) return this.nextQuestion();
      this.voteIds = ps.map((p) => p.id);
      this.cur = { ...q, options: ps.map((p) => `${p.emoji} ${p.name}`) };
    } else {
      this.cur = q;
    }
    // Robin Hood is a once-a-game outrage, and only once there's something to steal.
    const robinOk = !this.robinUsed && this.players.size >= 3 && this.qi >= 3;
    const pool = (q.kind === "quiz" ? QUIZ_MODS : VOTE_MODS).filter((m) => this.settings.mods.includes(m) && (m !== "robin" || robinOk));
    this.modPool = pool.length ? pool : ["vanilla"];
    this.modIndex = Math.floor(Math.random() * this.modPool.length);
    this.mod = this.modPool[this.modIndex];
    if (this.mod === "robin") this.robinUsed = true;
    const refill = this.qi > 0 && this.qi % 5 === 0;
    if (refill && [...this.players.values()].some((p) => !p.prank)) this.event("🃏 Fresh prank cards for everyone who used theirs");
    for (const p of this.players.values()) {
      Object.assign(p, { answer: null, answeredAt: 0, perm: null, allInActive: false, frozenUntil: 0, fogUntil: 0, banana: false, swapPending: false });
      if (refill && !p.prank) p.prank = pick(PRANKS);
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
    const frozen = new Set(everyone.filter((p) => p.frozenUntil > this.qStart));

    // Swaps happen before anything is counted, so the stolen answer is the one that scores.
    const extra: Record<string, string[]> = Object.fromEntries(everyone.map((p) => [p.id, []]));
    for (const p of shuffle(everyone.filter((o) => o.swapPending))) {
      const partner = pick(everyone.filter((o) => o !== p && o.answer !== null));
      if (p.answer === null || !partner) { extra[p.id].push("🔄 swap fizzled"); continue; }
      [p.answer, partner.answer] = [partner.answer, p.answer];
      [p.answeredAt, partner.answeredAt] = [partner.answeredAt, p.answeredAt];
      extra[p.id].push(`🔄 swapped with ${partner.name}`);
      extra[partner.id].push(`🔄 ${p.name} swapped with you`);
    }

    const counts = q.options.map(() => 0);
    for (const p of everyone) if (p.answer !== null) counts[p.answer]++;
    for (const p of everyone) {
      if (p.answer === null) p.stats.ghost++;
      else if (counts[p.answer] === 1 && q.kind === "quiz" && p.answer !== q.correct) p.stats.loneWolf++;
    }
    const mult = this.mod === "double" ? 2 : 1;
    const results: Record<string, Result> = {};
    let winners: number[] = [];
    let headline: string;

    if (q.kind === "quiz") {
      winners = [q.correct];
      const opposite = this.mod === "opposite";
      const scores = (p: Player) => p.answer !== null && (opposite ? p.answer !== q.correct : p.answer === q.correct);
      const right = everyone.filter(scores).sort((a, b) => a.answeredAt - b.answeredAt);
      const fastest = right[0];
      for (const p of everyone) {
        const correct = p.answer === q.correct;
        const scored = scores(p);
        if (!opposite) p.streak = correct ? p.streak + 1 : 0;
        if (correct) p.stats.slowestRight = Math.max(p.stats.slowestRight, p.answeredAt);
        let delta = 0;
        const notes: string[] = [...extra[p.id]];
        if (scored) {
          if (this.mod === "jackpot") {
            delta = p === fastest ? 2000 : 0;
            notes.push(p === fastest ? "🎰 JACKPOT" : "too slow for the jackpot");
          } else {
            delta = Math.round(1000 * (1 - (0.5 * Math.min(p.answeredAt, this.qDuration)) / this.qDuration));
            if (opposite) notes.push("🔄 gloriously wrong");
            else if (p.streak >= 2) {
              delta += 100 * Math.min(p.streak - 1, 5);
              notes.push(`🔥 ${p.streak} streak`);
            }
          }
          delta *= mult;
        } else if (opposite && correct) {
          delta -= 300;
          notes.push("🔄 too smart for your own good");
        } else if (this.mod === "mines") {
          delta -= 300;
          notes.push("💣 boom");
        }
        if (p.allInActive) {
          if (scored) { delta *= 2; notes.push("🎲 all-in paid off"); }
          else { delta -= 500; p.stats.allInLost += 500; notes.push("🎲 all-in busted"); }
        }
        results[p.id] = { delta, correct: scored, note: notes.join(" · ") };
      }
      headline = opposite
        ? right.length ? `🔄 ${right.length}/${everyone.length} got it wonderfully wrong` : "🔄 Everyone got it right. On Opposite Day. Embarrassing."
        : right.length === 0
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
      const crowned = winners.map((i) => this.players.get(this.voteIds[i])).filter((p): p is Player => !!p);
      const title = voteTitle(q.text);
      for (const p of crowned) p.titles.push(title);
      for (const p of everyone) {
        const won = p.answer !== null && winners.includes(p.answer);
        let delta = won ? 500 * mult : 0;
        const notes = [...extra[p.id], won ? "you read the room" : p.answer === null ? "didn't vote" : "outvoted"];
        if (crowned.includes(p)) notes.push("👑 that's you");
        if (p.allInActive) {
          if (won) { delta *= 2; notes.push("🎲 all-in paid off"); }
          else { delta -= 500; p.stats.allInLost += 500; notes.push("🎲 all-in busted"); }
        }
        results[p.id] = { delta, correct: null, note: notes.join(" · ") };
      }
      headline = !winners.length
        ? "Nobody voted. Cowards."
        : `👑 ${title}${this.mod === "contrarian" ? " (by the slimmest minority)" : ""}`;
    }

    if (this.mod === "robin") {
      const after = everyone.map((p) => ({ p, score: p.score + results[p.id].delta })).sort((a, b) => b.score - a.score);
      const top = after[0], bottom = after[after.length - 1];
      if (after.length >= 2 && top.score !== bottom.score) {
        results[top.p.id].delta = bottom.score - top.p.score;
        results[bottom.p.id].delta = top.score - bottom.p.score;
        results[top.p.id].note = [results[top.p.id].note, `🏹 swapped scores with ${bottom.p.name}`].filter(Boolean).join(" · ");
        results[bottom.p.id].note = [results[bottom.p.id].note, `🏹 swapped scores with ${top.p.name}`].filter(Boolean).join(" · ");
        headline = `🏹 Robin Hood! ${top.p.name} and ${bottom.p.name} swap scores`;
      }
    }

    const roast = this.roastFor(q, counts, winners, results, frozen);
    for (const p of everyone) p.score += results[p.id].delta;
    const picks = Object.fromEntries(everyone.map((p) => [p.id, p.answer]));
    this.reveal = { counts, winners, headline, results, rankBefore, picks, roast };
    this.phase = "reveal";
    this.broadcast();
  }

  // One line of trash talk for the big screen, picked from whatever went wrong this round.
  private roastFor(q: Question, counts: number[], winners: number[], results: Record<string, Result>, frozen: Set<Player>): string {
    const everyone = [...this.players.values()];
    const answered = everyone.filter((p) => p.answer !== null);
    const lines: string[] = [];
    const busted = everyone.filter((p) => p.allInActive && results[p.id].delta < 0);
    if (busted.length) lines.push(`${pick(busted).name} went All-in and lost 500. Thoughts and prayers.`);
    const ghosts = everyone.filter((p) => p.answer === null && p.ws);
    if (ghosts.length === 1) lines.push(`${ghosts[0].name} didn't answer. Probably replying to a Slack thread.`);
    else if (ghosts.length > 1) lines.push(`${ghosts.length} people didn't answer. Mentally already on the weekend.`);
    if (q.kind === "quiz") {
      const opposite = this.mod === "opposite";
      const wrong = answered.filter((p) => p.answer !== q.correct);
      const right = answered.filter((p) => p.answer === q.correct);
      const popular = counts.map((c, i) => [c, i]).filter(([, i]) => i !== q.correct).sort((a, b) => b[0] - a[0])[0];
      if (opposite && right.length) lines.push(`${pick(right).name} got it right on Opposite Day. Couldn't help themselves.`);
      if (!opposite && popular && popular[0] >= 2 && popular[0] > counts[q.correct]) lines.push(`${popular[0]} of you went with "${q.options[popular[1]]}". Bold.`);
      const lone = wrong.filter((p) => counts[p.answer!] === 1);
      if (!opposite && lone.length === 1 && answered.length >= 3) lines.push(`${lone[0].name} was the only one who picked "${q.options[lone[0].answer!]}". Brave.`);
      if (!opposite && !right.length && answered.length >= 2) lines.push("Not one of you. Incredible work, team.");
      if (!opposite && answered.length >= 3 && right.length === everyone.length) lines.push("Everyone got it. Too easy, or you're all googling.");
      const quick = [...answered].sort((a, b) => a.answeredAt - b.answeredAt)[0];
      if (!opposite && quick && quick.answer !== q.correct && quick.answeredAt < 4000) lines.push(`${quick.name} answered in ${(quick.answeredAt / 1000).toFixed(1)}s and was wrong. Confidence is a choice.`);
      const iced = [...frozen].filter((p) => p.answer !== q.correct);
      if (iced.length) lines.push(`${pick(iced).name} got frozen and never recovered.`);
    } else {
      const self = answered.filter((p) => this.voteIds[p.answer!] === p.id);
      if (self.length) lines.push(`${pick(self).name} voted for themselves. Respect.`);
      if (winners.length === 1 && answered.length >= 3 && counts[winners[0]] === answered.length) {
        lines.push(`Unanimous. ${this.players.get(this.voteIds[winners[0]])?.name ?? "You"}, you know what you did.`);
      } else if (winners.length === 1 && counts[winners[0]] >= 2) {
        lines.push(`${counts[winners[0]]} votes for ${this.players.get(this.voteIds[winners[0]])?.name}. HR has been notified.`);
      }
      if (winners.length >= 3) lines.push(`A ${winners.length}-way tie. Nobody wants to commit, just like sprint planning.`);
    }
    return lines.length ? pick(lines) : "";
  }

  // The superlatives shown before the podium. Each needs a clear "winner", or it's skipped.
  private awards(): Award[] {
    const ps = [...this.players.values()];
    const out: Award[] = [];
    const most = (f: (p: Player) => number) => ps.filter((p) => f(p) > 0).sort((a, b) => f(b) - f(a))[0];
    const add = (p: Player | undefined, emoji: string, title: string, desc: (p: Player) => string) => p && out.push({ emoji, title, desc: desc(p), id: p.id });
    add(most((p) => p.stats.allInLost), "🎲", "Overconfident", (p) => `lost ${p.stats.allInLost} going All-in`);
    add(most((p) => p.stats.slowestRight), "🦥", "Sloth", (p) => `took ${(p.stats.slowestRight / 1000).toFixed(1)}s to get one right`);
    add(most((p) => p.stats.loneWolf), "🐺", "Lone Wolf", (p) => `the only one on a wrong answer ${p.stats.loneWolf}×`);
    add(most((p) => p.stats.reacts), "⌨️", "Keyboard Warrior", (p) => `sent ${p.stats.reacts} reactions`);
    add(most((p) => p.stats.pranked), "🎯", "Most Wanted", (p) => `pranked ${p.stats.pranked}×`);
    add(most((p) => p.stats.ghost), "👻", "Ghost", (p) => `didn't answer ${p.stats.ghost}×`);
    const ranked = this.ranked();
    if (ranked.length >= 3) add(ranked[ranked.length - 1], "🏅", "Participation Trophy", () => "came last, but showed up");
    for (const p of ps) for (const t of p.titles) out.push({ emoji: "👑", title: "By popular vote", desc: t, id: p.id });
    return out;
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
      awards: this.phase === "end" ? this.awards() : [],
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
        answer: p.answer, allInUsed: p.allInUsed, allInActive: p.allInActive, prank: p.prank, swapPending: p.swapPending,
        frozenUntil: p.frozenUntil, frozenBy: p.frozenBy, fogUntil: p.fogUntil, fogBy: p.fogBy, banana: p.banana,
      },
      awards: this.phase === "end" ? this.awards().filter((a) => a.id === p.id) : [],
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
