// A push-optimal Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
//
// The levels are built as one hallway with one to four rooms off it, each room
// holding 3 or 4 boxes and as many goals, and a box pushed out of a room's door
// into the hallway can never come back: every box stays in its room, and the
// level's push-optimal count P* is the sum of its rooms' optima. So this solver
// splits the level into its rooms, solves each room push-optimally on its own
// (A* over pushes, with a box-to-goal matching estimate and deadlock pruning),
// and joins the rooms with walks through the hallway. Walking never costs a
// push, so the joined answer takes exactly P* pushes when every room is solved
// optimally. Deterministic: no clock, no randomness, fixed tie-breaking, and
// every search is capped by work (expansions), never by time, so two runs of
// the program write byte-identical answers.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Steps: [dx, dy, letter]. A letter is a player step; the replay decides which
// steps push a box.
const DIRS: [number, number, string][] = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array; // 1 where the cell is a wall
  goals: number[]; // cell indexes, sorted
  goalSet: Set<number>;
  boxes: number[]; // cell indexes, sorted
  player: number; // cell index
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = 0;
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      wall[i] = ch === '#' ? 1 : 0;
      if ('.*+'.includes(ch)) goals.push(i);
      if ('$*'.includes(ch)) boxes.push(i);
      if ('@+'.includes(ch)) player = i;
    }
  });
  goals.sort((a, b) => a - b);
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, goalSet: new Set(goals), boxes, player };
}

// Breadth-first distances from `from` over the cells where mask is 1.
// Returns an Int32Array of distances (-1 where unreachable).
function bfsDist(w: number, h: number, mask: Uint8Array, from: number): Int32Array {
  const dist = new Int32Array(w * h).fill(-1);
  const q: number[] = [from];
  dist[from] = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]!;
    const x = c % w;
    const y = (c / w) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const n = ny * w + nx;
      if (!mask[n] || dist[n] !== -1) continue;
      dist[n] = dist[c]! + 1;
      q.push(n);
    }
  }
  return dist;
}

// A walk from `from` to `to` over the cells where mask is 1, avoiding the
// cells in `blocked`. Returns the move letters, or null when unreachable.
// Deterministic: fixed direction order, FIFO queue.
function bfsPath(
  w: number,
  h: number,
  mask: Uint8Array,
  blocked: Set<number>,
  from: number,
  to: number,
): string | null {
  if (from === to) return '';
  const prev = new Int32Array(w * h).fill(-1);
  const prevStep = new Array<string>(w * h).fill('');
  const q: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]!;
    const x = c % w;
    const y = (c / w) | 0;
    for (const [dx, dy, letter] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const n = ny * w + nx;
      if (!mask[n] || blocked.has(n) || prev[n] !== -1) continue;
      prev[n] = c;
      prevStep[n] = letter;
      if (n === to) {
        const letters: string[] = [];
        let cur = n;
        while (cur !== from) {
          letters.push(prevStep[cur]!);
          cur = prev[cur]!;
        }
        letters.reverse();
        return letters.join('');
      }
      q.push(n);
    }
  }
  return null;
}

// The cheapest assignment of boxes to goals under a cost matrix, by trying
// every permutation (n <= 6), or the sum of per-box minima for larger n.
// Either way a lower bound on the pushes still needed: admissible.
function matchCost(costs: number[][]): number {
  const n = costs.length;
  if (n === 0) return 0;
  if (n <= 6) {
    const perm = costs[0]!.map((_, i) => i);
    let best = Infinity;
    const walk = (k: number, sum: number): void => {
      if (sum >= best) return;
      if (k === n) {
        best = sum;
        return;
      }
      for (let i = k; i < n; i++) {
        [perm[k], perm[i]] = [perm[i]!, perm[k]!];
        const c = costs[k]![perm[k]!]!;
        if (c < Infinity) walk(k + 1, sum + c);
        [perm[k], perm[i]] = [perm[i]!, perm[k]!];
      }
    };
    walk(0, 0);
    return best;
  }
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const m = Math.min(...costs[i]!);
    if (m === Infinity) return Infinity;
    sum += m;
  }
  return sum;
}

