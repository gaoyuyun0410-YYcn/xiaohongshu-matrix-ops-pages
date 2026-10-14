import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [input, output] = process.argv.slice(2);
const password = process.env.DASHBOARD_PASSWORD;
if (!password || !input || !output) throw new Error("Usage: DASHBOARD_PASSWORD=... node encrypt-config.mjs input.json output.enc.json");
const config = JSON.parse(await readFile(resolve(input), "utf8"));
if (!config?.accountId || !Array.isArray(config.channels) || !config.channels.length) throw new Error("Invalid channel config");

const iterations = 210_000;
const salt = randomBytes(16);
const iv = randomBytes(12);
const key = pbkdf2Sync(password, salt, iterations, 32, "sha256");
const cipher = createCipheriv("aes-256-gcm", key, iv);
const ciphertext = Buffer.concat([cipher.update(JSON.stringify(config), "utf8"), cipher.final(), cipher.getAuthTag()]);
await writeFile(resolve(output), `${JSON.stringify({
  version: 1,
  algorithm: "AES-256-GCM",
  kdf: "PBKDF2-SHA256",
  iterations,
  salt: salt.toString("base64"),
  iv: iv.toString("base64"),
  ciphertext: ciphertext.toString("base64"),
})}\n`, { mode: 0o600 });
console.log(`Encrypted ${config.channels.length} channel configurations`);
