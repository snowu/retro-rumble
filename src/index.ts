import { DurableObject } from "cloudflare:workers";

interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
}

type Phase = "lobby" | "spin" | "question" | "reveal" | "end";
type ModId = "vanilla" | "double" | "speed" | "mines" | "heist" | "jackpot" | "contrarian" | "opposite" | "robin";
type PrankId = "ice" | "banana" | "fog" | "swap";
// play: the host is also a player and can't edit questions. gm: the host runs everything and doesn't answer.
type Mode = "play" | "gm";

interface Settings {
  seconds: number;
  mods: ModId[];
  powerups: boolean;
}

// draw/drawoff: text is the secret word ("" = pick one). closest: num is the answer.
// write: text is the prompt; it spawns "who" rounds whose text is one answer, with prompt and authorId set.
// drawoff spawns a "dvote" round where the room picks the better of the two drawings.
// perform: a volunteer hums and mimes a song or a movie's theme (text, "" = pick one), the rest guess like a draw round.
type Kind = "quiz" | "vote" | "draw" | "drawoff" | "dvote" | "closest" | "hottake" | "write" | "who" | "perform";
interface Question {
  kind: Kind;
  text: string;
  options: string[];
  correct: number;
  num?: number;
  prompt?: string;
  authorId?: string;
  artists?: string[];
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
  combo: { e: string; t: number }[]; // recent reactions, for the badger combo
  lastGuess: number;
  num: number; // closest guess
  pct: number; // hot take: predicted % of the team that agrees
  text: string; // who wrote it: their answer
  drawn: number; // times this player has been the artist
  performer: boolean; // opted in to hum and mime
  performed: number;
  titles: string[]; // won team votes
  stats: Stats;
  bot?: boolean; // a test player the server answers for
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
  draw: { word: string; drawerId: string; got: { id: string; t: number }[] } | null;
  info?: Record<string, unknown>; // per-kind extras for the reveal screen
}

interface Stroke {
  id: string;
  a: number; // which artist, for draw-offs
  c: string;
  w: number;
  pts: number[]; // x,y pairs on a 0-1000 square
}

interface Guess {
  emoji: string;
  name: string;
  text: string; // "" for a correct guess, so the feed never shows the word
}

const MODS: Record<ModId, { label: string; emoji: string; desc: string; color: string }> = {
  vanilla: { label: "Vanilla", emoji: "🍦", desc: "A perfectly normal question. Suspicious.", color: "#f5e6c8" },
  double: { label: "Double Trouble", emoji: "✌️", desc: "All points ×2", color: "#ff3d9a" },
  speed: { label: "Speed Demon", emoji: "⚡", desc: "Way less time. Go.", color: "#ffd23f" },
  mines: { label: "Minefield", emoji: "💣", desc: "Wrong or no answer: −300", color: "#ff4d4d" },
  heist: { label: "Heist", emoji: "🦹", desc: "Fastest correct answer steals 20% from the leader", color: "#8b5cf6" },
  jackpot: { label: "Jackpot", emoji: "🎰", desc: "Only the fastest correct answer scores: 2000", color: "#3ef08a" },
  contrarian: { label: "Contrarian", emoji: "🙃", desc: "The LEAST picked answer wins", color: "#ff8a3d" },
  opposite: { label: "Opposite Day", emoji: "🔄", desc: "Wrong answers score. The right one costs you 300.", color: "#5b8cff" },
  robin: { label: "Robin Hood", emoji: "🏹", desc: "After this one, first and last place SWAP scores", color: "#2ecc71" },
};
const QUIZ_MODS: ModId[] = ["vanilla", "double", "speed", "mines", "heist", "jackpot", "opposite", "robin"];
const VOTE_MODS: ModId[] = ["vanilla", "double", "speed", "contrarian", "robin"];
const MAX_INK = 30000; // numbers, roughly 15k points per drawing
const INK_COLORS = ["#111111", "#ffffff", "#e53935", "#1e88e5", "#43a047", "#fdd835", "#fb8c00", "#8e24aa", "#6d4c41"];
const WORDS = [
  "cat", "dog", "pizza", "rocket", "banana", "unicorn", "snowman", "volcano", "octopus", "robot", "ghost", "dragon", "castle", "rainbow",
  "guitar", "bicycle", "umbrella", "penguin", "giraffe", "spider", "cactus", "mermaid", "pirate", "tornado", "sandwich", "toilet",
  "laptop", "coffee", "keyboard", "printer", "deadline", "meeting", "bug", "cloud", "rubber duck", "sticky note", "coffee machine",
  "spaghetti", "hamburger", "ice cream", "popcorn", "birthday cake", "toothbrush", "lighthouse", "submarine", "helicopter", "skateboard",
  "snail", "shark", "crab", "flamingo", "sloth", "zombie", "vampire", "wizard", "alien", "ninja", "astronaut", "dinosaur", "chicken",
  "mustache", "glasses", "crown", "trophy", "fire", "lightning", "tree", "mushroom", "island", "pyramid", "moon", "sun", "eye", "nose",
  "hot dog", "taco", "donut", "lemon", "carrot", "egg", "clock", "bomb", "key", "magnet", "anchor", "ladder", "kite", "tent", "bridge",
];
// Perform it: well-known tunes you can hum and mime. Titles only, never lyrics.
// The third field finds the original recording's official preview clip on the iTunes Search API
// (looked up by the performer's own browser, so Apple's rate limit is per person, not per Worker).
// [answer, type, iTunes search, the tune to hum]. Movies are hummed by their theme; the answer is the movie title.
const PERFORM: [string, "song" | "movie", string, string?][] = [
  ["Bohemian Rhapsody", "song", "Queen"], ["Africa", "song", "Toto"], ["Never Gonna Give You Up", "song", "Rick Astley"],
  ["Billie Jean", "song", "Michael Jackson"], ["Sweet Child O' Mine", "song", "Guns N' Roses"], ["Smells Like Teen Spirit", "song", "Nirvana"],
  ["Wonderwall", "song", "Oasis"], ["Hey Jude", "song", "The Beatles"], ["Yellow Submarine", "song", "The Beatles"], ["Bad Romance", "song", "Lady Gaga"],
  ["Shape of You", "song", "Ed Sheeran"], ["Rolling in the Deep", "song", "Adele"], ["Single Ladies", "song", "Beyonce"], ["Happy", "song", "Pharrell Williams"],
  ["Uptown Funk", "song", "Mark Ronson Bruno Mars"], ["Despacito", "song", "Luis Fonsi"], ["Macarena", "song", "Los del Rio"], ["YMCA", "song", "Village People"],
  ["Dancing Queen", "song", "ABBA"], ["Take On Me", "song", "a-ha"], ["Livin' on a Prayer", "song", "Bon Jovi"], ["Don't Stop Believin'", "song", "Journey"],
  ["Eye of the Tiger", "song", "Survivor"], ["We Will Rock You", "song", "Queen"], ["I Will Survive", "song", "Gloria Gaynor"], ["Stayin' Alive", "song", "Bee Gees"],
  ["Thriller", "song", "Michael Jackson"], ["Toxic", "song", "Britney Spears"], ["...Baby One More Time", "song", "Britney Spears"], ["Wannabe", "song", "Spice Girls"],
  ["My Heart Will Go On", "song", "Celine Dion"], ["Gangnam Style", "song", "PSY"], ["Seven Nation Army", "song", "The White Stripes"],
  ["Mr. Brightside", "song", "The Killers"], ["Blinding Lights", "song", "The Weeknd"], ["Shake It Off", "song", "Taylor Swift"],
  ["Call Me Maybe", "song", "Carly Rae Jepsen"], ["Viva la Vida", "song", "Coldplay"], ["The Final Countdown", "song", "Europe"], ["Barbie Girl", "song", "Aqua"],
  ["Ice Ice Baby", "song", "Vanilla Ice"], ["Under Pressure", "song", "Queen David Bowie"], ["Sweet Caroline", "song", "Neil Diamond"],
  ["Let It Go", "song", "Idina Menzel"],
  ["Star Wars", "movie", "Star Wars Main Title John Williams", "Main Title, John Williams"], ["Jaws", "movie", "Jaws Main Title John Williams", "the shark theme (da-dum… da-dum), John Williams"],
  ["Mission: Impossible", "movie", "Mission Impossible Theme Lalo Schifrin", "Mission: Impossible Theme, Lalo Schifrin"], ["Jurassic Park", "movie", "Jurassic Park Theme John Williams", "Jurassic Park Theme, John Williams"],
  ["Harry Potter", "movie", "Hedwig's Theme John Williams", "Hedwig's Theme, John Williams"], ["The Pink Panther", "movie", "The Pink Panther Theme Henry Mancini", "The Pink Panther Theme, Henry Mancini"],
  ["Ghostbusters", "movie", "Ghostbusters Ray Parker Jr", "Ghostbusters, Ray Parker Jr."], ["Rocky", "movie", "Gonna Fly Now Bill Conti", "Gonna Fly Now, Bill Conti"], ["The Lion King", "movie", "Circle of Life Elton John", "Circle of Life, Elton John"],
  ["Indiana Jones", "movie", "Raiders March John Williams", "Raiders March, John Williams"], ["Pirates of the Caribbean", "movie", "He's a Pirate Klaus Badelt", "He's a Pirate, Klaus Badelt"],
  ["James Bond", "movie", "James Bond Theme Monty Norman", "James Bond Theme, Monty Norman"], ["Back to the Future", "movie", "Back to the Future Alan Silvestri", "Back to the Future Theme, Alan Silvestri"],
  ["The Godfather", "movie", "The Godfather Waltz Nino Rota", "The Godfather Waltz, Nino Rota"], ["Top Gun", "movie", "Danger Zone Kenny Loggins", "Danger Zone, Kenny Loggins"], ["Titanic", "movie", "My Heart Will Go On Celine Dion", "My Heart Will Go On, Celine Dion"],
  ["Grease", "movie", "You're the One That I Want John Travolta", "You're the One That I Want"], ["Dirty Dancing", "movie", "Time of My Life Bill Medley", "(I've Had) The Time of My Life"], ["E.T.", "movie", "E.T. Flying Theme John Williams", "Flying Theme, John Williams"],
];
// Lowercase, no accents, no punctuation, no leading article: "The Rubber-Duck!" -> "rubber duck".
const norm = (t: string) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim().replace(/^(a|an|the) /, "");
// A guess counts if it's the answer give or take a plural, spacing, a bracketed part, a trailing "theme",
// or contains every word of a multi-word answer ("star wars theme music" for "Star Wars").
function guessMatches(guess: string, answer: string): boolean {
  const g = norm(guess).replace(/ (theme|song|movie|film)$/, "");
  const alts = new Set([answer, answer.replace(/\(.*?\)/g, ""), ...(answer.match(/\((.*?)\)/g) ?? []).map((x) => x.slice(1, -1))].map(norm).filter(Boolean));
  for (const a of alts) {
    if (g === a || g === a + "s" || g + "s" === a || g.replace(/ /g, "") === a.replace(/ /g, "")) return true;
    const aw = a.split(" "), gw = g.split(" ");
    if (aw.length >= 2 && gw.length <= aw.length + 3 && aw.every((w) => gw.includes(w) || gw.includes(w + "s"))) return true;
  }
  return false;
}
function lev(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length];
}
const PRANKS: PrankId[] = ["ice", "banana", "fog", "swap"];
const CLOSEST_MODS: ModId[] = ["vanilla", "double", "speed"];
const PLAIN_MODS: ModId[] = ["vanilla", "double"];
const NO_SPIN: Kind[] = ["who", "dvote"]; // follow-ups go straight in
const WHEEL_KINDS: Kind[] = ["quiz", "vote"]; // the rest get an intro card: their few modifiers would make a coin-flip wheel
const GUESS_KINDS: Kind[] = ["draw", "perform"]; // one player performs, everyone else types guesses
const DURATION: Partial<Record<Kind, number>> = { perform: 60000, draw: 60000, drawoff: 60000, write: 45000, who: 20000, dvote: 20000 };

