import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, "data", "db.json");
const DIST_DIR = join(__dirname, "dist");
const PORT = process.env.PORT || 4020;
const HOST = process.env.HOST || "0.0.0.0";
const GROUP_CAPACITY = Number(process.env.GROUP_CAPACITY || 5);
const GROUP_LIFETIME_MINUTES = Number(process.env.GROUP_LIFETIME_MINUTES || 90);
const BODY_LIMIT_BYTES = Number(process.env.BODY_LIMIT_BYTES || 16_384);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 80);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const isProduction = process.env.NODE_ENV === "production";
const rateLimitBuckets = new Map();

const defaultDb = {
  users: [],
  sessions: {},
  groups: [],
  safeValveRequests: []
};

const devTherapists = [
  { id: "therapist-1", name: "Professional Therapist 1", username: "therapist1", password: "support1" },
  { id: "therapist-2", name: "Professional Therapist 2", username: "therapist2", password: "support2" }
];

const riskTerms = [
  "suicide",
  "kill myself",
  "end my life",
  "self harm",
  "hurt myself",
  "can't go on",
  "cannot go on",
  "die"
];

async function ensureDb() {
  if (!existsSync(DB_PATH)) {
    await mkdir(dirname(DB_PATH), { recursive: true });
    await writeFile(DB_PATH, JSON.stringify(defaultDb, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  const raw = await readFile(DB_PATH, "utf8");
  const parsed = JSON.parse(raw || "{}");
  return {
    ...defaultDb,
    ...parsed,
    users: Array.isArray(parsed.users) ? parsed.users : [],
    sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
    groups: Array.isArray(parsed.groups) ? parsed.groups : [],
    safeValveRequests: Array.isArray(parsed.safeValveRequests) ? parsed.safeValveRequests : []
  };
}

async function writeDb(db) {
  await writeFile(DB_PATH, JSON.stringify(db, null, 2));
}

function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'",
    ...(isProduction ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {})
  };
}

function originAllowed(req, origin) {
  if (!origin) return true;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const protocol = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
  if (host && origin === `${protocol}://${host}`) return true;
  if (!isProduction && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

function applyBaseHeaders(req, res) {
  Object.entries(securityHeaders()).forEach(([key, value]) => res.setHeader(key, value));
  const origin = req.headers.origin || "";
  if (originAllowed(req, origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...securityHeaders()
  });
  res.end(JSON.stringify(body));
}

function contentType(filePath) {
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon"
  }[extname(filePath)] || "application/octet-stream";
}

async function serveStatic(url, res) {
  if (!existsSync(DIST_DIR)) return false;

  const cleanPath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const requestedPath = cleanPath ? join(DIST_DIR, cleanPath) : join(DIST_DIR, "index.html");
  const filePath = existsSync(requestedPath) && !requestedPath.endsWith("\\")
    ? requestedPath
    : join(DIST_DIR, "index.html");

  if (!normalize(filePath).startsWith(normalize(DIST_DIR))) return false;

  try {
    const file = await readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    res.end(file);
    return true;
  } catch {
    return false;
  }
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > BODY_LIMIT_BYTES) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

function clientKey(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "unknown";
}

function rateLimited(req) {
  if (!req.url?.startsWith("/api/")) return false;
  const key = clientKey(req);
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  bucket.count += 1;
  rateLimitBuckets.set(key, bucket);
  return bucket.count > RATE_LIMIT_MAX;
}

function getToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function sessionValue(db, req) {
  const token = getToken(req);
  return db.sessions[token];
}

function getUserFromToken(db, req) {
  const session = sessionValue(db, req);
  const userId = typeof session === "string" ? session : session?.userId;
  return db.users.find((user) => user.id === userId) || null;
}

function therapistAccounts() {
  if (process.env.THERAPIST_ACCOUNTS) {
    try {
      const parsed = JSON.parse(process.env.THERAPIST_ACCOUNTS);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item, index) => ({
            id: sanitizeText(item.id || `therapist-${index + 1}`, 60),
            name: sanitizeText(item.name, 80),
            username: sanitizeText(item.username, 80).toLowerCase(),
            password: String(item.password || "")
          }))
          .filter((item) => item.name && item.username && item.password);
      }
    } catch {
      return [];
    }
  }
  return isProduction ? [] : devTherapists;
}