// Is this box set provably dead? Only sound prunes. Two masks matter: a
// cell is box-occupiable when boxMask has it, and the player can stand on a
// cell when walkMask has it (the room's cells plus its hallway entry cell).
// A side of a box is sealed when the player cannot stand there to push the
// box away from it, which is what corners, freezes and wall runs turn on;
// a box can never be pushed onto a cell outside boxMask, which is what the
// 2x2 block turns on. A box sitting on a goal is never dead by itself.
function isDead(
  w: number,
  h: number,
  boxMask: Uint8Array,
  walkMask: Uint8Array,
  goalSet: Set<number>,
  boxes: number[],
  dists: Int32Array[],
): boolean {
  const boxSet = new Set(boxes);
  const cellAt = (x: number, y: number): number => y * w + x;
  // Sealed: outside the board, or no floor the player can stand on.
  const sealed = (c: number): boolean => c < 0 || c >= w * h || walkMask[c] === 0;
  // Wallish: outside the board, or no floor a box can occupy.
  const wallish = (c: number): boolean => c < 0 || c >= w * h || boxMask[c] === 0;
  for (let bi = 0; bi < boxes.length; bi++) {
    const b = boxes[bi]!;
    if (goalSet.has(b)) continue;
    const x = b % w;
    const y = (b / w) | 0;
    const n = y > 0 ? cellAt(x, y - 1) : -1;
    const s = y + 1 < h ? cellAt(x, y + 1) : -1;
    const west = x > 0 ? cellAt(x - 1, y) : -1;
    const e = x + 1 < w ? cellAt(x + 1, y) : -1;
    const sN = sealed(n);
    const sS = sealed(s);
    const sW = sealed(west);
    const sE = sealed(e);
    // Corner: sealed on two perpendicular sides.
    if ((sN || sS) && (sW || sE)) return true;
    // Frozen against a wall: sealed on one side and on both sides along it.
    if ((sN && sW && sE) || (sS && sW && sE) || (sW && sN && sS) || (sE && sN && sS)) return true;
    // Wall run with no goal: the box sits against a sealed side and can only
    // slide along it. The run is the stretch of cells whose sealed-side
    // neighbour is sealed; it ends closed where the floor stops, and open
    // where the sealed side opens up (the box can be pushed off there). A run
    // with no goal and both ends closed can never be solved.
    const sides: [number, number, number, number][] = [];
    if (sN) sides.push([0, -1, 1, 0]);
    if (sS) sides.push([0, 1, 1, 0]);
    if (sW) sides.push([-1, 0, 0, 1]);
    if (sE) sides.push([1, 0, 0, 1]);
    for (const [ox, oy, ax, ay] of sides) {
      let hasGoal = false;
      let openEnds = 0;
      for (const sign of [1, -1]) {
        let cx = x;
        let cy = y;
        for (;;) {
          if (goalSet.has(cellAt(cx, cy))) hasGoal = true;
          const nx2 = cx + ax * sign;
          const ny2 = cy + ay * sign;
          if (nx2 < 0 || nx2 >= w || ny2 < 0 || ny2 >= h) break;
          const nc = cellAt(nx2, ny2);
          if (wallish(nc)) break;
          const bx2 = nx2 + ox;
          const by2 = ny2 + oy;
          if (!sealed(bx2 < 0 || bx2 >= w || by2 < 0 || by2 >= h ? -1 : cellAt(bx2, by2))) {
            openEnds++;
            break;
          }
          cx = nx2;
          cy = ny2;
        }
      }
      if (!hasGoal && openEnds === 0) return true;
    }
    // Cannot reach any goal.
    let reach = false;
    for (let g = 0; g < dists.length; g++) {
      if (dists[g]![b] !== -1) {
        reach = true;
        break;
      }
    }
    if (!reach) return true;
  }
  // 2x2 block: every cell sealed or a box, and some box in it is not on a
  // goal. No box in such a block can be the first to move: every direction
  // out of the block needs the player to stand on a cell inside it, and
  // every direction into it is sealed or another box. (Sealed, not merely
  // unoccupiable: the room's hallway entry cell can hold the player, so a
  // box beside it can still be pushed away from it.)
  for (let y = 0; y + 1 < h; y++) {
    for (let x = 0; x + 1 < w; x++) {
      const cells = [cellAt(x, y), cellAt(x + 1, y), cellAt(x, y + 1), cellAt(x + 1, y + 1)];
      let blocked = 0;
      let unsolvedBox = false;
      for (const c of cells) {
        if (sealed(c)) blocked++;
        else if (boxSet.has(c)) {
          blocked++;
          if (!goalSet.has(c)) unsolvedBox = true;
        }
      }
      if (blocked === 4 && unsolvedBox) return true;
    }
  }
  return false;
}

