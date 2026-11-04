# ShipProof

Fake and AI-doctored "it arrived broken" claims cost sellers and marketplaces money, and honest buyers get caught in the suspicion. ShipProof puts a signed motion tag inside the parcel, so a damage claim is judged against what the parcel physically went through.

**Live app:** https://ship-proof-delta.vercel.app/

## How it works

1. **Tag.** A sensor tag rides inside the parcel and records motion. Each reading is signed with ECDSA P-256 by a key that never leaves the device, so nobody can edit readings afterwards without breaking the signature.
2. **Seller.** Creates a parcel (order reference, tag, handling profile or custom limits), dispatches it, marks it delivered. Gives the buyer a tracking link.
3. **Buyer.** Opens the link, sees the journey and what the sensor saw, and can report a problem after delivery. Only buyers can file claims, because only they open the parcel.
4. **Investigator.** The claim goes to an investigator running on **SERV Reasoning**. It receives the signed evidence summary and returns a strict JSON verdict: supports claim, does not support claim, or inconclusive.
5. **Company decides.** The verdict is a recommendation. The seller closes the claim; the buyer can appeal within a window.
6. **Public record.** Each decision has a hash binding the evidence, the model response id and the verdict. Anyone can check it at `/verify/<claim id>`.

## What the evidence contains

- Custody window from dispatch to delivery. Readings after delivery are kept apart and not hashed.
- Events: impacts, free falls, tilt past limit, and optional loud sound, found by comparing readings with the parcel's handling limits.
- Free-fall time, signed by the tag, converted to an estimated drop height (h = g t^2 / 2, no air drag).
- Coverage gaps (silence longer than 60 s).
- Sound is a loudness level only. Nothing records audio.

## Honest limits (and how the investigator treats them)

- A phone or a hobby accelerometer (about +-8 g, strongest sample per window) cannot see the short, hard peaks that break things. The thresholds measure rough handling, not breakage.
- The investigator is told this. In code, it can never return "does not support claim" with high confidence, must list sensor blind spots, and must answer "inconclusive" for claims about crushing, punctures, water or theft.
- The claimant's statement is untrusted text; it never changes the rules.
- The investigator answers "inconclusive" without calling the model when there are no readings.
- Without `SERV_API_KEY` the investigator returns an honest "not configured" error, never a made-up verdict.

## Devices

- **Phone** (`/capture`): works as a demo tag using the browser's motion sensors. Signs v2 readings including measured free-fall time.
- **Arduino Uno + MPU6050 firmware** (`firmware/`): shows what a real tag does: 50 Hz FIFO sampling, deterministic ECDSA via micro-ecc, optional analog sound-level sensor, a WebSerial dock page. The core logic is compiled and tested on a computer against the server's verifier; the sketch itself has not been run on a board.
- The product is the trust layer: any device that signs the reading format in `lib/reading.ts` works.

## Stack

Next.js 15 (App Router) with plain HTML/JS pages in `public/`, Node 22, MongoDB Atlas (`MONGODB_URI`) or a JSON file for local development, SERV Reasoning (OpenAI-compatible chat completions) for the investigator.

## Run it

```
npm install
npm run dev          # local, stores data in ./data
npm test             # runs all tests
```

Environment variables:

| Name | Purpose |
|---|---|
| `SERV_API_KEY` | SERV Reasoning key. Without it the investigator reports "not configured". |
| `SERV_MODEL`, `SERV_BASE_URL` | Optional. Defaults: `gpt-5.4-mini`, `https://inference-api.openserv.ai/v1`. |
| `MONGODB_URI`, `MONGODB_DB` | MongoDB Atlas. Without the URI a local JSON file is used (not for serverless). |
| `APPEAL_WINDOW_HOURS` | Default 48. |

To build and run the firmware tests: `git clone https://github.com/kmackay/micro-ecc`, then `UECC_DIR=/path/to/micro-ecc firmware/host/build.sh`, then `npm test`.

## Not built yet

Escrow and payouts, email or push notifications, photo evidence for buyer reports, API keys and webhooks for marketplaces, rate limiting on public buyer reports, offline logging on the Uno (SD card), and a hardened key store on the tag (secure element).
