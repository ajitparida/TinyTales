# Meadowtale

**Meadowtale** is an interactive warm watercolor picture-book web application crafted for toddlers (**ages 2–3**) and preschoolers (**ages 4–5**). Children can tap friendly characters on every spread, listen with expressive AI storytellers or a parent's own studio-cleaned voice recording, reflect on a gentle moral at the end of every tale, and enjoy a dedicated Bedtime Twilight mode. Parents can also grow the library by scanning physical books and screenshots or creating custom storybooks manually with their own text and artwork.

---

## Features

- **Curated Watercolor Library** — Handcrafted picture books tailored to **Ages 2–3** and **Ages 4–5**, searchable by title, subtitle, or core value, with completion stars per child reader profile.
- **Interactive Story Reader** — Tap-to-react character hotspots with gentle sound cues and spoken bubbles, word-by-word follow-along highlighting, and an end-of-story Moral Celebration card with a parent talk-together prompt.
- **Multi-Engine Voice Narration**
  - **AI Storyteller Voices** — Five personas (*Warm Storyteller*, *Gentle Bedtime*, *Playful Woodland*, *Classic Fairy Tale*, *Cozy Grandpa*) powered server-side with automatic fallback to the browser's built-in Device Voice if API quota is reached.
  - **Device Voice** — Instant, offline-friendly Web Speech API narration with configurable reading speed (`0.75x`–`1.25x`).
  - **Parent Voice Studio** — Record your own voice per page using browser microphone capture with client-side noise filtering, presence clarity EQ, dynamic range smoothing, and peak normalization (24 kHz mono WAV stored locally in IndexedDB).
- **Storybook Studio (Scan, Create Manually & Edit Anytime)**
  - **Scan Photos / Screenshots** — Upload or photograph physical book pages or story screenshots; extracts printed text verbatim (or age-simplified), auto-splits dense text into short kid-friendly pages (up to 10 pages), generates interactive hotspots, and paints a unique text-free watercolor illustration per page.
  - **Create Book Manually (100% Local)** — Write or paste a full story, auto-split it client-side into short kid-friendly pages, bulk-upload page images, choose a default watercolor backdrop, and save without requiring any scan API call. Includes a 1-click *"Continue Manually with These Photos"* fallback if a scan session is interrupted.
  - **Resize, Crop & Watercolor Framing** — Interactive framing modal with quick crop presets (*Center Art*, *Top Half*, *Bottom Half*, *Whole Image*), zoom (`50%`–`250%`), drag-to-pan, Fill/Fit, 90° rotation, and optional soft watercolor paper finish.
  - **Full Saved-Book Editing** — Edit titles, morals, and page text anytime; replace, redraw, or crop any page image; split, reorder, add, or delete pages; and import additional photos into existing books.
- **Bedtime Twilight Mode & Parental Dashboard**
  - Adult-gated Parent Dashboard with multi-child reader profiles, reading time & moral star logs.
  - Dedicated Bedtime Mode featuring low-blue-light twilight palette, adjustable warm screen dimness, reduced motion, ambient lullaby toggle, sleep countdown timer, and per-session story caps.
- **Local-First with Optional Cloud Sync** — Works immediately in guest mode (`localStorage` + IndexedDB for high-resolution page images and voice recordings) and syncs profiles, bedtime settings, custom book metadata, and reading logs across devices via Firebase Authentication + Cloud Firestore.

---

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite 8, Tailwind CSS v4, Lucide Icons, Motion
- **Backend Proxy**: Node.js + Express (`server.ts`) mounting Vite middleware in development and serving `dist/` in production
- **AI Services** (server-side via `@google/genai`):
  - `gemini-3.1-flash-lite` for physical storybook scanning/auto-splitting and text-free watercolor vector illustration generation
  - `gemini-3.8-flash-lite-tts` for expressive storyteller audio narration
- **Persistence**: Firebase Auth (Google Sign-In) + Cloud Firestore (metadata & logs) + browser IndexedDB (`src/lib/mediaStore.ts` for page artwork and voice recordings)

---

## Prerequisites

- **Node.js 22+** (required for native TypeScript execution in production via `node server.ts` and Vite 8)
- **npm** (or compatible package manager)
- A **Gemini API key** (for AI book scanning, watercolor redraw, and AI TTS narration; manual book creation and Device Voice narration work even without an API key)
- *(Optional)* A **Firebase project** with Authentication (Google provider) and Firestore enabled for cross-device parent cloud sync

---

## Local Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure environment variables**

   Copy `.env.example` to `.env` and fill in your values:

   ```bash
   cp .env.example .env
   ```

   | Variable | Required | Description |
   | --- | --- | --- |
   | `GEMINI_API_KEY` | For AI scan/redraw/TTS | Server-side Gemini API key (never exposed to the browser) |
   | `APP_URL` | Optional | Public URL of the deployed app |

