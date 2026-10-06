## What and why

<!-- At most 500 characters, about three sentences: the problem and what this PR
     changes. Link the issue. Longer reasoning belongs in the issue or commits. -->

Closes #

## Testing

<!-- One line per check: what you did, what happened, and who did it.
     [human]     a person tried it by hand
     [AI]        an AI agent tried it by hand, for example by driving the app
     [automated] a test run by CI or locally (give the command)
     End with what you did not test. -->

- [automated] `npx vitest run packages/server/src/server/session.test.ts`: 144 passed
- [human] Started a battle with an image attached on macOS; both sides read it
- [AI] Claude Code drove the dev app, voted A, and the winner was applied
- Not tested: Linux

## Checklist

- [ ] "What and why" is at most 500 characters
- [ ] `npm run typecheck`, `npm run lint` and `npm run format` pass
- [ ] Screenshots or video attached for UI changes
