#!/bin/bash
cd /root/lp-monitoring
npx tsx -e "
import DLMM from '@meteora-ag/dlmm';
import { Connection, PublicKey } from '@solana/web3.js';

async function main() {
  const conn = new Connection('https://api.mainnet-beta.solana.com');
  const wallet = 'ABnR6wG9UgCRtH6qtwJKwbW1BPQrkQPKt9ti3VAfc4GT';

  // Test DLMM API
  console.log('--- DLMM API ---');
  try {
    const res = await fetch('https://dlmm.datapi.meteora.ag/wallets/' + wallet + '/open_positions');
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  } catch(e) {
    console.log('Error:', e.message);
  }

  // Test Portfolio API
  console.log('\\n--- Portfolio API ---');
  try {
    const res = await fetch('https://dlmm.datapi.meteora.ag/portfolio/open?user=' + wallet + '&page_size=50');
    const data = await res.json();
    const pools = Array.isArray(data) ? data : data?.pools || [];
    for (const pool of pools) {
      console.log('Pool:', pool.poolAddress, 'Positions:', JSON.stringify(pool.listPositions));
    }
  } catch(e) {
    console.log('Error:', e.message);
  }
}
main().catch(console.error);
" 2>&1