// Closest wins: only fixed, well-documented facts, nothing that drifts (populations, prices, records).
const CLOSEST: [string, number][] = [
  ["How many bones are in the adult human body?", 206],
  ["How many keys does a standard piano have?", 88],
  ["In what year did Apollo 11 land on the Moon?", 1969],
  ["How tall is Mount Everest, in metres?", 8849],
  ["How many member states does the United Nations have?", 193],
  ["In what year was Python first released?", 1991],
  ["In what year was Git first released?", 2005],
  ["In what year did the Berlin Wall fall?", 1989],
  ["How many minutes are there in a week?", 10080],
  ["How many Earth days does Mars take to orbit the Sun?", 687],
  ["How many elements are in the periodic table?", 118],
  ["How many squares of all sizes are there on a chessboard?", 204],
  ["How many dots are there in total on a standard six-sided die?", 21],
  ["What's the largest number a signed 32-bit integer can hold?", 2147483647],
  ["In what year did the Titanic sink?", 1912],
  ["How many time zones does Russia span?", 11],
  ["How many years did the Hundred Years' War last?", 116],
  ["On average, how far is the Moon from Earth, in kilometres?", 384400],
  ["What is the speed of light, in kilometres per second (rounded)?", 299792],
  ["In what year was the first email sent?", 1971],
  ["In what year did JavaScript first appear?", 1995],
  ["How many seconds are there in a day?", 86400],
  ["Unix time counts seconds since January 1st of which year?", 1970],
  ["How many teeth does an adult human have, wisdom teeth included?", 32],
  ["How many coloured stickers are on a standard Rubik's Cube?", 54],
  ["How long is a marathon, in metres?", 42195],
  ["How many characters could a tweet have when Twitter launched?", 140],
  ["At what temperature does water boil at sea level, in Fahrenheit?", 212],
];
const HOT_TAKES = [
  "Tabs are better than spaces", "Pineapple belongs on pizza", "Meetings without an agenda should be cancelled automatically",
  "Cameras should be on in every video call", "Dark mode is the only acceptable mode", "Deploying on a Friday is fine",
  "Working from home beats the office", "Most stand-ups could be a Slack message", "Story points are made up",
  "Replying \"ok.\" with a full stop is passive-aggressive", "A hot dog is a sandwich", "Cereal is a soup",
  "Mondays aren't that bad", "Emojis belong in work emails", "We should all have a four-day week",
  "Unread notification badges are fine to ignore forever", "Good code doesn't need comments", "Breakfast is the best meal of the day",
];
const WRITE_PROMPTS = [
  "The worst bug you ever shipped", "Your most-used emoji", "The first concert you went to", "A weird food combo you secretly love",
  "Your go-to karaoke song", "Your very first job", "The app you'd delete from everyone's phone", "Your guilty-pleasure TV show",
  "A skill nobody here knows you have", "Your most controversial coffee opinion", "The best thing that happened this sprint",
  "Your dream retirement, in one sentence", "What you wanted to be as a kid", "The weirdest job you've ever had",
  "Something you're irrationally scared of", "Your most useless talent", "The last thing you googled (be honest)",
  "A hill you will die on", "Your go-to excuse for being late", "The weirdest thing in your fridge right now",
  "Your celebrity lookalike, according to someone else", "A food you refuse to eat",
];
const FOG_MS = 6000;

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

