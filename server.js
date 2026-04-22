const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const { Pool } = require("pg");

loadEnvFile(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = __dirname;
const COOKIE_NAME = "petrosphere_session";
const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 30;
const DATABASE_URL = process.env.DATABASE_URL || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
let databaseReady = false;
let databaseInitError = "";

const ROUTE_ALIASES = {
  "/": "/index.html",
  "/starter": "/starter.html",
  "/pro": "/pro.html",
  "/enterprise": "/enterprise.html",
  "/auth": "/auth.html",
  "/dashboard": "/dashboard.html",
  "/demo": "/demo.html",
  "/production-system": "/production-system.html",
  "/reservoir-system": "/reservoir-system.html",
  "/success": "/success.html",
  "/cancel": "/cancel.html",
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

const PRICE_CATALOG = {
  "starter-monthly": {
    plan: "Starter",
    billing: "monthly",
    amount: 29000,
    currency: "usd",
    interval: "month",
    name: "PetroSphere Starter",
    description:
      "Production monitoring, decline curve analysis and reporting for smaller teams.",
  },
  "starter-annual": {
    plan: "Starter",
    billing: "annual",
    amount: 295800,
    currency: "usd",
    interval: "year",
    name: "PetroSphere Starter",
    description: "Annual access to Starter with 15% savings.",
  },
  "pro-monthly": {
    plan: "Pro",
    billing: "monthly",
    amount: 89000,
    currency: "usd",
    interval: "month",
    name: "PetroSphere Pro",
    description:
      "Engineering suite with nodal analysis, reserves and collaboration.",
  },
  "pro-annual": {
    plan: "Pro",
    billing: "annual",
    amount: 907800,
    currency: "usd",
    interval: "year",
    name: "PetroSphere Pro",
    description: "Annual access to Pro with 15% savings.",
  },
  "enterprise-monthly": {
    plan: "Enterprise",
    billing: "monthly",
    amount: 250000,
    currency: "usd",
    interval: "month",
    name: "PetroSphere Enterprise",
    description:
      "Multi-asset deployment with governance, private hosting and connectors.",
  },
  "enterprise-annual": {
    plan: "Enterprise",
    billing: "annual",
    amount: 2550000,
    currency: "usd",
    interval: "year",
    name: "PetroSphere Enterprise",
    description:
      "Annual enterprise contract with 15% savings from base monthly pricing.",
  },
};

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: shouldUseSsl() ? { rejectUnauthorized: false } : undefined,
    })
  : null;

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, getBaseUrl(req));
    const pathname = requestUrl.pathname;

    if (pathname === "/api/config" && req.method === "GET") {
      return sendJson(res, 200, {
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || "",
        priceCatalog: Object.keys(PRICE_CATALOG),
      });
    }

    if (pathname === "/api/me" && req.method === "GET") {
      return handleGetCurrentUser(req, res);
    }

    if (pathname === "/api/auth/register" && req.method === "POST") {
      return handleRegister(req, res);
    }

    if (pathname === "/api/auth/login" && req.method === "POST") {
      return handleLogin(req, res);
    }

    if (pathname === "/api/auth/logout" && req.method === "POST") {
      return handleLogout(req, res);
    }

    if (pathname === "/api/create-checkout-session" && req.method === "POST") {
      return handleCreateCheckoutSession(req, res);
    }

    if (pathname === "/api/create-billing-portal-session" && req.method === "POST") {
      return handleCreateBillingPortalSession(req, res);
    }

    if (pathname === "/api/stripe/webhook" && req.method === "POST") {
      return handleStripeWebhook(req, res);
    }

    if (pathname === "/api/health" && req.method === "GET") {
      return sendJson(res, 200, {
        ok: true,
        dbConfigured: Boolean(pool),
        dbReady: isDatabaseAvailable(),
        dbError: databaseInitError || null,
      });
    }

    if (pathname.startsWith("/api/")) {
      return sendJson(res, 404, { error: "API route not found." });
    }

    return serveStaticFile(res, pathname);
  } catch (error) {
    console.error("Unhandled server error:", error);
    return sendJson(res, 500, { error: "Internal server error." });
  }
});

start();

async function start() {
  if (!pool) {
    console.warn("DATABASE_URL is not configured. Auth and subscription storage will not work.");
  } else {
    try {
      await initializeDatabase();
      databaseReady = true;
    } catch (error) {
      databaseInitError = getErrorMessage(error);
      console.error(
        "Database initialization failed. The app will start, but auth and subscription features will stay disabled until DATABASE_URL is fixed.",
        error
      );
    }
  }

  server.listen(PORT, () => {
    console.log(`PetroSphere server running on port ${PORT}`);
  });
}

