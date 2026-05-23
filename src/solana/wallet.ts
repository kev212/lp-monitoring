import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { config } from '../config.js'

let _wallet: Keypair | null = null

export function loadWallet(): Keypair {
  if (_wallet) return _wallet

  const secret = config.solanaPrivateKey.trim()
  if (!secret) {
    throw new Error('SOLANA_PRIVATE_KEY is required')
  }

  try {
    if (secret.startsWith('[')) {
      _wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)))
    } else {
      _wallet = Keypair.fromSecretKey(bs58.decode(secret))
    }
  } catch (err) {
    throw new Error(`Failed to load wallet: ${err instanceof Error ? err.message : 'unknown error'}`)
  }

  console.log(`[wallet] loaded ${_wallet.publicKey.toBase58()}`)
  return _wallet
}

export function getWallet(): Keypair {
  if (!_wallet) throw new Error('Wallet not loaded')
  return _wallet
}

export function walletPubkey(): string {
  return getWallet().publicKey.toBase58()
}
