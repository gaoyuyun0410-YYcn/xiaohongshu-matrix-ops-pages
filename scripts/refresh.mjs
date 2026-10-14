import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ITERATIONS = 210_000;
const password = process.env.DASHBOARD_PASSWORD;
if (!password) throw new Error("DASHBOARD_PASSWORD secret is required");

function encrypt(value) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return {
    version: 1,
    algorithm: "AES-256-GCM",
    kdf: "PBKDF2-SHA256",
    iterations: ITERATIONS,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    ciphertext: encrypted.toString("base64"),
    updatedAt: value.fetchedAt,
  };
}

function decrypt(envelope) {
  const salt = Buffer.from(envelope.salt, "base64");
  const iv = Buffer.from(envelope.iv, "base64");
  const encrypted = Buffer.from(envelope.ciphertext, "base64");
  const tag = encrypted.subarray(encrypted.length - 16);
  const body = encrypted.subarray(0, encrypted.length - 16);
  const key = pbkdf2Sync(password, salt, envelope.iterations, 32, "sha256");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8"));
}

const config = process.env.CHANNEL_CONFIG
  ? JSON.parse(process.env.CHANNEL_CONFIG)
  : decrypt(JSON.parse(await readFile(resolve(process.env.CONFIG_ENCRYPTED_PATH || "config.enc.json"), "utf8")));
if (!config?.accountId || !Array.isArray(config.channels) || !config.channels.length) throw new Error("Valid encrypted channel config is required");
const ACCOUNT_ID = config.accountId;
const CHANNELS = config.channels;

async function fetchPreviousRows() {
  const url = process.env.PREVIOUS_DATA_URL;
  if (!url) return [];
  try {
    const response = await fetch(`${url}?t=${Date.now()}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return [];
    const payload = decrypt(await response.json());
    return Array.isArray(payload.rows) ? payload.rows : [];
  } catch (error) {
    console.warn(`Previous history unavailable: ${error instanceof Error ? error.message : "unknown"}`);
    return [];
  }
}

async function fetchChannel([name, id, sourceUrl], fetchedAt) {
  const endpoint = new URL("https://alliance.yunzhanxinxi.com/promotion/statistics");
  endpoint.searchParams.set("accountsid", ACCOUNT_ID);
  endpoint.searchParams.set("channelid", id);
  try {
    const response = await fetch(endpoint, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(25_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.code !== 200 || !payload?.data) throw new Error(`source code ${payload?.code ?? "unknown"}`);
    const sourceRows = Array.isArray(payload.data.statistics_list) ? payload.data.statistics_list : [];
    const total = payload.data.statistics_total || {};
    return {
      channel: {
        name,
        id,
        sourceUrl,
        status: "ok",
        error: null,
        total: {
          orders: Number(total.valid_num),
          commission: Number(total.estimate_valid_amount),
          gmv: Number(total.valid_amount),
          orders30d: Number(total.days_valid_num),
          commission30d: Number(total.days_estimate_valid_amount),
          gmv30d: Number(total.days_valid_amount),
        },
        sourceRowCount: sourceRows.length,
      },
      rows: sourceRows.map((row) => ({
        channel_id: id,
        channel_name: name,
        stat_date: row.statistics_date,
        orders: Number(row.valid_num),
        commission: Number(row.estimate_valid_amount),
        gmv: Number(row.valid_amount),
        observed_at: fetchedAt,
      })),
    };
  } catch (error) {
    return {
      channel: { name, id, sourceUrl, status: "error", error: error instanceof Error ? error.message : "unknown", total: null, sourceRowCount: 0 },
      rows: [],
    };
  }
}

const fetchedAt = new Date().toISOString();
const results = await Promise.all(CHANNELS.map((channel) => fetchChannel(channel, fetchedAt)));
const rowsByKey = new Map((await fetchPreviousRows()).map((row) => [`${row.channel_id}:${row.stat_date}`, row]));
for (const row of results.flatMap((result) => result.rows)) rowsByKey.set(`${row.channel_id}:${row.stat_date}`, row);
const rows = [...rowsByKey.values()].sort((a, b) => a.stat_date.localeCompare(b.stat_date) || a.channel_name.localeCompare(b.channel_name, "zh-CN"));
const payload = {
  fetchedAt,
  refreshSeconds: 300,
  sourceWindow: "源站近30天逐日明细 + GitHub 已保存历史 + 平台累计汇总",
  historyStart: rows[0]?.stat_date || null,
  channels: results.map((result) => result.channel),
  rows,
};

if (!results.some((result) => result.channel.status === "ok")) throw new Error("All upstream sources failed; keeping the last successful Pages deployment");
const outputPath = process.env.OUTPUT_PATH ? resolve(process.env.OUTPUT_PATH) : resolve(dirname(fileURLToPath(import.meta.url)), "..", "data.enc.json");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(encrypt(payload))}\n`, { mode: 0o600 });
console.log(JSON.stringify({ outputPath, fetchedAt, channels: payload.channels.length, ok: payload.channels.filter((channel) => channel.status === "ok").length, rows: rows.length }));