async function handleGetCurrentUser(req, res) {
  if (!isDatabaseAvailable()) {
    return sendJson(res, 500, { error: getDatabaseUnavailableMessage() });
  }

  const auth = await getAuthenticatedUser(req);

  if (!auth.user) {
    return sendJson(res, 200, { user: null, subscription: null });
  }

  const subscription = await getLatestSubscriptionForUser(auth.user.id);

  return sendJson(res, 200, {
    user: sanitizeUser(auth.user),
    subscription,
  });
}

async function handleRegister(req, res) {
  if (!assertServerAuthConfig(res)) {
    return;
  }

  const rawBody = await readRequestBody(req);
  let payload;

  try {
    payload = JSON.parse(rawBody.toString("utf8") || "{}");
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON body." });
  }

  const name = String(payload.name || "").trim();
  const email = normalizeEmail(payload.email);
  const password = String(payload.password || "");

  if (!email || !password || password.length < 8) {
    return sendJson(res, 400, {
      error: "Name, email and password (min 8 chars) are required.",
    });
  }

  const existingUser = await getUserByEmail(email);
  if (existingUser) {
    return sendJson(res, 409, { error: "An account with this email already exists." });
  }

  const passwordHash = await hashPassword(password);
  const user = await createUser({ name, email, passwordHash });
  await createUserSession(res, user.id);

  return sendJson(res, 201, {
    user: sanitizeUser(user),
    subscription: null,
  });
}

async function handleLogin(req, res) {
  if (!assertServerAuthConfig(res)) {
    return;
  }

  const rawBody = await readRequestBody(req);
  let payload;

  try {
    payload = JSON.parse(rawBody.toString("utf8") || "{}");
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON body." });
  }

  const email = normalizeEmail(payload.email);
  const password = String(payload.password || "");

  if (!email || !password) {
    return sendJson(res, 400, { error: "Email and password are required." });
  }

  const user = await getUserByEmail(email);
  if (!user) {
    return sendJson(res, 401, { error: "Invalid email or password." });
  }

  const isValidPassword = await verifyPassword(password, user.password_hash);
  if (!isValidPassword) {
    return sendJson(res, 401, { error: "Invalid email or password." });
  }

  await createUserSession(res, user.id);
  const subscription = await getLatestSubscriptionForUser(user.id);

  return sendJson(res, 200, {
    user: sanitizeUser(user),
    subscription,
  });
}

async function handleLogout(req, res) {
  if (!isDatabaseAvailable()) {
    return sendJson(res, 500, { error: getDatabaseUnavailableMessage() });
  }

  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];

  if (token) {
    await deleteSessionByToken(token);
  }

  clearSessionCookie(res);
  return sendJson(res, 200, { ok: true });
}

async function handleCreateCheckoutSession(req, res) {
  if (!isDatabaseAvailable()) {
    return sendJson(res, 500, { error: getDatabaseUnavailableMessage() });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return sendJson(res, 500, {
      error: "Missing STRIPE_SECRET_KEY on the server.",
    });
  }

  if (!process.env.STRIPE_PUBLISHABLE_KEY) {
    return sendJson(res, 500, {
      error: "Missing STRIPE_PUBLISHABLE_KEY on the server.",
    });
  }

  const auth = await getAuthenticatedUser(req);
  if (!auth.user) {
    return sendJson(res, 401, {
      error: "Login required before checkout.",
      authRequired: true,
    });
  }

  const rawBody = await readRequestBody(req);
  let payload;

  try {
    payload = JSON.parse(rawBody.toString("utf8") || "{}");
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON body." });
  }

  const priceCode = payload.priceCode;
  const plan = PRICE_CATALOG[priceCode];

  if (!plan) {
    return sendJson(res, 400, { error: "Unknown price code." });
  }

  const stripeCustomerId = await ensureStripeCustomer(auth.user);
  const baseUrl = getBaseUrl(req);
  const params = new URLSearchParams();

  params.set("mode", "subscription");
  params.set("customer", stripeCustomerId);
  params.set(
    "success_url",
    `${baseUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`
  );
  params.set("cancel_url", `${baseUrl}/cancel.html?plan=${encodeURIComponent(priceCode)}`);
  params.set("billing_address_collection", "auto");
  params.set("allow_promotion_codes", "true");
  params.set("client_reference_id", String(auth.user.id));
  params.set("metadata[user_id]", String(auth.user.id));
  params.set("metadata[user_email]", auth.user.email);
  params.set("metadata[price_code]", priceCode);
  params.set("metadata[plan_name]", plan.plan);
  params.set("subscription_data[metadata][user_id]", String(auth.user.id));
  params.set("subscription_data[metadata][price_code]", priceCode);
  params.set("subscription_data[metadata][plan_name]", plan.plan);
  params.set("line_items[0][quantity]", "1");
  params.set("line_items[0][price_data][currency]", plan.currency);
  params.set("line_items[0][price_data][unit_amount]", String(plan.amount));
  params.set("line_items[0][price_data][recurring][interval]", plan.interval);
  params.set("line_items[0][price_data][product_data][name]", plan.name);
  params.set(
    "line_items[0][price_data][product_data][description]",
    plan.description
  );

  const stripePayload = await stripeRequest("/v1/checkout/sessions", params);

  return sendJson(res, 200, {
    sessionId: stripePayload.id,
    url: stripePayload.url,
  });
}

