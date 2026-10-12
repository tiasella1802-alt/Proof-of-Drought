// Accounts on the local test chain (npm run chain). These are Hardhat's published test keys: public and worthless.
import { ethers } from 'ethers'

const KEYS = {
  insurer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  era5: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  power: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  stranger: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
}

// No response caching, or a fast local chain hands back stale nonces for back-to-back transactions.
export function local(rpc = 'http://127.0.0.1:8545') {
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 })
  return { provider, ...Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, new ethers.Wallet(v, provider)])) }
}
