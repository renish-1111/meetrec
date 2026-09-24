<p align="center">
  <img src="https://cdn.simpleicons.org/googlemeet" width="72" height="72" alt="Google Meet">
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://cdn.simpleicons.org/obsstudio/white">
    <img src="https://cdn.simpleicons.org/obsstudio" width="72" height="72" alt="OBS Studio">
  </picture>
</p>

<h1 align="center">MeetRec</h1>

<p align="center">
  <b>Automatic OBS recording for Google Meet.</b><br>
  Join a call and recording starts. Hang up and it stops. There's nothing to click and nothing to forget.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Google%20Meet-00897B?logo=googlemeet&logoColor=white" alt="Google Meet">
  <img src="https://img.shields.io/badge/OBS%20Studio-302E31?logo=obsstudio&logoColor=white" alt="OBS Studio">
  <img src="https://img.shields.io/badge/Chrome%20%7C%20Edge-MV3-4285F4?logo=googlechrome&logoColor=white" alt="Chrome or Edge, Manifest V3">
  <img src="https://img.shields.io/badge/Node.js-18%2B-5FA04E?logo=nodedotjs&logoColor=white" alt="Node.js 18+">
  <img src="https://img.shields.io/badge/platform-Linux-FCC624?logo=linux&logoColor=black" alt="Linux">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/renish-1111/meetrec" alt="MIT license"></a>
</p>

- **Starts on its own.** Recording begins a few seconds after you join a call. It doesn't start in the pre-join lobby.
- **Stops on its own.** Recording ends about 3 seconds after you leave, or after you close the tab or the browser crashes.
- **Opens OBS for you.** If OBS isn't running when a call starts, MeetRec launches it minimized to the tray.
- **Handles glitches.** A brief disconnect doesn't split your recording. If a "left the call" signal is ever lost, recording still stops within about 15 seconds.
- **Supports several calls at once.** Recording keeps going until *every* Meet tab has left its call.
- **Runs in the background.** The bridge can start automatically when you log in, so it works without a terminal open.
- **Stays on your machine.** Everything runs on `127.0.0.1`. Nothing is sent anywhere else.

## How it works

```
 ┌──────────────── Chrome / Edge ────────────────┐
 │  Meet tab                                     │        ┌──────── bridge ────────┐        ┌──── OBS Studio ────┐
 │  content.js ── watches for the ──┐            │  HTTP  │  Node.js server        │  WS    │  obs-websocket     │
 │               "Leave call" button│            │ ─────▶ │  127.0.0.1:17643       │ ─────▶ │  127.0.0.1:4455    │
 │                                  ▼            │ join / │  • tracks active calls │ Start/ │                    │
 │                    background.js (service     │ leave  │  • start/stop timers   │ Stop   │  ● REC             │
 │                    worker) relays events      │        │  • launches OBS        │ Record │                    │
 └───────────────────────────────────────────────┘        └────────────────────────┘        └────────────────────┘
```

1. **Detecting the call.** Meet only shows the red **Leave call** button once you're actually in a call. The extension watches for it: when the button appears you've joined, and when it disappears you've left. A join must hold for 3 seconds and a leave for 1 second before it's reported, so brief flickers of the page are ignored.
2. **Relaying.** The extension's background worker sends each join and leave to the local **bridge**. While you're in a call, each tab also checks in every 5 seconds.
3. **Recording.** The bridge controls OBS through its built-in WebSocket API. It starts recording on the first join. It stops recording 2 seconds after the last tab leaves, unless you rejoin within that window.

## Requirements

