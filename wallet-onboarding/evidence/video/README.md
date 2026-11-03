# D2.1 recorded flow

> **Criterion (as submitted):** Recorded flow: email signup to embedded wallet to sponsored trustline, with the investor holding zero XLM at every step.

**Video:** [`d2-onboarding-demo.mp4`](d2-onboarding-demo.mp4). H.264, 1920×1080, 25 fps, 2:24, no audio; on-screen captions explain each step.
**Run record:** [`d2-video-run.json`](d2-video-run.json). The Privy user and wallet, every hash and account in the video, and the investor's XLM balance read from Horizon after every step.

The run is live on Stellar testnet against the live Privy API (2026-11-03, 21:56 UTC). The onboarding is the unchanged `wallet-onboarding` library: [`createOnboarding`](../../src/index.ts) with [`PrivyWalletProvider`](../../src/wallet/privy-provider.ts), and [`SponsorService`](../../src/sponsorship/sponsor-service.ts) for the sponsored account and trustline, each submitted as a fee-bump by the [pipeline](../../src/pipeline/investor-tx-pipeline.ts).

How the recording was made:

- The video opens on the live https://urbanflip.io in a headless browser. The site was switched to EN and its cookie banner was declined; both are choices the site stores in the browser. Nothing was injected into the site, nothing was submitted on urbanflip.io or app.urbanflip.io, and no account was created there.
- **The sign-up screen is a testnet demo, not the production sign-up.** The recording harness serves it locally (`127.0.0.1`, shown in the window's address bar). It uses urbanflip.io's visual identity, read from the live site's DOM and CSS: the Space Grotesk and DM Sans fonts, the colours `#0A0A0A`, `#EC743E` and `#F4F3F1`, square corners, the logo and the type scale. The screen is tagged "Testnet demo · Urbanflip onboarding service", and its footer says it is not the production urbanflip.io sign-up. It calls the onboarding service above. The video does not claim that urbanflip.io already offers this sign-up.
- The email is not verified with a one-time code in this demo. The Privy user is created server-side with Privy's create-user API, with that email linked. The new wallet is attributed to that user through the provider's existing `privyUserId` option (the wallet's `entity`). Privy then lists it on the user as an embedded wallet (`connector_type: embedded`, `wallet_client: privy`).
- The wallet has no owner (`owner_id: null`, `user_can_sign: false`). The backend signs the investor's transactions with Privy `raw_sign`, so onboarding works while the investor is offline.
- One Urbanflip channel account does two jobs: it sponsors the reserves (CAP-33) and it pays every fee (fee-bump). The "How it works" diagram calls it "Urbanflip's channel account".
- The XLM badge and the per-step balances come from Horizon reads made by the backend after each step. They are the `xlmHeldByInvestor` entries in the run record.
- The demo server pauses a few seconds between steps so each one can be read. The 33 s in the "Done" caption (from the click to the trustline) includes those pauses.
- The Privy request timeout was set to 25 s with the provider's own `timeoutMs` option (default 8 s). An earlier take that evening aborted at step 4 because a Privy `raw_sign` call took longer than 8 s, so no trustline was submitted. Its Privy user, its wallet (`GAHZSJ…JMEYTG`) and its sponsored account were left unused on testnet.
- Network reads (HTTP GET) that fail on a transient connection error are retried; none failed in this run. Privy creates and Stellar submissions were never retried.
- The orange boxes on stellar.expert and Horizon were added by the recording to point at the relevant lines. stellar.expert does not show result codes; Horizon reports both transactions as `successful: true` (in the run record).

## Scene by scene

| Time | What is on screen |
| --- | --- |
| 0:00 | Title card: Urbanflip × Stellar, the criterion, live run on Stellar testnet with the Privy API. |
| 0:07 | **urbanflip.io, live.** The hero ("Leaders in residential value-add in Madrid."), then a slow scroll to the track-record figures. Caption: who Urbanflip is. |
| 0:20 | **How it works.** Investor (email only) → Urbanflip onboarding service → Privy (embedded Stellar wallet, `raw_sign`) → Stellar testnet (the channel sponsors the reserves with CAP-33 and pays every fee with a fee-bump) → the investor holds 0 XLM. |
| 0:34 | **The sign-up screen** (testnet demo, see above). From here to the end of the ledger scenes, a 4-step progress rail and the "XLM held by the investor" badge stay at the top. The investor types `lucia.martin+87ojy@example.com` and submits. |
| 0:44 | **1. Sign up.** A Privy user is created with that email linked: `did:privy:cmw188wcn00hb0gl3es9psyf2`. |
| 0:53 | **2. Embedded wallet.** Privy creates the investor's Stellar wallet `w8vh3nw0zicsfk0dys359z1h` (`stellar`, connector `embedded`, owner none) at `GA6YK5…OCDPIA`. No account on the ledger yet: badge **0**. |
| 1:03 | **3. Sponsored account.** Fee-bump tx `2265da2d…c5f7a8`: the channel `GCNSHA…FJEEMR` pays the fee and sponsors the reserve; the account starts with 0 XLM. Read from Horizon: **0 XLM**. |
| 1:13 | **4. Sponsored trustline** to the demo deal asset `UFDEMO`. Fee-bump tx `16998162…fcd913`, reserve sponsored by the channel. Read from Horizon: **0 XLM**, 3 reserves sponsored. |
| 1:16 | Done: "Your account is ready." The investor held 0 XLM after every step. |
| 1:25 | stellar.expert, the step 3 fee-bump. Source account and fee: the channel. Inner transaction: `sponsored reserves for`, `created account … with starting balance 0 XLM`, `Finished sponsoring reserves`. Signatures: the channel's, and the investor's from Privy `raw_sign` (boxed). |
| 1:39 | stellar.expert, the step 4 fee-bump. Fee paid by the channel. The inner transaction opens the `UFDEMO` trustline inside a sponsorship block and is signed by the investor's Privy wallet. |
| 1:51 | Horizon, the investor account. The trustline's `sponsor` is the channel, the native balance is `0.0000000`, `num_sponsored: 3`, and the account's own `sponsor` is the channel. |
| 2:05 | stellar.expert, the investor account. Balances 0 XLM and 0 UFDEMO; "3 reserves sponsored by other accounts": the account base reserve and the `UFDEMO` trustline, both sponsored by the channel. |
| 2:15 | End card: criterion D2.1 met on Stellar testnet, with the investor account, both transactions and this folder. |

## Links (Stellar testnet)

| Step | Link |
| --- | --- |
| Investor account (0 XLM, 3 sponsored reserves) | https://stellar.expert/explorer/testnet/account/GA6YK5TNQFHLA7Z7XW6O3A3XGV73IOCRDG65UX74WPNOAHSCREOCDPIA |
| same account on Horizon (`sponsor`, `num_sponsored`, balances) | https://horizon-testnet.stellar.org/accounts/GA6YK5TNQFHLA7Z7XW6O3A3XGV73IOCRDG65UX74WPNOAHSCREOCDPIA |
| **3. Sponsored account, fee-bump** | https://stellar.expert/explorer/testnet/tx/2265da2d51e4ca7227f1ad65d0ef16cb0784c3964d29c5f44d9dbc83b0c5f7a8 |
| 3. inner transaction | https://stellar.expert/explorer/testnet/tx/585d83c06912c9cfeb55e54c5ef20cd7e8b723cfe33444df800342a654cd60d9 |
| **4. Sponsored trustline, fee-bump** | https://stellar.expert/explorer/testnet/tx/16998162c37de6edc16865613cadfcf8245c2a6fdb8a91d825c50a9f60fcd913 |
| 4. inner transaction | https://stellar.expert/explorer/testnet/tx/600417beddd46c19eef84cfc565abc5415db2c2d49be22df66eccca219799229 |
| Channel account (sponsor and fee payer) | https://stellar.expert/explorer/testnet/account/GCNSHALQXPYUSUQPEZYWVOYAHH2KKKDWGDLJ42GR6UJVKDRFKOFJEEMR |
| Demo deal asset UFDEMO, issuer created by the channel | https://stellar.expert/explorer/testnet/tx/adbaf9d49b4db9178329a837ed77cd25f30b5ad63b004df631b5b1ed90001408 |
| Urbanflip's live site (opening scene) | https://urbanflip.io |

The Privy user and wallet ids are in [`d2-video-run.json`](d2-video-run.json). Privy records are only readable with the app's credentials.

This run is separate from the 22-account sponsored cohort in [`urbanflip-backend/evidence/d2-sponsored-cohort-testnet.csv`](../../../urbanflip-backend/evidence/d2-sponsored-cohort-testnet.csv) (criterion D2.2).
