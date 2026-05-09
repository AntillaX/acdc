# Deploy — AC/DC on platformvv.com

Deploys alongside Platform, Auction, and Level 0 on the same droplet.

## What this adds

- A new Node service on **port 3300** (binds to `127.0.0.1`)
- A new nginx `/acdc/` route
- A new featured tile on the landing hub (deployed from the Auction
  repo's `deploy/hub/index.html`)

## One-time setup on the droplet

SSH in, then:

```bash
# 1. Clone the repo into /opt
sudo git clone https://github.com/AntillaX/acdc.git /opt/acdc
cd /opt/acdc
sudo npm ci --omit=dev

# 2. Install the systemd unit
sudo cp deploy/acdc.service /etc/systemd/system/acdc.service
sudo systemctl daemon-reload
sudo systemctl enable --now acdc
sudo systemctl status acdc   # should show "active (running)"

# 3. Add the nginx route
#    Open the existing site config:
sudo nano /etc/nginx/sites-available/vv
#    Paste the contents of deploy/nginx-snippet.conf inside the
#    server { ... } block, next to the /auction/ and /level0/ blocks.
#    (The Auction repo's deploy/nginx-vv.conf already includes the
#    /acdc/ block — if you redeploy that file wholesale, this step
#    is already covered.)

# 4. Test & reload nginx
sudo nginx -t && sudo systemctl reload nginx

# 5. Refresh the landing hub (from the Auction repo)
sudo cp /opt/auction/deploy/hub/index.html /var/www/vv/index.html
#    Then purge Cloudflare's cache for the root URL.
```

## Updates

```bash
cd /opt/acdc
sudo git pull
sudo npm ci --omit=dev   # only if package-lock.json changed
sudo systemctl restart acdc
```

## Layout on the droplet

```
/opt/acdc/              ← cloned from github.com/antillax/acdc
  server.js
  public/
  ...
```

## Ports

- `8080` — Platform relay
- `3100` — Auction
- `3200` — Level 0
- `3300` — AC/DC (new)

All bind to `127.0.0.1` and are proxied through nginx on `:80` (and
`:443` once Cloudflare or Let's Encrypt is in front).
