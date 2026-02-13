/**
 * Nylas webhook server for Render.io
 *
 * Verification: Nylas sends GET ?challenge=xxx — we must respond with 200 and
 * the exact challenge string in the body (no quotes, no chunked encoding).
 * POST: verify X-Nylas-Signature and respond 200 OK.
 */

const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// Raw body for POST so we can verify signature on exact bytes
app.use(
  "/webhook",
  express.raw({ type: "application/json", limit: "2mb" })
);

// Health check (Render and browsers)
app.get("/", (req, res) => {
  res.send("Nylas webhook endpoint. Use GET /webhook?challenge=... for verification.");
});

/**
 * Nylas webhook endpoint.
 * GET: verification challenge — return challenge as plain text, 200 OK.
 * POST: notification — verify signature, respond 200 OK.
 */
app.all("/webhook", (req, res) => {
  if (req.method === "GET") {
    const challenge = req.query.challenge;
    if (challenge != null && String(challenge).length > 0) {
      // Required: 200 OK with exact challenge in body (no quotes, no chunked)
      res.status(200).set("Content-Type", "text/plain").send(String(challenge));
      return;
    }
    res.status(400).send("Missing challenge");
    return;
  }

  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  const rawBody = req.body; // Buffer from express.raw()
  const signature = req.headers["x-nylas-signature"] || req.headers["X-Nylas-Signature"];
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("WEBHOOK_SECRET is not set");
    res.status(500).send("Server misconfiguration");
    return;
  }

  if (!signature) {
    res.status(401).send("Missing signature");
    return;
  }

  const isValid = verifySignature(rawBody, webhookSecret, signature);
  if (!isValid) {
    res.status(403).send("Invalid signature");
    return;
  }

  try {
    const payload = JSON.parse(rawBody.toString("utf8"));
    console.log("Webhook:", payload.type || payload);
    // Process payload here (e.g. grant.created, message.created, etc.)
  } catch (e) {
    console.error("Webhook payload parse error:", e.message);
  }

  res.status(200).send("OK");
});

function verifySignature(rawBody, secret, signature) {
  try {
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(rawBody);
    const expected = hmac.digest("hex");
    return crypto.timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expected, "hex")
    );
  } catch (e) {
    return false;
  }
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Nylas webhook listening on port ${PORT}`);
});
