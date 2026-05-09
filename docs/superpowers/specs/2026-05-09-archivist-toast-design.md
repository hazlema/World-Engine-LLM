# Archivist Toast Notification — Design Spec

**Date:** 2026-05-09  
**Status:** Approved

## Goal

Surface new world entries and threads added by the archivist while the WorldRail is collapsed. Players currently miss these updates unless they manually expand the rail.

## Behavior

- After each `stack-update` message, diff the previous entries/threads against the new ones to find additions.
- If there are any additions AND the relevant rail section is collapsed, show a toast.
- Toast auto-dismisses after **10 seconds**. No click action — it is display-only.
- Only one toast visible at a time. If a new turn fires while a toast is still showing, replace it (reset the 10s timer).
- If the rail section is already expanded when the update arrives, no toast.

## Visual Design

Card style, bottom-right corner of the viewport, fixed position above the input bar.

```
┌─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┐
║▌ WORLD UPDATED              10s ║
║▌ ─────────────────────────────  ║
║▌ the rusted door groans         ║
║▌ ─────────────────────────────  ║
║▌ a thread of candlelight flickers║
║▌ ─────────────────────────────  ║
║▌ iron smell — old blood or rust  ║
└─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┘
```

- **Background:** `#1e1e26` (matches rail cards)
- **Border:** `1px solid #2a2a35`, `border-left: 3px solid var(--ember)`
- **Border-radius:** 6px
- **Width:** ~220px
- **Header:** "WORLD UPDATED" in ember, 11px, 600 weight; faint countdown label top-right
- **Entry lines:** `#bbb`, 11px, separated by `1px solid #2a2a35` dividers — no bullets
- **Threads** use the same format but header reads "THREADS UPDATED"
- **Both in one turn:** one toast reading "WORLD UPDATED" containing all new entries + threads together, separated by dividers
- **Box shadow:** `0 4px 16px rgba(0,0,0,0.5)`
- **Entrance:** fade + slide up (~150ms); exit: fade out (~300ms)

## Data Flow

1. `ws.addEventListener("message")` handles `stack-update`
2. Before updating state, diff `prevStack.entries` vs `msg.entries` and `prevStack.threads` vs `msg.threads` to collect `newEntries[]` and `newThreads[]`
3. If either array is non-empty, fire `setToast({ entries: newEntries, threads: newThreads, id: Date.now() })`
4. Toast component renders, starts a 10s `setTimeout` keyed to `toast.id` — replacing replaces the timer
5. On timeout: `setToast(null)`

## Component

`function Toast({ entries, threads, onDismiss })` — pure display component, no side effects. Timer lives in the parent (`App`) to allow replacement.

## Scope

- Entries and threads only — objectives already get their own system-block treatment.
- No click-to-expand behavior in this version (future: could open the map modal).
- CSS lives in `styles.css` alongside existing `.rail-*` rules.

## Out of Scope

- Map modal (separate feature, toast may eventually link there)
- Per-item entry toasts (always condensed)
- Toast history or log
