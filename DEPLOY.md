# ROSpad — Self-Hosted Server Deployment Guide

> **This guide is for the self-hosted (offline / LAN) deployment only.**
> If you have internet access, use the hosted version at **[https://niravatgit.github.io/ROSPad/](https://niravatgit.github.io/ROSPad/)** — no server required.

The self-hosted server is ideal for:
- University classrooms without reliable internet
- Schools that want full data control
- Large cohorts (100+ students) on a local network

---

## Requirements

- Ubuntu 22.04 / 24.04 server
- Node.js 20+
- nginx (recommended for HTTPS and proper headers)
- 2+ GB RAM

---

## 1. Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # should print v20.x
```

---

## 2. Clone and Install ROSpad

```bash
git clone https://github.com/niravatgit/ROSPad.git /opt/rospad
cd /opt/rospad
npm install
```

---

## 3. Configure Environment

```bash
cp .env.example .env
nano .env
```

Set a strong, random `SESSION_SECRET` — this signs all user sessions. Never use the default.

```env
SESSION_SECRET=your-long-random-secret-here
PORT=3000
```

---

## 4. Configure nginx

ROSpad requires two HTTP headers for SharedArrayBuffer (needed by Pyodide). These **must** be set.

```bash
sudo nano /etc/nginx/sites-available/rospad
```

Paste:

```nginx
server {
    listen 80;
    server_name YOUR_DOMAIN_OR_IP;

    # Required for Pyodide / SharedArrayBuffer
    add_header Cross-Origin-Opener-Policy  "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_read_timeout 300s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/rospad /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## 5. HTTPS (strongly recommended)

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d YOUR_DOMAIN
```

HTTPS is required for some browser APIs and is strongly recommended for any network beyond localhost.

---

## 6. Run as a systemd Service

```bash
sudo nano /etc/systemd/system/rospad.service
```

Paste:

```ini
[Unit]
Description=ROSpad ROS2 Browser IDE
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/rospad
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
RestartSec=5
EnvironmentFile=/opt/rospad/.env
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable rospad
sudo systemctl start rospad
sudo systemctl status rospad   # should show active (running)
```

---

## 7. First Login

Navigate to `http://YOUR_SERVER_IP` (or your domain). On first visit you'll see a login screen. Register an account — the first registered user automatically becomes an instructor. Additional accounts are student accounts by default.

---

## 8. Capacity Notes

- Each student tab = 1 persistent HTTP connection
- Pyodide runs in the browser — **zero server CPU per student**
- The server only handles file I/O and WebSocket ping/pong
- 100 students = easily handled by a 2-core / 2 GB VPS
- RAM is almost entirely browser-side (Pyodide loads per tab)

---

## 9. Monitoring

```bash
# Live connections
watch -n 2 'ss -tn | grep :3000 | wc -l'

# ROSpad logs
journalctl -u rospad -f

# nginx access log
tail -f /var/log/nginx/access.log
```

---

## Updating

```bash
cd /opt/rospad
git pull
npm install
sudo systemctl restart rospad
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Pyodide won't load | Check COOP/COEP headers are set in nginx |
| SharedArrayBuffer error | Same — headers missing |
| Files not saving | Check write permissions on `rospad_user_data/` |
| Port 3000 not responding | `sudo systemctl status rospad` |
| HTTPS cert expired | `sudo certbot renew` |
