# AC/DC

Two-player simultaneous-pick game.

Each turn one player attacks and the other defends. Both privately pick a
number 1–4. Reveal is simultaneous. Match → defender blocks, turn ends,
roles swap. Mismatch → attacker scores points equal to their pick and
the turn continues. 5 attack turns per player (10 total). 30-point lead
ends the game instantly. Tie after 10 → sudden death until someone
leads at the end of a turn.

## Run

```
npm install
npm start
```

Defaults to port 3000; on the droplet the systemd unit pins it to 3300
behind nginx at `/acdc/`. See `deploy/README.md`.
