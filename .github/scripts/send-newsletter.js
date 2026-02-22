const https = require("https");
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

const { RESEND_API_KEY, WORKER_URL, WORKER_SECRET, RESEND_FROM, EPISODE_DATE } = process.env;

if (!RESEND_API_KEY || !WORKER_URL || !WORKER_SECRET || !EPISODE_DATE) {
  console.log("Missing required env vars, skipping newsletter");
  process.exit(0);
}

const emailPath = path.join("episodes", EPISODE_DATE, "email.html");
if (!fs.existsSync(emailPath)) {
  console.error("Email HTML not found:", emailPath);
  process.exit(1);
}
const emailTemplate = fs.readFileSync(emailPath, "utf-8");

function maskEmail(email) {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  const maskedLocal = local.length <= 2 ? "*".repeat(local.length) : local[0] + "*".repeat(local.length - 2) + local[local.length - 1];
  return maskedLocal + "@" + domain;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function hmacToken(email, secret) {
  return crypto.createHmac("sha256", secret).update(email).digest("hex");
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const BATCH_SIZE = 50;
const FROM = RESEND_FROM || "YOMOO 每日AI快送 <daily@yomoo.net>";
const SUBJECT = "YOMOO 每日AI快送 — " + EPISODE_DATE;

async function sendBatch(emails, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const resp = await fetchJson("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + RESEND_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(emails),
    });

    if (resp.status >= 200 && resp.status < 300) {
      return { success: true, data: resp.data };
    }

    if (resp.status === 429 && attempt < maxRetries) {
      const backoff = attempt * 3000;
      console.log("  Rate limited, retrying batch in", backoff, "ms...");
      await sleep(backoff);
      continue;
    }

    return { success: false, status: resp.status, data: resp.data };
  }
  return { success: false, status: 429, data: "Max retries exceeded" };
}

async function sendSingle(email, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const resp = await fetchJson("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + RESEND_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(email),
    });

    if (resp.status >= 200 && resp.status < 300) {
      return { success: true };
    }

    if (resp.status === 429 && attempt < maxRetries) {
      const backoff = attempt * 2000;
      await sleep(backoff);
      continue;
    }

    return { success: false, status: resp.status };
  }
  return { success: false, status: 429 };
}

function buildEmailPayload(sub, workerUrl) {
  const token = hmacToken(sub.email, WORKER_SECRET);
  const unsubUrl = workerUrl + "/unsubscribe?email=" + encodeURIComponent(sub.email) + "&token=" + token;
  const html = emailTemplate.replace(/{{UNSUBSCRIBE_URL}}/g, unsubUrl);
  return {
    from: FROM,
    to: sub.email,
    subject: SUBJECT,
    html: html,
  };
}

async function main() {
  const workerUrl = WORKER_URL.replace(/\/$/, "");
  console.log("Fetching subscribers...");

  const subResp = await fetchJson(workerUrl + "/subscribers", {
    method: "GET",
    headers: { "X-API-Secret": WORKER_SECRET },
  });

  if (subResp.status !== 200) {
    console.error("Failed to fetch subscribers:", subResp.status);
    process.exit(1);
  }

  const allSubscribers = subResp.data;
  console.log("Found", allSubscribers.length, "subscriber(s)");

  // Filter out invalid emails
  const valid = allSubscribers.filter(s => isValidEmail(s.email));
  const invalid = allSubscribers.filter(s => !isValidEmail(s.email));
  if (invalid.length > 0) {
    console.log("Skipping", invalid.length, "invalid email(s):", invalid.map(s => maskEmail(s.email)).join(", "));
  }

  if (valid.length === 0) {
    console.log("No valid subscribers, done");
    return;
  }

  // Build payloads
  const allEmails = valid.map(sub => buildEmailPayload(sub, workerUrl));

  let sent = 0, failed = 0;

  // Try batch first
  for (let i = 0; i < allEmails.length; i += BATCH_SIZE) {
    const batch = allEmails.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(allEmails.length / BATCH_SIZE);
    console.log(`Sending batch ${batchNum}/${totalBatches} (${batch.length} emails)...`);

    const result = await sendBatch(batch);

    if (result.success) {
      sent += batch.length;
      for (const e of batch) {
        console.log("  Sent to", maskEmail(e.to));
      }
    } else {
      // Batch failed — fall back to sending one by one
      console.log("  Batch failed (" + result.status + "), falling back to individual sends...");
      for (const e of batch) {
        const r = await sendSingle(e);
        if (r.success) {
          sent++;
          console.log("  Sent to", maskEmail(e.to));
        } else {
          failed++;
          console.error("  Failed for", maskEmail(e.to), ":", r.status);
        }
        await sleep(600);
      }
    }

    if (i + BATCH_SIZE < allEmails.length) {
      await sleep(1000);
    }
  }

  console.log("Done:", sent, "sent,", failed, "failed, out of", valid.length);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
