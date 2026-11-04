# ShipProof: submission material

## One-line pitch
A signed sensor tag inside the parcel, an investigator on SERV Reasoning, and a public decision record, so damage claims are judged on evidence instead of photos.

## Write-up

**Problem.** Sellers and marketplaces pay out on "it arrived broken" claims they cannot check, and AI-edited damage photos make it cheaper to fake. Honest buyers pay for it through stricter policies.

**Solution.** ShipProof gives every claim a physical record. A tag in the parcel logs motion and signs each reading with a key that never leaves the device. When the buyer reports a problem after delivery, an investigator running on SERV Reasoning reads the signed evidence and returns a strict, machine-checked verdict. The company decides, the buyer can appeal, and the decision is published with a hash that binds evidence, model response and verdict.

**How SERV Reasoning is used.** It is the investigator: it gets the claim, the handling limits and the evidence summary and returns JSON against a strict schema. Our code then checks the verdict against the evidence (cited times must exist, outcome and action must agree, no high-confidence denials because the sensor has blind spots) and retries once if it fails. Claimant text is treated as untrusted.

**What is real.** Signed readings and server-side verification, evidence engine, buyer and seller flows, appeal windows, tamper-evident decision records, MongoDB storage, an Arduino firmware core tested against the server verifier, and a phone demo tag.

**What is honest.** Cheap accelerometers miss the short peaks that break things, so ShipProof records handling severity, fall time and orientation, and says "inconclusive" when the evidence cannot answer the claim. A higher-range sensor is the upgrade path.

**Users and revenue.** Customers are sellers and marketplaces that pay for fraudulent or unverifiable damage claims. Revenue model: per-tag or per-parcel fee plus a per-claim investigation fee, with marketplaces integrating via API. Funding ask: build the production tag (high-g sensor, secure element, radio).

**Not built yet.** Escrow and payouts, notifications, photo evidence, API keys and webhooks, rate limits on buyer reports, offline logging on the tag.

## Demo script (about 2 minutes)
1. Seller console: show a registered tag, create a parcel for order "A-1042" with the Fragile profile. Dispatch. (10 s)
2. Phone recorder: arm it, put it in a box, shake it, then drop it onto a cushion. Show "Fall detected: about N cm". (25 s)
3. Mark delivered. Open the buyer link on a second screen: journey, sensor summary, drop height. (20 s)
4. Buyer reports "arrived crushed". Seller opens the claim: evidence, events, replay. (20 s)
5. Run the investigator. Show the verdict, its limits section and the recommended action. (25 s)
6. Close the claim, then open `/verify/<id>`: the public hash record. Edit nothing, show it is intact. (15 s)
7. Show the firmware folder and the dock page: "this is the real tag; the funding ask builds it." (10 s)

Before filming: run the full flow once on the deployed site and confirm the investigator returns a verdict, not an error.

## X post draft
Fake "it arrived broken" claims cost sellers real money. ShipProof puts a signed motion tag in the parcel and has a SERV Reasoning investigator judge claims on evidence, with a public, tamper-evident decision record. It also says "inconclusive" when the sensor can't tell. Built for @OpenServ SERV Hackathon 02. [repo] [demo video]