3. **Start the development server**

   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Starts the Express + Vite full-stack development server on port `3000` |
| `npm run lint` | Runs TypeScript static type-checking (`tsc --noEmit`) |
| `npm run build` | Builds the production frontend bundle into `dist/` |
| `npm run start` | Runs `node server.ts` in production mode, serving `dist/` and `/api/*` routes on port `3000` |
| `npm run clean` | Removes `dist/` build output |

---

## Project Structure

```text
.
├── server.ts                    # Express server (port 3000): /api/* Gemini proxies + Vite/static SPA
├── index.html                   # HTML entry point, Google Fonts (Fraunces, Plus Jakarta Sans, IBM Plex Mono)
├── firestore.rules              # Cloud Firestore security rules (owner-scoped parent/child/story/log access)
├── firebase-blueprint.json      # Firestore schema blueprint
├── firebase-applet-config.json  # Client Firebase web config
├── .env.example                 # Environment variable template (no secrets)
├── public/                      # Static watercolor art assets
└── src/
    ├── App.tsx                  # Root state, Firebase/local sync, Bedtime timer & dimness overlay
    ├── index.css                # Tailwind v4 setup, theme tokens, watercolor paper utilities
    ├── types/story.ts           # Core TypeScript domain types
    ├── data/curatedStories.ts   # Built-in curated watercolor storybooks & backdrop map
    ├── components/
    │   ├── TopBar.tsx           # Primary navigation & Bedtime/Account controls
    │   ├── LibraryView.tsx      # Hero spread, search, age/custom filters, shelf grid
    │   ├── StoryCard.tsx        # Storybook card with IndexedDB cover hydration & custom edit/delete
    │   ├── StoryReader.tsx      # Interactive spread reader, hotspots, AI/Device/Parent voice playback & moral card
    │   ├── StoryScanner.tsx     # Unified Create (Scan / Write Manually) & Edit Storybook Studio
    │   ├── PageImageFramingModal.tsx  # Interactive zoom/pan/rotate/preset cropper & watercolor finish
    │   ├── ParentalDashboard.tsx      # Adult-gated dashboard for child profiles, logs, voice & bedtime controls
    │   ├── BedtimeCompleteOverlay.tsx # Gentle bedtime session cap/timer screen
    │   ├── StoryConfetti.tsx          # End-of-story celebration effect
    │   └── ErrorBoundary.tsx          # React error fallback
    └── lib/
        ├── firebase.ts          # Firebase Auth + Firestore CRUD & realtime subscriptions
        ├── mediaStore.ts        # Browser IndexedDB store for page images & parent voice recordings
        ├── audioEngine.ts       # Web Audio API chimes, gentle sound cues & ambient lullaby synthesizer
        ├── voiceStudio.ts       # Client-side microphone capture, speech EQ/filtering & 24kHz WAV encoder
        └── watercolorFilter.ts  # Canvas image compression, watercolor retouch filter & SVG-to-canvas renderer
```

---

## API Routes

All server endpoints live in `server.ts` and strictly return JSON (including 400/404/413/500 errors):

- `GET /api/health` — Service health check (`{ "status": "ok", "service": "meadowtale" }`)
- `POST /api/stories/scan` — Scans 1–6 compressed book page photos/screenshots into structured multi-page storybooks (up to 10 pages) with hotspots and end-of-story moral
- `POST /api/stories/redraw` — Generates sanitized, text-free 4:3 watercolor/pastel/gouache SVG illustrations (supports both photo-guided redraw and pure text/scene generation)
- `POST /api/tts/narrate` — Generates expressive storyteller audio narration with persona styling

---

## Security & Data Model

- **Server-Side API Keys**: `GEMINI_API_KEY` is read exclusively in `server.ts` and never sent to the browser.
- **SVG Sanitization**: All AI-generated SVG artwork passes through a strict allow-clean sanitizer (`sanitizeIllustrationSvg`) that strips `<script>`, `<style>`, `<foreignObject>`, `<image>`, `<text>`, inline event handlers, and unsafe URLs before rendering onto a local HTML5 Canvas.
- **Firestore Security Rules**: `firestore.rules` enforces strict owner-only access (`request.auth.uid == parentId`), validates page count (`1..10`), text length (`<= 3000` chars/page), and forbids storing raw base64 media strings inside Firestore documents (images and audio remain in browser IndexedDB).

---

## Production Build & Publishing

```bash
# 1. Type-check
npm run lint

# 2. Build the production frontend
npm run build

# 3. Start the production server on port 3000
NODE_ENV=production npm run start
```

Verify health once running:

```bash
curl http://localhost:3000/api/health
```
