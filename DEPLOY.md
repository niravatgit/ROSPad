# ROSpad — Server Deployment Guide

## Requirements
- Ubuntu 22.04 / 24.04 server
- Node.js 20+
- nginx
- 2+ GB RAM (more = more concurrent students)

---

## 1. Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # should print v20.x
```

---

## 2. Clone / upload ROSpad

```bash
# Upload your rospad/ folder to server, then:
cd /opt
sudo mkdir rospad
sudo chown $USER:$USER rospad
cp -r ~/rospad/* /opt/rospad/

cd /opt/rospad
npm install
```

---

## 3. nginx config

**Critical**: ROSpad requires two special headers for SharedArrayBuffer 
(needed by Pyodide). These MUST be set.

```bash
sudo nano /etc/nginx/sites-available/rospad
```

Paste:

```nginx
server {
    listen 80;
    server_name YOUR_DOMAIN_OR_IP;

    # Required for Pyodide / SharedArrayBuffer
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;

    # Proxy to Node.js for API and WebSocket
    location /api/ {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    # Static files served by Node.js
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_read_timeout 300s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/rospad /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

## 4. HTTPS (strongly recommended)

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d YOUR_DOMAIN
# Auto-renews; HTTPS is required for some browser APIs
```

---

## 5. Run as a service (survives reboots)

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
Environment=NODE_ENV=production

# Allow more open files for 100 concurrent students
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

## 6. Per-student workspaces (multi-user)

For 100 students with isolated workspaces, add auth to server/index.js:

```bash
npm install express-session
```

Then in index.js, prefix all file paths with `sessions/${sessionId}/`:

```javascript
// Quick session-based isolation
app.use(session({ secret: 'rospad-iitm', resave: false, saveUninitialized: true }));

app.get('/api/files', (req, res) => {
  const userRoot = path.join(WORKSPACE_ROOT, 'sessions', req.session.id);
  // ...use userRoot instead of WORKSPACE_ROOT
});
```

Or use **Basic Auth** tied to student roll numbers:

```bash
sudo apt install apache2-utils
htpasswd -c /opt/rospad/.htpasswd student1
```

Add to nginx:
```nginx
auth_basic "ROSpad";
auth_basic_user_file /opt/rospad/.htpasswd;
```

---

## 7. Firewall

```bash
sudo ufw allow ssh
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```

---

## 8. Monitoring 100 students

```bash
# Watch live connections
watch -n 2 'ss -tn | grep :3000 | wc -l'

# Node.js memory/CPU
htop

# nginx access log
tail -f /var/log/nginx/access.log

# ROSpad logs
journalctl -u rospad -f
```

### Load notes
- Each student tab = 1 persistent HTTP connection
- Pyodide runs in browser — zero server CPU per student
- Server only handles file I/O (tiny)
- 100 students = easily handled by a 2-core VPS
- RAM: ~50MB server + students' browser RAM (local)

---

## 9. Serve pre-built URDF assets

```bash
mkdir -p /opt/rospad/public/urdf/ur5
# Copy UR5 URDF + meshes here
# Students load via: fetch('/urdf/ur5/ur5.urdf')
```

---

## Quick start summary

```bash
# 1. Upload files
scp -r rospad/ user@server:/opt/rospad

# 2. Install & start
cd /opt/rospad && npm install
sudo systemctl start rospad

# 3. Configure nginx (see above)

# 4. Open browser
# http://YOUR_SERVER_IP → ROSpad IDE
```

---

## Updating

```bash
# Pull new files
cd /opt/rospad
git pull  # or scp new files

# Restart server
sudo systemctl restart rospad
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Pyodide won't load | Check COOP/COEP headers are set in nginx |
| SharedArrayBuffer error | Same — headers missing |
| Files not saving | Check write permissions on workspace/ |
| Port 3000 not responding | `sudo systemctl status rospad` |
| HTTPS cert expired | `sudo certbot renew` |
