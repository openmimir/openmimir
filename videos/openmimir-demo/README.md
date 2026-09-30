# OpenMimir demo video

The 40-second demo on openmimir.com, built with [HyperFrames](https://hyperframes.heygen.com). The middle section
shows the real app in trainer mode, captured from a throwaway instance with demo data, so no real sessions appear.

To regenerate after the app changes:

```sh
# 1. A throwaway Mimir with every agent switched off (see BRIEF.md for the config used)
MIMIR_HOME=/tmp/mimir-demo bun run ../../apps/cli/src/index.ts serve    # port from its config.json

# 2. Seed each stage and capture trainer mode at 1920x1080
for s in 0 1 2 3 4 5 6 7; do
  MIMIR_HOME=/tmp/mimir-demo bun tools/seed.ts $s
  bun tools/shoot.ts "http://localhost:<port>/?mode=trainer" assets/img/trainer-$s.png 3500
done

# 3. Voices (OpenAI TTS; Mimir uses "marin", the app's live voice). Needs OPENAI_API_KEY.
bun tools/voices.ts            # or: bun tools/voices.ts m1 m3  to redo single lines

# 4. Check, render, and make the web copy
npx hyperframes check
npx hyperframes render --quality high --output renders/video.mp4
ffmpeg -i renders/video.mp4 -c:v libx264 -preset slow -crf 21 -movflags +faststart \
  -af loudnorm=I=-16:TP=-1.5:LRA=11 -c:a aac -b:a 160k ../../apps/site/public/demo.mp4
```

If a voice line changes length, update its `data-start`/`data-duration` in `index.html` and the
matching entry in the `lines` array (speech window `a`/`b`).