function publicTherapist(therapist) {
  return { id: therapist.id, name: therapist.name, username: therapist.username };
}

function getTherapistFromToken(db, req) {
  const session = sessionValue(db, req);
  if (!session || session.type !== "therapist") return null;
  return therapistAccounts().find((therapist) => therapist.id === session.therapistId) || null;
}

async function requireUser(req, res) {
  const db = await readDb();
  cleanupExpiredGroups(db);
  const user = getUserFromToken(db, req);
  if (!user) {
    send(res, 401, { error: "Start an anonymous session first." });
    return null;
  }
  return { db, user };
}

async function requireTherapist(req, res) {
  const db = await readDb();
  cleanupExpiredGroups(db);
  const therapist = getTherapistFromToken(db, req);
  if (!therapist) {
    send(res, 401, { error: "Therapist login is required." });
    return null;
  }
  return { db, therapist };
}

function publicUser(user) {
  return {
    id: user.id,
    alias: user.alias,
    anonymousId: user.anonymousId,
    intensity: user.intensity,
    createdAt: user.createdAt
  };
}

function publicGroup(group) {
  if (!group) return null;
  return {
    id: group.id,
    name: group.name,
    primaryTopic: group.primaryTopic || primaryTopic(group.topics),
    topics: group.topics,
    intensity: group.intensity,
    capacity: group.capacity,
    createdAt: group.createdAt,
    expiresAt: group.expiresAt,
    status: group.status,
    participants: group.participants,
    messages: group.messages
  };
}

