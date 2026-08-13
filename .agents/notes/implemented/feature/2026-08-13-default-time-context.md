# Agent Note: Default time context in shipped profiles

Status: implemented

English | [中文](2026-08-13-default-time-context.zh.md)

## Problem

The model in every shipped profile received no current time. `@deepseek-ai/dsh-time-context` existed and was durable, but every default composition left it disabled, so the capability never reached the shipped product. Date-sensitive reasoning — web_search query years are the observed case — then depended entirely on the model's training cutoff, and a model could compose searches for a stale year without any harness signal contradicting it.

## Decision

The dsh-base bundle mounts `time-context` by id with `refreshIntervalMs: 60000`, the first patch layer of every shipped profile (`web`, `headless`, and base-derived custom profiles). Each Web prompt still formats the reading in its Host-validated browser zone; TUI, headless, and other surfaces fall back to the process zone, and any composition can disable or reconfigure the row by id.

The 60-second interval is the shipped balance between the two extremes the plugin offers: omitting the interval appends a reading to every eligible entering step, which floods a long tool-call turn with near-identical clock restatements, while a minute-old reading still pins calendar-date reasoning. The Schedule Web overlay keeps per-step freshness by replacing its own `insert` with an id-targeted override that clears the base config — inserting a second row with the same id fails boot with the loader's duplicate-entry-id rejection — so the overlay remains one patch file with no duplicated row.

The acp-snapshot normalizer tokenizes the two wall-clock fields of a durable reading — the rendered timestamp and the elapsed duration — as `{{timeReadingTimestamp}}` and `{{timeReadingElapsed}}`, keeping turn/step position, browser-zone policy, and baseline verbatim, so a session fixture recorded through a shipped profile replays on any later day.

This reverses the opt-in stance recorded in the [durable per-step time-context Agent Note](2026-07-16-durable-per-step-time-context.md), whose mechanism is unchanged.

## Alternatives considered

- **Mount with no refresh interval, as the Schedule overlay did** — rejected as the general default: every eligible step would append a reading, and a long tool-call turn would accumulate dozens of messages that only restate the clock. A 60-second floor keeps calendar reasoning current while bounding history growth and Web transcript noise to roughly one context row per turn. Compositions that need per-step freshness clear the interval, as Schedule does.
- **Add the current date to the system prompt** — rejected: a dynamic prompt value is not reconstructable from the session log, breaking the model-visible ⟺ logged invariant and historical request reconstruction, while the durable per-step reading is.
- **Mount the row inside each shipped agent preset instead of the host plane** — rejected: a preset row that is also active on the host plane is rejected by the plane-separation gate, and one host-plane row already reaches every agent whose scope chain descends from the host root — preset-joined Web sessions included — so per-preset copies would add collision risk with no coverage gain.
- **Keep time-context opt-in** — rejected: the absence was the shipped default, and the model then has no current clock at all, so date-sensitive tool inputs silently go stale. This is the reversal this note records.

## Consequences

- Every shipped profile now tells the model the current time before an entering step when no reading exists or the latest one is at least a minute old.
- Web transcripts show one context row per turn by default (source `time-context`, snapshot form); the Schedule overlay keeps one per request step.
- The Schedule Web overlay is now an id-targeted config override over the base row, not an insert.
- Snapshot fixtures that boot shipped profiles tokenize time-context readings through the acp-snapshot normalizer; the product headless-profile fixture exercises the default row end to end.
