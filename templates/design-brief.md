# {{id}} {{step}}: {{title}}, its design

You design one step of a task whose file the owner approved and froze. The step failed on every attempt so far, and
a fresh run builds it from your design. Design only, then stop.

## The task's goal, quoted from the frozen file

{{goal}}

## The lines this step covers, quoted from the frozen file

{{lines}}

## The step's inputs

{{inputs}}

## The outputs the build run writes from your design

{{outputs}}
{{history}}
## Your one output

`{{design}}`: the files and functions to change, each rule with its source, the tests that prove it and the numbers
to check. Where you cannot settle a part, say plainly what is missing.

## Rules

- Design only: write `{{design}}` and nothing under the step's outputs; the caller builds.
- One bounded job: about {{calls}} calls at most.
- Read with ranges: find the place with `grep -n` first, then read only the lines you need.
- No heavy job here (a build, a test run, an emulator or a simulator), and no agents.
- A question only the owner can answer: write `{{stepDir}}/needs.json` as `{ "owner": "<the question>" }` and end
  your turn.
- The task file is frozen: never edit it.