// Bump together with BUILD in public/index.html: pages with an older BUILD ask to be refreshed.
const VERSION = "2026-10-31.1";
const SPIN_MS = 6500;
// Bots fill a room for testing: they count as connected, answer at random moments and never draw or perform.
const BOT_WS = { send() {}, close() {} } as unknown as WebSocket;
const BOT_NAMES = ["Beep", "Boop", "Clanker", "Sprocket", "Widget", "Gizmo", "Bolt", "Pixel", "Byte", "Chip", "Turing", "Ada", "Marvin", "Robbie", "Dot", "Servo", "Cog", "Rivet", "Zap", "Tinker"];
const BOT_LINES = ["Have you tried turning it off and on again", "Whatever the PM said", "Coffee. Lots of coffee.", "I plead the fifth", "Beep boop", "Deleting prod by accident", "A strongly worded Jira ticket", "Pineapple, obviously"];
const MAX_PLAYERS = 40;
const INTRO_MS = 5000;
const FREEZE_MS = 5000;
// Players can pick one (same list in public/index.html); otherwise they get a random free one.
const AVATARS = ["🦊", "🐸", "🐙", "🦄", "🐼", "🦖", "🐝", "🦉", "🐧", "🦀", "🐯", "🐨", "🦦", "🐳", "🦩", "🐲", "🦔", "🐌", "👾", "🤖", "💃", "💅", "🥲"];
const REACTIONS = ["🔥", "😂", "👏", "😱", "💀", "🎉", "🤡", "🧠", "🦀", "🦡", "🐍", "🍄"];

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
    const special = line.match(/^(draw|drawoff|perform|closest|hottake|write):\s*(.*)$/i);
    if (special) {
      if (cur && cur.options.length >= 2 && cur.correct >= 0) out.push(cur);
      cur = null;
      const kind = special[1].toLowerCase() as Kind, rest = special[2].trim();
      if (kind === "closest") {
        const m = rest.match(/^(.+?)\s*=\s*(-?[\d.,_ ]+)$/);
        const num = m ? Number(m[2].replace(/[,_ ]/g, "")) : NaN;
        if (m && Number.isFinite(num)) out.push({ kind, text: m[1].slice(0, 200), options: [], correct: -1, num });
      } else if (kind === "draw" || kind === "drawoff" || kind === "perform") {
        out.push({ kind, text: rest.slice(0, 40), options: [], correct: -1 });
      } else if (rest) {
        out.push({ kind, text: rest.slice(0, 200), options: [], correct: -1 });
      }
      continue;
    }
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

// Trivia recap: one Wikipedia sentence about each trivia question, shown on the end screen
// (there's no time to chat about them mid-game). Candidate articles come from quoted titles,
// proper nouns, the answer and the question's keywords; the intro sentence sharing the most
// words with the question and answer wins, and weak matches are dropped.
interface Fact { qi: number; q: string; a: string; title: string; text: string }
const FACT_STOP = new Set(("a an the of in on at to for from by with and or is are was were wasn isn be been what which who whom whose when where why how " +
  "does did do this that these those it its as than then there their they his her he she you your known called name named first most many much " +
  "following not true false originally made type example year years").split(" "));
const factWords = (s: string) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1 && !FACT_STOP.has(w));
const stem5 = (w: string) => w.slice(0, 5);
async function wikiApi(params: Record<string, string>): Promise<any> {
  const url = new URL("https://en.wikipedia.org/w/api.php");
  for (const [k, v] of Object.entries({ format: "json", formatversion: "2", ...params })) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { headers: { "User-Agent": "retro-rumble (https://github.com/snowu/retro-rumble)" } }).catch(() => null);
  return res?.ok ? res.json().catch(() => null) : null;
}
async function wikiSearch(q: string, n: number): Promise<string[]> {
  if (!q.trim()) return [];
  const d = await wikiApi({ action: "query", list: "search", srlimit: String(n), srsearch: q });
  return (d?.query?.search ?? []).map((x: { title: string }) => x.title);
}
async function wikiFact(q: string, a: string, yesNo: boolean): Promise<{ title: string; text: string } | null> {
  const kw = [...new Set(factWords(q))], aw = yesNo ? [] : factWords(a);
  const quoted = [...q.matchAll(/["“]([^"”]{3,60})["”]/g)].slice(0, 2).map((m) => m[1]);
  const proper = [...q.matchAll(/(?<!^)(?<![.?!] )\b([A-Z][\w'!-]*(?: (?:of |and |the |a )?[A-Z][\w'!-]*)*)/g)].slice(0, 2).map((m) => m[1]);
  const found = await Promise.all([
    ...quoted.map((x) => wikiSearch(x, 1)),
    ...proper.map((x) => wikiSearch(x, 1)),
    aw.length && !/^\d/.test(a) ? wikiSearch(a, 2) : [],
    wikiSearch(kw.join(" "), 2),
    aw.length ? wikiSearch([...kw, ...aw].join(" "), 2) : [],
  ]);
  const titles = [...new Set(found.flat())].slice(0, 8);
  if (!titles.length) return null;
  const d = await wikiApi({ action: "query", prop: "extracts", exintro: "1", explaintext: "1", redirects: "1", titles: titles.join("|") });
  const K = new Set(kw.map(stem5)), A = new Set(aw.map(stem5));
  let best: { score: number; title: string; text: string } | null = null;
  for (const page of d?.query?.pages ?? []) {
    const ex: string = page.extract ?? "";
    if (ex.includes("may refer to")) continue; // disambiguation page
    for (const sentence of ex.split(/(?<=[a-z0-9)]{2}[.!?])\s+(?=[A-Z])/)) {
      if (sentence.length < 40 || sentence.length > 300 || sentence.includes("\n")) continue;
      const ws = new Set(factWords(sentence).map(stem5));
      const k = [...ws].filter((w) => K.has(w)).length, an = [...ws].filter((w) => A.has(w)).length;
      if (k < 2 && !(k && an)) continue;
      const score = k + 2 * an;
      if (!best || score > best.score) best = { score, title: page.title, text: sentence };
    }
  }
  return best && { title: best.title, text: best.text };
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
    if (q.kind === "draw" || q.kind === "drawoff" || q.kind === "perform") return true;
    if (seen.some((t) => similar(t, q.text))) return false;
    seen.push(q.text);
    return true;
  });
}