- <img src="https://cdn.simpleicons.org/linux/9e9e9e" width="16" height="16" alt=""> **Linux** with a desktop session. Tested on Ubuntu with X11. The auto-start script uses systemd.
- <img src="https://cdn.simpleicons.org/obsstudio/9e9e9e" width="16" height="16" alt=""> **[OBS Studio](https://obsproject.com/) 28 or newer**, which includes the WebSocket server (`sudo snap install obs-studio` or `sudo apt install obs-studio`)
- <img src="https://cdn.simpleicons.org/nodedotjs" width="16" height="16" alt=""> **Node.js 18 or newer**
- <img src="https://cdn.simpleicons.org/googlechrome" width="16" height="16" alt=""> **Google Chrome, Chromium or Microsoft Edge**

## Setup

### 1. Turn on OBS's WebSocket server

Open OBS and go to **Tools → WebSocket Server Settings**:

- Check **Enable WebSocket server**.
- Keep the port as `4455`.
- Note the password (click **Show Connect Info**).

Set up your scene and sources the way you want them recorded. MeetRec just presses record. It uses whatever scene is active.

### 2. Configure the bridge

```bash
cd bridge
npm install
cp .env.example .env
```

Open `bridge/.env` and set `OBS_WEBSOCKET_PASSWORD` to the password from step 1.

### 3. Start the bridge in the background

```bash
./install-autostart.sh
```

This runs the bridge as a background service (`meetrec-bridge`). It starts every time you log in and restarts itself if it crashes. You should see `Installed and running.`

<details>
<summary>Prefer to run it by hand instead?</summary>

```bash
cd bridge
npm start
```

You should see `[MeetRec] bridge listening on http://127.0.0.1:17643`. It runs until you close the terminal.
</details>

### 4. Load the extension

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `extension/` folder.

### 5. Try it

Close OBS, then join any Google Meet call. Within a few seconds, OBS opens in the tray and starts recording. Hang up, and recording stops about 3 seconds later.

## Everyday use

There's nothing to do. Just join your calls. To check on things:

| I want to… | Run |
|---|---|
| See if it's running and what it's doing | `curl http://127.0.0.1:17643/status` |
| Watch the live log | `journalctl --user -u meetrec-bridge -f` |
| Apply changes to `bridge/.env` | `systemctl --user restart meetrec-bridge` |
| Stop it until next login | `systemctl --user stop meetrec-bridge` |
| Remove the auto-start completely | `./install-autostart.sh --uninstall` |

`/status` returns something like:

```json
{ "obsConnected": true, "activeMeetings": [1731104427], "recording": true }
```

**Where do recordings go?** Wherever OBS is set to save them (**Settings → Output → Recording Path**). With the snap version of OBS, the default is `~/snap/obs-studio/common/`.

## Configuration

All settings live in `bridge/.env`. Restart the bridge after changing them.

| Variable | Default | What it does |
|---|---|---|
| `OBS_WEBSOCKET_URL` | `ws://127.0.0.1:4455` | Where OBS's WebSocket server is |
| `OBS_WEBSOCKET_PASSWORD` | *(empty)* | Password from OBS's WebSocket settings |
| `PORT` | `17643` | Port the bridge listens on. If you change it, also change `BRIDGE_BASE_URL` in `extension/background.js` |
| `START_DELAY_SECONDS` | `0` | Extra wait before recording starts after you join (max 60) |
| `STOP_DELAY_SECONDS` | `2` | Wait before recording stops after the last call ends. Rejoining within this window keeps the same recording going |
| `HEARTBEAT_TIMEOUT_SECONDS` | `15` | If a Meet tab stops checking in for this long, the bridge treats it as having left |
| `OBS_LAUNCH_COMMAND` | `obs-studio --minimize-to-tray --disable-missing-files-check` | How to start OBS when it isn't running. Leave empty to turn auto-launch off |

**Timing, end to end:** recording starts about 3 seconds after you join, plus `START_DELAY_SECONDS`, plus OBS's startup time if it had to be launched. It stops about 1 second (to detect the hang-up) plus `STOP_DELAY_SECONDS` after you leave.

## Troubleshooting

| Problem | Likely cause and fix |
|---|---|
| Log says `connect ECONNREFUSED 127.0.0.1:4455` | OBS isn't running and couldn't be launched, or its WebSocket server is off. Check step 1, and that `obs-studio` works from a terminal. |
| Log says `Authentication failed` | `OBS_WEBSOCKET_PASSWORD` in `bridge/.env` doesn't match OBS. Fix it, then restart the bridge. |
| Nothing happens when I join a call | Is the bridge running (`systemctl --user status meetrec-bridge`)? Is the extension enabled? Is Meet in English? (See the next row.) |
| Meet isn't in English | Detection looks for the English "Leave call" label. Add your language's label to `IN_CALL_SELECTOR` in `extension/content.js`, then reload the extension. |
| Recording keeps going after a call | It should stop by itself within about 15 seconds. If it doesn't, check the live log for errors. |
| `install-autostart.sh` says the port is in use | A bridge started with `npm start` is still running. Press Ctrl+C in that terminal and run the script again. |
| Stopped working after moving the folder or updating Node | Run `./install-autostart.sh` again, since it records both paths. If you moved the folder, also load the extension again from its new location. |

## Development

```bash
cd bridge
npm test
```

Runs 34 checks in roughly a minute. No OBS or browser is needed.

- **`test/bridge.test.mjs`** runs the real bridge against a fake OBS server. It checks start and stop timing, multiple tabs, rejoining, OBS reconnects, auto-launch and heartbeat timeouts.
- **`test/extension.test.mjs`** runs the extension scripts with fake Chrome and page APIs. It checks the flicker protection, the worker being restarted mid-call, heartbeats and re-injection after an extension reload.

The tests use ports `17698`, `17699`, `4498` and `4499`.

After editing the extension, click the reload icon on its card in `chrome://extensions`. It's safe to do mid-call, because open Meet tabs get a fresh copy of the script.

### Project layout

```
meetrec/
├── extension/            Chrome/Edge extension (Manifest V3)
│   ├── manifest.json
│   ├── content.js        watches the Meet page for joining and leaving
│   └── background.js     relays events to the bridge; re-injects into open tabs on reload
├── bridge/               local Node.js server that controls OBS
│   ├── server.js
│   ├── .env.example
│   └── package.json
├── test/                 automated tests (npm test, from bridge/)
├── install-autostart.sh  installs or removes the background service
└── LICENSE               MIT
```

## A note on consent

Recording laws differ by country, and many places require everyone on a call to agree to be recorded. MeetRec records automatically, so it's easy to forget it's on. Let people know when you're recording them.

## License

[MIT](LICENSE) © 2026 renish-1111

<sub>Google Meet is a trademark of Google LLC. OBS Studio is a trademark of the OBS Project. MeetRec isn't affiliated with or endorsed by either. Logos come from <a href="https://simpleicons.org">Simple Icons</a>.</sub>
