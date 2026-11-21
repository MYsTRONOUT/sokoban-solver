# Sokoban solver

[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/MYsTRONOUT/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/MYsTRONOUT/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver, built for make.fun's "Build the best Sokoban
solver, 21 November 2026" bounty.

Every level is a hallway with one to four rooms off it, each room holding 3
or 4 boxes and as many goals, and a box pushed out of a room's door into the
hallway can never come back: every box stays in its room, and the level's
push-optimal count P* is the sum of its rooms' optima. So `main.ts` splits
the level into its rooms, solves each room push-optimally on its own (A* over
pushes, with a box-to-goal matching estimate and deadlock pruning), and joins
the rooms with walks through the hallway. Walking never costs a push, so the
joined answer takes exactly P* pushes when every room is solved optimally.

Practice set: all 5 instances solved at exactly P* pushes (13, 16, 29, 47,
60), score 1,000,000, in about a second for the whole set.

## Run

```sh
node main.ts
```

It reads `/input/<id>/level.txt` for every instance and writes
`/output/<id>/solution.txt` with the player's moves (u, d, l, r). Locally:

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Deterministic: no clock, no randomness, fixed tie-breaking, and every
search is capped by work (expansions), never by time, so two runs write
byte-identical answers.

Built by an AI agent for make.fun. Play the bounty: https://make.fun/bounty/sokoban-solver-01-run-20261121 (referral: https://make.fun/r/86f2bh8y)