// Play along alternates strictly: a trivia question, then a silly round, and so on.
// Closest wins counts as trivia. Leftover trivia is kept as spares to keep "who wrote it" rounds alternating too.
function playSet(builtin: Question[], trivia: Question[], asked: Set<string>): { list: Question[]; spares: Question[] } {
  const fresh = <T>(xs: T[], text: (x: T) => string, n: number) => {
    const unseen = xs.filter((x) => !asked.has(text(x)));
    return shuffle(unseen.length >= n ? unseen : xs).slice(0, n);
  };
  const classics = fresh(builtin.filter((q) => q.kind === "quiz"), (q) => q.text, 14);
  const extra = dedupe(trivia, [...asked, ...classics.map((q) => q.text)]);
  const pool = extra.length >= 5 ? [...shuffle(extra), ...classics] : classics;
  const blank = (kind: Kind, text = ""): Question => ({ kind, text, options: [], correct: -1 });
  const closest = fresh(CLOSEST, ([t]) => t, 1).map(([text, num]) => ({ ...blank("closest", text), num }));
  const triviaLane = shuffle([...pool.slice(0, 7), ...closest]); // one closest-wins per game is plenty
  const sillyLane = shuffle([
    ...fresh(builtin.filter((q) => q.kind === "vote"), (q) => q.text, 2),
    ...fresh(HOT_TAKES, (t) => t, 2).map((t) => blank("hottake", t)),
    blank("perform"),
    blank("write", fresh(WRITE_PROMPTS, (t) => t, 1)[0]),
    blank("draw"),
    blank("drawoff"),
  ]);
  return { list: triviaLane.flatMap((q, i) => (sillyLane[i] ? [q, sillyLane[i]] : [q])), spares: pool.slice(7, 10) };
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
  drawerId = "";
  artists: string[] = []; // the two players in a draw-off
  spares: Question[] = []; // play along: trivia kept back to slot between "who wrote it" rounds
  strokes: Stroke[] = [];
  cleared: { a: number; strokes: Stroke[] }[] = []; // wiped canvases, so a clear can be undone
  inkSize = 0;
  game = 0; // bumped every start, so a late Wikipedia answer can't land in the next game
  facts: Fact[] = [];
  feed: Guess[] = [];
  hintOrder: number[] = [];
  hintLevel = 0;
  secretType = ""; // perform: "song" or "movie"
  secretTune = ""; // perform: what the star hums, shown only to them
  secretSearch = ""; // perform: iTunes search term for the preview clip
  passes = 0;
  lastCombo = 0;
  hintTimers: ReturnType<typeof setTimeout>[] = [];
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
      this.sendInk(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    const id = (url.searchParams.get("pid") ?? "").slice(0, 64);
    const name = (url.searchParams.get("name") ?? "").trim().slice(0, 16);
    const chosen = AVATARS.includes(url.searchParams.get("emoji") ?? "") ? url.searchParams.get("emoji")! : "";
    if (!id || !name) {
      server.close(4000, "missing name");
      return new Response(null, { status: 101, webSocket: client });
    }
    let p = this.players.get(id);
    if (p) {
      try { p.ws?.close(4001, "replaced"); } catch {}
      p.ws = server;
      p.name = name;
      if (chosen) p.emoji = chosen;
    } else {
      const used = new Set([...this.players.values()].map((o) => o.emoji));
      p = {
        id, name, ws: server,
        emoji: chosen || pick(AVATARS.filter((a) => !used.has(a)).concat(used.size >= AVATARS.length ? AVATARS : [])),
        score: 0, streak: 0, answer: null, answeredAt: 0, perm: null,
        allInUsed: false, allInActive: false, prank: pick(PRANKS), frozenUntil: 0, frozenBy: "",
        fogUntil: 0, fogBy: "", banana: false, swapPending: false, lastReact: 0, combo: [], lastGuess: 0, num: 0, pct: 50, text: "", drawn: 0, performer: false, performed: 0, titles: [], stats: freshStats(),
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
    this.sendInk(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private addBot() {
    const used = new Set([...this.players.values()].map((o) => o.name));
    const free = BOT_NAMES.filter((n) => !used.has(`🤖 ${n}`));
    const name = `🤖 ${free.length ? pick(free) : `Bot ${this.players.size + 1}`}`;
    const usedAv = new Set([...this.players.values()].map((o) => o.emoji));
    const id = "bot-" + crypto.randomUUID().slice(0, 8);
    this.players.set(id, {
      id, name, ws: BOT_WS, bot: true,
      emoji: pick(AVATARS.filter((a) => !usedAv.has(a)).concat(usedAv.size >= AVATARS.length ? AVATARS : [])),
      score: 0, streak: 0, answer: null, answeredAt: 0, perm: null,
      allInUsed: false, allInActive: false, prank: pick(PRANKS), frozenUntil: 0, frozenBy: "",
      fogUntil: 0, fogBy: "", banana: false, swapPending: false, lastReact: 0, combo: [], lastGuess: 0, num: 0, pct: 50, text: "", drawn: 0, performer: false, performed: 0, titles: [], stats: freshStats(),
    });
  }

  // Each bot answers once, at a random point in the question, through the same checks as a real player.
  private botMoves() {
    const q = this.cur!, qi = this.qi;
    for (const b of this.players.values()) {
      if (!b.bot || this.bench().has(b.id)) continue;
      const guessing = GUESS_KINDS.includes(q.kind);
      const delay = this.qDuration * (guessing ? 0.2 + Math.random() * 0.7 : 0.1 + Math.random() * 0.6);
      setTimeout(() => {
        if (this.qi !== qi || this.phase !== "question" || !this.players.has(b.id) || b.answer !== null) return;
        const n = q.options.length, rnd = Math.floor(Math.random() * n);
        const msg =
          q.kind === "closest" ? { t: "num", v: String(Math.round((q.num ?? 100) * (0.4 + Math.random() * 1.2))) }
          : q.kind === "hottake" ? { t: "take", agree: Math.random() < 0.6, pct: 5 * Math.floor(Math.random() * 21) }
          : q.kind === "write" ? { t: "write", text: pick(BOT_LINES) }
          : guessing ? { t: "guess", text: Math.random() < 0.4 ? q.text : pick(WORDS) }
          : q.kind === "quiz" && Math.random() < 0.5 ? { t: "answer", i: q.correct }
          : { t: "answer", i: q.kind === "who" && this.voteIds[rnd] === b.id ? (rnd + 1) % n : rnd };
        this.onPlayer(b, JSON.stringify(msg));
      }, delay);
    }
  }

  private drawing() {
    return (this.phase === "question" || this.phase === "reveal") && ["draw", "drawoff", "dvote"].includes(this.cur?.kind ?? "");
  }

  // Who sits this round out: the artist, the author, the draw-off pair, or the host's seat when writing.
  private bench(): Set<string> {
    const q = this.cur;
    if (!q) return new Set();
    if (GUESS_KINDS.includes(q.kind)) return new Set([this.drawerId]);
    if (q.kind === "who") return new Set([q.authorId ?? ""]);
    if (q.kind === "drawoff" || q.kind === "dvote") return new Set(this.artists);
    return new Set();
  }

  // Everyone who can still answer has: reveal a moment later.
  private checkAllIn(delay = 800) {
    const bench = this.bench();
    const live = [...this.players.values()].filter((o) => o.ws && !bench.has(o.id));
    if (live.length && live.every((o) => o.answer !== null)) {
      this.clearTimer();
      this.timer = setTimeout(() => this.doReveal(), delay);
    }
  }

  private sendInk(ws: WebSocket) {
    if (this.drawing()) this.send(ws, { t: "inkAll", qi: this.qi, strokes: this.strokes });
  }

  // Strokes go to every screen but the artist's own.
  private toAllBut(id: string, msg: unknown) {
    this.toHosts(msg);
    for (const p of this.players.values()) if (p.id !== id) this.send(p.ws, msg);
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
        ({ list: this.questions, spares: this.spares } = playSet(qs, trivia, this.asked));
      } else {
        this.questions = qs;
        this.spares = [];
      }
      this.qi = -1;
      this.robinUsed = false;
      this.game++;
      this.facts = [];
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
    } else if (msg.t === "addBots") {
      const n = Math.max(1, Math.min(10, Number(msg.n) || 1));
      for (let k = 0; k < n && this.players.size < MAX_PLAYERS; k++) this.addBot();
      this.broadcast();
    } else if (msg.t === "removeBots") {
      for (const p of [...this.players.values()]) if (p.bot) this.players.delete(p.id);
      this.broadcast();
    } else if (msg.t === "again" && this.phase === "end") {
      for (const p of this.players.values()) {
        Object.assign(p, { score: 0, streak: 0, answer: null, allInUsed: false, allInActive: false, prank: pick(PRANKS), frozenUntil: 0, drawn: 0, performed: 0, titles: [], stats: freshStats() });
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
    const canAnswer = this.phase === "question" && !!this.cur && p.answer === null && now >= p.frozenUntil && !this.bench().has(p.id);
    const kind = this.cur?.kind;
    if (msg.t === "answer") {
      const i = Number(msg.i);
      if (!canAnswer || !Number.isInteger(i) || i < 0 || i >= this.cur!.options.length) return;
      if (kind === "who" && this.voteIds[i] === p.id) return; // you know you didn't write it
      p.answer = i;
      p.answeredAt = now - this.qStart;
      this.broadcast();
      this.checkAllIn();
    } else if (msg.t === "num") {
      const v = Number(String(msg.v ?? "").replace(/[,_ ]/g, ""));
      if (!canAnswer || kind !== "closest" || !Number.isFinite(v) || Math.abs(v) > 1e13) return;
      Object.assign(p, { answer: 0, num: v, answeredAt: now - this.qStart });
      this.broadcast();
      this.checkAllIn();
    } else if (msg.t === "take") {
      const pct = Math.round(Number(msg.pct));
      if (!canAnswer || kind !== "hottake" || !(pct >= 0 && pct <= 100)) return;
      Object.assign(p, { answer: msg.agree ? 0 : 1, pct, answeredAt: now - this.qStart });
      this.broadcast();
      this.checkAllIn();
    } else if (msg.t === "write") {
      const text = String(msg.text ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      if (!canAnswer || kind !== "write" || !text) return;
      Object.assign(p, { answer: 0, text, answeredAt: now - this.qStart });
      this.broadcast();
      this.checkAllIn(400);
    } else if (msg.t === "ink") {
      const k = kind === "draw" ? (p.id === this.drawerId ? 0 : -1) : kind === "drawoff" ? this.artists.indexOf(p.id) : -1;
      if (this.phase !== "question" || k < 0 || now < p.frozenUntil) return;
      const id = String(msg.id ?? "").slice(0, 40);
      const raw = Array.isArray(msg.pts) ? msg.pts.slice(0, 400) : [];
      const pts = raw.map((v) => Math.max(0, Math.min(1000, Math.round(Number(v) || 0))));
      if (!id || pts.length < 2 || this.inkSize + pts.length > MAX_INK) return;
      this.inkSize += pts.length;
      let st = this.strokes.find((x) => x.id === id);
      if (!st) {
        st = { id, a: k, c: INK_COLORS.includes(String(msg.c)) ? String(msg.c) : INK_COLORS[0], w: Math.max(4, Math.min(80, Number(msg.w) || 10)), pts: [] };
        this.strokes.push(st);
      }
      st.pts.push(...pts);
      this.toAllBut(p.id, { t: "ink", id, a: k, c: st.c, w: st.w, pts });
    } else if (msg.t === "inkClear") {
      const k = kind === "draw" ? (p.id === this.drawerId ? 0 : -1) : kind === "drawoff" ? this.artists.indexOf(p.id) : -1;
      if (this.phase !== "question" || k < 0) return;
      this.cleared.push({ a: k, strokes: this.strokes.filter((x) => x.a === k) });
      this.strokes = this.strokes.filter((x) => x.a !== k);
      this.toAllBut(p.id, { t: "inkClear", a: k });
    } else if (msg.t === "inkRestore") {
      // Undo of a clear: the artist's latest wiped canvas comes back.
      const k = kind === "draw" ? (p.id === this.drawerId ? 0 : -1) : kind === "drawoff" ? this.artists.indexOf(p.id) : -1;
      let i = this.cleared.length - 1;
      while (i >= 0 && this.cleared[i].a !== k) i--;
      if (this.phase !== "question" || k < 0 || i < 0) return;
      const [{ strokes }] = this.cleared.splice(i, 1);
      this.strokes.push(...strokes);
      this.toAllBut(p.id, { t: "inkRestore", strokes });
    } else if (msg.t === "inkUndo") {
      // Only your own strokes: in a draw-off each artist undoes on their own canvas.
      const k = kind === "draw" ? (p.id === this.drawerId ? 0 : -1) : kind === "drawoff" ? this.artists.indexOf(p.id) : -1;
      const id = String(msg.id ?? "");
      if (this.phase !== "question" || k < 0 || !this.strokes.some((x) => x.id === id && x.a === k)) return;
      this.strokes = this.strokes.filter((x) => x.id !== id);
      this.toAllBut(p.id, { t: "inkUndo", id });
    } else if (msg.t === "avatar") {
      if (!AVATARS.includes(String(msg.e))) return;
      p.emoji = String(msg.e);
      this.broadcast();
    } else if (msg.t === "performer") {
      p.performer = !!msg.on;
      this.broadcast();
    } else if (msg.t === "pass") {
      // The performer doesn't know it, or doesn't want to: hand it to another volunteer, or draw a new one.
      if (this.phase !== "question" || kind !== "perform" || p.id !== this.drawerId || this.passes >= 2) return;
      if ([...this.players.values()].some((o) => o.answer !== null)) return this.send(p.ws, { t: "event", own: true, text: "Someone already got it, keep going!" });
      this.passes++;
      const next = this.volunteers().find((o) => o.id !== p.id);
      if (next) { p.performed--; next.performed++; this.drawerId = next.id; }
      this.pickSecret(this.cur!, [this.cur!.text]);
      this.feed = [];
      this.event(next ? `🙈 ${p.name} passed to ${next.name}` : `🙈 ${p.name} asked for a different one`);
      this.clearTimer();
      this.startQuestion();
    } else if (msg.t === "guess") {
      const q = this.cur;
      if (this.phase !== "question" || !q || !GUESS_KINDS.includes(q.kind) || p.id === this.drawerId || p.answer !== null || now < p.frozenUntil) return;
      if (now - p.lastGuess < 500) return;
      p.lastGuess = now;
      const text = String(msg.text ?? "").trim().slice(0, 40);
      const g = norm(text), word = norm(q.text);
      if (!g) return;
      if (guessMatches(text, q.text)) {
        p.answer = 0;
        p.answeredAt = now - this.qStart;
        this.feed.push({ emoji: p.emoji, name: p.name, text: "" });
        this.event(`✅ ${p.name} got it!`);
        this.broadcast();
        this.checkAllIn(1200);
      } else if (word.length >= 4 && lev(g, word) <= Math.max(1, Math.floor(word.length / 8))) {
        this.send(p.ws, { t: "event", own: true, text: `🔥 "${text}" is SO close` });
      } else {
        this.feed.push({ emoji: p.emoji, name: p.name, text });
        if (this.feed.length > 60) this.feed.shift();
        this.broadcast();
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
        if (kind !== "quiz" && kind !== "vote") return this.send(p.ws, { t: "event", own: true, text: "Nothing to swap this round. Keep it for later" });
        if (p.swapPending) return;
        p.swapPending = true;
        p.prank = null;
        this.event(`🔄 ${p.name} is planning a swap 👀`);
        return this.broadcast();
      }
      if (p.prank === "banana" && !this.cur?.options.length) return this.send(p.ws, { t: "event", own: true, text: "No buttons to banana this round. Keep it for later" });
      const target =
        p.prank === "ice" ? this.ranked().find((o) => open.includes(o) && o.frozenUntil < now)
        : p.prank === "banana" ? pick(open.filter((o) => !o.banana))
        : pick(open.filter((o) => o.fogUntil < now));
      if (!target) return this.send(p.ws, { t: "event", own: true, text: "Nobody left to prank 🤷 Keep it for later" });
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
      this.toAllBut("", { t: "react", e }); // every screen, so remote players see each other's reactions too
      // Badger badger badger… mushroom mushroom… snake! Sent in that order within a few seconds plays the meme everywhere.
      p.combo = [...p.combo.filter((c) => now - c.t < 6000), { e, t: now }].slice(-6);
      const seq = p.combo.map((c) => c.e).join("");
      if (e === "🐍" && /🦡+🍄+🐍$/u.test(seq) && now - this.lastCombo > 8000) {
        this.lastCombo = now;
        p.combo = [];
        this.toAllBut("", { t: "combo", name: p.name, emoji: p.emoji });
      }
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
    } else if (q.kind === "draw") {
      // The artist is whoever has drawn least; the host's own seat would show the word on the big screen.
      const artists = shuffle([...this.players.values()].filter((p) => p.ws)).sort((a, b) => Number(!!a.bot) - Number(!!b.bot) || a.drawn - b.drawn);
      if (!artists.length || [...this.players.values()].filter((p) => p.ws).length < 2) return this.nextQuestion();
      const drawer = artists[0];
      drawer.drawn++;
      this.drawerId = drawer.id;
      const fresh = WORDS.filter((w) => !this.asked.has(w));
      const word = q.text || pick(fresh.length ? fresh : WORDS);
      this.asked.add(word);
      this.cur = { ...q, text: word };
      this.strokes = [];
      this.cleared = [];
      this.inkSize = 0;
      this.feed = [];
      this.hintLevel = 0;
      this.hintOrder = shuffle([...word].map((ch, i) => (ch === " " ? -1 : i)).filter((i) => i >= 0));
    } else if (q.kind === "perform") {
      const star = this.volunteers()[0];
      if (!star || [...this.players.values()].filter((p) => p.ws).length < 2) return this.nextQuestion();
      star.performed++;
      this.drawerId = star.id;
      this.passes = 0;
      this.feed = [];
      this.pickSecret(q, []);
    } else if (q.kind === "drawoff") {
      const pair = shuffle([...this.players.values()].filter((p) => p.ws)).sort((a, b) => Number(!!a.bot) - Number(!!b.bot) || a.drawn - b.drawn).slice(0, 2);
      if (pair.length < 2 || [...this.players.values()].filter((p) => p.ws).length < 3) return this.nextQuestion();
      for (const p of pair) p.drawn++;
      this.artists = pair.map((p) => p.id);
      const unseen = WORDS.filter((w) => !this.asked.has(w));
      const word = q.text || pick(unseen.length ? unseen : WORDS);
      this.asked.add(word);
      this.cur = { ...q, text: word, artists: this.artists };
      this.strokes = [];
      this.cleared = [];
      this.inkSize = 0;
    } else if (q.kind === "dvote") {
      const pair = this.artists.map((id) => this.players.get(id));
      if (pair.some((p) => !p)) return this.nextQuestion();
      this.voteIds = [...this.artists];
      this.cur = { ...q, options: pair.map((p) => `${p!.emoji} ${p!.name}`) };
    } else if (q.kind === "who") {
      const ps = [...this.players.values()];
      if (!this.players.get(q.authorId ?? "")) return this.nextQuestion();
      this.voteIds = ps.map((p) => p.id);
      this.cur = { ...q, options: ps.map((p) => `${p.emoji} ${p.name}`), correct: this.voteIds.indexOf(q.authorId!) };
    } else if (q.kind === "write" && [...this.players.values()].filter((p) => p.ws).length < 3) {
      return this.nextQuestion(); // who wrote it needs a few writers to be a guess
    } else {
      this.cur = q;
      if (q.kind === "quiz" && q.options[q.correct]) this.lookUpFact(q);
    }
    // Robin Hood is a once-a-game outrage, and only once there's something to steal.
    const robinOk = !this.robinUsed && this.players.size >= 3 && this.qi >= 3;
    const pools: Partial<Record<Kind, ModId[]>> = { quiz: QUIZ_MODS, vote: VOTE_MODS, draw: PLAIN_MODS, closest: CLOSEST_MODS, hottake: PLAIN_MODS, drawoff: PLAIN_MODS };
    const pool = (pools[q.kind] ?? ["vanilla"]).filter((m) => this.settings.mods.includes(m) && (m !== "robin" || robinOk));
    this.modPool = pool.length ? pool : ["vanilla"];
    this.modIndex = Math.floor(Math.random() * this.modPool.length);
    if (!WHEEL_KINDS.includes(q.kind) && Math.random() < 0.6) this.modIndex = Math.max(0, this.modPool.indexOf("vanilla")); // mostly plain
    this.mod = this.modPool[this.modIndex];
    if (this.mod === "robin") this.robinUsed = true;
    const refill = this.qi > 0 && this.qi % 5 === 0;
    if (refill && [...this.players.values()].some((p) => !p.prank)) this.event("🃏 Fresh prank cards for everyone who used theirs");
    for (const p of this.players.values()) {
      Object.assign(p, { answer: null, answeredAt: 0, perm: null, allInActive: false, frozenUntil: 0, fogUntil: 0, banana: false, swapPending: false, num: 0, pct: 50 });
      if (refill && !p.prank) p.prank = pick(PRANKS);
    }
    this.reveal = null;
    if (NO_SPIN.includes(q.kind)) {
      this.modPool = ["vanilla"];
      this.modIndex = 0;
      this.mod = "vanilla";
      return this.startQuestion();
    }
    this.phase = "spin";
    this.broadcast();
    this.timer = setTimeout(() => this.startQuestion(), this.wheelOn() ? SPIN_MS : INTRO_MS);
  }

  private startQuestion() {
    this.phase = "question";
    const draw = GUESS_KINDS.includes(this.cur!.kind);
    this.qDuration = DURATION[this.cur!.kind] ?? (this.mod === "speed" ? speedMs(this.settings) : this.settings.seconds * 1000);
    this.qStart = Date.now();
    this.broadcast();
    this.botMoves();
    // The vote round after a draw-off shows both drawings again on every screen.
    if (this.cur?.kind === "dvote") this.toAllBut("", { t: "inkAll", qi: this.qi, strokes: this.strokes });
    this.timer = setTimeout(() => this.doReveal(), this.qDuration + 300);
    // Draw rounds give away a letter at half time and another at three quarters.
    if (draw && this.hintOrder.length >= 3) {
      for (const k of [0.5, 0.75]) this.hintTimers.push(setTimeout(() => { this.hintLevel++; this.broadcast(); }, this.qDuration * k));
    }
  }

  // Opted-in performers, whoever has gone least first. The host's seat reads its secret in a separate window.
  private volunteers(): Player[] {
    return shuffle([...this.players.values()].filter((p) => p.ws && p.performer)).sort((a, b) => a.performed - b.performed);
  }

  private pickSecret(q: Question, not: string[]) {
    const unseen = PERFORM.filter(([t]) => !this.asked.has(t) && !not.includes(t));
    const [title, type, search, tune] = q.text && !not.includes(q.text) ? [q.text, "song or movie", q.text] : pick(unseen.length ? unseen : PERFORM);
    this.asked.add(title);
    this.secretType = type;
    this.secretTune = type === "movie" ? `🎵 ${tune ?? "its main theme"}` : type === "song" ? `by ${search}` : "";
    this.secretSearch = type === "song" ? `${title} ${search}` : search;
    this.cur = { ...q, text: title };
    this.hintLevel = 0;
    this.hintOrder = shuffle([...title].map((ch, i) => (/[a-z0-9]/i.test(ch) ? i : -1)).filter((i) => i >= 0));
  }

  // A wheel needs a few real choices; with fewer it's an intro card instead.
  private wheelOn(): boolean {
    return !!this.cur && WHEEL_KINDS.includes(this.cur.kind) && this.modPool.length >= 4;
  }

  private hint(): string {
    const word = this.cur?.text ?? "";
    const step = Math.max(1, Math.round(this.hintOrder.length / 6));
    const shown = new Set(this.hintOrder.slice(0, this.hintLevel * step));
    return [...word].map((ch, i) => (!/[a-z0-9]/i.test(ch) ? ch : shown.has(i) ? ch : "_")).join("");
  }

  private doReveal() {
    if (this.phase !== "question" || !this.cur) return;
    this.clearTimer();
    const q = this.cur;
    if (GUESS_KINDS.includes(q.kind)) return this.revealDraw(q);
    if (q.kind === "drawoff") return this.toDrawVote(q);
    if (q.kind === "write") return this.toWhoRounds(q);
    if (q.kind === "closest") return this.revealClosest(q);
    if (q.kind === "hottake") return this.revealTake(q);
    if (q.kind === "who" || q.kind === "dvote") return this.revealPick(q);
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
    this.reveal = { counts, winners, headline, results, rankBefore, picks, roast, draw: null };
    this.phase = "reveal";
    this.broadcast();
  }

  // Shared ending for the newer round types: apply the deltas and show the reveal.
  private finish(results: Record<string, Result>, rankBefore: Record<string, number>, headline: string, roast: string, info: Record<string, unknown>) {
    const everyone = [...this.players.values()];
    for (const p of everyone) p.score += results[p.id]?.delta ?? 0;
    this.reveal = {
      counts: [], winners: [], results, rankBefore, headline, roast, draw: null, info,
      picks: Object.fromEntries(everyone.map((p) => [p.id, p.answer])),
    };
    this.phase = "reveal";
    this.broadcast();
  }

  private rankSnapshot() {
    return Object.fromEntries([...this.players.values()].map((p) => [p.id, this.rankOf(p)]));
  }

  // All-in on the newer rounds: doubles a win, costs 500 otherwise.
  private allIn(p: Player, won: boolean, r: Result) {
    if (!p.allInActive) return;
    if (won) { r.delta *= 2; r.note += " · 🎲 all-in paid off"; }
    else { r.delta -= 500; p.stats.allInLost += 500; r.note += " · 🎲 all-in busted"; }
  }

  private revealClosest(q: Question) {
    const rankBefore = this.rankSnapshot();
    const answer = q.num ?? 0;
    const mult = this.mod === "double" ? 2 : 1;
    const everyone = [...this.players.values()];
    const guessed = everyone.filter((p) => p.answer !== null).sort((a, b) => Math.abs(a.num - answer) - Math.abs(b.num - answer));
    const results: Record<string, Result> = {};
    const PRIZES = [1000, 600, 300];
    const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 3 });
    for (const p of everyone) {
      if (p.answer === null) { p.stats.ghost++; results[p.id] = { delta: 0, correct: null, note: "no guess" }; continue; }
      const diff = Math.abs(p.num - answer);
      const place = guessed.findIndex((o) => Math.abs(o.num - answer) === diff); // ties share a place
      let delta = (PRIZES[place] ?? 0) + (diff === 0 ? 500 : 0);
      delta *= mult;
      const r: Result = { delta, correct: place === 0, note: diff === 0 ? "🎯 bullseye" : `guessed ${fmt(p.num)}, off by ${fmt(diff)}` };
      this.allIn(p, place === 0, r);
      results[p.id] = r;
    }
    const best = guessed[0], worst = guessed[guessed.length - 1];
    const lines: string[] = [];
    if (best && best.num === answer) lines.push(`${best.name} nailed it exactly. Suspicious.`);
    if (worst && guessed.length >= 2 && worst !== best) lines.push(`${worst.name} guessed ${fmt(worst.num)}. Off by ${fmt(Math.abs(worst.num - answer))}.`);
    if (!guessed.length) lines.push("Nobody even guessed. It's a number, not a commitment.");
    this.finish(results, rankBefore,
      best ? `📏 The answer: ${fmt(answer)} · closest: ${best.emoji} ${best.name}` : `📏 The answer: ${fmt(answer)}`,
      lines.length ? pick(lines) : "",
      { answer, guesses: guessed.map((p) => ({ id: p.id, v: p.num, diff: Math.abs(p.num - answer) })) });
  }

  private revealTake(q: Question) {
    const rankBefore = this.rankSnapshot();
    const mult = this.mod === "double" ? 2 : 1;
    const everyone = [...this.players.values()];
    const voted = everyone.filter((p) => p.answer !== null);
    const agree = voted.filter((p) => p.answer === 0), disagree = voted.filter((p) => p.answer === 1);
    const pct = voted.length ? Math.round((100 * agree.length) / voted.length) : 0;
    const results: Record<string, Result> = {};
    for (const p of everyone) {
      if (p.answer === null) { p.stats.ghost++; results[p.id] = { delta: 0, correct: null, note: "sat this one out" }; continue; }
      const off = Math.abs(p.pct - pct);
      const r: Result = { delta: Math.max(0, Math.round(1000 - 25 * off)) * mult, correct: off <= 10, note: `guessed ${p.pct}%, it was ${pct}%: ${off ? `off by ${off}` : "spot on"}${off <= 5 ? " · 🔮 mind reader" : ""}` };
      this.allIn(p, off <= 10, r);
      results[p.id] = r;
    }
    const lines: string[] = [];
    if (voted.length >= 3 && agree.length === 1) lines.push(`${agree[0].name} is the only one who agrees. Brave.`);
    if (voted.length >= 3 && disagree.length === 1) lines.push(`${disagree[0].name} is the only one who disagrees. Brave.`);
    if (voted.length >= 2 && (!agree.length || !disagree.length)) lines.push("Unanimous. Not much of a hot take, then.");
    if (voted.length >= 2 && agree.length === disagree.length) lines.push("A perfect split. Enjoy the next retro.");
    const best = voted.sort((a, b) => Math.abs(a.pct - pct) - Math.abs(b.pct - pct))[0];
    if (best && Math.abs(best.pct - pct) <= 5) lines.push(`${best.name} called it at ${best.pct}%. Knows you all too well.`);
    this.finish(results, rankBefore, `🔥 ${pct}% of the team agree`, lines.length ? pick(lines) : "",
      { pct, agree: agree.map((p) => p.id), disagree: disagree.map((p) => p.id) });
  }

  // Writing time is over: up to three answers become "who wrote this?" rounds, straight after.
  private toWhoRounds(q: Question) {
    const entries = shuffle([...this.players.values()].filter((p) => p.answer !== null && p.text));
    if (entries.length < 2) {
      this.event("✍️ Not enough answers for Who wrote it. Moving on");
      return this.nextQuestion();
    }
    const rounds = entries.slice(0, 3).map((p): Question => ({ kind: "who", text: p.text, prompt: q.text, authorId: p.id, options: [], correct: -1 }));
    // In play along a spare trivia question goes before each one, so trivia and silly rounds keep taking turns.
    const seq = rounds.flatMap((r) => { const spare = this.spares.shift(); return spare ? [spare, r] : [r]; });
    this.questions.splice(this.qi + 1, 0, ...seq);
    this.event(`✍️ ${entries.length} answers are in. Who wrote what?`);
    this.nextQuestion();
  }

  private toDrawVote(q: Question) {
    this.questions.splice(this.qi + 1, 0, { kind: "dvote", text: q.text, options: [], correct: -1, artists: this.artists });
    this.nextQuestion();
  }

  // "Who wrote it" and the draw-off vote: pick a player, the bench (author or artists) scores from the picks.
  private revealPick(q: Question) {
    const rankBefore = this.rankSnapshot();
    const everyone = [...this.players.values()];
    const bench = this.bench();
    const counts = q.options.map(() => 0);
    for (const p of everyone) if (p.answer !== null) counts[p.answer]++;
    const voters = everyone.filter((p) => !bench.has(p.id));
    const results: Record<string, Result> = {};
    let winners: number[], headline: string;
    const lines: string[] = [];
    const nameOf = (i: number) => this.players.get(this.voteIds[i])?.name ?? "?";
    if (q.kind === "who") {
      winners = [q.correct];
      const author = this.players.get(q.authorId!)!;
      const right = voters.filter((p) => p.answer === q.correct), fooled = voters.filter((p) => p.answer !== null && p.answer !== q.correct);
      for (const p of voters) {
        const ok = p.answer === q.correct;
        if (p.answer === null) p.stats.ghost++;
        const r: Result = { delta: ok ? Math.round(1000 * (1 - (0.5 * Math.min(p.answeredAt, this.qDuration)) / this.qDuration)) : 0, correct: ok, note: ok ? "✍️ saw right through it" : p.answer === null ? "no guess" : "✍️ fooled" };
        this.allIn(p, ok, r);
        results[p.id] = r;
      }
      const ra: Result = { delta: 200 * fooled.length, correct: null, note: fooled.length ? `✍️ you fooled ${fooled.length}` : "✍️ everyone knew it was you" };
      this.allIn(author, fooled.length > 0, ra);
      results[author.id] = ra;
      headline = `✍️ Written by ${author.emoji} ${author.name} · ${right.length}/${voters.length} guessed it`;
      if (voters.length >= 2 && !right.length) lines.push(`Nobody suspected ${author.name}. Undercover legend.`);
      if (voters.length >= 2 && right.length === voters.length) lines.push(`Everyone knew it was ${author.name}. Very on brand.`);
      const top = counts.map((c, i) => [c, i]).filter(([, i]) => i !== q.correct).sort((a, b) => b[0] - a[0])[0];
      if (top && top[0] >= 2) lines.push(`${top[0]} of you thought it was ${nameOf(top[1])}. ${nameOf(top[1])}, are you OK with that?`);
    } else {
      const most = Math.max(0, ...counts);
      winners = most ? counts.map((c, i) => [c, i]).filter(([c]) => c === most).map(([, i]) => i) : [];
      for (const p of voters) {
        if (p.answer === null) p.stats.ghost++;
        const won = p.answer !== null && winners.includes(p.answer);
        const r: Result = { delta: won ? 300 : 0, correct: null, note: won ? "🖌️ backed the winner" : p.answer === null ? "didn't vote" : "🖌️ backed the loser" };
        this.allIn(p, won, r);
        results[p.id] = r;
      }
      this.artists.forEach((id, i) => {
        const a = this.players.get(id);
        if (!a) return;
        const r: Result = { delta: 400 * counts[i], correct: null, note: `🖌️ ${counts[i]} vote${counts[i] === 1 ? "" : "s"}${winners.includes(i) ? " · 🏆 winner" : ""}` };
        this.allIn(a, winners.includes(i), r);
        results[id] = r;
      });
      headline = !winners.length ? "Nobody voted. Art is dead." : winners.length > 1 ? "🖌️ It's a tie" : `🏆 ${nameOf(winners[0])} wins the draw-off`;
      if (winners.length > 1) lines.push("A tie. Everyone's a winner, nobody's happy.");
      else if (winners.length === 1) {
        const loser = 1 - winners[0];
        lines.push(counts[loser] ? `${nameOf(loser)} got ${counts[loser]} vote${counts[loser] === 1 ? "" : "s"}. Art is subjective.` : `${nameOf(loser)} got zero votes. Brutal.`);
      }
    }
    for (const p of everyone) p.score += results[p.id]?.delta ?? 0;
    this.reveal = {
      counts, winners, headline, results, rankBefore, roast: lines.length ? pick(lines) : "", draw: null,
      picks: Object.fromEntries(everyone.map((p) => [p.id, p.answer])),
    };
    this.phase = "reveal";
    this.broadcast();
  }

  private revealDraw(q: Question) {
    const everyone = [...this.players.values()];
    const rankBefore = Object.fromEntries(everyone.map((p) => [p.id, this.rankOf(p)]));
    const drawer = this.players.get(this.drawerId);
    const mult = this.mod === "double" ? 2 : 1;
    const got = everyone.filter((p) => p.id !== this.drawerId && p.answer !== null).sort((a, b) => a.answeredAt - b.answeredAt);
    const guessers = everyone.filter((p) => p.id !== this.drawerId);
    const results: Record<string, Result> = {};
    for (const p of everyone) {
      const artist = p.id === this.drawerId;
      const ok = artist ? got.length > 0 : p.answer !== null;
      let delta = artist
        ? 300 * got.length * mult
        : ok ? Math.round(1000 * (1 - (0.5 * Math.min(p.answeredAt, this.qDuration)) / this.qDuration)) * mult : 0;
      const icon = q.kind === "perform" ? "🎤" : "🎨", work = q.kind === "perform" ? "performance" : "drawing";
      const notes = [artist ? (got.length ? `${icon} ${got.length} got your ${work}` : `${icon} nobody got your ${work}`) : ok ? `${icon} got it in ${(p.answeredAt / 1000).toFixed(1)}s` : `${icon} no luck`];
      if (ok && !artist) p.stats.slowestRight = Math.max(p.stats.slowestRight, p.answeredAt);
      if (p.allInActive) {
        if (ok) { delta *= 2; notes.push("🎲 all-in paid off"); }
        else { delta -= 500; p.stats.allInLost += 500; notes.push("🎲 all-in busted"); }
      }
      results[p.id] = { delta, correct: artist ? null : ok, note: notes.join(" · ") };
    }
    const name = drawer?.name ?? "The artist";
    const lines: string[] = [];
    const wrong = this.feed.filter((g) => g.text);
    if (wrong.length) lines.push(...[0, 1].map(() => { const g = pick(wrong); return `Best wrong guess: "${g.text}" (${g.name})`; }));
    if (q.kind === "perform") {
      if (!got.length) lines.push(`Nobody got it. ${name}, that was apparently "${q.text}".`);
      if (guessers.length >= 2 && got.length === guessers.length) lines.push(`Everyone got it. ${name}, the world tour starts Monday.`);
      if (got[0] && got[0].answeredAt < 8000) lines.push(`${got[0].name} got it in ${(got[0].answeredAt / 1000).toFixed(1)}s. Suspiciously fast.`);
    } else {
      if (!got.length) lines.push(`Nobody got it. ${name} is an abstract artist now.`);
      if (guessers.length >= 2 && got.length === guessers.length) lines.push(`Everyone got it. ${name}, quit your day job.`);
      if (!this.strokes.length) lines.push(`${name} didn't draw a single line. Minimalism.`);
    }
    const roast = lines.length ? pick(lines) : "";
    for (const p of everyone) p.score += results[p.id].delta;
    this.reveal = {
      counts: [], winners: [], results, rankBefore, roast,
      headline: `${q.kind === "perform" ? "🎤" : "🎨"} It was "${q.text}" · ${got.length}/${guessers.length} got it`,
      picks: Object.fromEntries(everyone.map((p) => [p.id, p.answer])),
      draw: { word: q.text, drawerId: this.drawerId, got: got.map((p) => ({ id: p.id, t: p.answeredAt })) },
    };
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
    for (const t of this.hintTimers) clearTimeout(t);
    this.hintTimers = [];
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

  // Runs in the background while the question plays; the end screen lists whatever came back.
  private lookUpFact(q: Question): void {
    const game = this.game, qi = this.qi, a = q.options[q.correct];
    const yesNo = q.options.length === 2 && q.options.every((o) => /^(true|false)$/i.test(o));
    wikiFact(q.text, a, yesNo).then((f) => {
      if (!f || game !== this.game) return;
      this.facts.push({ qi, q: q.text, a, ...f });
      // A slow lookup can land after its reveal has started, or after the podium.
      if (this.phase === "end" || (this.phase === "reveal" && this.qi === qi)) this.broadcast();
    }).catch(() => {});
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
      kind: this.cur?.kind ?? null,
      wheel: this.modPool.map((id) => this.modInfo(id)),
      modIndex: this.modIndex,
      now: Date.now(),
      wheelOn: this.wheelOn(),
      facts: this.phase === "end" ? [...this.facts].sort((x, y) => x.qi - y.qi) : [],
      fact: this.phase === "reveal" ? this.facts.find((f) => f.qi === this.qi) ?? null : null,
      ver: VERSION,
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
        connected: !!p.ws, answered: p.answer !== null, allIn: p.allInActive, rank: this.rankOf(p), performer: p.performer, bot: !!p.bot,
      })),
      // Answers and the queue only go out in gm mode, where the host isn't playing.
      q: q ? { kind: q.kind, text: GUESS_KINDS.includes(q.kind) && !gm && this.phase !== "reveal" ? "" : q.text, prompt: q.prompt ?? "", options: q.options, correct: gm ? q.correct : -1 } : null,
      artists: this.artistsView(),
      bench: [...this.bench()],
      draw: this.drawView(),
      feed: GUESS_KINDS.includes(this.cur?.kind ?? "quiz") ? this.feed.slice(-14) : [],
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
      if (!p.perm) p.perm = q.options.map((_, i) => i);
      options = p.perm.map((i) => ({ i, text: q.options[i] }));
    }
    const r = this.reveal;
    return {
      ...this.common(),
      role: "player",
      me: {
        id: p.id, name: p.name, emoji: p.emoji, score: p.score, streak: p.streak, rank: this.rankOf(p),
        answer: p.answer, allInUsed: p.allInUsed, performer: p.performer, allInActive: p.allInActive, prank: p.prank, swapPending: p.swapPending,
        frozenUntil: p.frozenUntil, frozenBy: p.frozenBy, fogUntil: p.fogUntil, fogBy: p.fogBy, banana: p.banana,
      },
      awards: this.phase === "end" ? this.awards() : [],
      playerCount: this.players.size,
      q: q && (options.length || (q.kind !== "quiz" && q.kind !== "vote" && this.phase !== "spin"))
        ? { kind: q.kind, text: GUESS_KINDS.includes(q.kind) && p.id !== this.drawerId && p.answer === null && this.phase !== "reveal" ? "" : q.text, prompt: q.prompt ?? "", options }
        : null,
      artists: this.artistsView(),
      benched: this.bench().has(p.id),
      // Who has locked in this question, as a row of avatars that light up.
      lineup: this.phase === "question" ? [...this.players.values()].filter((o) => o.ws && !this.bench().has(o.id)).map((o) => ({ emoji: o.emoji, name: o.name, done: o.answer !== null })) : [],
      mine: { num: p.num, pct: p.pct, text: p.text },
      info: this.phase === "reveal" ? r?.info ?? null : null,
      draw: this.drawView(),
      feed: GUESS_KINDS.includes(this.cur?.kind ?? "quiz") ? this.feed.slice(-6) : [],
      preview: this.cur?.kind === "perform" && p.id === this.drawerId ? this.secretSearch : "",
      tune: this.cur?.kind === "perform" && p.id === this.drawerId ? this.secretTune : "",
      result: this.phase === "reveal" && r ? r.results[p.id] ?? null : null,
      winners: this.phase === "reveal" && r ? r.winners : [],
      // Everyone's picks and the standings, so phones show who answered what too.
      picks: this.phase === "reveal" && r ? r.picks : {},
      gotIt: this.phase === "reveal" && r?.draw ? r.draw.got : [],
      roster: this.phase === "reveal" || this.phase === "end" ? this.ranked().map((o) => ({ id: o.id, name: o.name, emoji: o.emoji, score: o.score, rank: this.rankOf(o), delta: r?.results[o.id]?.delta ?? 0, was: this.phase === "reveal" ? r?.rankBefore[o.id] ?? 0 : 0 })) : [],
      headline: this.phase === "reveal" && r ? r.headline : "",
    };
  }

  private artistsView() {
    const k = this.cur?.kind;
    if (k !== "drawoff" && k !== "dvote") return [];
    return this.artists.map((id) => this.players.get(id)).filter((p): p is Player => !!p).map((p) => ({ id: p.id, name: p.name, emoji: p.emoji }));
  }

  private drawView() {
    if (!GUESS_KINDS.includes(this.cur?.kind ?? "quiz")) return null;
    const d = this.players.get(this.drawerId);
    return {
      drawerId: this.drawerId, drawerName: d?.name ?? "", drawerEmoji: d?.emoji ?? "🎨", hint: this.hint(),
      secretType: this.secretType, passesLeft: 2 - this.passes,
      got: [...this.players.values()].filter((p) => p.id !== this.drawerId && p.answer !== null).map((p) => p.id),
    };
  }

  private send(ws: WebSocket | null, msg: unknown) {
    if (!ws || ws === BOT_WS) return;
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
    for (const p of this.players.values()) if (!p.bot) this.send(p.ws, this.playerView(p));
  }
}
