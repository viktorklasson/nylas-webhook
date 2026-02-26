/**
 * Nylas webhook server for Render.io
 *
 * - GET ?challenge=xxx → return challenge (verification).
 * - POST: verify signature, on message.created parse forwarded email for
 *   company name + domain and create an order in SaleSys.
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

// Health check
app.get("/", (req, res) => {
  res.send("Nylas webhook endpoint. Use GET /webhook?challenge=... for verification.");
});

/**
 * Strip HTML tags and decode common entities for regex over plain text.
 */
function stripHtml(html) {
  if (!html || typeof html !== "string") return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Get the message object from Nylas webhook payload.
 * Nylas v3 sends data.application_id and data.object (the message); older or alternate shapes put message fields on data directly.
 */
function getMessageData(payload) {
  const data = payload.data;
  if (!data) return null;
  const msg = data.object && typeof data.object === "object" ? data.object : data;
  if (msg.subject != null || msg.body != null || msg.snippet != null || msg.id) return msg;
  return null;
}

/**
 * Fetch full message from Nylas API when webhook only sent id/grant_id.
 */
async function fetchNylasMessage(messageId, grantId) {
  const apiKey = process.env.NYLAS_API_KEY;
  const baseUrl = process.env.NYLAS_API_URI || "https://api.us.nylas.com";
  if (!apiKey || !messageId || !grantId) return null;
  try {
    const url = `${baseUrl.replace(/\/$/, "")}/v3/grants/${grantId}/messages/${messageId}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error("Nylas fetch error:", e.message);
    return null;
  }
}

/**
 * Normalize domain for fuzzy matching (lowercase, no www, trim).
 */
function normalizeDomain(domain) {
  if (!domain || typeof domain !== "string") return "";
  return domain.toLowerCase().replace(/^www\./, "").trim();
}

/**
 * Extract the next text element after the first string containing "företag" (case insensitive) in HTML or plain text.
 */
function getCompanyNameAfterForetag(text) {
  if (!text || typeof text !== "string") return null;
  const idx = text.search(/företag/i);
  if (idx === -1) return null;
  const m = text.slice(idx).match(/företag/i);
  const after = text.slice(idx + (m ? m[0].length : 0));
  const plain = stripHtml(after).replace(/\s+/g, " ").trim();
  const nameMatch = plain.match(/^([A-Za-zÅÄÖåäö0-9\s\-.,()&]+?)(?=\s+Start\s|\s+Plats\s|$)/i) || plain.match(/^([A-Za-zÅÄÖåäö0-9\s\-.,()&]+)/);
  return nameMatch ? nameMatch[1].trim() || null : null;
}

/**
 * Extract the first email address appearing after the keyword "Resurs" (case insensitive).
 */
function getEmailAfterResurs(text) {
  if (!text || typeof text !== "string") return null;
  const plain = stripHtml(text);
  const m = plain.match(/resurs\b[\s\S]*?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
  return m ? m[1] : null;
}

/**
 * Extract the first URL-like string appearing after the keyword "Url" (case insensitive).
 */
function getUrlAfterUrl(text) {
  if (!text || typeof text !== "string") return null;
  const plain = stripHtml(text);
  const m = plain.match(/\burl\b[\s\S]*?((?:https?:\/\/)?(?:www\.)?[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}(?:\/\S*)?)/i);
  return m ? m[1] : null;
}

/**
 * Parse forwarded booking email (Bright / Loop style) for company name, domain, and salesperson email.
 * - Company (Företag): next text element after first string containing "företag" (case insensitive).
 * - Salesperson email (Resurs): next email address after the word "Resurs".
 * - Domain (Url): next URL-like string after the word "Url".
 */
function parseForwardedEmail(data) {
  const body = data.body || "";
  const snippet = data.snippet || "";
  const result = { companyName: null, domain: null, salespersonEmail: null };

  // Företag: next text after first "företag" (case insensitive) in body or snippet
  result.companyName = getCompanyNameAfterForetag(body) || getCompanyNameAfterForetag(snippet);

  // Resurs: next email address after the word "Resurs"
  result.salespersonEmail = getEmailAfterResurs(body) || getEmailAfterResurs(snippet);

  // Url: next URL-like string after the word "Url" → extract domain
  const url = getUrlAfterUrl(body) || getUrlAfterUrl(snippet);
  if (url) {
    result.domain = normalizeDomain(url.replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
  }

  return result;
}

/**
 * Create order in SaleSys with Domän, Företag, and Säljare e-post.
 */
async function createSaleSysOrder(parsed) {
  const bearer = process.env.SALESYS_BEARER;
  const userId = process.env.SALESYS_USER_ID;
  const projectId = process.env.SALESYS_PROJECT_ID;
  const tagIds = process.env.SALESYS_TAG_IDS ? JSON.parse(process.env.SALESYS_TAG_IDS) : ["698f547309154bfcc1f0bb87"];
  const fieldIdDomain = process.env.SALESYS_FIELD_ID_DOMAIN || "698f51a709154bfcc1f0ba02";       // Domän
  const fieldIdCompany = process.env.SALESYS_FIELD_ID_COMPANY || "65784e2c2a93b41dba43d3cb";   // Företag
  const fieldIdSalespersonEmail = process.env.SALESYS_FIELD_ID_SALESPERSON_EMAIL || "698f542309154bfcc1f0bb71"; // Säljare e-post

  if (!bearer || !userId || !projectId) {
    console.warn("SaleSys env not configured (SALESYS_BEARER, SALESYS_USER_ID, SALESYS_PROJECT_ID); skipping order.");
    return null;
  }

  if (!parsed.domain && !parsed.companyName) {
    console.warn("No domain or company name parsed; skipping SaleSys order.");
    return null;
  }

  const now = new Date();
  const businessDate = new Date(now);
  businessDate.setDate(businessDate.getDate() + 4);

  const fields = [
    { fieldId: fieldIdDomain, value: parsed.domain || "", changedByUser: true },
    { fieldId: fieldIdCompany, value: parsed.companyName || "", changedByUser: true },
    { fieldId: fieldIdSalespersonEmail, value: parsed.salespersonEmail || "", changedByUser: true },
  ];
  const fieldValues = {
    [fieldIdDomain]: parsed.domain || "",
    [fieldIdCompany]: parsed.companyName || "",
    [fieldIdSalespersonEmail]: parsed.salespersonEmail || "",
  };

  const body = {
    tagIds,
    date: now.toISOString(),
    businessDate: businessDate.toISOString(),
    userId,
    products: [],
    fields,
    comments: [],
    files: [],
    externalEvents: [],
    isTest: false,
    projectId,
    calendarEventIds: [],
    calendarEvents: null,
    fieldValues,
    autoFill: false,
  };

  const res = await fetch("https://app.salesys.se/api/orders/orders-v2", {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/json",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("SaleSys order failed:", res.status, text);
    return null;
  }
  const data = await res.json();
  console.log("SaleSys order created:", data.id || data);
  return data;
}

app.all("/webhook", async (req, res) => {
  if (req.method === "GET") {
    const challenge = req.query.challenge;
    if (challenge != null && String(challenge).length > 0) {
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

  const rawBody = req.body;
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
  if (!verifySignature(rawBody, webhookSecret, signature)) {
    res.status(403).send("Invalid signature");
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch (e) {
    console.error("Webhook payload parse error:", e.message);
    res.status(200).send("OK");
    return;
  }

  const eventType = payload.type || payload.event;
  console.log("Webhook:", eventType);

  let data = getMessageData(payload);
  const rawData = payload.data;

  if (eventType === "message.created" || eventType === "message.updated") {
    const msgRef = rawData?.object && typeof rawData.object === "object" ? rawData.object : rawData;
    if (!data && msgRef?.id && msgRef?.grant_id) {
      console.log("Payload has id/grant_id but no body; fetching message from Nylas API.");
      data = await fetchNylasMessage(msgRef.id, msgRef.grant_id);
    }
    if (data && (data.body == null || data.body === "") && data.id && data.grant_id) {
      console.log("Message has no body; fetching full message from Nylas API.");
      data = await fetchNylasMessage(data.id, data.grant_id) || data;
    }
    if (data) {
      const subjectLen = (data.subject || "").length;
      const bodyLen = (data.body || "").length;
      const snippetLen = (data.snippet || "").length;
      console.log("Payload data keys:", Object.keys(data).join(", "), "| subject:", subjectLen, "body:", bodyLen, "snippet:", snippetLen);
      if (subjectLen) console.log("Subject:", (data.subject || "").slice(0, 120));
      const parsed = parseForwardedEmail(data);
      console.log("Parsed:", parsed);
      createSaleSysOrder(parsed).catch((err) => console.error("SaleSys error:", err));
    } else {
      console.log("No message data; payload.data keys:", rawData ? Object.keys(rawData).join(", ") : "none");
    }
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
