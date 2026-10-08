#!/bin/sh
set -e

# If an Azure Files mount is present, point the app's mutable data dir at it so RUNTIME-MUTABLE
# state survives container restarts + redeploys:
#   - data/leaderboard.json and data/karaoke-leaderboard.json - persistent scoreboards
#   - data/trivia-leaderboard.json - persistent Voice Trivia scoreboard
#   - data/trivia-questions.json - the live protected Trivia question bank, seeded from the image's
#                                  content/trivia/questions.json on first boot
#   - data/analytics.json   — bounded daily activation analytics rollups
#   - data/wizard-chess-audio/*.mp3 — fixed character narration reused across calls and deploys
#   - data/maps.json        — LIVE level configs authored in the editor (seeded once from the
#                             image's assets/maps/maps.json on first boot; see http-server.seedMapsFile)
# The app uses normal fs calls (writeFileAtomic mkdir's data/); we just make data/ resolve to the share.
#
# Only runtime-mutable state belongs on the share. assets/ (GLB models) and client/dist (the built UI)
# ship in the image and MUST NOT be linked — they change with each deploy and the share would pin a
# stale copy. assets/maps/maps.json is the git-committed SEED for data/maps.json, never the live file.
DATA_MOUNT="${DATA_MOUNT:-/app/appdata}"

if [ -d "$DATA_MOUNT" ]; then
  echo "Persistent storage detected at $DATA_MOUNT — linking data/"
  mkdir -p "$DATA_MOUNT/data"
  rm -rf /app/data
  ln -sf "$DATA_MOUNT/data" /app/data
  echo "  Linked /app/data -> $DATA_MOUNT/data"
else
  echo "No persistent mount at $DATA_MOUNT — leaderboards, Trivia questions, and analytics use ephemeral container storage."
fi

# Run the TypeScript server directly via tsx (see Dockerfile rationale). exec so tini is PID-1 parent
# and SIGTERM reaches node for a clean shutdown.
exec npx tsx server/index.ts
