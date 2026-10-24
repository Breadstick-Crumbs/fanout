# Example: going global (4 sessions)

## foundations
model: opus
owns: src/lib/types.ts, src/server/db/**, src/server/services/matching.ts
exposes: src/lib/types.ts
done: per-country visibility works; typecheck passes; UAE behaviour unchanged

## money
model: sonnet
owns: src/lib/present.ts, src/components/MatchCard.tsx, src/app/(app)/picks/page.tsx
done: no hard-coded currency left; typecheck passes
uses: src/lib/types.ts

## landing
model: opus
owns: src/app/start/**, src/components/landing/**
done: hero says anyone can apply anywhere; mockup reviewed before building
after: foundations, money

## research
model: sonnet
owns: design/catalogue/**
done: source-checked notes with URLs; no code
