// Push-optimal Sokoban solver: room decomposition + push A* per room.
//
// A level is a 1-wide hallway with 1-4 rooms off it; a box pushed out of a
// room can never come back, so each room is solved on its own (push-optimal)
// and the room solutions are stitched with hallway walks. Inside a room the
// search is A* over pushes: a state is the sorted box squares plus the
// player's reachable region (named by its lowest square). The heuristic is
// the min-cost assignment of boxes to goals over precomputed floor
// distances (each push moves one box one square, so it is admissible),
// which keeps the search push-optimal. Dead states are pruned with
// live squares (pull-back from the goals) and frozen 2x2 blocks.
// Budgets are counts of expansions, never the clock, so two runs agree.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const LOW = ['u', 'd', 'l', 'r'];
const UP = ['U', 'D', 'L', 'R'];

// Work budgets (expansions). The generator keeps a room only when its own
// push search solves it within 250k states, so 250k per room is ample.
const ROOM_EXPANSIONS = 250_000;
const GLOBAL_EXPANSIONS = 250_000;
const RUN_EXPANSIONS = 2_000_000;
let spent = 0;

type Level = { w: number; h: number; wall: Uint8Array; goals: number[]; boxes: number[]; player: number };

function parse(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

// Squares a box can stand on and still be pushed onto some goal: pull the
// box back from the goals. A box at y can be pushed to x when the player
// can stand at y-d (one step past the box, opposite the push).
function liveSquares(wall: Uint8Array, goals: number[], w: number): Uint8Array {
  const live = new Uint8Array(wall.length);
  const q = [...goals];
  for (const g of goals) live[g] = 1;
  for (let i = 0; i < q.length; i++) {
    const x = q[i];
    for (let k = 0; k < 4; k++) {
      const d = DY[k] * w + DX[k];
      const y = x - d;
      if (y < 0 || y >= wall.length || live[y] || wall[y] || wall[y - d]) continue;
      live[y] = 1;
      q.push(y);
    }
  }
  return live;
}

// Flood fill from `from` avoiding walls and boxes (occupied=1). Marks the
// reached cells in `seen` with `stamp`, returns the lowest reached cell.
function reach(wall: Uint8Array, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array, w: number): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k] * w + DX[k];
      if (!wall[q] && !occupied[q] && seen[q] !== stamp) { seen[q] = stamp; stack[n++] = q; }
    }
  }
  return low;
}

// True when the box just pushed to t is stuck in a 2x2 block of walls and
// boxes holding a box off its goal.
function frozen(wall: Uint8Array, occupied: Uint8Array, isGoal: Uint8Array, t: number, w: number): boolean {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1, c = a + w, d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !isGoal[a]) || (occupied[b] && !isGoal[b]) || (occupied[c] && !isGoal[c]) || (occupied[d] && !isGoal[d])) return true;
  }
  return false;
}

// Shortest walk from `from` to `to` avoiding walls and boxes; directions
// tried u, d, l, r so ties break the same way every run.
function walkTo(wall: Uint8Array, occupied: Uint8Array, from: number, to: number, w: number): string {
  if (from === to) return '';
  const n = wall.length;
  const prev = new Int32Array(n).fill(-1);
  const how = new Array<string>(n);
  const q = [from];
  prev[from] = from;
  for (let i = 0; i < q.length; i++) {
    const p = q[i];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const r = p + DY[k] * w + DX[k];
      if (wall[r] || occupied[r] || prev[r] !== -1) continue;
      prev[r] = p; how[r] = LOW[k]; q.push(r);
    }
  }
  if (prev[to] === -1) return '';
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) {
    const c = ch.toLowerCase();
    p += c === 'u' ? -w : c === 'd' ? w : c === 'l' ? -1 : 1;
  }
  return p;
}

function popcount(x: number): number {
  let c = 0;
  while (x) { x &= x - 1; c++; }
  return c;
}