async function handleCreateBillingPortalSession(req, res) {
  if (!isDatabaseAvailable()) {
    return sendJson(res, 500, { error: getDatabaseUnavailableMessage() });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return sendJson(res, 500, {
      error: "Missing STRIPE_SECRET_KEY on the server.",
    });
  }

  const auth = await getAuthenticatedUser(req);
  if (!auth.user) {
    return sendJson(res, 401, {
      error: "Login required to open the billing portal.",
      authRequired: true,
    });
  }

  if (!auth.user.stripe_customer_id) {
    return sendJson(res, 400, {
      error: "No Stripe customer was found for this account yet.",
    });
  }

  const params = new URLSearchParams();
  params.set("customer", auth.user.stripe_customer_id);
  params.set("return_url", `${getBaseUrl(req)}/dashboard.html`);

  const stripePayload = await stripeRequest("/v1/billing_portal/sessions", params);

  return sendJson(res, 200, {
    url: stripePayload.url,
  });
}

async function handleStripeWebhook(req, res) {
  if (!isDatabaseAvailable()) {
    return sendJson(res, 500, { error: getDatabaseUnavailableMessage() });
  }

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    return sendJson(res, 500, {
      error: "Missing STRIPE_WEBHOOK_SECRET on the server.",
    });
  }

  const rawBody = await readRequestBody(req);
  const signature = req.headers["stripe-signature"];

  if (!verifyStripeSignature(signature, rawBody, process.env.STRIPE_WEBHOOK_SECRET)) {
    return sendJson(res, 400, { error: "Invalid Stripe signature." });
  }

  const event = JSON.parse(rawBody.toString("utf8"));
  const wasNewEvent = await registerStripeEvent(event);

  if (!wasNewEvent) {
    return sendJson(res, 200, { received: true, duplicate: true });
  }

  switch (event.type) {
    case "checkout.session.completed":
      await syncCheckoutSessionCompleted(event.data.object);
      break;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await syncSubscriptionFromEvent(event.data.object);
      break;
    default:
      console.log("Unhandled Stripe event:", event.type);
      break;
  }

  return sendJson(res, 200, { received: true });
}

async function syncCheckoutSessionCompleted(session) {
  const userId = Number(session.metadata?.user_id || session.client_reference_id || 0);

  if (!userId || !session.customer) {
    return;
  }

  await pool.query(
    `UPDATE users
     SET stripe_customer_id = COALESCE(stripe_customer_id, $2)
     WHERE id = $1`,
    [userId, session.customer]
  );
}

async function syncSubscriptionFromEvent(subscription) {
  const explicitUserId = Number(subscription.metadata?.user_id || 0) || null;
  let userId = explicitUserId;

  if (!userId && subscription.customer) {
    const result = await pool.query(
      "SELECT id FROM users WHERE stripe_customer_id = $1 LIMIT 1",
      [subscription.customer]
    );
    userId = result.rows[0]?.id || null;
  }

  await pool.query(
    `
      INSERT INTO subscriptions (
        user_id,
        stripe_customer_id,
        stripe_subscription_id,
        plan_code,
        plan_name,
        status,
        current_period_end,
        cancel_at_period_end,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
      ON CONFLICT (stripe_subscription_id) DO UPDATE
      SET
        user_id = EXCLUDED.user_id,
        stripe_customer_id = EXCLUDED.stripe_customer_id,
        plan_code = EXCLUDED.plan_code,
        plan_name = EXCLUDED.plan_name,
        status = EXCLUDED.status,
        current_period_end = EXCLUDED.current_period_end,
        cancel_at_period_end = EXCLUDED.cancel_at_period_end,
        updated_at = NOW()
    `,
    [
      userId,
      subscription.customer || null,
      subscription.id,
      subscription.metadata?.price_code || null,
      subscription.metadata?.plan_name || null,
      subscription.status || "unknown",
      subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000).toISOString()
        : null,
      Boolean(subscription.cancel_at_period_end),
    ]
  );

  if (userId && subscription.customer) {
    await pool.query(
      "UPDATE users SET stripe_customer_id = COALESCE(stripe_customer_id, $2) WHERE id = $1",
      [userId, subscription.customer]
    );
  }
}