interface RoomSolve {
  moves: string;
  endPlayer: number;
  pushes: number;
}

// Push-optimal A* for one closed problem: boxes may occupy `boxMask` cells,
// the player may walk `walkMask` cells, from `player` with `boxes` to all
// `goals`. `weight` scales the estimate: 1 is optimal, above 1 is a faster
// greedy fallback. Capped by `maxExpansions` expansions, never by the clock.
function solveRoom(
  w: number,
  h: number,
  boxMask: Uint8Array,
  walkMask: Uint8Array,
  goals: number[],
  boxes0: number[],
  player0: number,
  maxExpansions: number,
  weight: number,
): RoomSolve | null {
  const goalSet = new Set(goals);
  // Walking distances from each goal, over the box cells alone.
  const dists = goals.map((g) => bfsDist(w, h, boxMask, g));
  const heuristic = (boxes: number[]): number => {
    const costs = boxes.map((b) => dists.map((d) => (d[b] === -1 ? Infinity : d[b])));
    return matchCost(costs);
  };
  const boxes0s = [...boxes0].sort((a, b) => a - b);
  if (boxes0s.every((b) => goalSet.has(b))) return { moves: '', endPlayer: player0, pushes: 0 };
  if (isDead(w, h, boxMask, walkMask, goalSet, boxes0s, dists)) return null;
  const h0 = heuristic(boxes0s);
  if (h0 === Infinity) return null;
  // States: player, boxes, pushes so far, parent, the move segment into it.
  const sp: number[] = [player0];
  const sb: number[][] = [boxes0s];
  const sg: number[] = [0];
  const parent: number[] = [-1];
  const seg: string[] = [''];
  const best = new Map<string, number>();
  const keyOf = (p: number, bs: number[]): string => p + ':' + bs.join(',');
  best.set(keyOf(player0, boxes0s), 0);
  // Heap of [f, h, counter, state], ordered by f, then h, then insertion.
  const heap: [number, number, number, number][] = [[h0 * weight, h0, 0, 0]];
  let counter = 1;
  const less = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };
  let expanded = 0;
  while (heap.length > 0) {
    const [, , , s] = heapPop();
    const p = sp[s]!;
    const bs = sb[s]!;
    const g = sg[s]!;
    if (best.get(keyOf(p, bs)) !== s) continue;
    if (bs.every((b) => goalSet.has(b))) {
      const parts: string[] = [];
      let cur = s;
      while (cur > 0) {
        parts.push(seg[cur]!);
        cur = parent[cur]!;
      }
      parts.reverse();
      return { moves: parts.join(''), endPlayer: p, pushes: g };
    }
    if (expanded >= maxExpansions) return null;
    expanded++;
    const boxSet = new Set(bs);
    for (let bi = 0; bi < bs.length; bi++) {
      const b = bs[bi]!;
      const bx = b % w;
      const by = (b / w) | 0;
      for (const [dx, dy, letter] of DIRS) {
        const nx = bx + dx;
        const ny = by + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const dest = ny * w + nx;
        if (!boxMask[dest] || boxSet.has(dest)) continue;
        const px = bx - dx;
        const py = by - dy;
        if (px < 0 || px >= w || py < 0 || py >= h) continue;
        const from = py * w + px;
        if (!walkMask[from] || boxSet.has(from)) continue;
        const walk = bfsPath(w, h, walkMask, boxSet, p, from);
        if (walk === null) continue;
        const next = [...bs];
        next[bi] = dest;
        next.sort((a, b2) => a - b2);
        if (isDead(w, h, boxMask, walkMask, goalSet, next, dists)) continue;
        const hh = heuristic(next);
        if (hh === Infinity) continue;
        const ng = g + 1;
        const k = keyOf(b, next);
        const prev = best.get(k);
        if (prev !== undefined && sg[prev]! <= ng) continue;
        const idx = sp.length;
        sp.push(b);
        sb.push(next);
        sg.push(ng);
        parent.push(s);
        seg.push(walk + letter);
        best.set(k, idx);
        heapPush([ng + hh * weight, hh, counter++, idx]);
      }
    }
  }
  return null;
}

