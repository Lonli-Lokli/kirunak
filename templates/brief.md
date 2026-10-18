# {{id}} {{step}}: {{title}}

You run one step of a task whose file the owner approved and froze. Do this step only, then stop.

## The task's goal, quoted from the frozen file

{{goal}}

## The lines this step covers, quoted from the frozen file

{{lines}}

## Inputs

{{inputs}}

## Outputs: write every one

{{outputs}}

## Rules

- One bounded job: about {{calls}} calls at most. If the step needs more, say in the report what is left and stop.
- Read with ranges: find the place with `grep -n` first, then read only the lines you need.
- No heavy job here (a build, a test run, an emulator or a simulator). When the step needs one, write
  `{{stepDir}}/needs.json` as
  `{ "heavy": { "what": "<what it is>", "command": ["<program>", "<argument>"], "maxMinutes": <minutes> }, "then": "resume" }`
  and end your turn. The job runs outside this conversation, which then resumes with its result.
- A question only the owner can answer: write `{{stepDir}}/needs.json` as `{ "owner": "<the question>" }` and end
  your turn.
- No agents.
- Every result is a file under `{{stepDir}}/` or `{{evidenceDir}}/`. The task file is frozen: never edit it.
- Last, write `{{stepDir}}/report.md`, at most a page: what you did, the files, what is left.
