# Simulator Scoring

This document describes how the current RL simulator and self-play scoring work in `ai-training.js`.

## 1. Two different score layers

There are two separate layers:

1. Per-step RL reward
This is the reward used while training the Q-table.

2. End-of-match self-play score
This is the score used to rank agents at the end of a self-play match.

These are related, but not identical.

## 2. Unit kill and loss points

The simulator now gives explicit points by ship type when an enemy combat unit is destroyed, and larger penalties when your own combat unit is lost.

Current kill points:

| Unit | Kill points |
| --- | ---: |
| frigate | 18 |
| destroyer | 30 |
| cruiser | 48 |
| battleship | 80 |
| carrier | 70 |
| submarine | 62 |
| assaultship | 54 |
| missile_launcher | 64 |

Current loss penalties:

| Unit | Loss penalty |
| --- | ---: |
| frigate | 24 |
| destroyer | 40 |
| cruiser | 62 |
| battleship | 100 |
| carrier | 90 |
| submarine | 82 |
| assaultship | 72 |
| missile_launcher | 84 |

This means the system prefers efficient trades. Example:

- Kill 1 enemy battleship: `+80`
- Lose 1 own battleship: `-100`

## 3. Live RL reward

`calculateReward(prevSnapshot, currentSnapshot)` is used for live RL transitions.

Main components:

- Exact ship trade reward:
  `+ enemy kill score`
  `- own loss score`
- Worker loss penalty:
  `-2.5` per worker lost
- Building progress:
  `+2.6` per completed building increase
- Building retention:
  small positive reward for keeping completed buildings alive
- Building loss:
  extra penalty when retained building value drops
- Economy tempo:
  reward for higher energy income, higher active production spend, and balanced throughput
- Tech progress:
  `+1.4 * tech score increase`
- Fleet diversity:
  `+2.5 * diversity increase`
- Resource band bonus:
  `+0.5` if resources stay in a healthy middle range
- Enemy combat power damage:
  `+0.018 * enemy power loss`
- Own combat power loss:
  `-0.03 * own power loss`
- Survival:
  `+0.1` if alive, `-50` if dead
- Worker corps stability:
  small bonus for keeping 2 to 5 workers alive
- Mono-composition penalty:
  extra penalty if one unit type dominates too much
- Win bonus:
  `+100`

## 4. Solo simulation step reward

The headless solo simulator also gives small action rewards and structural rewards.

Important behavior:

- There is no free base income anymore.
- Passive income is now only:
  `power_plant_count * 5`
- Building actions give positive reward mainly for:
  more power plants, more shipyards, tech buildings, and defense towers when pressured
- Unit production rewards are intentionally weak and mostly neutral.
  The system is no longer supposed to strongly bribe specific ship production.
- After each step, the simulator also gives extra reward for:
  higher energy income
  higher balanced throughput
  keeping buildings alive
  avoiding underbuilt economy while fielding many combat units

Balanced throughput means:

`min(energy income per second, active energy spend per second)`

This rewards production capacity that is actually being used.

## 5. Self-play final score

At the end of a self-play match, `_calculateScore(agent)` ranks agents using a larger final score.

Main components:

- Remaining combat power:
  `+0.35 * combatPower`
- Building count:
  `+35 * buildingCount`
- Building retention score:
  extra score for keeping higher-value infrastructure alive
- Building loss score:
  subtract penalty when important buildings are destroyed
- Tech progression:
  `+22 * techScore`
- Energy income:
  `+8 * energyIncomePerSecond`
- Economy tempo:
  `+6 * economyTempoScore`
- Fleet diversity:
  `+18 * fleetDiversity`
- Mono-composition penalty:
  `-160 * max(0, fleetDominance - 0.7)`
- Kill event score:
  sum of ship-type kill points
- Loss event score:
  subtract sum of ship-type loss penalties
- Worker losses:
  `-8 * workerLosses`
- Value destroyed / value lost:
  small modifiers from combat power exchanged
- Damage dealt / damage taken:
  small modifiers
- Enemy elimination:
  `+120` per eliminated enemy
- Alive at end:
  `+200`
- Resources banked:
  `+0.05 * min(resources, 3000)`

## 6. Victory margin

`avgVictoryMargin` in self-play is:

`winner final score - second place final score`

This is not direct raw combat power.
It is the difference between the two agents' final self-play scores after all of the scoring terms above are applied.

## 7. Snapshot fields that matter most

The current reward and score system cares most about:

- power plant count
- shipyard count
- naval academy count
- missile silo count
- carbase count
- energy income per second
- active energy spend per second
- ship-type counts
- fleet diversity
- fleet dominance
- worker count
- remaining combat power

## 8. Design intent

The current scoring is trying to produce this behavior:

- build economy first
- keep production active
- avoid rushing with only cheap ships forever
- trade efficiently
- protect expensive ships
- protect important infrastructure
- transition into mixed fleets and tech
- win with low losses rather than pure throwaway spam

## 9. Not currently used

The simulator does not currently use per-unit killstreak scoring such as:

- "this exact destroyer got a kill, so its next kill is worth +1 more"

That feature is intentionally not enabled because the current self-play simulator is mostly count-based, not full per-entity simulation, and killstreak rewards would create a strong snowball bias.
