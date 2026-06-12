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

## Create a prompt - paste the following into terminal
    # Step 1: Set your API key (paste between the straight quotes; use plain ASCII quotes, not smart quotes)
    export ELEVENLABS_API_KEY="8288b2ba783a4e98382274686123c9d0af464bd3257dda07deb067b0e6e69733"

    # Step 2: Single-line curl — no line continuations, safer to paste
    curl --http1.1 -X POST "https://api.elevenlabs.io/v1/text-to-speech/cgSgspJ2msm6clMCkdW9" -H "xi-api-key: $ELEVENLABS_API_KEY" -H "Content-Type: application/json" -d '{"text":"For eleven labs, press or say one. For all others, press or say two.","model_id":"eleven_multilingual_v2"}' --output /tmp/demotts.mp3

    # Step 3: Sanity check
    ls -la /tmp/demotts.mp3
    file /tmp/demotts.mp3

    # Step 4: Convert + install
    sudo ffmpeg -y -i /tmp/demotts.mp3 -ar 8000 -ac 1 -sample_fmt s16 /usr/share/freeswitch/sounds/ivr/demotts.wav
    sudo chown freeswitch:freeswitch /usr/share/freeswitch/sounds/ivr/demotts.wav
    soxi /usr/share/freeswitch/sounds/ivr/demotts.wav
