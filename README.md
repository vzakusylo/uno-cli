# uno-cli

A command-line driver for [uno-special-edition.com](https://www.uno-special-edition.com/game).
It loads the real site in a Chromium window (Playwright), signs you in, and
gives you a prompt where you can host or join a table, read the board and play
cards — all from the terminal.

## Setup

```bash
npm install
npx playwright install chromium
```

## Run

```bash
node uno.js --user alice
```

Flags:

| flag | meaning |
| --- | --- |
| `--user <name>` | username to sign in with (required) |
| `--pass <pw>` | password, if the account has one (they are optional on the site) |
| `--headless` | no visible browser window |
| `--slow <ms>` | slow-motion between actions (default 40) |
| `--exec "a; b; c"` | run these commands and exit |
| `--keep` | with `--exec` or `--bot`, drop into the prompt afterwards |
| `--bot` | unattended: take a table and play the match out |
| `--join <host>` | with `--bot`: join that player's table (otherwise host one) |
| `--minutes <n>` | with `--bot`: give up after n minutes (default 15) |
| `--color <name>` | colour to pick for wilds (default red) |
| `--mode/--format/--players` | table settings when hosting |

The browser profile is kept in `.profiles/<user>`, so the login survives
between runs.

## Commands

**Lobby**

```
rooms                     list open tables
create [mode] [fmt] [n]   host a table (default: Classic 1v1 2)
join <host|index|url>     open a table — you arrive as a spectator
seat                      take a seat
start                     start the game (host only, 2+ seated)
ready                     confirm readiness
leave                     exit the table
```

**Game**

```
state  (s)                the board: turn, pile, seats, your hand, recent log
hand                      your cards; ● playable, ○ not
play <i|name> [color]     play by index or name ("play red seven", "play 3")
draw                      draw from the deck
playnow [color] / keep    answer the "Auto-play this card?" prompt
color <red|blue|…>        pick a colour after a wild
uno                       call UNO!
auto [turns] [color]      bot mode: plays the first playable card each turn
playout [min] [color] [host]
                          bot plays the whole match to the end
watch [seconds]           stream the activity log until it's your turn
```

**Other**

```
chat <message>            send a chat message
shot [file.png]           screenshot
probe                     dump the CSS class names on screen (for extending this)
eval <js>                 run JS in the page
url · help · exit
```

## Unattended bot

`--bot` plays a whole match without you — it hosts (or joins) a table, marks
itself ready, starts the game once a second player is seated, then plays every
turn until someone wins the match, and exits.

```bash
node uno.js --user alice --bot --minutes 10            # hosts and waits
node uno.js --user bob --bot --join alice --color blue # joins and plays
```

It plays the first legal card in hand (drawing when it has none) and handles:
the readiness prompt, wild colour choice, the "Auto-play this card?" prompt
after a draw, +2/+4 stacking (stacks when it holds a matching card, otherwise
takes the penalty), calling UNO, round transitions, and the end-of-match
screen. It gives up if the table goes quiet for a couple of minutes or the
time limit runs out. It is a *legal-move* bot, not a clever one.

Any dialog it does not recognise is printed once with its buttons rather than
clicked blindly; `UNO_DEBUG=1` additionally dumps that dialog's HTML, which is
how the stacking prompt was added.

## Two players from one machine

Each user gets its own browser profile, so run two terminals:

```bash
node uno.js --user alice --exec "create; watch 60; start; auto 20" 
```

```bash
node uno.js --user bob --exec "join alice; seat; auto 20"
```

`auto` waits for its turn, so the guest can start before the host presses
start. A table disappears when its host's browser closes, so keep the process
alive (`--keep`, or a long `watch`) while another player joins.

## How it talks to the site

The site is an Angular app with good accessibility labelling, which is what the
CLI keys off — no private API, no scraping of hashed class names:

| thing | handle |
| --- | --- |
| hand card | `button.game-card-button`, `aria-label="Play red seven"`, class `game-card-playable` when legal |
| draw pile | `button.game-draw-button` |
| discard top | `.last-card-button img` → `/images/cards/small/<color>/<value>.png` |
| your turn | `.game-hand-panel-your-turn` |
| seats | `.player-seat` → `.player-seat-name-text`, `.player-seat-card-count` |
| activity log | `.game-activity-entry` |
| UNO call | `button[aria-label*="Call UNO"]` |
| draw auto-play prompt | `ngb-modal-window` → "Keep in hand" / "Play card" |
| stacking prompt | `app-select-stacking-card` → `button.game-stacking-option`, then "Confirm stack" (disabled until one is picked) or "Decline and draw" |
| round / match result | `.game-round-feedback` and the activity log ("Game ended! Players that won the game: …") |
| lobby tables | `[class*="home-room-entry"]` |

Angular's `ng-tns-*` / `_ngcontent-*` attributes change on every build, so
nothing depends on them. If the site is restyled, `probe` prints the class
names on the current screen to help you re-point a selector.

## Notes

- Joining a table first makes you a **spectator**; `seat` is the separate step
  that puts you in the game.
- The lobby list does not always refresh over the socket, so `rooms` and `join`
  reload the page (and `join` retries for a few seconds).
- The wild colour picker is handled generically (`color <name>`); if a future
  build renames those buttons, `probe` plus `eval` will show the new markup.
