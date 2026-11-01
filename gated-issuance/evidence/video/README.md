# D1.2 recorded demo

> **Criterion (as submitted):** Recorded demo: non-KYC wallet rejected at protocol level (op_not_authorized); KYC-approved wallet authorized and receiving.

**Video:** [`d1-lifecycle-demo.mp4`](d1-lifecycle-demo.mp4). H.264, 1280×720, 2:52, no audio; on-screen captions explain each step.
**Run record:** [`d1-video-run.json`](d1-video-run.json). Every hash and account in the video, plus the audit trail.

The run is live on Stellar testnet (2026-11-01, 23:10 UTC). It is produced by `runGatedLifecycle()` in [`src/testkit/lifecycle.ts`](../../src/testkit/lifecycle.ts), the same lifecycle that `npm run demo` and the live integration test run, with the parameters of [`demo/live-lifecycle.ts`](../../demo/live-lifecycle.ts). Nothing in the lifecycle was changed for the recording. The recorder only observed the transactions as they were submitted, held the run before offboarding (the clawback) so the authorized, funded investor account could be shown on Horizon first, and retried network reads (HTTP GET) that failed on a transient connection error. Submissions were never retried.

In this demo the compliance gate is a static allowlist entry (`provider: static-allowlist` in the audit trail) standing in for Urbanflip's KYC result. The gate contract is in [`src/gate`](../../src/gate).

## Scene by scene

| Time | What is on screen |
| --- | --- |
| 0:00 | Title card with the criterion. |
| 0:08 | Live run in a terminal, one line per transaction as it lands. |
| 0:22 | **1. Issuer provisioned.** `AUTH_REQUIRED`, `AUTH_REVOCABLE` and `AUTH_CLAWBACK_ENABLED` (setFlags=11) and `home_domain=urbanflip.io` are set in the same transaction that creates the account, so before any trustline exists. |
| 0:32 | **2. Investor trustline** opened. Because the issuer is `AUTH_REQUIRED`, it starts unauthorized. |
| 0:37 | **3. Payment of 10 UF0042, issuer → investor, before KYC: rejected by the protocol**, `tx_failed` / `op_not_authorized`. |
| 0:41 | **4. Compliance gate** approves `inv-001` for deal `UF-0042`. |
| 0:44 | **5. Trustline authorized** with `SetTrustLineFlags authorized=true`. |
| 0:47 | **6. The same payment succeeds**: the KYC-approved wallet is authorized and receiving. |
| 0:56 | stellar.expert, the step 3 tx: **Status: Failed**. The fee was charged and nothing moved. |
| 1:06 | Horizon, the same tx: `"successful": false` and its `result_xdr`. |
| 1:16 | Stellar Lab decodes that `result_xdr` as `TransactionResult`: `tx_failed → op_inner → payment: not_authorized`, which Horizon reports as `op_not_authorized`. stellar.expert does not display result codes, which is why this step is shown. |
| 1:39 | stellar.expert, the step 5 tx: `set trustline flags [authorized]`, Successful. |
| 1:49 | stellar.expert, the step 6 tx: `sent 10 UF0042`, same issuer to the same wallet, Successful. |
| 1:58 | Horizon, the investor account at that moment: `"balance": "10.0000000"`, `"is_authorized": true`, `"asset_code": "UF0042"`. |
| 2:08 | stellar.expert, the issuer account: home domain `urbanflip.io`; asset authorization flags `required, revocable, clawback_enabled`. |
| 2:19 | Run resumes on the offboarding path (D1.4): **7. clawback** of 5 UF0042, **8. freeze** (`authorized=false`), then **9. payment after freeze, rejected again** with `op_not_authorized`. |
| 2:39 | End card with the three D1.2 links. |

## Links (Stellar testnet)

| Step | Link |
| --- | --- |
| Asset UF0042 | https://stellar.expert/explorer/testnet/asset/UF0042-GC2PPZTFSVK2JYPYBCO74LJKCZ6CJYZJNVEVVBDNMUNBMJHL3DE7AGVP |
| Issuer account (flags, home domain) | https://stellar.expert/explorer/testnet/account/GC2PPZTFSVK2JYPYBCO74LJKCZ6CJYZJNVEVVBDNMUNBMJHL3DE7AGVP |
| 1. Issuer provisioned, flags in the creating tx | https://stellar.expert/explorer/testnet/tx/ad25740bec93c2f4f0eabcabca5afb1d80af8fbdc4acd48917cde9fc2765b70a |
| Investor account | https://stellar.expert/explorer/testnet/account/GBN4JWAIIB5AVKDX7T3X2GIANBHOESPYHROZ5W37U5TGOQGHQDQY5V34 |
| 2. Investor trustline (unauthorized) | https://stellar.expert/explorer/testnet/tx/bc9aca7519644eff78f5d39fedfa2b9661a6cf7bd7b5e9ce372b4028615a6e31 |
| **3. Payment before KYC: failed, `op_not_authorized`** | https://stellar.expert/explorer/testnet/tx/4db8e8d89f8e1131f5f8c11af765e15ae3b65e88e7d11ab185ffd39170e540f5 |
| same tx on Horizon (`successful: false`, `result_xdr`) | https://horizon-testnet.stellar.org/transactions/4db8e8d89f8e1131f5f8c11af765e15ae3b65e88e7d11ab185ffd39170e540f5 |
| **5. Trustline authorized** | https://stellar.expert/explorer/testnet/tx/49af3691d6265ee58a7f4af791fbf3af753f588b44d47d7372a862a3f05528ec |
| **6. Payment received** | https://stellar.expert/explorer/testnet/tx/54e99099bd729d7c6bbf32c989f3a76d94bf3b21745d2e2d7bb0b613eb085a51 |
| 7. Clawback, 5 UF0042 (D1.4) | https://stellar.expert/explorer/testnet/tx/6047974a10fe040edbd522c98260e23c11243dd9f78b2ea199055168a929ddb7 |
| 8. Freeze (D1.4) | https://stellar.expert/explorer/testnet/tx/33fff12a4d1a5c5050818cd950fc48b699149b7a2f30819a986847c046402389 |
| 9. Payment after freeze: failed, `op_not_authorized` | https://stellar.expert/explorer/testnet/tx/935ab2d8be15c194e3b153f70a024ed8f003ab52a88c15e8f851d0bf6ec9fdd2 |

To check a result code yourself, take `result_xdr` from the Horizon link and paste it into https://lab.stellar.org/xdr/view with the XDR type `TransactionResult`.

The investor account now shows 5 UF0042 on a frozen (unauthorized) trustline. That is the state after steps 7 and 8. The video shows it at 1:58, before offboarding, holding 10 UF0042 on an authorized trustline.

This run is separate from the one in [`../d1-lifecycle-testnet.json`](../d1-lifecycle-testnet.json), whose issuer is the one listed in [`../stellar.toml`](../stellar.toml). Both runs use the same code and parameters.
