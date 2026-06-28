const { Connection, Keypair, PublicKey, VersionedTransaction } = require('@solana/web3.js');
const axios = require('axios');
const bs58 = require('bs58');
require('dotenv').config();

const PK = process.env.SOLANA_PRIVATE_KEY;
const RICH = '5hiLgyybrAYPpUwNFa38agfZ8iEtnahWKAPixcfspump';
const WSOL = 'So11111111111111111111111111111111111111112';
const RPC = 'https://api.mainnet-beta.solana.com';

async function main() {
  if (!PK) throw new Error('SOLANA_PRIVATE_KEY is required');
  const wallet = Keypair.fromSecretKey(bs58.default.decode(PK));
  const conn = new Connection(RPC);

  const ata = new PublicKey('DdbwKrCj3at8tadhJ6vJEmEmrKmSZaN6UQMdzcD7fVp2');
  const bal = await conn.getTokenAccountBalance(ata);
  const amt = bal.value.uiAmount;
  const raw = bal.value.amount;
  console.log(`RICH: ${amt}`);
  if (!amt || amt <= 0) { console.log('No RICH'); return; }

  console.log(`Swapping ${amt} RICH → SOL...`);
  const qurl = new URL('https://api.jup.ag/swap/v2/quote');
  qurl.searchParams.set('inputMint', RICH);
  qurl.searchParams.set('outputMint', WSOL);
  qurl.searchParams.set('amount', raw);
  qurl.searchParams.set('slippageBps', '500');
  qurl.searchParams.set('onlyDirectRoutes', 'false');

  const q = await axios.get(qurl.toString(), { headers: { Accept: 'application/json' }, timeout: 15000 });
  const quote = q.data;
  if (quote.error) { console.log('Quote err'); return; }
  console.log(`Quote: ${(Number(quote.outAmount)/1e9).toFixed(6)} SOL`);

  // Get fresh blockhash BEFORE requesting swap
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  console.log(`Blockhash: ${blockhash}`);

  const res = await axios.post('https://api.jup.ag/swap/v2/swap', {
    quoteResponse: quote,
    userPublicKey: wallet.publicKey.toBase58(),
    taker: wallet.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 'auto',
  }, { headers: { 'Content-Type': 'application/json' }, timeout: 20000 });

  const { swapTransaction } = res.data;
  if (!swapTransaction) { console.log('No tx'); return; }

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.message.recentBlockhash = blockhash;
  tx.sign([wallet]);

  const sig = await conn.sendTransaction(tx, { skipPreflight: true, maxRetries: 3 });
  console.log(`Sent: ${sig}`);
  
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  console.log(`✅ Confirmed`);

  await new Promise(r => setTimeout(r, 3000));
  const check = await conn.getTokenAccountBalance(ata);
  console.log(`RICH remaining: ${check.value.uiAmount}`);
  const final = await conn.getBalance(wallet.publicKey);
  console.log(`SOL: ${final / 1e9}`);
}

main().catch(e => console.error('❌', e.message));
