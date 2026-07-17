# RustDesk kiosk chat server

This service is independent from `hbbs`/`hbbr`. Run it as its own Node.js process and reverse-proxy it over HTTPS.

```bash
cd server
npm ci
ADMIN_TOKEN='replace-with-a-long-random-value' PORT=3000 node index.js
```

`ADMIN_TOKEN` is required for the dashboard and boss chat. It is never embedded in the RustDesk client. The RustDesk app stores a random per-device chat token locally, sends it during device registration, and uses it to access only that device's private conversation.

Keep port 3000 private behind a TLS proxy where possible, then configure the app's **API server** to the public HTTPS URL. Do not expose the Node service directly over HTTP: it carries unattended RustDesk passwords and chat credentials.
