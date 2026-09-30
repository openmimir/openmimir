---
workflow: product-launch-video
flow: automation
storyboard: no
message: "Talk to all your coding agents, hands-free."
angle: voiced-conversation
destination: youtube
aspect: "16:9"
length: 40s
language: en
audience: developers who run Claude Code, Codex or OpenCode
---

## Intent

Voiced conversation (user's pick). The real OpenMimir app on screen, captured from a throwaway instance seeded with
demo sessions, while a spoken conversation plays: a voice asks, Mimir reads the plan back, the user says "yes", a
Claude Code session goes Working -> Finished, Mimir reports the result aloud. Short text cards frame it:
"Talk to all your coding agents."

## Customizations

- Feature the app's own captured screens as the video's assets (show-it-as-is for the middle section).
- Voices: two generated voices, "user" and "Mimir" (user's pick). Anonymous, no footage of the maker.
- Review: none; build from this brief and show the finished cut (user's pick: "Just build it").

## Assets

- App screens: captured from `mimir serve` with a temp MIMIR_HOME and demo data (tools/seed.ts).
- Logos: apps/site/public/icons (Claude Code, Codex, OpenCode) and the OpenMimir favicon.

## Notes

- Used on the home page hero, the README, Show HN and YouTube.
- Claude Code is the most prominent agent (user preference from the site work).
- Never show the maker's real sessions or project names.
