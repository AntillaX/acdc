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

## Auto-deploy

Once enabled, anything merged to `main` is live within about two
minutes, without anyone touching the droplet — the same setup as
Level 0.

A systemd timer runs `deploy/deploy.sh` every two minutes and the
script decides whether there's anything to do:

- **No new commits** — exits immediately, no restart.
- **A game is in progress** — defers and tries again next tick. Rooms
  live in memory, so a restart mid-game would end it. After 45 minutes
  of waiting it deploys anyway. "In progress" comes from
  `GET /api/status` on the local port, which reports counts only.
- **`package-lock.json` changed** — reinstalls dependencies first.
- **The checkout isn't on `main`** — switches it to `main` (the clone
  may have been made from GitHub's old default branch).

`GET /acdc/api/status` also reports the commit that's running, so
"is it live yet?" can be answered from a phone browser.

### Enabling it

From the DigitalOcean web console (**Droplets → your droplet →
Access → Launch Droplet Console**):

```bash
cd /opt/acdc
sudo git fetch origin && sudo git checkout main && sudo git pull --ff-only origin main
sudo cp deploy/acdc-autodeploy.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo /opt/acdc/deploy/deploy.sh --force      # deploy what's on main now
sudo systemctl enable --now acdc-autodeploy.timer
```

Check it:

```bash
systemctl list-timers acdc-autodeploy   # next run time
sudo systemctl start acdc-autodeploy    # force a check right now
journalctl -u acdc-autodeploy -n 30     # what it did
```

Turn it off with `sudo systemctl disable --now acdc-autodeploy.timer`;
deploys go back to being manual with the same script.

## Updating by hand

Always available, whether or not the timer is enabled:

```bash
sudo /opt/acdc/deploy/deploy.sh          # deploy if main has moved
sudo /opt/acdc/deploy/deploy.sh --force  # deploy even if it hasn't
```

It fast-forwards `/opt/acdc` to the latest `main`, reinstalls
dependencies only if `package-lock.json` changed, restarts
`acdc.service`, and verifies the service came back up.

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