// Push-optimal A* over one (sub-)level. Returns {pushes, moves} or null
// when the expansion budget runs out or the level is unsolvable.
function pushSearch(wall: Uint8Array, goals: number[], boxes0: number[], player0: number, w: number, h: number, maxExp: number): { pushes: number; moves: string } | null {
  const size = w * h;
  const n = boxes0.length;
  if (n === 0) return { pushes: 0, moves: '' };
  // State keys encode boxes in base `size`; exact only up to 5 boxes.
  if (n > 5) return null;
  const isGoal = new Uint8Array(size);
  for (const g of goals) isGoal[g] = 1;
  const live = liveSquares(wall, goals, w);
  for (const b of boxes0) if (!live[b]) return null;
  const solved = (bs: number[]): boolean => bs.every((b) => isGoal[b]);
  if (solved(boxes0)) return { pushes: 0, moves: '' };

  // Floor distance from every cell to each goal (boxes ignored).
  const BIG = 1e6;
  const dist: Int32Array[] = goals.map((g) => {
    const d = new Int32Array(size).fill(-1);
    const q = [g];
    d[g] = 0;
    for (let i = 0; i < q.length; i++) {
      const p = q[i];
      for (let k = 0; k < 4; k++) {
        const r = p + DY[k] * w + DX[k];
        if (!wall[r] && d[r] === -1) { d[r] = d[p] + 1; q.push(r); }
      }
    }
    return d;
  });
  // Min-cost assignment of boxes to goals (subset DP over goal masks),
  // cached per box set. Each push moves one box one square, so the sum of
  // per-box floor distances under the best assignment never overestimates.
  const hCache = new Map<number, number>();
  const heuristic = (bs: number[]): number => {
    let k = 0;
    for (const b of bs) k = k * size + b;
    const hit = hCache.get(k);
    if (hit !== undefined) return hit;
    const m = goals.length;
    const dp = new Float64Array(1 << m).fill(BIG);
    dp[0] = 0;
    for (let mask = 0; mask < (1 << m); mask++) {
      const bi = popcount(mask);
      if (bi >= n || dp[mask] >= BIG) continue;
      for (let j = 0; j < m; j++) {
        if (mask & (1 << j)) continue;
        const dd = dist[j][bs[bi]];
        const c = dd < 0 ? BIG : dd;
        const nm = mask | (1 << j);
        if (dp[mask] + c < dp[nm]) dp[nm] = dp[mask] + c;
      }
    }
    const v = dp[(1 << m) - 1];
    hCache.set(k, v);
    return v;
  };
  // State key: lowest reachable square, then the sorted box squares, as
  // digits in base `size` (exact below 2^53 for rooms of up to 5 boxes).
  const keyOf = (bs: number[], low: number): number => {
    let k = low;
    for (const b of bs) k = k * size + b;
    return k;
  };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  const sBoxes: number[][] = [boxes0.slice()];
  const sPlayer: number[] = [player0];
  const sG: number[] = [0];
  const sKey: number[] = [];
  const parent: number[] = [-1];
  const pushDir: number[] = [-1];
  const pushBox: number[] = [-1];
  const best = new Map<number, number>();
  for (const b of boxes0) occupied[b] = 1;
  const low0 = reach(wall, occupied, player0, seen, ++stamp, stack, w);
  for (const b of boxes0) occupied[b] = 0;
  sKey.push(keyOf(boxes0, low0));
  best.set(sKey[0], 0);

  // Binary heap ordered by (f asc, g desc, insertion asc).
  const hf: number[] = [];
  const hg: number[] = [];
  const hs: number[] = [];
  const hseq: number[] = [];
  let seq = 0;
  const swap = (i: number, j: number): void => {
    [hf[i], hf[j]] = [hf[j], hf[i]]; [hg[i], hg[j]] = [hg[j], hg[i]];
    [hs[i], hs[j]] = [hs[j], hs[i]]; [hseq[i], hseq[j]] = [hseq[j], hseq[i]];
  };
  const less = (i: number, j: number): boolean =>
    hf[i] < hf[j] || (hf[i] === hf[j] && (hg[i] > hg[j] || (hg[i] === hg[j] && hseq[i] < hseq[j])));
  const hpush = (f: number, g: number, s: number): void => {
    let i = hf.length;
    hf.push(f); hg.push(g); hs.push(s); hseq.push(seq++);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(i, p)) break;
      swap(i, p); i = p;
    }
  };
  const hpop = (): number => {
    const top = hs[0];
    const li = hf.length - 1;
    hf[0] = hf[li]; hg[0] = hg[li]; hs[0] = hs[li]; hseq[0] = hseq[li];
    hf.pop(); hg.pop(); hs.pop(); hseq.pop();
    for (let i = 0; ; ) {
      let c = 2 * i + 1;
      if (c >= hf.length) break;
      if (c + 1 < hf.length && less(c + 1, c)) c++;
      if (!less(c, i)) break;
      swap(i, c); i = c;
    }
    return top;
  };

  hpush(heuristic(boxes0), 0, 0);
  let expanded = 0;
  let found = -1;
  while (hf.length > 0) {
    const s = hpop();
    const g = sG[s];
    if (g !== best.get(sKey[s])) continue; // stale heap entry
    const boxes = sBoxes[s];
    if (solved(boxes)) { found = s; break; }
    if (expanded >= maxExp || spent >= RUN_EXPANSIONS) return null;
    expanded++;
    spent++;
    for (const b of boxes) occupied[b] = 1;
    reach(wall, occupied, sPlayer[s], seen, ++stamp, stack, w);
    const here = stamp;
    for (let bi = 0; bi < n; bi++) {
      const b = boxes[bi];
      for (let k = 0; k < 4; k++) {
        const d = DY[k] * w + DX[k];
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0; occupied[t] = 1;
        const fr = frozen(wall, occupied, isGoal, t, w);
        let key = -1;
        let next: number[] | null = null;
        if (!fr) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, c) => a - c);
          const low = reach(wall, occupied, b, mark, ++stamp, stack, w);
          key = keyOf(next, low);
        }
        occupied[t] = 0; occupied[b] = 1;
        if (fr || next === null) continue;
        const prevG = best.get(key);
        if (prevG !== undefined && prevG <= g + 1) continue;
        const hv = heuristic(next);
        if (hv >= BIG) continue;
        best.set(key, g + 1);
        const ns = sBoxes.length;
        sKey.push(key);
        sBoxes.push(next);
        sPlayer.push(b);
        sG.push(g + 1);
        parent.push(s);
        pushDir.push(k);
        pushBox.push(b);
        hpush(g + 1 + hv, g + 1, ns);
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;
  // Rebuild the push sequence, then the moves (walk + push per step).
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = player0;
  let boxes = boxes0.slice();
  for (const s of path) {
    const next = sBoxes[s];
    const k = pushDir[s];
    const d = DY[k] * w + DX[k];
    const from = pushBox[s];
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(wall, occupied, player, from - d, w);
    for (const b of boxes) occupied[b] = 0;
    moves += UP[k];
    player = from;
    boxes = next;
  }
  return { pushes: path.length, moves };
}