// Split the level into its rooms: the hallway is the player's row, and each
// room is a connected component of floor once that row is taken out. A room's
// door is its one cell touching the hallway; the entry is the hallway cell
// beside it. Returns null when the level does not split cleanly.
interface Room {
  door: number;
  entry: number;
  cells: number[];
  boxes: number[];
  goals: number[];
}

function splitRooms(level: Level): Room[] | null {
  const { w, h, wall, player } = level;
  const hallRow = (player / w) | 0;
  const seen = new Uint8Array(w * h);
  const rooms: Room[] = [];
  for (let i = 0; i < w * h; i++) {
    if (wall[i] || (i / w | 0) === hallRow || seen[i]) continue;
    // Flood one component.
    const cells: number[] = [i];
    seen[i] = 1;
    let door = -1;
    let entry = -1;
    for (let ci = 0; ci < cells.length; ci++) {
      const c = cells[ci]!;
      const x = c % w;
      const y = (c / w) | 0;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const n = ny * w + nx;
        if (ny === hallRow) {
          if (!wall[n] && door === -1) {
            door = c;
            entry = n;
          }
          continue;
        }
        if (!wall[n] && !seen[n]) {
          seen[n] = 1;
          cells.push(n);
        }
      }
    }
    if (door === -1) return null;
    const cellSet = new Set(cells);
    const boxes = level.boxes.filter((b) => cellSet.has(b));
    const goals = level.goals.filter((g) => cellSet.has(g));
    if (boxes.length === 0 || boxes.length !== goals.length) return null;
    rooms.push({ door, entry, cells, boxes, goals });
  }
  // Every box and goal must sit in exactly one room.
  const placed = rooms.reduce((a, r) => a + r.boxes.length, 0);
  if (placed !== level.boxes.length) return null;
  // Deterministic order: above the hallway first, then below, left to right.
  rooms.sort((a, b) => a.door - b.door);
  return rooms;
}

// Solve one level. Returns the move string, or '' when it cannot be solved.
function solveLevel(text: string): string {
  const level = parseLevel(text);
  const { w, h, wall } = level;
  const floorMask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) floorMask[i] = wall[i] ? 0 : 1;
  const rooms = splitRooms(level);
  if (rooms === null) {
    // No clean split: solve the whole level as one room.
    const res =
      solveRoom(w, h, floorMask, floorMask, level.goals, level.boxes, level.player, 250_000, 1) ??
      solveRoom(w, h, floorMask, floorMask, level.goals, level.boxes, level.player, 250_000, 3);
    return res === null ? '' : res.moves;
  }
  let moves = '';
  let curPlayer = level.player;
  const liveBoxes = new Set(level.boxes);
  for (const room of rooms) {
    const boxMask = new Uint8Array(w * h);
    for (const c of room.cells) boxMask[c] = 1;
    const walkMask = new Uint8Array(boxMask);
    walkMask[room.entry] = 1;
    // Walk from where the player stands to this room's door.
    const walk = bfsPath(w, h, floorMask, liveBoxes, curPlayer, room.entry);
    if (walk === null) return '';
    moves += walk;
    curPlayer = room.entry;
    // Solve the room push-optimally; a greedy retry if the optimal search
    // runs out of its expansion budget.
    let res = solveRoom(w, h, boxMask, walkMask, room.goals, room.boxes, curPlayer, 250_000, 1);
    if (res === null) {
      res = solveRoom(w, h, boxMask, walkMask, room.goals, room.boxes, curPlayer, 250_000, 3);
    }
    if (res === null) return '';
    moves += res.moves;
    curPlayer = res.endPlayer;
    // The room's boxes are now on its goals: refresh the live box set.
    for (const b of room.boxes) liveBoxes.delete(b);
    for (const g of room.goals) liveBoxes.add(g);
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
