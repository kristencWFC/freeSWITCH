# WxCC IVR via FreeSWITCH + Google STT
tes
Self-hosted IVR for Webex Contact Center using FreeSWITCH and Google Speech-to-Text.

## Architecture
PSTN → Webex Calling → WxCC Flow → Bridge Transfer x1122 → CUBE → FreeSWITCH → Node.js ESL Controller → Google STT → BYE with X-IVR-Result header → CUBE → WxCC

## Components
- `/opt/ivr-controller/index.js` - Node.js ESL controller
- `/etc/freeswitch/dialplan/public/ivr_menu.xml` - FreeSWITCH dialplan
- `/etc/systemd/system/ivr-controller.service` - systemd service
- `/usr/share/freeswitch/sounds/ivr/*.wav` - IVR prompt audio files
- CUBE config on WFC-VG1 (tenant 300, dial-peers 1122/1123)

## Setup
1. Place `gcp-key.json` (GCP service account with Speech-to-Text role) at `/opt/ivr-controller/gcp-key.json`
2. Install deps: `npm install`
3. Enable service: `sudo systemctl enable --now ivr-controller`

## Adding a new IVR menu
1. Record menu prompt as WAV (8kHz, mono, mu-law): `/usr/share/freeswitch/sounds/ivr/<menu_id>.wav`
2. Configure WxCC Bridge Transfer to add SIP header `X-IVR-Menu: <menu_id>`
3. FreeSWITCH auto-loads the correct prompt based on the header

