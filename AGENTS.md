# AGENTS.md — Meadowtale Engineering Guide

This document defines the architecture, invariants, security rules, and verification steps for contributors and AI coding agents working on **Meadowtale**.

---

## 1. Product Summary

Meadowtale is a full-stack interactive watercolor children's picture-book web application (ages **2–3** and **4–5**).

Core user flows:
1. **Library (`LibraryView.tsx`)** — Browse curated & custom books by age tier or search query, switch child profiles, launch stories, or enter the Book Studio in Scan or Manual mode.
2. **Interactive Reader (`StoryReader.tsx`)** — Full-bleed 4:3 picture spreads, tappable character hotspots, word-level follow-along narration (AI TTS with automatic Device Voice fallback, built-in Device Voice, or studio-cleaned Parent Voice recordings), and an end-of-story Moral Celebration card.
3. **Storybook Studio (`StoryScanner.tsx` + `PageImageFramingModal.tsx`)** — Unified flow for:
   - Scanning 1–6 photos/screenshots with verbatim or simplified text extraction and multi-page auto-splitting (up to 10 pages).
   - Creating storybooks 100% manually in the browser (paste & auto-split full text, bulk-upload page images, choose watercolor backdrops — zero server dependency).
   - Editing any saved custom book (metadata, page text, split/reorder/add/delete pages, crop/resize, watercolor retouch, AI redraw, import extra photos).
4. **Parental Dashboard (`ParentalDashboard.tsx`)** — Adult-gated controls for child profiles, reading logs, voice preferences, and Bedtime Twilight settings (dimness scrim, reduced motion, ambient lullaby, sleep timer, session story cap).

---

## 2. Runtime & Build Architecture

- **Single Entry Server (`server.ts`)**: Runs Express on **port `3000`**.
  - Development (`npm run dev` → `tsx server.ts`): Mounts Vite in middleware mode (`vite.middlewares`).
  - Production (`npm run start` → `node server.ts` with `NODE_ENV=production`): Serves built static assets from `dist/` with SPA fallback.
  - **Never** mount Express inside `vite.config.ts`.
- **Styling**: Tailwind CSS v4 via `@import "tailwindcss";` in `src/index.css`. Avoid separate per-component CSS files or ad-hoc inline styles unless dynamic (e.g., hotspot `x`/`y` coordinates or bedtime dimness opacity).
- **TypeScript**: Strict ES modules (`"type": "module"`). Keep all imports at top level and use standard enums only.

---

## 3. Non-Negotiable Invariants

### Server & AI Proxy (`server.ts`)
- **Secrets stay server-side**: `GEMINI_API_KEY` must only be read in `server.ts`. Never create browser UI for API keys or pass `GEMINI_API_KEY` into `VITE_*` variables.
- **API routes always return JSON**:
  - `app.use(express.json({ limit: '30mb' }))` handles multi-photo base64 payloads.
  - An `/api/*` 404 JSON catch-all and an Express `/api` JSON error handler (covering `413`, `400`, `500`) must stay registered **before** Vite/SPA HTML fallbacks so API callers never silently receive `<!doctype html>`.
- **Client API resilience**: `StoryScanner.tsx` sends images compressed via `compressDataUrlForApi` (`src/lib/watercolorFilter.ts`) and uses `postApiJson` with HTML-response detection, single retry, and a 1-click **"Continue Manually with These Photos"** fallback if scanning fails.
- **Free-Tier Models Only**:
  - Story scan & SVG illustration generation: `gemini-3.1-flash-lite` (`ThinkingLevel.MINIMAL` for redraw).
  - Expressive narration TTS: `gemini-3.8-flash-lite-tts` (on HTTP `429` quota exhaustion, `StoryReader.tsx` automatically falls back to browser Web Speech API).
  - Do **not** switch to paid image models without explicit user approval.
- **SVG Safety**: All model-generated SVG strings must pass through `sanitizeIllustrationSvg` in `server.ts` (strips `<script>`, `<style>`, `<foreignObject>`, `<iframe/object/embed/image>`, `<text>/<tspan>`, inline `on*` handlers, and unsafe `href`/`xlink:href`) and are rasterized locally via `renderRedrawnSvgToWatercolorCanvas` before display/storage.