async function registerStripeEvent(event) {
  const result = await pool.query(
    `
      INSERT INTO stripe_events (stripe_event_id, event_type, created_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (stripe_event_id) DO NOTHING
      RETURNING stripe_event_id
    `,
    [event.id, event.type]
  );

  return result.rowCount > 0;
}

async function getAuthenticatedUser(req) {
  if (!isDatabaseAvailable()) {
    return { user: null };
  }

  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];

  if (!token) {
    return { user: null };
  }

  const tokenHash = hashSessionToken(token);
  const result = await pool.query(
    `
      SELECT u.id, u.name, u.email, u.stripe_customer_id
      FROM user_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.expires_at > NOW()
      LIMIT 1
    `,
    [tokenHash]
  );

  return { user: result.rows[0] || null };
}

async function createUserSession(res, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();

  await pool.query(
    `
      INSERT INTO user_sessions (user_id, token_hash, expires_at, created_at)
      VALUES ($1, $2, $3, NOW())
    `,
    [userId, tokenHash, expiresAt]
  );

  setSessionCookie(res, token, expiresAt);
}

async function deleteSessionByToken(token) {
  const tokenHash = hashSessionToken(token);
  await pool.query("DELETE FROM user_sessions WHERE token_hash = $1", [tokenHash]);
}

