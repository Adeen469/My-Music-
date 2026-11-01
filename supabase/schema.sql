-- My Music — Supabase table for saved tracks.
-- Run this in Supabase SQL Editor. No sample rows are inserted.
create table if not exists public.saved_tracks (
  id bigint generated always as identity primary key,
  user_email text not null,
  video_id text not null,
  title text not null default '',
  channel text not null default '',
  thumbnail text not null default '',
  -- Direct audio file link the user attached (own / licensed file only).
  -- Empty for YouTube tracks: there is no file to download for those.
  download_url text not null default '',
  created_at timestamptz not null default now(),
  unique (user_email, video_id)
);
-- For tables created before this column existed:
alter table public.saved_tracks add column if not exists download_url text not null default '';
-- The backend uses the service-role key server-side, so no RLS policies
-- are required for this starter. If you expose Supabase to the browser
-- later, enable RLS and add per-user policies before doing so.

-- My Music — registered users for admin approval (added 2026-11-01).
-- First Google sign-in creates a row with status 'pending' and does
-- NOT sign the user in. An admin approves it in /admin, after which
-- sign-in works. Rejecting sets status 'rejected'. Removing a user
-- deletes the row, so their next sign-in is a fresh pending request.
-- No sample rows are inserted.
create table if not exists public.my_music_users (
  id bigint generated always as identity primary key,
  user_email text not null unique,
  name text not null default '',
  picture text not null default '',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  approved_at timestamptz
);

-- My Music — server playlists for public sharing (added 2026-11-01).
-- Before this, playlists lived only in browser localStorage, so a
-- "Public" playlist could never be seen by another user. Now a
-- playlist marked Public is stored here and readable by ANY user
-- (signed in or not) through the server API. Private playlists are
-- never stored here. File tracks are never synced (only YouTube
-- tracks, whose links are public anyway). No sample rows.
create table if not exists public.my_music_playlists (
  id bigint generated always as identity primary key,
  owner_email text not null,
  owner_name text not null default '',
  name text not null,
  visibility text not null default 'public' check (visibility in ('public', 'private')),
  created_at timestamptz not null default now(),
  unique (owner_email, name)
);
create table if not exists public.my_music_playlist_tracks (
  id bigint generated always as identity primary key,
  playlist_id bigint not null references public.my_music_playlists (id) on delete cascade,
  video_id text not null,
  title text not null default '',
  channel text not null default '',
  thumbnail text not null default '',
  duration_seconds integer not null default 0,
  position integer not null default 0,
  created_at timestamptz not null default now()
);
