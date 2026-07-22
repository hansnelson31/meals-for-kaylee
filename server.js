/**
 * Meal sign-up server.
 *
 * Serves the page out of public/ and keeps the sign-ups in Postgres.
 * Runs on Fly.io.
 *
 * Environment variables:
 *   DATABASE_URL  connection string from Fly Postgres, set as a secret.
 *                 If it is missing the server keeps sign-ups in memory
 *                 instead, which is fine for poking at it locally but
 *                 loses everything on restart (a real risk on Fly, since
 *                 the machine can stop and restart between visits).
 *   PORT          set in fly.toml / the Dockerfile.
 */

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const HOST_PIN = process.env.HOST_PIN || "7776";

/* ---------- storage ---------- */

let db = null;
const memory = new Map();

async function initDb() {
  if (!DATABASE_URL) {
    console.log("No DATABASE_URL set. Using in-memory storage (nothing persists).");
    return;
  }
  const { Pool } = require("pg");
  // Fly's internal Postgres runs on a private network with no SSL
  // (its connection string says so via sslmode=disable). Anything else
  // gets the relaxed-but-encrypted default.
  const noSsl = DATABASE_URL.includes("localhost") || DATABASE_URL.includes("sslmode=disable");
  db = new Pool({
    connectionString: DATABASE_URL,
    ssl: noSsl ? false : { rejectUnauthorized: false }
  });
  await db.query(`
    CREATE TABLE IF NOT EXISTS signups (
      slot_date  TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      contact    TEXT NOT NULL,
      meal       TEXT NOT NULL,
      note       TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  console.log("Connected to Postgres.");
}

async function readAll() {
  if (!db) return Object.fromEntries(memory);
  const { rows } = await db.query("SELECT * FROM signups");
  const out = {};
  for (const r of rows) {
    out[r.slot_date] = { name: r.name, contact: r.contact, meal: r.meal, note: r.note || "" };
  }
  return out;
}

/** Strips contact info — used for anything visible to the public. */
function stripContact(entry) {
  return { name: entry.name, meal: entry.meal, note: entry.note };
}
function withoutContact(all) {
  const out = {};
  for (const [date, entry] of Object.entries(all)) out[date] = stripContact(entry);
  return out;
}

/** Returns the existing entry if the night was already taken, otherwise null. */
async function claim(date, entry) {
  if (!db) {
    if (memory.has(date)) return memory.get(date);
    memory.set(date, entry);
    return null;
  }
  const { rows } = await db.query(
    `INSERT INTO signups (slot_date, name, contact, meal, note)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (slot_date) DO NOTHING
     RETURNING slot_date`,
    [date, entry.name, entry.contact, entry.meal, entry.note]
  );
  if (rows.length) return null; // the insert won
  const taken = await db.query("SELECT * FROM signups WHERE slot_date = $1", [date]);
  const r = taken.rows[0];
  return { name: r.name, contact: r.contact, meal: r.meal, note: r.note || "" };
}

async function release(date) {
  if (!db) { memory.delete(date); return; }
  await db.query("DELETE FROM signups WHERE slot_date = $1", [date]);
}

/* ---------- routes ---------- */

app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/signups", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json(withoutContact(await readAll()));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not read the sign-ups." });
  }
});

/* Host-only view: same data, but with contact info included. Gated by
   a shared PIN rather than a real login, since this is just a family
   meal train and not worth building accounts for. */
app.post("/api/host/signups", async (req, res) => {
  const pin = String((req.body || {}).pin || "");
  if (pin !== HOST_PIN) {
    return res.status(401).json({ error: "Wrong PIN." });
  }
  try {
    res.set("Cache-Control", "no-store");
    res.json(await readAll());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not read the sign-ups." });
  }
});

app.get("/host", (req, res) => res.sendFile(path.join(__dirname, "public", "host.html")));

app.post("/api/signups/:date", async (req, res) => {
  const date = req.params.date;
  const b = req.body || {};
  const entry = {
    name: String(b.name || "").trim().slice(0, 120),
    contact: String(b.contact || "").trim().slice(0, 120),
    meal: String(b.meal || "").trim().slice(0, 400),
    note: String(b.note || "").trim().slice(0, 600)
  };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "That is not a valid date." });
  }
  if (!entry.name || !entry.contact || !entry.meal) {
    return res.status(400).json({ error: "Name, contact, and meal are all required." });
  }

  try {
    const taken = await claim(date, entry);
    if (taken) return res.status(409).json({ error: "taken", entry: stripContact(taken) });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save that sign-up." });
  }
});

app.delete("/api/signups/:date", async (req, res) => {
  try {
    await release(req.params.date);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not cancel that sign-up." });
  }
});

/* Fly pings this to confirm the machine is healthy and awake. */
app.get("/healthz", (req, res) => res.send("ok"));

initDb()
  .catch(err => console.error("Database setup failed:", err))
  .finally(() => {
    app.listen(PORT, () => console.log("Listening on port " + PORT));
  });
