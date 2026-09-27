<p align="center">
  <img src="https://upload.wikimedia.org/wikipedia/commons/9/9b/Google_Meet_icon_%282020%29.svg" height="72" alt="Google Meet">
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://cdn.simpleicons.org/obsstudio/white">
    <img src="https://cdn.simpleicons.org/obsstudio" width="72" height="72" alt="OBS Studio">
  </picture>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <img src="https://upload.wikimedia.org/wikipedia/commons/1/12/Google_Drive_icon_%282020%29.svg" height="72" alt="Google Drive">
</p>

<h1 align="center">MeetRec</h1>

<p align="center">
  <b>Automatic OBS recording for Google Meet, uploaded to Google Drive.</b><br>
  Join a call and recording starts. Hang up and it stops, and the video goes to your Drive. There's nothing to click and nothing to forget.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Google%20Meet-00897B?logo=googlemeet&logoColor=white" alt="Google Meet">
  <img src="https://img.shields.io/badge/OBS%20Studio-302E31?logo=obsstudio&logoColor=white" alt="OBS Studio">
  <img src="https://img.shields.io/badge/Google%20Drive-1FA463?logo=googledrive&logoColor=white" alt="Google Drive">
  <img src="https://img.shields.io/badge/Chrome%20%7C%20Edge-MV3-4285F4?logo=googlechrome&logoColor=white" alt="Chrome or Edge, Manifest V3">
  <img src="https://img.shields.io/badge/Node.js-18%2B-5FA04E?logo=nodedotjs&logoColor=white" alt="Node.js 18+">
  <img src="https://img.shields.io/badge/platform-Linux-FCC624?logo=linux&logoColor=black" alt="Linux">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/renish-1111/meetrec" alt="MIT license"></a>
</p>

## What it does

- **Records by itself.** Recording starts when you join a Meet call and stops about 3 seconds after you leave.
- **Opens OBS for you** if it isn't running.
- **Uploads to Google Drive** (optional) once each recording finishes.
- **Runs on your computer only.** Nothing leaves it unless you turn on the Drive upload.

## How it works

```
Chrome extension  ──►  bridge (Node.js, 127.0.0.1)  ──►  OBS (start/stop recording)
notices join/leave                                  ──►  Google Drive (upload)
```

The **extension** notices when you join or leave a call. The **bridge** is a small local program that controls OBS and uploads the files. A browser extension can't open programs, read files on your disk, or keep long uploads running, so the bridge does those jobs.

## Requirements

- Linux (tested on Ubuntu)
- [OBS Studio](https://obsproject.com/) 28 or newer
- Node.js 18 or newer
- Chrome, Chromium or Edge

## Setup

**1. Turn on OBS's WebSocket server.** In OBS, open **Tools → WebSocket Server Settings**, check **Enable WebSocket server**, and copy the password (**Show Connect Info**).

**2. Set up the bridge.**

```bash
cd bridge
npm install
cp .env.example .env     # then put the OBS password in OBS_WEBSOCKET_PASSWORD
```

**3. Start the bridge.** This installs it as a background service that starts when you log in:

```bash
./install-autostart.sh
```

To run it by hand instead, use `npm start` in `bridge/`.

**4. Load the extension.** Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the `extension/` folder.

**5. Try it.** Join a Google Meet call. OBS starts recording within a few seconds, and stops shortly after you hang up.

## Google Drive upload (optional)

1. Create an OAuth client once:
   - In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Google Drive API**.
   - Under **Google Auth Platform**, choose **External** and click **Publish app**. If you skip publishing, the sign-in expires after 7 days.
   - Under **Clients**, create a client of type **Desktop app**.
2. Put its values in `bridge/.env` and restart the bridge:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ```
3. Click the MeetRec icon in the toolbar, then **Connect Google Drive**.

Recordings upload to a `MeetRec` folder in your Drive. MeetRec can only see the files it creates there.

Uploads are reliable. If the upload is interrupted by a network outage, laptop sleep, a restart, or an expired sign-in, it waits and continues where it stopped. A file only appears in Drive once it's fully uploaded.

> **Tip:** Set OBS to record in **MP4** (**Settings → Output → Recording Format**).

## Everyday use

| To… | Run |
|---|---|
| Check status | `curl http://127.0.0.1:17643/status` |
| Watch the log | `journalctl --user -u meetrec-bridge -f` |
| Restart (after editing `.env`) | `systemctl --user restart meetrec-bridge` |
| Uninstall the service | `./install-autostart.sh --uninstall` |

Recordings are saved wherever OBS saves them (**Settings → Output → Recording Path**).

## Settings

All in `bridge/.env`. Restart the bridge after changing them.

| Setting | Default | Meaning |
|---|---|---|
| `OBS_WEBSOCKET_PASSWORD` | *(empty)* | Password from OBS's WebSocket settings |
| `OBS_WEBSOCKET_URL` | `ws://127.0.0.1:4455` | OBS WebSocket address |
| `PORT` | `17643` | Bridge port. If changed, also change `BRIDGE_BASE_URL` in `extension/background.js` |
| `START_DELAY_SECONDS` | `0` | Extra wait before recording starts |
| `STOP_DELAY_SECONDS` | `2` | Wait before recording stops. Rejoining in time keeps the same recording |
| `HEARTBEAT_TIMEOUT_SECONDS` | `15` | A tab silent this long counts as having left |
| `OBS_LAUNCH_COMMAND` | `obs-studio --minimize-to-tray ...` | How to open OBS. Leave empty to turn off |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | *(empty)* | Turns on the Drive upload |
| `GOOGLE_DRIVE_FOLDER_NAME` | `MeetRec` | Drive folder name |
| `DELETE_AFTER_UPLOAD` | `false` | Delete the local file after it uploads |
| `UPLOAD_MANUAL_RECORDINGS` | `false` | Also upload recordings you start by hand in OBS |

## Troubleshooting

| Problem | Fix |
|---|---|
| `ECONNREFUSED 127.0.0.1:4455` | OBS isn't running or its WebSocket server is off (setup step 1) |
| `Authentication failed` | Wrong `OBS_WEBSOCKET_PASSWORD` in `bridge/.env` |
| Nothing happens in a call | Check that the bridge is running (`systemctl --user status meetrec-bridge`) and the extension is on. Meet must be in English, or add your language's "Leave call" label to `extension/content.js`. |
| `invalid_grant` in the log | The Drive sign-in expired. Publish the OAuth app, then reconnect from the extension popup. |
| `redirect_uri_mismatch` | Create the OAuth client as **Desktop app**, not "Web application" |

## Development

```bash
cd bridge && npm test
```

The tests use a fake OBS, browser and Google, so you need none of them installed. After editing the extension, click reload on its card in `chrome://extensions`.

## Consent

Many places require everyone on a call to agree to be recorded. Tell people when you're recording.

## License

[MIT](LICENSE) © 2026 renish-1111

<sub>Google Meet and Google Drive are trademarks of Google LLC. OBS Studio is a trademark of the OBS Project. MeetRec isn't affiliated with either. Logos from <a href="https://simpleicons.org">Simple Icons</a> and <a href="https://commons.wikimedia.org">Wikimedia Commons</a>.</sub>