function sanitizeText(value, max = 700) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function createAlias(value) {
  const cleaned = sanitizeText(value, 28);
  if (cleaned) return cleaned;
  return `Peer-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}

function createAnonymousId() {
  return `anon-${crypto.randomBytes(3).toString("hex")}`;
}

function normalizeIntensity(value) {
  return ["low", "medium", "high"].includes(value) ? value : "medium";
}

function cleanupExpiredGroups(db) {
  const now = Date.now();
  db.groups.forEach((group) => {
    if (new Date(group.expiresAt).getTime() <= now) {
      group.status = "expired";
      group.messages = [];
      group.participants = [];
    }
  });
}

function activeGroupForUser(db, userId) {
  cleanupExpiredGroups(db);
  return db.groups.find((group) => group.status === "active" && group.participants.some((participant) => participant.id === userId)) || null;
}

function primaryTopic(topics) {
  return sanitizeText(Array.isArray(topics) ? topics[0] : "", 60);
}

function createSystemMessage(content) {
  return {
    id: crypto.randomUUID(),
    type: "system",
    senderId: "system",
    senderAlias: "System",
    content,
    createdAt: new Date().toISOString()
  };
}

function routeUserToGroup(db, user, topics, intensity, note) {
  const requestedTopic = primaryTopic(topics);
  const activeGroup = activeGroupForUser(db, user.id);
  if (activeGroup) {
    activeGroup.participants = activeGroup.participants.filter((participant) => participant.id !== user.id);
    activeGroup.messages.push(createSystemMessage(`${user.alias} left to find another Vent Group.`));
  }

  const candidates = db.groups
    .filter((group) => group.status === "active")
    .filter((group) => group.primaryTopic === requestedTopic || (!group.primaryTopic && primaryTopic(group.topics) === requestedTopic))
    .filter((group) => group.participants.length < group.capacity)
    .filter((group) => !group.participants.some((participant) => participant.id === user.id))
    .map((group) => ({ group, score: group.intensity === intensity ? 1 : 0 }))
    .sort((a, b) => b.score - a.score || b.group.participants.length - a.group.participants.length);

  let created = false;
  const group = candidates[0]?.group || (() => {
    created = true;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + GROUP_LIFETIME_MINUTES * 60000);
    const newGroup = {
      id: crypto.randomUUID(),
      name: `${requestedTopic} Circle`,
      primaryTopic: requestedTopic,
      topics: [requestedTopic],
      intensity,
      capacity: GROUP_CAPACITY,
      status: "active",
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      participants: [],
      messages: [createSystemMessage("This temporary Vent Group is open. Share only what feels safe.")]
    };
    db.groups.push(newGroup);
    return newGroup;
  })();

  group.participants.push({ id: user.id, alias: user.alias, anonymousId: user.anonymousId, joinedAt: new Date().toISOString() });
  group.messages.push(createSystemMessage(`${user.alias} joined anonymously.`));
  if (note) {
    group.messages.push({
      id: crypto.randomUUID(),
      type: "routing-note",
      senderId: user.id,
      senderAlias: user.alias,
      content: `Routing note: ${note}`,
      createdAt: new Date().toISOString()
    });
  }
  return { group, created };
}

function containsRiskLanguage(text) {
  const lower = text.toLowerCase();
  return riskTerms.some((term) => lower.includes(term));
}

function chooseTherapist(db) {
  const therapists = therapistAccounts();
  if (!therapists.length) return null;
  return therapists
    .map((therapist) => ({
      therapist,
      openCases: db.safeValveRequests.filter((request) => request.assignedTherapistId === therapist.id && request.status !== "closed").length
    }))
    .sort((a, b) => a.openCases - b.openCases)[0].therapist;
}

function caseMessage(senderType, senderId, senderName, content) {
  return {
    id: crypto.randomUUID(),
    senderType,
    senderId,
    senderName,
    content: sanitizeText(content, 700),
    createdAt: new Date().toISOString()
  };
}

function createSafeValveRequest(db, user, payload, sourceMessageId = null) {
  const therapist = chooseTherapist(db);
  const request = {
    id: crypto.randomUUID(),
    userId: user.id,
    anonymousId: user.anonymousId,
    alias: user.alias,
    reason: sanitizeText(payload.reason || "Possible high-risk distress", 120),
    contactPreference: sanitizeText(payload.contactPreference || "in-app follow-up", 80),
    details: sanitizeText(payload.details || "Created from message safety detection.", 500),
    urgency: sanitizeText(payload.urgency || "normal", 40),
    status: therapist ? "assigned" : "open",
    assignedTherapistId: therapist?.id || null,
    assignedTherapistName: therapist?.name || null,
    sourceMessageId,
    messages: [
      caseMessage("student", user.id, user.alias, payload.details || "Safe Valve support requested."),
      caseMessage(
        "system",
        "system",
        "System",
        therapist
          ? `This case was assigned to ${therapist.name}.`
          : "This case is waiting for a therapist account to be configured."
      )
    ],
    createdAt: new Date().toISOString()
  };
  db.safeValveRequests.unshift(request);
  return request;
}

function publicSafeValveRequest(request) {
  return {
    id: request.id,
    anonymousId: request.anonymousId,
    alias: request.alias,
    reason: request.reason,
    contactPreference: request.contactPreference,
    details: request.details,
    urgency: request.urgency || "normal",
    status: request.status,
    assignedTherapistId: request.assignedTherapistId || null,
    assignedTherapistName: request.assignedTherapistName || null,
    sourceMessageId: request.sourceMessageId || null,
    messages: request.messages || [],
    createdAt: request.createdAt
  };
}

async function router(req, res) {
  applyBaseHeaders(req, res);

  if (!originAllowed(req, req.headers.origin || "")) {
    send(res, 403, { error: "Origin is not allowed." });
    return;
  }

  if (req.method === "OPTIONS") {
    send(res, 204, {});
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (rateLimited(req)) {
    send(res, 429, { error: "Too many requests. Please wait and try again." });
    return;
  }

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      send(res, 200, { status: "ok", service: "anonymous-peer-support-routing" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/session") {
      const body = await parseBody(req);
      const db = await readDb();
      const user = {
        id: crypto.randomUUID(),
        alias: createAlias(body.alias),
        anonymousId: createAnonymousId(),
        intensity: normalizeIntensity(body.intensity),
        createdAt: new Date().toISOString()
      };
      const token = crypto.randomBytes(32).toString("hex");
      db.users.push(user);
      db.sessions[token] = user.id;
      await writeDb(db);
      send(res, 201, { token, user: publicUser(user) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/therapist/login") {
      const body = await parseBody(req);
      const username = sanitizeText(body.username, 80).toLowerCase();
      const password = String(body.password || "");
      const therapist = therapistAccounts().find((candidate) => candidate.username === username && candidate.password === password);
      if (!therapist) {
        send(res, 401, { error: "Therapist username or password is incorrect." });
        return;
      }
      const db = await readDb();
      const token = crypto.randomBytes(32).toString("hex");
      db.sessions[token] = { type: "therapist", therapistId: therapist.id };
      await writeDb(db);
      send(res, 200, { token, therapist: publicTherapist(therapist) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/therapist/me") {
      const auth = await requireTherapist(req, res);
      if (!auth) return;
      send(res, 200, { therapist: publicTherapist(auth.therapist) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/therapist/cases") {
      const auth = await requireTherapist(req, res);
      if (!auth) return;
      const cases = auth.db.safeValveRequests
        .filter((request) => !request.assignedTherapistId || request.assignedTherapistId === auth.therapist.id)
        .map(publicSafeValveRequest);
      send(res, 200, { cases });
      return;
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/therapist\/cases\/[^/]+\/assign$/)) {
      const auth = await requireTherapist(req, res);
      if (!auth) return;
      const id = url.pathname.split("/")[4];
      const request = auth.db.safeValveRequests.find((entry) => entry.id === id);
      if (!request) {
        send(res, 404, { error: "Safe Valve case not found." });
        return;
      }
      request.assignedTherapistId = auth.therapist.id;
      request.assignedTherapistName = auth.therapist.name;
      request.status = "assigned";
      request.messages = request.messages || [];
      request.messages.push(caseMessage("system", "system", "System", `${auth.therapist.name} accepted this Safe Valve case.`));
      await writeDb(auth.db);
      send(res, 200, { case: publicSafeValveRequest(request) });
      return;
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/therapist\/cases\/[^/]+\/messages$/)) {
      const auth = await requireTherapist(req, res);
      if (!auth) return;
      const body = await parseBody(req);
      const id = url.pathname.split("/")[4];
      const request = auth.db.safeValveRequests.find((entry) => entry.id === id);
      if (!request) {
        send(res, 404, { error: "Safe Valve case not found." });
        return;
      }
      if (request.assignedTherapistId && request.assignedTherapistId !== auth.therapist.id) {
        send(res, 403, { error: "This case is assigned to another therapist." });
        return;
      }
      const content = sanitizeText(body.content);
      if (!content) {
        send(res, 400, { error: "Message content is required." });
        return;
      }
      request.assignedTherapistId = auth.therapist.id;
      request.assignedTherapistName = auth.therapist.name;
      request.status = sanitizeText(body.status, 40) || request.status || "assigned";
      request.messages = request.messages || [];
      request.messages.push(caseMessage("therapist", auth.therapist.id, auth.therapist.name, content));
      await writeDb(auth.db);
      send(res, 201, { case: publicSafeValveRequest(request) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/me") {
      const auth = await requireUser(req, res);
      if (!auth) return;
      send(res, 200, { user: publicUser(auth.user) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/groups/join") {
      const auth = await requireUser(req, res);
      if (!auth) return;
      const body = await parseBody(req);
      const topics = Array.isArray(body.topics)
        ? body.topics.map((topic) => sanitizeText(topic, 60)).filter(Boolean).slice(0, 5)
        : [];
      if (!topics.length) {
        send(res, 400, { error: "Choose at least one support theme." });
        return;
      }
      const routingTopics = [primaryTopic(topics)];
      const result = routeUserToGroup(
        auth.db,
        auth.user,
        routingTopics,
        normalizeIntensity(body.intensity),
        sanitizeText(body.note, 220)
      );
      await writeDb(auth.db);
      send(res, 200, { group: publicGroup(result.group), created: result.created });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/groups/current") {
      const auth = await requireUser(req, res);
      if (!auth) return;
      const group = activeGroupForUser(auth.db, auth.user.id);
      await writeDb(auth.db);
      send(res, 200, { group: publicGroup(group) });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/groups/")) {
      const auth = await requireUser(req, res);
      if (!auth) return;
      const id = url.pathname.split("/")[3];
      const group = auth.db.groups.find((entry) => entry.id === id && entry.participants.some((participant) => participant.id === auth.user.id));
      if (!group || group.status !== "active") {
        send(res, 404, { error: "Vent Group not found." });
        return;
      }
      send(res, 200, { group: publicGroup(group) });
      return;
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/groups\/[^/]+\/messages$/)) {
      const auth = await requireUser(req, res);
      if (!auth) return;
      const body = await parseBody(req);
      const id = url.pathname.split("/")[3];
      const group = auth.db.groups.find((entry) => entry.id === id && entry.status === "active");
      if (!group || !group.participants.some((participant) => participant.id === auth.user.id)) {
        send(res, 404, { error: "Join this Vent Group before sending messages." });
        return;
      }
      const content = sanitizeText(body.content);
      if (!content) {
        send(res, 400, { error: "Message content is required." });
        return;
      }
      const message = {
        id: crypto.randomUUID(),
        type: "message",
        senderId: auth.user.id,
        senderAlias: auth.user.alias,
        content,
        mood: sanitizeText(body.mood, 40),
        createdAt: new Date().toISOString()
      };
      group.messages.push(message);
      let safeValveTriggered = false;
      if (containsRiskLanguage(content)) {
        safeValveTriggered = true;
        createSafeValveRequest(auth.db, auth.user, {
          reason: "Possible high-risk distress",
          contactPreference: "ICT therapist queue",
          details: "A Vent Group message matched high-risk safety language."
        }, message.id);
        group.messages.push(createSystemMessage("Safe Valve opened for professional support review."));
      }
      await writeDb(auth.db);
      send(res, 201, { group: publicGroup(group), safeValveTriggered });
      return;
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/groups\/[^/]+\/leave$/)) {
      const auth = await requireUser(req, res);
      if (!auth) return;
      const id = url.pathname.split("/")[3];
      const group = auth.db.groups.find((entry) => entry.id === id);
      if (group) {
        group.participants = group.participants.filter((participant) => participant.id !== auth.user.id);
        group.messages.push(createSystemMessage(`${auth.user.alias} left the group.`));
        if (!group.participants.length) {
          group.status = "closed";
          group.messages = [];
        }
      }
      await writeDb(auth.db);
      send(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/safe-valve") {
      const auth = await requireUser(req, res);
      if (!auth) return;
      const body = await parseBody(req);
      if (!sanitizeText(body.details, 500)) {
        send(res, 400, { error: "Describe what support is needed." });
        return;
      }
      createSafeValveRequest(auth.db, auth.user, body);
      await writeDb(auth.db);
      const requests = auth.db.safeValveRequests
        .filter((request) => request.userId === auth.user.id)
        .map(publicSafeValveRequest);
      send(res, 201, { requests });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/safe-valve") {
      const auth = await requireUser(req, res);
      if (!auth) return;
      const requests = auth.db.safeValveRequests
        .filter((request) => request.userId === auth.user.id)
        .map(publicSafeValveRequest);
      send(res, 200, { requests });
      return;
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/safe-valve\/[^/]+\/messages$/)) {
      const auth = await requireUser(req, res);
      if (!auth) return;
      const body = await parseBody(req);
      const id = url.pathname.split("/")[3];
      const request = auth.db.safeValveRequests.find((entry) => entry.id === id && entry.userId === auth.user.id);
      if (!request) {
        send(res, 404, { error: "Safe Valve case not found." });
        return;
      }
      const content = sanitizeText(body.content);
      if (!content) {
        send(res, 400, { error: "Message content is required." });
        return;
      }
      request.messages = request.messages || [];
      request.messages.push(caseMessage("student", auth.user.id, auth.user.alias, content));
      await writeDb(auth.db);
      send(res, 201, { case: publicSafeValveRequest(request) });
      return;
    }

    if (!url.pathname.startsWith("/api/") && await serveStatic(url, res)) {
      return;
    }

    send(res, 404, { error: "Route not found." });
  } catch (error) {
    send(res, error.statusCode || 500, { error: error.message || "Server error." });
  }
}

createServer(router).listen(PORT, HOST, () => {
  console.log(`Peer-support API running at http://${HOST}:${PORT}`);
});
