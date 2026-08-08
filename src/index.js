// WTFU Scavenger Hunt backend Worker.
// Routes per WTFU_BACKEND_PLAN.md Section 4, plus GET /api/media/:key so
// uploaded R2 objects can actually be served back to the feed/leaderboard
// without making the bucket publicly readable.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const VALID_ROUNDS = [1, 2];
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

async function handleCreatePlayer(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.name !== "string" || !body.name.trim()) {
    return json({ error: "name is required" }, 400);
  }
  if (typeof body.avatar !== "string" || !body.avatar.trim()) {
    return json({ error: "avatar is required" }, 400);
  }

  const name = body.name.trim().slice(0, 100);
  const contact = typeof body.contact === "string" ? body.contact.trim().slice(0, 200) || null : null;
  const avatar = body.avatar.trim().slice(0, 100);

  const existing = await env.DB.prepare("SELECT id FROM players WHERE avatar = ?").bind(avatar).first();
  if (existing) {
    return json({ error: "avatar already taken" }, 409);
  }

  const id = crypto.randomUUID();
  const created_at = Math.floor(Date.now() / 1000);

  await env.DB.prepare(
    "INSERT INTO players (id, name, contact, avatar, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, name, contact, avatar, created_at).run();

  return json({ id, name, contact, avatar, created_at }, 201);
}

async function handleAvatarsTaken(env) {
  const { results } = await env.DB.prepare("SELECT avatar FROM players").all();
  return json({ avatars: results.map((row) => row.avatar) });
}

async function handleUpload(request, env) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return json({ error: "expected multipart/form-data with a 'file' field" }, 400);
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return json({ error: "'file' field is required" }, 400);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return json({ error: "file too large (25MB max)" }, 413);
  }

  const ext = (file.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10) || "bin";
  const key = `${crypto.randomUUID()}.${ext}`;

  await env.UPLOADS.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });

  return json({ key, url: `/api/media/${key}` }, 201);
}

async function handleMedia(pathname, env) {
  const key = decodeURIComponent(pathname.slice("/api/media/".length));
  if (!key) return json({ error: "missing key" }, 400);

  const object = await env.UPLOADS.get(key);
  if (!object) return json({ error: "not found" }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
}

async function handleCreateSubmission(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "invalid JSON body" }, 400);

  const { player_id, prompt_id, round, points, media_url, text_answer } = body;

  if (typeof player_id !== "string" || !player_id.trim()) {
    return json({ error: "player_id is required" }, 400);
  }
  if (typeof prompt_id !== "string" || !prompt_id.trim()) {
    return json({ error: "prompt_id is required" }, 400);
  }
  if (!VALID_ROUNDS.includes(round)) {
    return json({ error: "round must be 1 or 2" }, 400);
  }
  if (typeof points !== "number" || !Number.isFinite(points) || points < 0) {
    return json({ error: "points must be a non-negative number" }, 400);
  }

  const player = await env.DB.prepare("SELECT id FROM players WHERE id = ?").bind(player_id).first();
  if (!player) {
    return json({ error: "unknown player_id" }, 404);
  }

  const id = crypto.randomUUID();
  const created_at = Math.floor(Date.now() / 1000);
  const textAnswer = typeof text_answer === "string" ? text_answer.trim().slice(0, 500) || null : null;

  await env.DB.prepare(
    "INSERT INTO submissions (id, player_id, prompt_id, round, points, media_url, text_answer, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, player_id, prompt_id, round, points, media_url || null, textAnswer, created_at).run();

  return json({ id, created_at }, 201);
}

async function handleFeed(url, env) {
  const roundParam = url.searchParams.get("round");
  let round = null;

  if (roundParam !== null) {
    round = Number(roundParam);
    if (!VALID_ROUNDS.includes(round)) {
      return json({ error: "round must be 1 or 2" }, 400);
    }
  }

  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 50;

  const query = round
    ? `SELECT s.id, s.player_id, s.prompt_id, s.round, s.points, s.media_url, s.text_answer, s.created_at,
              p.name, p.avatar
       FROM submissions s JOIN players p ON p.id = s.player_id
       WHERE s.round = ?
       ORDER BY s.created_at DESC LIMIT ?`
    : `SELECT s.id, s.player_id, s.prompt_id, s.round, s.points, s.media_url, s.text_answer, s.created_at,
              p.name, p.avatar
       FROM submissions s JOIN players p ON p.id = s.player_id
       ORDER BY s.created_at DESC LIMIT ?`;

  const stmt = round ? env.DB.prepare(query).bind(round, limit) : env.DB.prepare(query).bind(limit);
  const { results } = await stmt.all();

  return json({ round, feed: results });
}

async function handleLeaderboard(url, env) {
  const roundParam = url.searchParams.get("round");
  let round = null;

  if (roundParam !== null) {
    round = Number(roundParam);
    if (!VALID_ROUNDS.includes(round)) {
      return json({ error: "round must be 1 or 2" }, 400);
    }
  }

  /* tie-break: whoever's most recent submission (the one that set
     their current total) landed earliest wins the tie — "first to
     reach that score," not an arbitrary DB ordering */
  const query = round
    ? `SELECT p.id, p.name, p.avatar, COALESCE(SUM(s.points), 0) AS score, MAX(s.created_at) AS last_at
       FROM players p LEFT JOIN submissions s ON s.player_id = p.id AND s.round = ?
       GROUP BY p.id ORDER BY score DESC, last_at ASC`
    : `SELECT p.id, p.name, p.avatar, COALESCE(SUM(s.points), 0) AS score, MAX(s.created_at) AS last_at
       FROM players p LEFT JOIN submissions s ON s.player_id = p.id
       GROUP BY p.id ORDER BY score DESC, last_at ASC`;

  const stmt = round ? env.DB.prepare(query).bind(round) : env.DB.prepare(query);
  const { results } = await stmt.all();

  return json({ round, leaderboard: results });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const { method } = request;

    if (method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    try {
      if (pathname === "/api/time" && method === "GET") {
        return withCors(json({ now: Date.now() }));
      }
      if (pathname === "/api/players" && method === "POST") {
        return withCors(await handleCreatePlayer(request, env));
      }
      if (pathname === "/api/players/avatars-taken" && method === "GET") {
        return withCors(await handleAvatarsTaken(env));
      }
      if (pathname === "/api/upload" && method === "POST") {
        return withCors(await handleUpload(request, env));
      }
      if (pathname.startsWith("/api/media/") && method === "GET") {
        return withCors(await handleMedia(pathname, env));
      }
      if (pathname === "/api/submissions" && method === "POST") {
        return withCors(await handleCreateSubmission(request, env));
      }
      if (pathname === "/api/leaderboard" && method === "GET") {
        return withCors(await handleLeaderboard(url, env));
      }
      if (pathname === "/api/feed" && method === "GET") {
        return withCors(await handleFeed(url, env));
      }

      return withCors(json({ error: "not found" }, 404));
    } catch (err) {
      return withCors(json({ error: "internal error", detail: String((err && err.message) || err) }, 500));
    }
  },
};
