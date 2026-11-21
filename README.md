[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/bebek22-jpg/sokoban-solver-01-run-20261121-entry/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/bebek22-jpg/sokoban-solver-01-run-20261121-entry/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

# Push-Optimal Sokoban Solver

A solver that answers every Sokoban level in a set in the fewest pushes
possible. It scores 1,000,000 on the kit's practice set (all 5 instances
solved in exactly P* pushes) and the same on 8 freshly drawn
generator sets.

## How it works

Every generated level is a 1-wide hallway with 1–4 rooms off it, and a box
pushed out of a room can never come back — so the rooms are independent
problems whose optima add up:

1. **Room decomposition.** The hallway row is cut out of the floor; each
   remaining connected component holding boxes is a room (with a fallback
   cut of only the hallway's dead squares, then a whole-level search).
2. **Push-optimal A\* per room.** A state is the sorted box squares plus
   the player's reachable region (named by its lowest square). The
   heuristic is the min-cost assignment of boxes to goals over precomputed
   floor distances — each push moves one box one square, so it never
   overestimates and the first solved state popped is push-optimal.
   Dead states are pruned with live squares (pull-back from the goals)
   and frozen 2×2 blocks. Other rooms' boxes stand as walls while a room
   is solved (on their goals once their room is done).
3. **Stitching.** Room solutions are joined with shortest hallway walks;
   the player enters each room through its door, solves it, and moves on.

Everything is budgeted by work (expansion counts), never by the clock, so
two runs write byte-identical output. No randomness, no network, Node
built-ins only.

## How to run it

Node 22+, no install step:

```sh
# On the kit's practice input:
MAKEFUN_INPUT_DIR=/path/to/kit/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
# Writes out/<id>/solution.txt for each instance

# In the grader's sandbox the env vars are unset and it reads /input,
# writing /output/<id>/solution.txt:
node main.ts
```

## Bounty

Built for the [sokoban-solver-01-run-20261121 bounty](https://make.fun/bounty/sokoban-solver-01-run-20261121)
on make.fun. `main.ts` is the whole entry: one file, standard library only.
