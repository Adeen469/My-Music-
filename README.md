# My Music

A YouTube Music-style app with a backend, powered by the **real YouTube Data API**.
There is **no sample data**: search, trending and library results are only ever
real API / Supabase results. If the API is not connected yet, the app shows an
empty state and a clear message instead of fake songs.

## Features

- Home with trending music (YouTube category: Music)
- Search songs, artists and albums
- Bottom player using the YouTube embed player
- No sign-in needed (for now): Google sign-in is disabled — see “Authentication” below
- Save tracks to your Library, stored in this browser while sign-in is disabled
- Download + Offline: every card and the player have a Download button,
  plus “Save to a folder…” where the browser supports a save picker.
  Downloaded copies are also kept in the browser (IndexedDB) under
  **Offline**, and play there without internet.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Fill in the `.env` file in the **root folder** of this repo — see
   `.env.example` for the full blank template (it lists `YOUTUBE_API_KEY`,
   `GROQ_API_KEY`, `AUTH_ENABLED`, Google, Supabase and `ADMIN_*` names,
   all blank). **Do not paste real keys in chat, and do not commit a
   filled-in `.env`** — it is gitignored. For deployment, set the same
   names as environment variables in your hosting dashboard.
3. In Supabase, run `supabase/schema.sql` in the SQL Editor to create the
   `saved_tracks` table. No sample rows are inserted. (Not needed while
   sign-in is disabled — Library is local then — but keep it for when
   sign-in returns.)
4. Google sign-in is disabled for now, so skip the Google Cloud callback
   step until you re-enable it with `AUTH_ENABLED=true` (see
   “Authentication” below).
5. Run it:
   ```bash
   npm start
   ```
   Then open http://localhost:3000

## Authentication — disabled for now

Google sign-in is **disabled** (2026-11-01 decision): the app needs no
account at all right now. The top bar shows “No sign-in needed”, the
Google routes return 503, and Library / Save work locally in the
browser (`localStorage`) instead of Supabase.

The Google code is **kept, not deleted**, so it can come back later:
set `AUTH_ENABLED=true` in Vercel, keep `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET` and the callback URI configured, and redeploy.

## Environment variables in Vercel

- `YOUTUBE_API_KEY` — the YouTube Data API key (the older name
  `YOUTUBE_DATA_API` also works). Without it, search/trending show the
  “API not connected” message instead of fake songs.
- `GROQ_API_KEY` — reserved for future AI features. It is only reported
  as set/unset by `/api/health`; nothing uses it yet.
- `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD` — reserved for a future
  default admin account. **No admin login exists yet**, and no admin
  password is in this repo. Set the password only as a Vercel env var,
  make it a strong unique password (do not use a short default), and
  never commit it or paste it in chat.

## Pages (separate URLs, like YouTube Music)

- `/` — Home, `/explore` — Explore, `/library` — Library
- `/song/<videoId>` — song page: cover, artist link, Play, Save, Share (copies its link), Related
- `/artist/<channel name>` — artist page: avatar, song list, Play, Share (only songs actually by that channel, via `/api/artist/:name`)
- `/profile` — profile page: no sign-in needed, saved-track count + saved list in this browser
- `/watch?v=<videoId>` works as an alias for a song page.
The server serves the same app for all of these, so a shared link or a refresh on a song/artist page does not 404. Back/forward buttons work via browser history.

## Frontend — Tailwind UI + bridge

