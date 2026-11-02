# D2.1 recorded flow

> **Criterion (as submitted):** Recorded flow: email signup to embedded wallet to sponsored trustline, with the investor holding zero XLM at every step.

**Video:** [`d2-onboarding-demo.mp4`](d2-onboarding-demo.mp4). H.264, 1280×720, 1:56, no audio; on-screen captions explain each step.
**Run record:** [`d2-video-run.json`](d2-video-run.json). The Privy user and wallet, every hash and account in the video, and the investor's XLM balance read from Horizon after every step.

The run is live on Stellar testnet against the live Privy API (2026-11-02, 09:45 UTC). The onboarding is the unchanged `wallet-onboarding` library: [`createOnboarding`](../../src/index.ts) with [`PrivyWalletProvider`](../../src/wallet/privy-provider.ts), and [`SponsorService`](../../src/sponsorship/sponsor-service.ts) for the sponsored account and trustline, each submitted as a fee-bump by the [pipeline](../../src/pipeline/investor-tx-pipeline.ts).

How the recording was made:

- The sign-up page is a demo page served locally for the recording. In production the Urbanflip app's sign-up calls the same onboarding service.
- The email is not verified with a one-time code in this demo. The Privy user is created server-side with Privy's create-user API, with that email linked. The new wallet is attributed to that user through the provider's existing `privyUserId` option (the wallet's `entity`). Privy then lists it on the user as an embedded wallet (`connector_type: embedded`, `wallet_client: privy`).
- The wallet has no owner (`owner_id: null`, `user_can_sign: false`). The backend signs the investor's transactions with Privy `raw_sign`, so onboarding works while the investor is offline.
- The demo server pauses a few seconds between steps so each one can be read.
- Network reads (HTTP GET) that failed on a transient connection error were retried. Privy creates and Stellar submissions were never retried.

## Scene by scene

| Time | What is on screen |
| --- | --- |
| 0:00 | Title card with the criterion. |
| 0:13 | The sign-up page. The investor types an email (`lucia.martin+2ojfe@example.com`) and submits. The badge "XLM held by the investor" stays visible in the header for the whole flow. |
| 0:23 | **1. Email sign-up.** A Privy user is created with that email linked: `did:privy:cmvz2p14o032z0gkzyt297ht2`. |
| 0:29 | **2. Embedded wallet.** Privy creates the investor's Stellar wallet `xpo4w896w7m3idxricbj3pzu` (`chain_type: stellar`, connector `embedded`, owner none) at `GCQLANS6…WGBM`. No account on the ledger yet: **0 XLM**. |
| 0:38 | **3. Sponsored account.** Fee-bump tx `73a1b364…`: the channel pays the fee and sponsors the reserve; the account is created with a 0 XLM starting balance. Read from Horizon: **0 XLM**. |
| 0:48 | **4. Sponsored trustline** to the deal asset `UFDEMO`. Fee-bump tx `b290c110…`, reserve sponsored by the channel. Read from Horizon: **0 XLM**, 3 reserves sponsored. |
| 0:52 | Done: account ready. |
| 0:59 | stellar.expert, the step 3 tx: source = the channel (fee-bump), inner tx with `sponsored reserves for`, `created account … with starting balance 0 XLM` and `Finished sponsoring reserves`. Signatures: the channel's and the investor's, which came from Privy `raw_sign`. |
| 1:11 | stellar.expert, the step 4 tx: fee-bump; the inner tx opens the trustline inside a sponsorship block, again signed by the investor's Privy wallet. |
| 1:22 | Horizon, the investor account: the trustline's `sponsor` is the channel, the native balance is `0.0000000`, `num_sponsored: 3`, and the account's own `sponsor` is the channel. |
| 1:34 | stellar.expert, the investor account: balances 0 XLM and 0 UFDEMO; "3 reserves sponsored by other accounts", the account base reserve and the trustline both sponsored by the channel. |
| 1:48 | End card with the D2.1 links. |

## Links (Stellar testnet)

| Step | Link |
| --- | --- |
| Investor account (0 XLM, 3 sponsored reserves) | https://stellar.expert/explorer/testnet/account/GCQLANS6NVHWF5YT3NOZ5EPFS2MUYCCUQYEOEV7ZXZX3TMFKOB23WGBM |
| same account on Horizon (`sponsor`, `num_sponsored`, balances) | https://horizon-testnet.stellar.org/accounts/GCQLANS6NVHWF5YT3NOZ5EPFS2MUYCCUQYEOEV7ZXZX3TMFKOB23WGBM |
| **3. Sponsored account, fee-bump** | https://stellar.expert/explorer/testnet/tx/73a1b36469e2a99dee3af5844e21cd210509075a2b02593de8e7b528501aee06 |
| 3. inner transaction | https://stellar.expert/explorer/testnet/tx/ea64176296e061099db6985ea6ea38be4c69560e634aa4f7f33b39aa0f36ad82 |
| **4. Sponsored trustline, fee-bump** | https://stellar.expert/explorer/testnet/tx/b290c110117beea448ac9ff014ed25a75b686522f62d22d53ee67d88aecdd305 |
| 4. inner transaction | https://stellar.expert/explorer/testnet/tx/aa87e71490306e00de811b21ad6204da5724321a0d6d8794eb1bcae469a07c59 |
| Channel account (sponsor and fee payer) | https://stellar.expert/explorer/testnet/account/GBRHSTGLORDDZJTCMCQ7OGSOP3K2PPNNND73IT2HJRMMUZGH42FCK7JJ |
| Demo deal asset UFDEMO, issuer created by the channel | https://stellar.expert/explorer/testnet/tx/107b4a66d99d32047099b359cab4995b08a340cdda90c6cfc0448944f927f4a5 |

The Privy user and wallet ids are in [`d2-video-run.json`](d2-video-run.json). Privy records are only readable with the app's credentials.

This run is separate from the 22-account sponsored cohort in [`urbanflip-backend/evidence/d2-sponsored-cohort-testnet.csv`](../../../urbanflip-backend/evidence/d2-sponsored-cohort-testnet.csv) (criterion D2.2).