async function getLatestSubscriptionForUser(userId) {
  const result = await pool.query(
    `
      SELECT
        plan_code,
        plan_name,
        status,
        current_period_end,
        cancel_at_period_end,
        stripe_subscription_id
      FROM subscriptions
      WHERE user_id = $1
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [userId]
  );

  return result.rows[0] || null;
}

async function getUserByEmail(email) {
  const result = await pool.query(
    "SELECT id, name, email, password_hash, stripe_customer_id FROM users WHERE email = $1 LIMIT 1",
    [email]
  );

  return result.rows[0] || null;
}

async function createUser({ name, email, passwordHash }) {
  const result = await pool.query(
    `
      INSERT INTO users (name, email, password_hash, created_at)
      VALUES ($1, $2, $3, NOW())
      RETURNING id, name, email, stripe_customer_id
    `,
    [name || null, email, passwordHash]
  );

  return result.rows[0];
}

async function ensureStripeCustomer(user) {
  if (user.stripe_customer_id) {
    return user.stripe_customer_id;
  }

  const params = new URLSearchParams();
  params.set("email", user.email);

  if (user.name) {
    params.set("name", user.name);
  }

  params.set("metadata[user_id]", String(user.id));

  const stripeCustomer = await stripeRequest("/v1/customers", params);

  await pool.query(
    "UPDATE users SET stripe_customer_id = $2 WHERE id = $1",
    [user.id, stripeCustomer.id]
  );

  user.stripe_customer_id = stripeCustomer.id;
  return stripeCustomer.id;
}

async function stripeRequest(endpoint, params) {
  const response = await fetch(`https://api.stripe.com${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  const payload = await response.json();

  if (!response.ok) {
    console.error("Stripe API error:", payload);
    throw new Error(payload.error?.message || "Stripe API request failed.");
  }

  return payload;
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      stripe_customer_id TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT NOT NULL UNIQUE,
      plan_code TEXT,
      plan_name TEXT,
      status TEXT NOT NULL,
      current_period_end TIMESTAMPTZ,
      cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS stripe_events (
      id SERIAL PRIMARY KEY,
      stripe_event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function serveStaticFile(res, originalPathname) {
  let pathname = ROUTE_ALIASES[originalPathname] || originalPathname;

  if (pathname === "/favicon.ico") {
    res.writeHead(204);
    return res.end();
  }

  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(ROOT_DIR, safePath);

  if (!filePath.startsWith(ROOT_DIR)) {
    return sendJson(res, 403, { error: "Forbidden." });
  }

  try {
    const stat = await fsp.stat(filePath);

    if (!stat.isFile()) {
      return sendJson(res, 404, { error: "File not found." });
    }

    const extension = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[extension] || "application/octet-stream";
    const fileBuffer = await fsp.readFile(filePath);

    res.writeHead(200, { "Content-Type": contentType });
    res.end(fileBuffer);
  } catch {
    return sendJson(res, 404, { error: "File not found." });
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return header.split(";").reduce((acc, part) => {
    const [name, ...rest] = part.trim().split("=");
    if (!name || rest.length === 0) {
      return acc;
    }
    acc[name] = decodeURIComponent(rest.join("="));
    return acc;
  }, {});
}

function setSessionCookie(res, token, expiresAt) {
  const expires = new Date(expiresAt).toUTCString();
  const isSecure = isHttpsCookie();
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expires}`,
  ];

  if (isSecure) {
    parts.push("Secure");
  }

  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res) {
  const parts = [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];

  if (isHttpsCookie()) {
    parts.push("Secure");
  }

  res.setHeader("Set-Cookie", parts.join("; "));
}

function getBaseUrl(req) {
  if (process.env.BASE_URL) {
    return process.env.BASE_URL.replace(/\/$/, "");
  }

  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

async function readRequestBody(req) {
  const chunks = [];
  let totalSize = 0;

  for await (const chunk of req) {
    totalSize += chunk.length;
    if (totalSize > 1024 * 1024) {
      throw new Error("Request body too large.");
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await scryptAsync(password, salt);
  return `${salt}:${hash}`;
}

async function verifyPassword(password, storedHash) {
  const [salt, hash] = String(storedHash || "").split(":");
  if (!salt || !hash) {
    return false;
  }

  const candidate = await scryptAsync(password, salt);
  return safeCompare(hash, candidate);
}

function scryptAsync(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey.toString("hex"));
    });
  });
}

function hashSessionToken(token) {
  return crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(token, "utf8")
    .digest("hex");
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sanitizeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    stripeCustomerId: user.stripe_customer_id || null,
  };
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function verifyStripeSignature(signatureHeader, rawBody, webhookSecret) {
  if (!signatureHeader || !webhookSecret) {
    return false;
  }

  const parts = signatureHeader.split(",").reduce((acc, part) => {
    const [key, value] = part.split("=");
    if (key && value) {
      acc[key] = acc[key] ? [].concat(acc[key], value) : value;
    }
    return acc;
  }, {});

  const timestamp = parts.t;
  const signatures = Array.isArray(parts.v1) ? parts.v1 : parts.v1 ? [parts.v1] : [];

  if (!timestamp || signatures.length === 0) {
    return false;
  }

  const signedPayload = `${timestamp}.${rawBody.toString("utf8")}`;
  const expected = crypto
    .createHmac("sha256", webhookSecret)
    .update(signedPayload, "utf8")
    .digest("hex");

  return signatures.some((candidate) => safeCompare(expected, candidate));
}

function safeCompare(expected, candidate) {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const candidateBuffer = Buffer.from(candidate, "utf8");

  if (expectedBuffer.length !== candidateBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, candidateBuffer);
}

function assertServerAuthConfig(res) {
  if (!isDatabaseAvailable()) {
    sendJson(res, 500, { error: getDatabaseUnavailableMessage() });
    return false;
  }

  if (!SESSION_SECRET) {
    sendJson(res, 500, { error: "SESSION_SECRET is not configured." });
    return false;
  }

  return true;
}

function shouldUseSsl() {
  const value = String(process.env.DATABASE_SSL || "").toLowerCase();
  return value === "1" || value === "true";
}

function isDatabaseAvailable() {
  return Boolean(pool) && databaseReady;
}

function getDatabaseUnavailableMessage() {
  if (!pool) {
    return "DATABASE_URL is not configured.";
  }

  if (databaseInitError) {
    return `Database connection failed: ${databaseInitError}`;
  }

  return "Database is not ready.";
}

function isHttpsCookie() {
  return String(process.env.COOKIE_SECURE || "").toLowerCase() === "true" ||
    String(process.env.BASE_URL || "").startsWith("https://");
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const envContents = fs.readFileSync(filePath, "utf8");
  const lines = envContents.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^"(.*)"$/, "$1");

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function getErrorMessage(error) {
  if (!error) {
    return "Unknown error";
  }

  if (typeof error.message === "string" && error.message.trim()) {
    return error.message.trim();
  }

  return String(error);
}
