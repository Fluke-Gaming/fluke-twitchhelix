// ─── Config ──────────────────────────────────────────────────────────────────
const CHANNEL = "flukegaming";
const KV_TOKEN_KEY = "twitch_access_token";

// env bindings (wrangler.toml + secrets):
//   TWITCH_CLIENT_ID     → wrangler secret
//   TWITCH_CLIENT_SECRET → wrangler secret
//   TWITCH_KV            → KV namespace binding

// ─── Token management ────────────────────────────────────────────────────────

async function getAccessToken(env) {
  const cached = await env.TWITCH_KV.getWithMetadata(KV_TOKEN_KEY);

  if (cached.value) {
    return cached.value;
  }

  return await refreshAccessToken(env);
}

async function refreshAccessToken(env) {
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status}`);
  }

  const { access_token, expires_in } = await res.json();

  // Cache with 60s buffer before actual expiry
  await env.TWITCH_KV.put(KV_TOKEN_KEY, access_token, {
    expirationTtl: expires_in - 60,
  });

  return access_token;
}

// ─── Twitch API helper ────────────────────────────────────────────────────────

async function twitchFetch(env, path, retried = false) {
  const token = await getAccessToken(env);

  const res = await fetch(`https://api.twitch.tv/helix${path}`, {
    headers: {
      "Client-Id": env.TWITCH_CLIENT_ID,
      Authorization: `Bearer ${token}`,
    },
  });

  // Token expired mid-cache-window — purge and retry once
  if (res.status === 401 && !retried) {
    await env.TWITCH_KV.delete(KV_TOKEN_KEY);
    return twitchFetch(env, path, true);
  }

  if (!res.ok) {
    throw new Error(`Twitch API error: ${res.status} on ${path}`);
  }

  return res.json();
}

// ─── Endpoint handlers ────────────────────────────────────────────────────────

async function handleStreamStatus(env) {
  // First resolve login → user_id (needed for stream lookup)
  const userData = await twitchFetch(env, `/users?login=${CHANNEL}`);
  const user = userData.data[0];

  if (!user) {
    return json({ live: false, channel: CHANNEL }, 404);
  }

  const streamData = await twitchFetch(env, `/streams?user_id=${user.id}`);
  const stream = streamData.data[0] ?? null;

  return json({
    live: !!stream,
    channel: CHANNEL,
    title: stream?.title ?? null,
    game: stream?.game_name ?? null,
    viewers: stream?.viewer_count ?? null,
    started_at: stream?.started_at ?? null,
    thumbnail: stream
      ? stream.thumbnail_url.replace("{width}", "1280").replace("{height}", "720")
      : null,
  });
}

async function handleChannelInfo(env) {
  const userData = await twitchFetch(env, `/users?login=${CHANNEL}`);
  const user = userData.data[0];

  if (!user) return json({ error: "Channel not found" }, 404);

  const channelData = await twitchFetch(env, `/channels?broadcaster_id=${user.id}`);
  const channel = channelData.data[0];

  return json({
    channel: CHANNEL,
    display_name: user.display_name,
    description: user.description,
    profile_image: user.profile_image_url,
    offline_image: user.offline_image_url,
    view_count: user.view_count,
    game: channel?.game_name ?? null,
    title: channel?.title ?? null,
    language: channel?.broadcaster_language ?? null,
  });
}

async function handleClips(env, url) {
  const userData = await twitchFetch(env, `/users?login=${CHANNEL}`);
  const user = userData.data[0];

  if (!user) return json({ error: "Channel not found" }, 404);

  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "10"), 20);
  const cursor = url.searchParams.get("cursor") ?? "";
  const cursorParam = cursor ? `&after=${cursor}` : "";

  const clipsData = await twitchFetch(
    env, `/clips?broadcaster_id=${user.id}&first=${limit}${cursorParam}`
  );

  return json({
    clips: clipsData.data.map((c) => ({
      id: c.id,
      title: c.title,
      url: c.url,
      embed_url: c.embed_url,
      thumbnail: c.thumbnail_url,
      views: c.view_count,
      duration: c.duration,
      created_at: c.created_at,
      game: c.game_name ?? null,
    })),
    pagination: clipsData.pagination ?? {},
  });
}

async function handleVideos(env, url) {
  const userData = await twitchFetch(env, `/users?login=${CHANNEL}`);
  const user = userData.data[0];

  if (!user) return json({ error: "Channel not found" }, 404);

  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "10"), 20);
  const cursor = url.searchParams.get("cursor") ?? "";
  const cursorParam = cursor ? `&after=${cursor}` : "";

  const videoData = await twitchFetch(
    env, `/videos?user_id=${user.id}&first=${limit}${cursorParam}`
  );

  return json({
    videos: videoData.data.map((v) => ({
      id: v.id,
      title: v.title,
      url: v.url,
      thumbnail: v.thumbnail_url,
      views: v.view_count,
      duration: v.duration,
      created_at: v.created_at,
      type: v.type,
    })),
    pagination: videoData.pagination ?? {},
  });
}

// ─── Router ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, cors);
    }

    try {
      let response;

      switch(pathname) {
        case "/stream-status":
          response = await handleStreamStatus(env);
          break;
        case "/channel-info":
          response = await handleChannelInfo(env);
          break;
        case "/videos":
          response = await handleVideos(env, url);
          break;
        case "/clips":
          response = await handleClips(env, url);
          break;
        default:
          response = json({ error: "Not found" }, 404);
      }

      // Merge CORS into response headers
      const headers = new Headers(response.headers);
      Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
      return new Response(response.body, { status: response.status, headers });

    } catch (err) {
      console.error(err);
      return json({ error: "Internal server error", detail: err.message }, 500, cors);
    }
  },
};

// ─── Util ─────────────────────────────────────────────────────────────────────

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}