// --- room decomposition -------------------------------------------------
// Cut the hallway row out of the floor; each remaining component holding
// boxes is a room. Mode 0 cuts the whole player row; mode 1 cuts only its
// dead squares. Returns rooms sorted by their lowest square, or null when
// the level is no set of rooms.
function decompose(level: Level, live: Uint8Array): { boxes: number[]; goals: number[] }[] | null {
  const { w, wall, goals, boxes, player } = level;
  const row = Math.floor(player / w);
  for (let mode = 0; mode < 2; mode++) {
    const cut = new Uint8Array(wall.length);
    for (let i = row * w; i < (row + 1) * w; i++) {
      if (wall[i]) continue;
      if (mode === 0 || !live[i]) cut[i] = 1;
    }
    if (boxes.some((b) => cut[b])) continue;
    const part = new Int32Array(wall.length).fill(-1);
    const comps: { squares: number[]; boxes: number[]; goals: number[] }[] = [];
    for (let s = 0; s < wall.length; s++) {
      if (wall[s] || cut[s] || part[s] >= 0) continue;
      const sq = [s];
      part[s] = comps.length;
      for (let i = 0; i < sq.length; i++) {
        for (let k = 0; k < 4; k++) {
          const q = sq[i] + DY[k] * w + DX[k];
          if (!wall[q] && !cut[q] && part[q] < 0) { part[q] = comps.length; sq.push(q); }
        }
      }
      comps.push({ squares: sq, boxes: [], goals: [] });
    }
    let ok = true;
    for (const b of boxes) { if (part[b] < 0) { ok = false; break; } comps[part[b]].boxes.push(b); }
    if (!ok) continue;
    for (const g of goals) { if (part[g] < 0) { ok = false; break; } comps[part[g]].goals.push(g); }
    if (!ok) continue;
    if (comps.some((c) => c.boxes.length !== c.goals.length)) continue;
    const rooms = comps.filter((c) => c.boxes.length > 0)
      .map((c) => ({ boxes: c.boxes.sort((a, b) => a - b), goals: c.goals.sort((a, b) => a - b), low: c.squares[0] }))
      .sort((a, b) => a.low - b.low);
    return rooms.map((r) => ({ boxes: r.boxes, goals: r.goals }));
  }
  return null;
}

function solveLevel(level: Level): string {
  const live = liveSquares(level.wall, level.goals, level.w);
  const rooms = decompose(level, live);
  if (rooms !== null) {
    let player = level.player;
    let moves = '';
    const done: { boxes: number[]; goals: number[] }[] = [];
    for (const room of rooms) {
      const wall2 = level.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        const cells = done.includes(other) ? other.goals : other.boxes;
        for (const b of cells) wall2[b] = 1;
      }
      const res = pushSearch(wall2, room.goals, room.boxes, player, level.w, level.h, ROOM_EXPANSIONS);
      if (res === null) return globalSolve(level);
      moves += res.moves;
      player = endOf(level.w, player, res.moves);
      done.push(room);
    }
    return moves;
  }
  return globalSolve(level);
}

function globalSolve(level: Level): string {
  const res = pushSearch(level.wall, level.goals, level.boxes, level.player, level.w, level.h, GLOBAL_EXPANSIONS);
  return res === null ? '' : res.moves;
}

for (const id of readdirSync(IN).sort()) {
  let moves = '';
  try { moves = solveLevel(parse(readFileSync(join(IN, id, 'level.txt'), 'utf8'))); } catch { moves = ''; }
  mkdirSync(join(OUT, id), { recursive: true });
  writeFileSync(join(OUT, id, 'solution.txt'), `${moves}\n`);
}
