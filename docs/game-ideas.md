# Game Ideas And Implementation History

> **Document status (2026-08-29):** This remains an unscheduled concept backlog, not an implementation
> roadmap. Voice Trivia has moved out of the backlog and is now a playable registered game; its
> original concept is retained below as history.
>
> **Operational truth:** Use the [README](../README.md), [Deployment](DEPLOYMENT.md), and
> [Infrastructure Setup](INFRA_SETUP.md) for current games, behavior, and operations.

## Voice Trivia

**Status:** Implemented and playable

**Current implementation delta (2026-10-07):** Voice Trivia is the fifth game in the canonical
registry at `/trivia.html`, with one to four human players and no AI fallback. Players vote by voice
for one of eight categories or Mixed, then every player may answer each of eight questions during a
25-second window that starts after the spoken question, before the choices are read. Correct answers earn speed-tier points plus a streak bonus; final ordering uses
score, correct-answer count, cumulative correct-answer time, and stable player order. The localized
shared display shows answer locks, reveals, explanations, standings, and final normalized scores.

The server-only production bank contains 200 strictly validated questions, 25 in each category, with
complete `en-US` and `pt-BR` prompts, four choices, optional private voice-alias fields, explanations,
sources, and review metadata. The bundled alias arrays are currently empty. The protected editor is
`/editor?game=trivia`; live edits are ETag-protected and
persist to `data/trivia-questions.json` by default. Current review metadata records an AI-assisted
editorial audit and does not claim human review.

**Original concept (2026-07-25):** The proposal below is retained as the idea that preceded
the authoritative implementation. Its first-correct-only scoring and open design questions do not
describe the current game.

A Kahoot-style multiplayer trivia game played entirely through Twilio Voice. Players call the
same game and watch questions appear on a shared display. They answer aloud over the phone, and
the first player to give the correct answer earns points. The game continues through a series of
questions and ends with a ranked scoreboard.

Core loop:

1. Players call in and join the same trivia session.
2. A question appears on the shared screen and is announced to callers.
3. Players answer by voice through the call.
4. The first correctly recognized answer increases that player's score.
5. The display reveals the answer, updates the leaderboard, and advances to the next question.

The original concept left answer-matching tolerance, simultaneous-answer tie handling, question
categories and difficulty, round length, and incorrect-answer lockout as design decisions. The
current authoritative implementation and tests now define those behaviors.

## Twilio Games Station Platform

The product-direction roadmap and decision history for TAC, lead capture, digital coins, earning
challenges, a single-display queue, post-game summaries, Conversation Memory, and Conversation
Intelligence is preserved in the [Twilio Games station plan](TWILIO_ARCADE_PLAN.md). It is not the
current operational source of truth.