The frontend is the uploaded Tailwind UI (`public/index.html`, zero
dummy data) plus `public/bridge.js`, which connects its
`window.MyMusicAPI` to this backend: trending/search from YouTube,
Library from this browser (no sign-in), Offline from IndexedDB, and
Downloads. YouTube tracks play through the youtube-nocookie embed
(patched into the UI's playback code); file tracks play through the
UI's native `<audio>` engine. No YouTube stream is extracted.

## Downloads & offline — where files actually go

- **Download** (no picker): the file goes to the browser's Downloads
  folder. On a phone that is Files &gt; Downloads. The app cannot force
  a different folder on mobile — that is a browser limit, not a bug.
  To be asked every time, turn on “Ask where to save each file” in your
  browser's download settings.
- **Save to a folder…**: on desktop Chrome this opens a save picker, so
  you choose the folder and filename. The button is hidden on browsers
  without that picker, where Download (above) is the only option.
- **Offline in the app**: every successful download is also stored in
  IndexedDB in this browser and listed under **Offline**, where it plays
  without internet. Removing it there only removes the in-app copy, not
  the file already in Downloads.
- **Add your own audio file**: Offline has a form for a title, artist
  and direct audio link (MP3 etc.) that you own or have rights to. That
  track plays with the HTML audio player (not the YouTube embed) and can
  be downloaded the same way.
- **YouTube tracks**: search / trending songs are YouTube embeds — there
  is no audio file in this app to download, and this app does not extract
  YouTube streams (that would break YouTube's terms and the artists'
  rights, and risk the API key). On a YouTube track, Download asks you
  to paste your own / licensed file link for that song, and downloads
  that file instead. YouTube's own offline saving stays inside the
  YouTube / YouTube Music app with Premium.

## Ads

- My Music itself shows no ads: no banners, no AdSense, no ad SDK.
- Playback uses YouTube's privacy-enhanced embed (`youtube-nocookie.com`),
  which does not set tracking cookies before play. This is the closest
  official option to an ad blocker inside an app, but it is **not a
  guaranteed ad blocker**: YouTube states that ads can still be served
  (non-personalised) on monetised videos, and no code in this app can
  reliably strip ads out of YouTube's cross-origin iframe. Stripping
  YouTube's video streams to bypass ads would also break YouTube's terms
  and risk the API key, so this app does not do that.
- The only guaranteed ad-free playback is playing while signed in with a
  YouTube Premium account. A browser ad-blocker extension on your own
  device (for example uBlock Origin) can also reduce ads in your own
  browser, but that is outside this app and YouTube changes its ad
  delivery often, so it is not guaranteed either.

## How it works

- The browser never sees your YouTube API key or Supabase service key.
  The backend in `server.js` proxies YouTube (`/api/search`, `/api/trending`,
  `/api/video/:id`, `/api/related/:id`) and talks to Supabase
  (`/api/library`) server-side only.
- Google sign-in: `/auth/google` → `/auth/google/callback`.
- If a key is missing, the backend returns a `503` with a plain message
  (for example, "YOUTUBE_DATA_API is not set in .env") instead of fake data.

## Deploying to Vercel

This repo uses Vercel's Express deployment with the output directory
`public` (see `vercel.json`). The entrypoint Vercel looks for must live
inside that output directory, so `public/server.js` is a small shim that
directly requires Express and re-exports the real app from the root
`server.js` (which also serves the frontend from `public/` itself).
There is deliberately **no `api/` folder and no rewrites** — an earlier
version had both, and Vercel's build failed twice: first with
`No entrypoint found which imports express. Found possible entrypoint: app.js`
(the frontend file `public/app.js` looked like a server entrypoint), then
with `No entrypoint found in output directory: "public"` (deleting
`vercel.json` did not clear the Output Directory saved in the Vercel
project settings, so Vercel only searched inside `public/`). The frontend
script is therefore named `public/main.js`, not `app.js`, and the
entrypoint shim is `public/server.js`. Locally, `npm start` still runs
the root `server.js` directly. If you ever clear the Output Directory in
the Vercel project settings, the root `server.js` alone would also work
— but with `vercel.json` setting it to `public`, the shim is the path
that is actually used.

After importing the repo into Vercel, set these environment variables in the
Vercel project settings (Production) — do not paste real values in chat:
`YOUTUBE_API_KEY` (or `YOUTUBE_DATA_API`), `GROQ_API_KEY`,
`ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD` (Vercel only, strong password),
plus Supabase vars if you use them later. Google vars are only needed when
you re-enable sign-in with `AUTH_ENABLED=true`, with
`GOOGLE_REDIRECT_URI` set to `https://<your-project>.vercel.app/auth/google/callback`
(also add that URL as an authorised redirect URI in Google Cloud Console).
Then redeploy. Until the YouTube key is set, the deployed site will load
but show the same "API not connected" message as locally. Adding or changing
an env var in Vercel needs a redeploy to take effect.

## Project structure

```
.env                  # root env file (gitignored, fill in locally)
.env.example          # blank template for .env
server.js             # Express backend + YouTube / Google / Supabase APIs (also the Vercel entrypoint)
public/               # frontend (index.html = Tailwind UI, bridge.js = backend wiring)
supabase/schema.sql   # saved_tracks table
```
