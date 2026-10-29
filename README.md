# agent-hours

How many hours did your Claude Code agents actually work? What did an hour buy? And how does that
compare with your own hours before AI?

One TypeScript file, no install, Node 22.18+ or Bun. It reads `~/.claude/projects` and local git;
nothing leaves your machine.

Write-up with my numbers: [Agent Hours](https://claude.ai/artifact/GRLvJqGecZtPmngYUK4La9).

## Run it

Paste this into Claude Code:

```
Measure my agent-hours. Download https://raw.githubusercontent.com/dested/agent-hours/main/agent-hours.mts
into a scratch folder (not inside a repo), read it, and run `node agent-hours.mts` (Node 22.18+) or
`bun agent-hours.mts`. Show me the output. Then ask me which folders hold my own pre-AI repos, which
email(s) I committed with, and when I started coding with AI; rerun with --repos, --author and
--before, and tell me in three lines how my agent-hour compares with my own hour.
```

Or run it yourself:

```sh
curl -O https://raw.githubusercontent.com/dested/agent-hours/main/agent-hours.mts
node agent-hours.mts
node agent-hours.mts --repos ~/code/old-a,~/code/old-b --author "me@example.com" --before 2022-06-01
```

| Flag | |
| --- | --- |
| `--root DIR` | transcript root, repeatable (default `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`) |
| `--since DATE` | only transcripts from DATE on |
| `--repos A,B` | repos holding your own pre-AI work |
| `--author REGEX` | your commit email(s), case-insensitive (default `git config user.email`) |
| `--before DATE` | human cutoff (default 2022-06-01, before Copilot) |
| `--no-git` | skip looking up the agents' commits |
| `--json` | machine-readable output |

## What it counts

An **agent-hour** is one agent actively working for 60 minutes: the model generating or a tool
running. Every gap between transcript events goes to whoever ended it:

- your next message, or an answer to a question or plan → waiting on you, not counted;
- a background-agent notification, or an idle wake-up → waiting on agents, not counted;
- a tool result → tool time, capped at 12 minutes;
- a model message → model time, capped at 15 minutes;
- a foreground subagent returning → counted in the subagent's own transcript instead.

**Your hours** come from commit timestamps: commits under 2 hours apart form one session, plus
30 minutes before each session's first commit. Commit timestamps miss the thinking between
commits, so this flatters you.

**Lines** count code files only, skip lockfiles and build output, and drop any commit that adds
or removes more than 3,000 lines (imports, pastes, mass deletions) on both sides. Agent commits
are found from `git commit` output in Bash results and counted only for runs that committed their
own work. Lines are a sanity check, not a measure of value.

## License

MIT
