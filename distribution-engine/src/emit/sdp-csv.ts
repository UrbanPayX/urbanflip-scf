import { assertStellarAddress, type UsdcConversion } from './usdc-conversion';

/**
 * SDP disbursement CSV (Stellar Disbursement Platform, EMAIL_AND_WALLET_ADDRESS
 * mode). Columns per the SDP upload spec:
 *
 *   amount,id,destination,memo,memo_type
 *
 * `amount` is USDC from a UsdcConversion (convertOnChain): the EUR schedule is
 * never emitted directly, so EUR amounts cannot go out as USDC. `id` is the
 * receiver identifier (email), `destination` the wallet address.
 * Files are capped at maxRowsPerFile (SDP accepts up to 10,000 payments per
 * batch) and emitted as a set with stable, ordered names.
 */
export const SDP_MAX_ROWS = 10_000;

export interface SdpEmitOptions {
  maxRowsPerFile?: number;
}

export interface SdpFile {
  name: string;
  content: string;
  rowCount: number;
}

export function emitSdpFiles(conversion: UsdcConversion, options: SdpEmitOptions = {}): SdpFile[] {
  if (!Array.isArray((conversion as Partial<UsdcConversion>).payouts)) {
    // A caller still on the old (schedule) signature would be paying EUR as USDC.
    throw new Error('emitSdpFiles takes a UsdcConversion from convertOnChain(), not an EUR distribution schedule');
  }
  const maxRows = options.maxRowsPerFile ?? SDP_MAX_ROWS;

  const files: SdpFile[] = [];
  for (let start = 0; start < conversion.payouts.length; start += maxRows) {
    const chunk = conversion.payouts.slice(start, start + maxRows);
    const lines = ['amount,id,destination,memo,memo_type'];
    for (const payout of chunk) {
      // Re-checked at the sink: every row must stay exactly 5 fields.
      if (!/^\d+\.\d{2}$/.test(payout.usdc)) {
        throw new Error(`investor '${payout.investorId}': USDC amount '${payout.usdc}' is not a 2-decimal amount`);
      }
      assertStellarAddress(payout.destination, payout.investorId);
      lines.push(
        [
          payout.usdc,
          csvField(payout.email),
          payout.destination,
          '', // memo
          '', // memo_type
        ].join(','),
      );
    }
    files.push({
      name: `sdp-${conversion.dealId}-${String(files.length + 1).padStart(3, '0')}.csv`,
      content: lines.join('\n') + '\n',
      rowCount: chunk.length,
    });
  }
  return files;
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
}
