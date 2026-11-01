// My Music backend bridge for the Tailwind UI in index.html.
// This file is INVISIBLE: it adds no buttons, no nav items, no layout
// changes. It only connects window.MyMusicAPI to the real backend and
// plays YouTube tracks through a hidden embed (see below).
// Track shape used by the UI: { id, title, artist, album, cover,
//   audioUrl, videoId, duration }
//  - File tracks (audioUrl set): the UI's native <audio> engine plays them.
//  - YouTube tracks: audioUrl is null, videoId is the YouTube id. The
//    UI's own startPlayback would otherwise mark them "playing" with no
//    sound, so this bridge plays them through a hidden youtube-nocookie
//    embed instead. No stream is extracted, and no YouTube track ever
//    pretends to play from the audio element.
(function () {
  // YouTube IFrame Player API: this is what makes seek, progress,
  // duration and volume actually work for YouTube tracks. A plain
  // nocookie embed with autoplay cannot report time or seek, so the
  // old hidden-iframe approach left everything at 0:00 and made the
  // scrubber and volume do nothing for YouTube songs.
  const ytDiv = document.createElement("div");
  ytDiv.id = "yt-player-div";
  ytDiv.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden;";
  document.body.appendChild(ytDiv);
  // Fallback iframe, used only if the IFrame API never loads.
  const yt = document.createElement("iframe");
  yt.id = "yt-engine";
  yt.allow = "autoplay; encrypted-media";
  yt.allowFullscreen = true;
  yt.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;border:0;";
  document.body.appendChild(yt);
  let ytPlayer = null;
  let ytReady = false;
  let ytPendingId = null;
  window.__ytState = { current: 0, duration: 0 };
  window.__ytSeekTo = (sec) => { try { if (ytPlayer && ytReady) ytPlayer.seekTo(Math.max(0, sec), true); } catch {} };
  window.__ytSetVolume = (vol100) => { try { if (ytPlayer && ytReady) ytPlayer.setVolume(Math.max(0, Math.min(100, vol100))); } catch {} };
  window.__ytPlay = () => { try { if (ytPlayer && ytReady) ytPlayer.playVideo(); } catch {} };
  window.__ytPause = () => { try { if (ytPlayer && ytReady) ytPlayer.pauseVideo(); } catch {} };
  function ytLoad(id) {
    ytPendingId = id;
    if (ytPlayer && ytReady) { yt.src = ""; ytPlayer.loadVideoById(id); }
    else { yt.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`; }
  }
  function ytStop() { ytPendingId = null; yt.src = ""; try { if (ytPlayer && ytReady) ytPlayer.stopVideo(); } catch {} }
  window.onYouTubeIframeAPIReady = () => {
    try {
      ytPlayer = new YT.Player("yt-player-div", {
        height: "1", width: "1",
        playerVars: { autoplay: 0, rel: 0, playsinline: 1 },
        events: {
          onReady: () => { ytReady = true; if (ytPendingId) { yt.src = ""; ytPlayer.loadVideoById(ytPendingId); } },
          onStateChange: (e) => {
            // 0 = ended -> autoplay: recommended next if autoplay is on,
            // otherwise the next track in the queue.
            if (e.data === 0) { try {
              if (isRepeat && ytPlayer) ytPlayer.playVideo();
              else if (window.__autoplayOn !== false && typeof window.__playRecommendedNext === "function") window.__playRecommendedNext();
              else nextTrack();
            } catch {} }
          },
        },
      });
    } catch {}
  };
  const ytScript = document.createElement("script");
  ytScript.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(ytScript);
  // Poll the player for time/duration and repaint the progress UI.
  setInterval(() => {
    try {
      if (ytPlayer && ytReady && typeof ytPlayer.getCurrentTime === "function") {
        window.__ytState = { current: ytPlayer.getCurrentTime() || 0, duration: ytPlayer.getDuration() || 0 };
        if (typeof updateProgressUI === "function") updateProgressUI();
      }
    } catch {}
  }, 500);

  const API = window.MyMusicAPI;
  if (!API) return;

  function mapItem(it) {
    const isFile = it && String(it.id || "").startsWith("file-");
    return {
      id: it.id,
      title: it.title || "",
      artist: it.channel || "",
      album: it.channel || "",
      cover: it.thumbnail || "",
      audioUrl: it.downloadUrl || null,
      videoId: isFile ? null : it.id,
      downloadUrl: it.downloadUrl || null,
      duration: it.durationSeconds || 0, // real YouTube duration when the server returns it; 0 only if unknown, never invented
      publishedAt: it.publishedAt || "",
    };
  }
  function artistsFrom(tracks) {
    const seen = new Map();
    tracks.forEach((t) => { if (t.artist && !seen.has(t.artist)) seen.set(t.artist, { id: t.artist, name: t.artist, cover: t.cover, subscribers: "" }); });
    return [...seen.values()];
  }
  function localSaved() { try { return JSON.parse(localStorage.getItem("my_music_saved_tracks") || "[]"); } catch { return []; } }
  function localFiles() { try { return JSON.parse(localStorage.getItem("my_music_file_tracks") || "[]"); } catch { return []; } }
  function saveLocal(track) {
    const list = localSaved();
    if (!list.some((t) => t.id === track.id)) list.push({ id: track.id, title: track.title, channel: track.artist, thumbnail: track.cover, downloadUrl: track.downloadUrl || null });
    localStorage.setItem("my_music_saved_tracks", JSON.stringify(list));
  }

  // ---- OFFLINE FILES (2026-11-01, user request) ----
  // "Users can save any file offline (download) in their browser."
  // Audio bytes live in IndexedDB in THIS browser only — they are
  // never uploaded, never synced to another device, and are lost if
  // site data is cleared. That is also why this is safe for file
  // tracks only: a YouTube song has no file to save, and extracting
  // a YouTube stream is never done here. For a YouTube track, Save
  // offline only works if that track already carries the user's own
  // / licensed direct file link (downloadUrl); otherwise the user
  // is told to add their own audio file in Library > Offline.
  const OFFLINE_DB = "my_music_offline", OFFLINE_STORE = "files";
  window.__offlineFiles = [];
  const __offlineBlobUrls = new Map();
  function openOfflineDB() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) { reject(new Error("This browser does not support offline storage")); return; }
      const req = indexedDB.open(OFFLINE_DB, 1);
      req.onupgradeneeded = () => { try { req.result.createObjectStore(OFFLINE_STORE, { keyPath: "id" }); } catch {} };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("Could not open offline storage"));
    });
  }
  function offlineTx(db, mode, fn) {
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(OFFLINE_STORE, mode);
        const req = fn(tx.objectStore(OFFLINE_STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("Offline storage failed"));
      } catch (e) { reject(e); }
    });
  }
  async function offlinePut(rec) {
    const db = await openOfflineDB();
    try { await offlineTx(db, "readwrite", (s) => s.put(rec)); } finally { try { db.close(); } catch {} }
  }
  async function offlineGet(id) {
    const db = await openOfflineDB();
    try { return await offlineTx(db, "readonly", (s) => s.get(id)); } finally { try { db.close(); } catch {} }
  }
  async function offlineDelete(id) {
    const db = await openOfflineDB();
    try { await offlineTx(db, "readwrite", (s) => s.delete(id)); } finally { try { db.close(); } catch {} }
  }
  async function offlineListAll() {
    const db = await openOfflineDB();
    try { return await offlineTx(db, "readonly", (s) => s.getAll()); } finally { try { db.close(); } catch {} }
  }
  async function loadOfflineFiles() {
    try {
      const rows = await offlineListAll();
      window.__offlineFiles = (rows || []).map((r) => ({
        id: r.id,
        title: r.title,
        artist: r.artist,
        cover: r.cover || "",
        fileName: r.fileName || "",
        mimeType: r.mimeType || (r.blob && r.blob.type) || "application/octet-stream",
        size: r.blob ? r.blob.size : 0,
        source: r.source || "upload",
        createdAt: r.createdAt || 0,
      })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch { window.__offlineFiles = []; }
    return window.__offlineFiles;
  }
  async function offlineBlobUrl(id) {
    if (__offlineBlobUrls.has(id)) return __offlineBlobUrls.get(id);
    const rec = await offlineGet(id);
    if (!rec || !rec.blob) return null;
    const url = URL.createObjectURL(rec.blob);
    __offlineBlobUrls.set(id, url);
    return url;
  }
  async function saveBlobOffline({ id, title, artist, cover, blob, fileName, mimeType, source }) {
    if (!blob) throw new Error("No file to save");
    const MAX_BYTES = 50 * 1024 * 1024;
    if (blob.size > MAX_BYTES) throw new Error("File exceeds the 50 MB offline storage limit");
    await offlinePut({
      id,
      title: title || "Untitled",
      artist: artist || "",
      cover: cover || "",
      fileName: fileName || "",
      mimeType: mimeType || blob.type || "application/octet-stream",
      blob,
      source: source || "upload",
      createdAt: Date.now(),
    });
    await loadOfflineFiles();
  }
  async function fetchBlobWithFallback(link) {
    try {
      const directRes = await fetch(link);
      if (directRes.ok) return await directRes.blob();
    } catch {
      // Direct fetch blocked by CORS or network error — fallback to server proxy
    }
    const proxyRes = await fetch(`/api/offline-proxy?url=${encodeURIComponent(link)}`);
    if (!proxyRes.ok) {
      const errData = await proxyRes.json().catch(() => ({}));
      throw new Error(errData.error || `Could not download file (${proxyRes.status})`);
    }
    return await proxyRes.blob();
  }
  function isPlayableMedia(mimeType, fileName) {
    const m = String(mimeType || "").toLowerCase();
    const f = String(fileName || "").toLowerCase();
    return m.startsWith("audio/") || m.startsWith("video/") || /\.(mp3|m4a|wav|ogg|flac|aac|webm|mp4|opus)$/i.test(f);
  }
  function inferExtension(fileName, mimeType) {
    const match = /\.([a-z0-9]{1,8})$/i.exec(String(fileName || "").trim());
    if (match) return `.${match[1].toLowerCase()}`;
    const m = String(mimeType || "").toLowerCase();
    if (m.includes("mpeg") || m.includes("mp3")) return ".mp3";
    if (m.includes("mp4") || m.includes("m4a")) return ".m4a";
    if (m.includes("wav")) return ".wav";
    if (m.includes("ogg")) return ".ogg";
    if (m.includes("flac")) return ".flac";
    if (m.includes("webm")) return ".webm";
    if (m.includes("pdf")) return ".pdf";
    if (m.includes("json")) return ".json";
    if (m.includes("text/plain")) return ".txt";
    if (m.includes("png")) return ".png";
    if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
    return "";
  }
  const __offlineSavingLocks = new Set();
  window.__saveOfflineFileFromInput = async () => {
    if (__offlineSavingLocks.has("input")) return;
    const input = document.getElementById("offline-file-input");
    const filesList = input && input.files ? Array.from(input.files) : [];
    if (!filesList.length) { API.notify("Choose a file from your device first"); return; }
    __offlineSavingLocks.add("input");
    const btn = document.getElementById("offline-save-file-btn");
    if (btn) btn.disabled = true;
    try {
      let savedCount = 0;
      const storedTracks = localFiles();
      for (const file of filesList) {
        const id = `file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const title = file.name.replace(/\.[^.]+$/, "") || file.name || "Untitled";
        await saveBlobOffline({
          id,
          title,
          artist: isPlayableMedia(file.type, file.name) ? "Local file" : (file.type || "Offline file"),
          cover: "",
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
          blob: file,
          source: "upload",
        });
        if (isPlayableMedia(file.type, file.name)) {
          if (!storedTracks.some((t) => String(t.id) === String(id))) {
            storedTracks.push({ id, title, channel: "Local file", thumbnail: "", downloadUrl: null });
          }
        }
        savedCount++;
      }
      localStorage.setItem("my_music_file_tracks", JSON.stringify(storedTracks));
      if (input) input.value = "";
      API.notify(savedCount === 1 ? `Saved "${filesList[0].name}" offline in this browser` : `Saved ${savedCount} files offline in this browser`);
      if (typeof renderContent === "function") { try { renderContent(); } catch {} }
    } catch (e) {
      API.notify(e.message || "Could not save this file offline");
    } finally {
      __offlineSavingLocks.delete("input");
      if (btn) btn.disabled = false;
    }
  };
  window.__saveOfflineFileFromUrl = async () => {
    if (__offlineSavingLocks.has("url")) return;
    const urlInput = document.getElementById("offline-url-input");
    const nameInput = document.getElementById("offline-url-name");
    const rawUrl = urlInput ? urlInput.value.trim() : "";
    const customName = nameInput ? nameInput.value.trim() : "";
    if (!rawUrl) { API.notify("Paste a direct file URL first"); return; }
    if (!/^https?:\/\//i.test(rawUrl)) { API.notify("Enter a valid http:// or https:// URL"); return; }
    __offlineSavingLocks.add("url");
    const btn = document.getElementById("offline-save-url-btn");
    if (btn) btn.disabled = true;
    try {
      API.notify("Downloading file to browser offline storage…");
      const blob = await fetchBlobWithFallback(rawUrl);
      let urlPathName = "";
      try {
        const u = new URL(rawUrl);
        urlPathName = decodeURIComponent((u.pathname.split("/").pop() || "").trim());
      } catch {}
      const ext = inferExtension(customName || urlPathName, blob.type);
      const baseTitle = customName || (urlPathName ? urlPathName.replace(/\.[^.]+$/, "") : "") || `Offline file ${new Date().toLocaleTimeString()}`;
      const fileName = baseTitle.endsWith(ext) ? baseTitle : `${baseTitle}${ext}`;
      const id = `file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      await saveBlobOffline({
        id,
        title: baseTitle,
        artist: isPlayableMedia(blob.type, fileName) ? "Downloaded URL" : (blob.type || "Offline file"),
        cover: "",
        fileName,
        mimeType: blob.type || "application/octet-stream",
        blob,
        source: "url",
      });
      if (isPlayableMedia(blob.type, fileName)) {
        const files = localFiles();
        if (!files.some((t) => String(t.id) === String(id))) {
          files.push({ id, title: baseTitle, channel: "Downloaded URL", thumbnail: "", downloadUrl: rawUrl });
        }
        localStorage.setItem("my_music_file_tracks", JSON.stringify(files));
      }
      if (urlInput) urlInput.value = "";
      if (nameInput) nameInput.value = "";
      API.notify(`Saved "${baseTitle}" offline in this browser`);
      if (typeof renderContent === "function") { try { renderContent(); } catch {} }
    } catch (e) {
      API.notify(e.message || "Could not download that URL for offline use");
    } finally {
      __offlineSavingLocks.delete("url");
      if (btn) btn.disabled = false;
    }
  };
  window.__saveTrackOffline = async (trackId, preferType = "video") => {
    const key = `track-${trackId}`;
    if (__offlineSavingLocks.has(key)) {
      API.notify("Download already in progress…");
      return;
    }
    __offlineSavingLocks.add(key);
    try {
      const track = (typeof poolById !== "undefined" && poolById.get(trackId))
        || (typeof currentTracks !== "undefined" && currentTracks.find((t) => String(t.id) === String(trackId)))
        || (typeof state !== "undefined" && state.tracks.find((t) => String(t.id) === String(trackId)))
        || (typeof queue !== "undefined" && queue.find((t) => String(t.id) === String(trackId)))
        || { id: trackId, videoId: String(trackId).startsWith("file-") ? null : trackId, title: String(trackId), artist: "" };

      const existing = await offlineGet(trackId).catch(() => null);
      if (existing && existing.blob) {
        await window.__downloadOfflineFile(trackId);
        return;
      }

      const safeTitle = (track.title || "video").replace(/[\\/:*?"<>|]/g, "").trim() || "video";
      const videoId = track.videoId || (!String(track.id || "").startsWith("file-") ? track.id : null);

      // If this is a YouTube video from the site, fetch the stream via /api/youtube/download/:id,
      // save it in browser IndexedDB for offline playback, and trigger browser file download.
      if (videoId && (!track.downloadUrl || !/^https?:\/\//i.test(track.downloadUrl))) {
        const downloadEndpoint = `/api/youtube/download/${encodeURIComponent(videoId)}?type=${encodeURIComponent(preferType)}&title=${encodeURIComponent(track.title || videoId)}`;
        API.notify(`Downloading "${track.title || videoId}" in browser…`);
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          if (errData.botBlocked) {
            API.notify(`YouTube restricted downloading "${track.title || videoId}" (cloud bot protection). Use "Open on YouTube" to watch or save.`);
            return;
          }
          throw new Error(errData.error || `Download failed (${res.status})`);
        }
        const blob = await res.blob();
        const contentType = res.headers.get("content-type") || blob.type || "video/mp4";
        const ext = contentType.includes("webm") ? ".webm" : contentType.startsWith("audio/") ? ".m4a" : ".mp4";
        const fileName = `${safeTitle}${ext}`;

        // Save in browser IndexedDB so it is also available offline in Library > Offline
        try {
          await saveBlobOffline({
            id: track.id || videoId,
            title: track.title || videoId,
            artist: track.artist || "",
            cover: track.cover || "",
            fileName,
            mimeType: contentType,
            blob,
            source: "youtube",
          });
        } catch {
          // Even if IndexedDB quota is full or exceeds 50MB, still trigger browser file download
        }

        // Trigger native browser file download
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

        API.notify(`Downloaded "${fileName}" & saved offline in browser`);
        if (typeof renderContent === "function") { try { renderContent(); } catch {} }
        return;
      }

      let link = track.downloadUrl || track.audioUrl;
      if (link && link.startsWith("blob:")) {
        await window.__downloadOfflineFile(trackId);
        return;
      }
      if (!link || !/^https?:\/\//i.test(link)) {
        API.notify("Could not find a downloadable stream for this track.");
        return;
      }
      API.notify(`Downloading "${track.title || "file"}"…`);
      const blob = await fetchBlobWithFallback(link);
      const ext = inferExtension(link, blob.type) || ".mp4";
      const fileName = `${safeTitle}${ext}`;
      await saveBlobOffline({
        id: trackId,
        title: track.title,
        artist: track.artist || "",
        cover: track.cover || "",
        fileName,
        mimeType: blob.type || "video/mp4",
        blob,
        source: "link",
      });
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
      API.notify(`Downloaded "${fileName}" & saved offline in browser`);
      if (typeof renderContent === "function") { try { renderContent(); } catch {} }
    } catch (e) {
      API.notify(e.message || "Could not download this video");
    } finally {
      __offlineSavingLocks.delete(key);
    }
  };
  window.__saveCurrentTrackOffline = async () => {
    try {
      const cur = (typeof queue !== "undefined" && typeof currentIndex !== "undefined") ? queue[currentIndex] : null;
      if (!cur) { API.notify("No track is playing"); return; }
      await window.__saveTrackOffline(cur.id, "video");
    } catch { API.notify("Could not download this track"); }
  };
  window.__playOfflineFile = async (id) => {
    try {
      const rec = await offlineGet(id);
      if (!rec || !rec.blob) { API.notify("Offline file not found"); return; }
      const url = await offlineBlobUrl(id);
      if (!url) { API.notify("Offline file not found"); return; }
      const meta = (window.__offlineFiles || []).find((f) => String(f.id) === String(id)) || {};
      if (!isPlayableMedia(rec.mimeType || rec.blob.type, rec.fileName || rec.title)) {
        await window.__downloadOfflineFile(id);
        return;
      }
      window.MyMusicAPI.playTrack({ id, title: meta.title || "Offline file", artist: meta.artist || "", album: meta.artist || "", cover: meta.cover || "", audioUrl: url, videoId: null, duration: 0 });
    } catch { API.notify("Could not open this offline file"); }
  };
  window.__downloadOfflineFile = async (id) => {
    try {
      const rec = await offlineGet(id);
      if (!rec || !rec.blob) { API.notify("Offline file not found"); return; }
      const url = URL.createObjectURL(rec.blob);
      const a = document.createElement("a");
      const ext = inferExtension(rec.fileName, rec.mimeType || rec.blob.type) || ".mp3";
      const base = (rec.fileName || rec.title || "offline-file").replace(/[\\/:*?"<>|]/g, "").trim() || "offline-file";
      a.href = url;
      a.download = base.includes(".") ? base : `${base}${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      API.notify(`Downloading "${a.download}"`);
    } catch { API.notify("Could not download this file"); }
  };
  window.__deleteOfflineFile = async (id) => {
    try {
      await offlineDelete(id);
      if (__offlineBlobUrls.has(id)) {
        try { URL.revokeObjectURL(__offlineBlobUrls.get(id)); } catch {}
        __offlineBlobUrls.delete(id);
      }
      const files = localFiles().filter((t) => String(t.id) !== String(id));
      localStorage.setItem("my_music_file_tracks", JSON.stringify(files));
      await loadOfflineFiles();
      API.notify("Offline file deleted");
      if (typeof renderContent === "function") { try { renderContent(); } catch {} }
    } catch { API.notify("Could not delete this offline file"); }
  };

  // ---- RECOMMENDATION ENGINE (local, personal, no account) ----
  // Honest limits, by design: Google sign-in is disabled and the YouTube
  // Data API key cannot read the user's private YouTube watch history,
  // and there is no cross-user data here, so there is NO neural Two
  // Tower, NO collaborative filtering across users, and NO audio
  // fingerprinting / BPM clustering. What this IS:
  //  - Candidate pool: trending + search + related + artist tracks
  //    actually seen in this browser (YouTube's related endpoint is
  //    the closest available proxy for "people who heard X also heard Y").
  //  - Signals, with the weights the user asked for: listen duration
  //    (finish = strongest), repeat, skip <30s = strong dislike,
  //    like/save, search, and time-of-day affinity for tracks the user
  //    already played at a similar hour. All events stay in this
  //    browser's localStorage; nothing is sent to a server account.
  //  - Markov transitions: the user's own A -> B -> C plays, so the
  //    next recommendation after A prefers the B the user actually
  //    played after A before.
  const REC_KEY = "my_music_rec_events";
  let poolById = new Map();
  let recEvents = [];
  try { recEvents = JSON.parse(localStorage.getItem(REC_KEY) || "[]"); } catch { recEvents = []; }
  let currentPlaying = null; // {track, at}
  window.__autoplayOn = true;
  function saveRecEvents() { try { localStorage.setItem(REC_KEY, JSON.stringify(recEvents.slice(-1000))); } catch {} }
  function recordRec(ev) {
    recEvents.push({ at: Date.now(), hour: new Date().getHours(), ...ev });
    if (recEvents.length > 1000) recEvents = recEvents.slice(-1000);
    saveRecEvents();
  }
  function trackStats() {
    const stats = new Map();
    const get = (id) => { if (!stats.has(id)) stats.set(id, { play: 0, finish: 0, skip: 0, partial: 0, like: 0, listened: 0, lastAt: 0, hours: new Set(), channels: new Set() }); return stats.get(id); };
    for (const ev of recEvents) {
      if (!ev.id) continue;
      const s = get(ev.id);
      if (ev.type === "play") { s.play += 1; s.lastAt = Math.max(s.lastAt, ev.at); }
      if (ev.type === "finish") { s.finish += 1; s.listened += ev.listenedSec || 0; }
      if (ev.type === "skip") { s.skip += 1; }
      if (ev.type === "partial") { s.listened += ev.listenedSec || 0; }
      if (ev.type === "like") s.like = 1;
      if (ev.type === "unlike") s.like = 0;
      if (ev.channel) s.channels.add(ev.channel);
      if (typeof ev.hour === "number") s.hours.add(ev.hour);
    }
    // Saved tracks count as likes even if the like event predates this engine.
    for (const s of localSaved()) { const st = get(s.id); st.like = 1; }
    return stats;
  }
  function scoreTrack(track, stats, now) {
    const s = stats.get(track.id);
    if (!s) return 0;
    let score = 0;
    score += s.like * 50;
    score += Math.min(40, s.play * 8);
    score += Math.min(60, s.finish * 20);
    score += Math.min(30, s.play > 1 ? 15 : 0); // repeat = love
    score -= Math.min(60, s.skip * 30); // skip <30s = strong dislike
    if (s.play && track.duration) score += Math.min(40, 40 * Math.min(1, (s.listened / Math.max(1, s.play)) / Math.max(1, track.duration)));
    const daysAgo = (now - s.lastAt) / 86400000;
    if (daysAgo <= 7) score += 10; else if (daysAgo <= 30) score += 5;
    const hour = new Date().getHours();
    for (const h of s.hours) if (Math.abs(h - hour) <= 2 || Math.abs(h - hour) >= 22) score += 10;
    return score;
  }
  function buildMixes() {
    const pool = [...poolById.values()];
    const stats = trackStats();
    const now = Date.now();
    const likedChannels = new Set();
    for (const [id, s] of stats) if (s.like) { const tr = poolById.get(id); if (tr) likedChannels.add(tr.artist); }
    const scored = pool.map((tr) => ({ tr, score: scoreTrack(tr, stats, now), s: stats.get(tr.id) })).sort((a, b) => b.score - a.score);
    const hasHistory = recEvents.some((e) => e.type === "play");
    const recommended = hasHistory ? scored.filter((x) => x.score > 0).slice(0, 20).map((x) => x.tr) : [];
    // Supermix: 70% known favourites, 20% similar artists, 10% new discovery
    const known = scored.filter((x) => x.s && (x.s.play > 0 || x.s.like)).map((x) => x.tr);
    const similar = scored.filter((x) => !known.includes(x.tr) && likedChannels.has(x.tr.artist)).map((x) => x.tr);
    const discovery = scored.filter((x) => !x.s || x.s.play === 0).map((x) => x.tr);
    const supermix = hasHistory ? [...known.slice(0, 14), ...similar.slice(0, 4), ...discovery.slice(0, 2)] : [];
    // Discover Mix: never played, from artists played only 1-2 times, or new trending
    const channelPlays = new Map();
    for (const [, s] of stats) for (const ch of s.channels) channelPlays.set(ch, (channelPlays.get(ch) || 0) + s.play);
    const discover = pool.filter((tr) => { const s = stats.get(tr.id); return !s || s.play === 0; })
      .filter((tr) => { const cp = channelPlays.get(tr.artist) || 0; return cp >= 1 && cp <= 2; })
      .concat(pool.filter((tr) => { const s = stats.get(tr.id); return !s || s.play === 0; }).slice(0, 10))
      .filter((tr, i, arr) => arr.findIndex((x) => x.id === tr.id) === i).slice(0, 20);
    // Replay Mix: most played in the last 30 days
    const replay = scored.filter((x) => x.s && x.s.play > 0 && (now - x.s.lastAt) <= 30 * 86400000)
      .sort((a, b) => (b.s.play * (1 + b.s.finish)) - (a.s.play * (1 + a.s.finish))).slice(0, 20).map((x) => x.tr);
    // New Release Mix: newest songs from liked/followed channels, last 45 days
    const newReleases = pool.filter((tr) => likedChannels.has(tr.artist) && tr.publishedAt && (now - new Date(tr.publishedAt).getTime()) <= 45 * 86400000)
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)).slice(0, 20);
    return { recommended, supermix, discover, replay, newReleases, hasHistory };
  }
  function updateRecommendations() {
    try {
      const mixes = buildMixes();
      window.__recommendations = mixes;
      if (API.setRecommendations) API.setRecommendations(mixes);
    } catch {}
  }
  function finishPreviousTrack() {
    if (!currentPlaying) return;
    const prev = currentPlaying.track;
    let pos = 0, dur = prev.duration || 0;
    try {
      if (prev.videoId && !prev.audioUrl && window.__ytState) { pos = window.__ytState.current || 0; dur = window.__ytState.duration || dur; }
      else if (typeof audio !== "undefined" && audio) pos = audio.currentTime || 0;
    } catch {}
    const type = dur && pos >= dur * 0.8 ? "finish" : pos < 30 ? "skip" : "partial";
    recordRec({ type, id: prev.id, channel: prev.artist, listenedSec: Math.round(pos), durationSec: Math.round(dur) });
    currentPlaying = null;
  }
  function playRecommendedNext() {
    return (async () => {
      try {
        const cur = typeof queue !== "undefined" && typeof currentIndex !== "undefined" ? queue[currentIndex] : null;
        if (!cur) { nextTrack(); return; }
        // 1. Markov: what did this user actually play after this song before?
        const transitions = new Map();
        for (let i = 0; i + 1 < recEvents.length; i++) {
          if (recEvents[i].type === "play" && recEvents[i].id === cur.id && recEvents[i + 1].type === "play") {
            transitions.set(recEvents[i + 1].id, (transitions.get(recEvents[i + 1].id) || 0) + 1);
          }
        }
        const markovId = [...transitions.entries()].sort((a, b) => b[1] - a[1])[0];
        if (markovId && poolById.has(markovId[0])) { window.MyMusicAPI.playTrack(poolById.get(markovId[0])); return; }
        // 2. Best scored pool track not just played
        const mixes = buildMixes();
        const candidate = mixes.recommended.find((tr) => String(tr.id) !== String(cur.id));
        if (candidate) { window.MyMusicAPI.playTrack(candidate); return; }
        // 3. YouTube related = co-listening proxy
        if (cur.videoId) {
          const res = await fetch(`/api/related/${encodeURIComponent(cur.videoId)}`);
          const data = await res.json();
          const items = (data.items || []).map(mapItem);
          items.forEach((tr) => poolById.set(tr.id, tr));
          if (items.length) { window.MyMusicAPI.playTrack(items[0]); return; }
        }
      } catch {}
      nextTrack();
    })();
  }
  window.__playRecommendedNext = playRecommendedNext;

  // ---- Playlists (real, 2026-11-01) ----
  // Why "New playlist" never created one before: handleCreatePlaylist
  // only prompted for a name and the old onCreatePlaylist handler just
  // showed a "not saved yet" toast — there was no storage, no server
  // endpoint and no playlist table anywhere. Playlists still live in
  // this browser's localStorage, exactly like Saved tracks / Library,
  // BUT a playlist marked Public is now also synced to the server
  // (Supabase, /api/playlists) and can be opened by ANY user, signed
  // in or not, via /playlist/<server id>. Private playlists are
  // never synced, and toggling to private deletes the server copy.
  const PL_KEY = "my_music_playlists";
  function loadPlaylists() { try { return JSON.parse(localStorage.getItem(PL_KEY) || "[]"); } catch { return []; } }
  function savePlaylists(list) { try { localStorage.setItem(PL_KEY, JSON.stringify(list)); } catch {} }
  function userPlaylistsForUI() {
    return loadPlaylists().map((pl) => ({
      id: pl.id, name: pl.name, visibility: pl.visibility || "private",
      sub: `${pl.visibility === "public" ? "Public" : "Private"} • ${(pl.tracks || []).length} song${(pl.tracks || []).length === 1 ? "" : "s"}`,
      tracks: pl.tracks || [],
    }));
  }
  function publicPlaylistsForUI() {
    return (window.__publicPlaylists || []).map((p) => ({
      id: `public-${p.id}`, name: p.name, visibility: "public",
      sub: `Public • ${p.track_count} song${p.track_count === 1 ? "" : "s"}${p.owner_name ? ` • by ${p.owner_name}` : ""}`,
      tracks: [],
    }));
  }
  function refreshPlaylistsUI() {
    const all = [...userPlaylistsForUI(), ...publicPlaylistsForUI(), { id: "saved-tracks", name: "Saved tracks", sub: "Local library (no sign-in)" }];
    if (typeof API.setPlaylists === "function") API.setPlaylists(all);
    else if (typeof setCatalogFor === "function") setCatalogFor(currentTracks);
  }
  // PUBLIC PLAYLISTS (2026-11-01): sync local Public playlists to
  // the server so any user can open them; private ones never leave
  // this browser, and a previously-public playlist turned private
  // has its server copy deleted. File tracks are skipped (your own
  // files are not shared). Runs for approved users only.
  async function syncPublicPlaylists() {
    if (!window.__currentUser) return;
    const list = loadPlaylists();
    let changed = false;
    for (const pl of list) {
      try {
        if (pl.visibility === "public") {
          const res = await fetch("/api/playlists", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: pl.name, visibility: "public",
              tracks: (pl.tracks || []).map((t) => ({ id: t.id, videoId: t.videoId || t.id, title: t.title, artist: t.artist || t.channel, channel: t.channel || t.artist, cover: t.cover || t.thumbnail, thumbnail: t.thumbnail || t.cover, duration: t.duration || 0 })),
            }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.id && pl.serverId !== data.id) { pl.serverId = data.id; changed = true; }
        } else if (pl.serverId) {
          await fetch(`/api/playlists/${encodeURIComponent(pl.serverId)}`, { method: "DELETE" });
          delete pl.serverId; changed = true;
        }
      } catch {}
    }
    if (changed) savePlaylists(list);
  }
  async function loadPublicPlaylists() {
    try {
      const res = await fetch("/api/playlists/public");
      const data = await res.json().catch(() => ({}));
      window.__publicPlaylists = res.ok ? (data.playlists || []) : [];
    } catch { window.__publicPlaylists = []; }
    refreshPlaylistsUI();
    if (typeof renderContent === "function") {
      try { if (typeof currentView !== "undefined" && currentView === "landing") renderContent(); } catch {}
    }
  }
  window.__savePublicPlaylistCopy = () => {
    const pl = (typeof routeData !== "undefined" && routeData.publicPlaylist) || null;
    if (!pl || !pl.tracks) return;
    const list = loadPlaylists();
    let name = pl.name; let n = 2;
    while (list.some((p) => p.name.toLowerCase() === name.toLowerCase())) name = `${pl.name} (${n++})`;
    list.push({ id: `pl-${Date.now()}`, name, visibility: "private", tracks: pl.tracks, createdAt: Date.now() });
    savePlaylists(list);
    refreshPlaylistsUI();
    API.notify(`Saved a copy of "${pl.name}" to your playlists`);
  };

  let currentTracks = [];
  function setCatalogFor(tracks, opts = {}) {
    currentTracks = tracks;
    tracks.forEach((tr) => poolById.set(tr.id, tr));
    API.setCatalog({
      tracks,
      albums: opts.albums || [],
      artists: artistsFrom(tracks),
      playlists: opts.playlists || [...userPlaylistsForUI(), ...publicPlaylistsForUI(), { id: "saved-tracks", name: "Saved tracks", sub: "Local library (no sign-in)" }],
      moods: [],
      likedIds: opts.likedIds || localSaved().map((t) => t.id),
    });
    updateRecommendations();
  }

  async function loadTrending() {
    API.setLoading(true);
    try {
      const res = await fetch("/api/trending"); const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load trending");
      setCatalogFor((data.items || []).map(mapItem));
    } catch (e) {
      API.notify(e.message);
      setCatalogFor([]);
    } finally { API.setLoading(false); }
  }
  async function loadLibrary() {
    await loadOfflineFiles().catch(() => {});
    const raw = [...localSaved(), ...localFiles()];
    const saved = [];
    for (const t of raw) {
      const item = mapItem({ id: t.id, title: t.title, channel: t.channel, thumbnail: t.thumbnail, downloadUrl: t.downloadUrl || null });
      // Offline copy wins: if this track is saved in IndexedDB, it
      // plays from the local blob even with no internet.
      try {
        const url = await offlineBlobUrl(t.id).catch(() => null);
        if (url) { item.audioUrl = url; item.videoId = null; }
      } catch {}
      saved.push(item);
    }
    // Uploaded offline files are in localFiles already, but also
    // include any IndexedDB file whose metadata entry was lost.
    for (const f of window.__offlineFiles || []) {
      if (!saved.some((t) => String(t.id) === String(f.id))) {
        const url = await offlineBlobUrl(f.id).catch(() => null);
        if (url) saved.push({ id: f.id, title: f.title, artist: f.artist, album: f.artist, cover: f.cover, audioUrl: url, videoId: null, downloadUrl: null, duration: 0 });
      }
    }
    setCatalogFor(saved, { likedIds: saved.map((t) => t.id) });
  }

  // ---- YouTube playback sync (hidden, no visual change) ----
  // The UI's queue / currentIndex / isPlaying are top-level globals in
  // index.html's script, so they are visible here as global identifiers.
  function syncYouTube() {
    try {
      const cur = queue[currentIndex];
      if (!cur) { ytStop(); return; }
      if (cur.videoId && !cur.audioUrl) {
        if (isPlaying) { if (ytPlayer && ytReady) ytPlayer.playVideo(); else ytLoad(cur.videoId); }
        else { if (ytPlayer && ytReady) ytPlayer.pauseVideo(); else yt.src = ""; }
      } else {
        ytStop();
      }
    } catch { /* queue not ready yet */ }
  }
  API.on("onTrackPlay", (track) => {
    if (track && track.videoId && !track.audioUrl) ytLoad(track.videoId);
    else ytStop();
    if (track) {
      finishPreviousTrack();
      recordRec({ type: "play", id: track.id, channel: track.artist });
      currentPlaying = { track, at: Date.now() };
      poolById.set(track.id, track);
      updateRecommendations();
    }
  });
  function bindPlayPauseSync() {
    const btn = document.getElementById("play-pause-btn");
    if (btn) btn.addEventListener("click", () => setTimeout(syncYouTube, 0));
    // Spacebar also toggles play in the UI; sync after its handler runs.
    document.addEventListener("keydown", (e) => {
      if (e.code === "Space" && !/INPUT|TEXTAREA/.test(document.activeElement && document.activeElement.tagName || "")) {
        setTimeout(syncYouTube, 0);
      }
    });
  }

  // ---- Separate pages: load artist / profile data on route change ----
  async function loadRoute(route) {
    if (route && route.type === "publicPlaylist") {
      if (typeof window.showPublicPlaylist === "function") window.showPublicPlaylist(route.id);
      return;
    }
    if (window.__approvalRequired && typeof window.__currentUser !== "undefined" && !window.__currentUser && typeof window.showLanding === "function") {
      window.showLanding();
      return;
    }
    if (!route) return;
    try {
      if (route.type === "song") {
        if (String(route.id).startsWith("file-")) { renderContent(); return; }
        const videoRes = await fetch(`/api/video/${encodeURIComponent(route.id)}`);
        const video = await videoRes.json();
        if (!videoRes.ok) throw new Error(video.error || "Song not found");
        if (typeof history !== "undefined" && location.pathname !== "/") history.replaceState({}, "", "/");
        window.MyMusicAPI.playTrack(mapItem(video));
        renderContent();
      } else if (route.type === "artist") {
        routeLoading = true; renderContent();
        const res = await fetch(`/api/artist/${encodeURIComponent(route.name)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Artist not found");
        routeData = { song: null, related: [], artistTracks: (data.items || []).map(mapItem), artistName: route.name };
        routeLoading = false; renderContent();
      } else if (route.type === "profile") {
        await loadLibrary();
        renderContent();
      }
    } catch (e) {
      routeLoading = false;
      API.notify(e.message);
      try { renderContent(); } catch {}
    }
  }
  window.addEventListener("myMusicRoute", (e) => loadRoute(e.detail));

  // ---- MyMusicAPI event wiring ----
  let searchTimer = null;
  API.on("onSearch", (q) => {
    if (window.__approvalRequired && !window.__currentUser && typeof window.showLanding === "function") { window.showLanding(); return; }
    if (q) recordRec({ type: "search", query: q });
    clearTimeout(searchTimer);
    if (!q) { loadTrending(); return; }
    searchTimer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`); const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Search failed");
        setCatalogFor((data.items || []).map(mapItem));
        try { searchQuery = ""; renderContent(); } catch { /* render already done by setCatalog */ }
      } catch (e) { API.notify(e.message); }
    }, 350);
  });
  API.on("onLikeToggle", ({ id, liked }) => {
    recordRec({ type: liked ? "like" : "unlike", id });
    updateRecommendations();
    if (liked) {
      const track = currentTracks.find((t) => String(t.id) === String(id));
      if (track) saveLocal(track);
      API.notify("Saved to your Library in this browser (no sign-in).");
    } else {
      const list = localSaved().filter((t) => String(t.id) !== String(id));
      localStorage.setItem("my_music_saved_tracks", JSON.stringify(list));
      API.notify("Removed from Library.");
    }
  });
  API.on("onPlaylistSelect", (id) => {
    if (typeof id === "string" && id.startsWith("public-")) {
      if (typeof window.showPublicPlaylist === "function") window.showPublicPlaylist(id.slice(7));
      return;
    }
    if (window.__approvalRequired && !window.__currentUser && typeof window.showLanding === "function") { window.showLanding(); return; }
    const pl = loadPlaylists().find((p) => String(p.id) === String(id));
    if (pl) {
      refreshPlaylistsUI();
      try { if (typeof window.showPlaylist === "function") window.showPlaylist(pl.id); } catch {}
      return;
    }
    loadLibrary(); window.switchView("library");
  });
  API.on("onCreatePlaylist", (input) => {
    const name = typeof input === "string" ? input.trim() : (input && input.name ? String(input.name).trim() : "");
    const visibility = input && input.visibility === "public" ? "public" : "private";
    if (!name) { API.notify("Enter a playlist name"); return; }
    const list = loadPlaylists();
    if (list.some((p) => p.name.toLowerCase() === name.toLowerCase())) { API.notify(`A playlist called "${name}" already exists`); return; }
    list.push({ id: `pl-${Date.now()}`, name, visibility, tracks: [], createdAt: Date.now() });
    savePlaylists(list);
    syncPublicPlaylists();
    refreshPlaylistsUI();
    API.notify(`Playlist "${name}" created (${visibility === "public" ? "Public" : "Private"})`);
  });
  API.on("onAddToPlaylist", async (input) => {
    const trackId = input && (input.trackId || input.id);
    const playlistId = input && input.playlistId;
    if (!trackId || !playlistId) return;
    const list = loadPlaylists();
    const pl = list.find((p) => String(p.id) === String(playlistId));
    if (!pl) { API.notify("Playlist not found"); return; }
    let track = poolById.get(trackId) || currentTracks.find((t) => String(t.id) === String(trackId));
    if (!track) {
      try {
        const res = await fetch(`/api/video/${encodeURIComponent(trackId)}`);
        const video = await res.json();
        if (!res.ok) throw new Error(video.error || "Song not found");
        track = mapItem(video);
      } catch (e) { API.notify(e.message); return; }
    }
    if ((pl.tracks || []).some((t) => String(t.id) === String(trackId))) { API.notify("Already in this playlist"); return; }
    pl.tracks = [...(pl.tracks || []), track];
    savePlaylists(list);
    refreshPlaylistsUI();
    syncPublicPlaylists();
    API.notify(`Added to "${pl.name}"`);
  });
  API.on("onRemoveFromPlaylist", (input) => {
    const list = loadPlaylists();
    const pl = list.find((p) => String(p.id) === String(input && input.playlistId));
    if (!pl) return;
    pl.tracks = (pl.tracks || []).filter((t) => String(t.id) !== String(input.trackId));
    savePlaylists(list);
    refreshPlaylistsUI();
    syncPublicPlaylists();
  });
  API.on("onPlaylistVisibility", (input) => {
    const list = loadPlaylists();
    const pl = list.find((p) => String(p.id) === String(input && input.id));
    if (!pl) return;
    pl.visibility = input.visibility === "public" ? "public" : "private";
    savePlaylists(list);
    refreshPlaylistsUI();
    syncPublicPlaylists();
    API.notify(`"${pl.name}" is now ${pl.visibility}`);
  });
  API.on("onPlaylistDelete", (id) => {
    const playlistId = typeof id === "string" ? id : (id && id.id);
    const doomed = loadPlaylists().find((p) => String(p.id) === String(playlistId));
    if (doomed && doomed.serverId) fetch(`/api/playlists/${encodeURIComponent(doomed.serverId)}`, { method: "DELETE" }).catch(() => {});
    savePlaylists(loadPlaylists().filter((p) => String(p.id) !== String(playlistId)));
    refreshPlaylistsUI();
    try {
      if (typeof routePage !== "undefined" && routePage && routePage.type === "playlist" && String(routePage.id) === String(playlistId)) window.switchView("home");
    } catch {}
    API.notify("Playlist deleted");
  });
  API.on("onCastClick", () => API.notify("Cast is not available in this web app."));

  window.__authEnabled = false;
  window.__approvalRequired = false;

  async function refreshMe() {
    try {
      const res = await fetch("/api/me"); const data = await res.json();
      window.__currentUser = data.user || null;
      window.__authEnabled = Boolean(data.authEnabled);
      window.__approvalRequired = Boolean(data.approvalRequired);
      if (window.__approvalRequired && !data.user && data.registrationStatus) {
        if (data.registrationStatus === "removed") API.notify("Your account was removed by the admin.");
        else if (data.registrationStatus === "rejected") API.notify("Your registration was not approved by the admin.");
        else if (data.registrationStatus === "pending") API.notify("Your registration is waiting for admin approval.");
        else if (data.registrationStatus === "setup") API.notify("Admin approval is not set up yet — the admin needs to finish the Supabase setup.");
      }
      const avatar = document.getElementById("user-avatar");
      if (avatar && data.user) {
        if (data.user.picture) {
          avatar.innerHTML = `<img src="${data.user.picture}" class="w-full h-full rounded-full object-cover" />`;
        } else {
          avatar.textContent = (data.user.name || data.user.email || "?")[0].toUpperCase();
        }
        avatar.title = data.user.email || data.user.name || "Profile";
      }
      if (typeof renderContent === "function") {
        try { if (typeof routePage !== "undefined" && routePage && routePage.type === "profile") renderContent(); } catch {}
      }
      return data.user || null;
    } catch { return null; }
  }
  API.on("onProfileClick", () => {
    try { window.showProfile(); } catch {
      if (window.__authEnabled && !window.__currentUser) window.location.href = "/auth/google";
    }
  });
  API.on("onArtistSelect", (name) => { try { window.showArtist(name); } catch {} });

  // Nav clicks: load the right data after the UI switches view.
  const gated = (fn) => () => {
    if (window.__approvalRequired && !window.__currentUser && typeof window.showLanding === "function") window.showLanding();
    else fn();
  };
  document.querySelectorAll('[data-nav="home"], [data-mobile-nav="home"]').forEach((b) => b.addEventListener("click", gated(loadTrending)));
  document.querySelectorAll('[data-nav="explore"], [data-mobile-nav="explore"]').forEach((b) => b.addEventListener("click", gated(loadTrending)));
  document.querySelectorAll('[data-nav="library"], [data-mobile-nav="library"]').forEach((b) => b.addEventListener("click", loadLibrary));

  // Startup
  if (document.readyState !== "loading") bindPlayPauseSync();
  else document.addEventListener("DOMContentLoaded", bindPlayPauseSync);

  (async () => {
    await loadOfflineFiles().catch(() => {});
    let reg = null;
    try { reg = new URLSearchParams(location.search).get("registration"); } catch {}
    const user = await refreshMe();
    if (typeof routePage !== "undefined" && routePage && routePage.type === "publicPlaylist") {
      await loadPublicPlaylists();
      if (typeof window.showPublicPlaylist === "function") window.showPublicPlaylist(routePage.id);
      return;
    }
    if (typeof currentView !== "undefined" && currentView === "library") {
      await loadLibrary();
      return;
    }
    if (window.__approvalRequired) {
      if (reg === "pending") {
        window.__registrationRejected = false;
        if (typeof window.showPending === "function") window.showPending();
        API.notify("Your registration is waiting for admin approval.");
        return;
      }
      if (reg === "rejected" || reg === "removed") {
        window.__registrationRejected = (reg === "rejected");
        if (typeof window.showLanding === "function") window.showLanding();
        await loadPublicPlaylists();
        API.notify(reg === "rejected" ? "Your registration was not approved by the admin." : "Your account was removed by the admin.");
        return;
      }
      if (!user) {
        window.__registrationRejected = false;
        if (typeof window.showLanding === "function") window.showLanding();
        await loadPublicPlaylists();
        return;
      }
    }
    // Open app directly when approval is disabled (or when user is approved).
    await syncPublicPlaylists();
    await loadPublicPlaylists();
    try {
      const health = await (await fetch("/api/health")).json();
      if (!health.youtubeConfigured) API.notify("YouTube API is not connected yet: set YOUTUBE_API_KEY in Vercel env vars, then redeploy. No sample songs are shown.");
    } catch { /* health is best-effort */ }
    try {
      if (typeof window.__deepLinkSongId !== "undefined" && window.__deepLinkSongId && !String(window.__deepLinkSongId).startsWith("file-")) {
        const id = window.__deepLinkSongId;
        window.__deepLinkSongId = null;
        const videoRes = await fetch(`/api/video/${encodeURIComponent(id)}`);
        const video = await videoRes.json();
        if (videoRes.ok) window.MyMusicAPI.playTrack(mapItem(video));
        loadTrending();
      } else if (typeof routePage !== "undefined" && routePage) loadRoute(routePage);
      else loadTrending();
    } catch { loadTrending(); }
  })();
})();
