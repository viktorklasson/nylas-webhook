# Nylas webhook endpoint for Render.io

Minimal Node.js server that handles [Nylas webhook verification](https://developer.nylas.com/docs/v3/notifications/webhooks/) and notifications. Use this when your host (e.g. SiteGround) blocks or alters the verification request.

## Deploy on Render.io

1. **Create a repo**  
   Create a new repository on GitHub (or GitLab) and push this project.

2. **New Web Service on Render**  
   - [Dashboard](https://dashboard.render.com) → **New** → **Web Service**
   - Connect your repo and select this project
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free (or any plan)

3. **Environment variables**  
   In the Render service → **Environment** add:
   - `WEBHOOK_SECRET` – After the webhook is verified in the Nylas Dashboard, copy the **Webhook secret** for this destination and set it here.

4. **Webhook URL**  
   Use your Render URL plus `/webhook`, for example:
   ```text
   https://your-service-name.onrender.com/webhook
   ```

5. **Create the webhook in Nylas**  
   In [Nylas Dashboard](https://dashboard-v3.nylas.com) → **Notifications** → **Create webhook**, set:
   - **Webhook URL:** `https://your-service-name.onrender.com/webhook`
   - Choose your triggers (e.g. `grant.created`, `message.created`)

Nylas will send a GET request with `?challenge=...` to verify the endpoint. This server responds with the challenge in the body so verification succeeds on Render.

## Local run

```bash
npm install
WEBHOOK_SECRET=your_secret npm start
```

For local testing with a public URL, use [ngrok](https://ngrok.com) or [Hookdeck](https://hookdeck.com) (Nylas recommends avoiding ngrok for production-style testing).

## Endpoints

| Method | Path    | Purpose |
|--------|---------|--------|
| GET    | `/`     | Health / info |
| GET    | `/webhook?challenge=...` | Nylas verification – returns `challenge` |
| POST   | `/webhook` | Nylas notifications – verifies `X-Nylas-Signature`, returns 200 |

## Notes

- **WEBHOOK_SECRET:** Set only after creating the webhook in Nylas; the secret is shown once when the webhook is verified. If you didn’t save it, create a new webhook and set the new secret in Render.
- Respond with **200 OK** and the **exact** challenge string (no extra characters) for verification. This server does that so it works on Render even when other hosts block or modify the request.
