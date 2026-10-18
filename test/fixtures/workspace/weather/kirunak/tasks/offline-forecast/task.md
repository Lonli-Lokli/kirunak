---
id: weather/offline-forecast
title: The last forecast stays readable offline
created: 2026-11-02
from: openspec/changes/add-offline-mode
---

## Goal
With no network, the app still shows the last forecast it fetched and says how old it is. [owner 2026-11-02 Q-1]

## Acceptance criteria
- AC-1 With no network, the app opens on the last forecast it fetched, with the time it was fetched. [research docs/offline.md §2]
- AC-2 The forecast screen shows the fetch time in the reader's own time format. [owner 2026-11-02 Q-2]
- AC-3 Both phone platforms keep the last forecast across a restart. [owner 2026-11-02 Q-3]

## Edge cases
- E-1 A forecast older than a day shows its age in words, not only a time. [owner 2026-11-02 Q-4]

## Out of scope
- O-1 Weather alerts while offline. [owner 2026-11-02 Q-5] [from openspec/changes/add-offline-mode/tasks.md 3.2]

## Decisions
- D-1 Keep the last three days of forecasts, no more. [owner 2026-11-02 Q-6]

## Aspects
- platforms: in (AC-3) [owner 2026-11-02 Q-3]
- large-text: n/a: the forecast screen keeps its layout [owner 2026-11-02 Q-7]
- offline: in (AC-1, E-1) [default 2026-11-02]

## Open questions
