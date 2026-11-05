# Demo video guide

**Status:** Narration and production prompt are prepared; no video has been recorded or uploaded. Target runtime is about 2 minutes 20 seconds. The YouTube video must be under 3 minutes and show the actual app.

Use [resqiva-demo-narration.md](../submission-assets/resqiva-demo-narration.md) for voiceover and [resqiva-video-prompt.md](../submission-assets/resqiva-video-prompt.md) for editing directions.

| Time | Scene | Show |
|---|---|---|
| 0:00–0:18 | Introduce Resqiva | The problem of turning surplus grocery deals into meals that fit a budget |
| 0:18–0:35 | Set demo context | Live shopper view, selected fictional store, sample request |
| 0:35–1:05 | Plan a meal | Request fields and the three sample options, including prices and pickup windows |
| 1:05–1:32 | Explain the planner | Server-side inventory and budget validation; clarify the hosted free parser is deterministic |
| 1:32–1:58 | Show merchant tools | Fictional inventory and order views |
| 1:58–2:20 | Close honestly | Explain PayPal Sandbox is unverified; do not depict a successful payment |

Use a Microsoft Bing/Azure Speech neural voice for narration. Include readable English subtitles. Do not show private credentials or real customer information. Keep fictional sample data labeled, and do not claim real food-waste impact from demo records.

The free hosted demo uses `AI_PROVIDER=local`; the Fireworks model is available in a separately configured run. Only claim to demonstrate the Fireworks-backed path if the recording actually uses it. PayPal Sandbox credentials currently return `invalid_client`, so buyer approval, capture, and webhook delivery remain unverified.

## Before upload

- Confirm the video is public or unlisted, has no password, and runs for less than 3 minutes.
- Watch the exported file to verify the narration, subtitles, app footage, and total runtime.
- Remove credentials, tokens, private account details, and unlicensed third-party material.
- Provide judges free, unrestricted demo access through December 15, 2026; the current free database expires December 5.