### Firebase & Local Storage (`src/lib/firebase.ts`, `src/lib/mediaStore.ts`, `firestore.rules`)
- **No base64 blobs in Firestore**: High-resolution page images and parent voice WAV clips are stored exclusively in browser IndexedDB (`src/lib/mediaStore.ts`), referenced by sanitized `mediaId` keys on `Story` / `StoryPage`.
- **Honor `firestore.rules` strictly**:
  - Every custom story must have `1 <= pages.length <= 10`, with each page's `text.length <= 3000`.
  - `updateCustomStoryCloud` must use `updateDoc` and include **only** the 11 mutable fields permitted by `firestore.rules` (`title`, `subtitle`, `ageGroup`, `moralTitle`, `moralLesson`, `parentDiscussionPrompt`, `coverMediaId`, `coverFallbackId`, `readMinutes`, `pages`, `updatedAt`) — never overwrite immutable creation metadata (`id`, `isCustom`, `createdAt`, `createdAtMs`) on update.
  - All Firestore paths are owner-scoped under `parents/{parentId}/...` with `request.auth.uid == parentId`.
- **Cover Resolution**: When displaying any `Story` cover (e.g., `StoryCard.tsx`, `LibraryView.tsx` featured hero), always resolve in order: `coverImageUrl` → IndexedDB `coverMediaId` → IndexedDB `pages[0].mediaId` → `BACKDROP_ART_MAP[coverFallbackId]`, with an `onError` fallback guard.

### Visual & UX System
- **Typography**: `Fraunces` (`.font-display`) for headings/story titles, `Plus Jakarta Sans` for body/UI, `IBM Plex Mono` (`tabular-nums`) for timers, page counters, and metrics.
- **Dual-Theme Parity**: Every new surface, border, input, and button must maintain crisp contrast in both:
  - **Daytime Cotton Paper**: `#FAF8F4` canvas, `#FFFFFF` cards, `#E6E1D8` borders, `#24292E` ink, `#2F7A5E` forest-sage primary CTA.
  - **Bedtime Twilight (`dark:*`)**: `#121624` canvas, `#1A2033` cards, `#2A324B` borders, `#EDE9DF` warm cream ink, `#E5A94C` warm amber primary CTA.
- **Restraint**: Avoid static decorative pill badges and status/telemetry clutter in the UI. Keep navigation links single-line (`whitespace-nowrap`). Never use `window.alert` or `window.open`.

---

## 4. Key Files Map

| Area | Files |
| --- | --- |
| Backend & AI Proxy | `server.ts` |
| App State & Routing | `src/App.tsx`, `src/types/story.ts` |
| Library & Navigation | `src/components/TopBar.tsx`, `src/components/LibraryView.tsx`, `src/components/StoryCard.tsx` |
| Interactive Reader | `src/components/StoryReader.tsx`, `src/components/StoryConfetti.tsx`, `src/lib/audioEngine.ts`, `src/lib/voiceStudio.ts` |
| Storybook Studio (Scan / Manual / Edit) | `src/components/StoryScanner.tsx`, `src/components/PageImageFramingModal.tsx`, `src/lib/watercolorFilter.ts` |
| Parents & Bedtime | `src/components/ParentalDashboard.tsx`, `src/components/BedtimeCompleteOverlay.tsx` |
| Data & Persistence | `src/data/curatedStories.ts`, `src/lib/firebase.ts`, `src/lib/mediaStore.ts`, `firestore.rules` |

---

## 5. Verification Checklist Before Finishing Any Change

1. **Type-check**: `npm run lint` (`tsc --noEmit`) — must pass with 0 errors.
2. **Production build**: `npm run build` (`vite build`) — must succeed cleanly.
3. **Server check** (when `server.ts` changes):
   - `node --check server.ts`
   - Verify `GET /api/health` returns HTTP `200` JSON.
   - Verify unknown `/api/*` routes return HTTP `404` JSON (not HTML).
4. **Firestore rules check** (when `firestore.rules` or `src/lib/firebase.ts` changes):
   - Confirm written/updated document fields match the allowed keys and size limits in `firestore.rules`.
   - Deploy updated rules if `firestore.rules` changed.
5. **Security hygiene**:
   - Confirm `.env.example`, `README.md`, and `AGENTS.md` contain zero real API keys or private credentials.
   - Confirm `metadata.json` and `index.html` title/meta descriptions stay in sync.
