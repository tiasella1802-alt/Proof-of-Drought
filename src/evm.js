// A private Ethereum chain that runs in the page (the Ethereum Foundation's @ethereumjs/vm).
// Visitors can watch the real DroughtCover bytecode settle a drought without a wallet or a network: every call is a
// signed transaction executed by the same EVM rules as Ethereum, with real gas, logs and balances.
import { createVM, runTx } from '@ethereumjs/vm'
import { createLegacyTx } from '@ethereumjs/tx'
import { createBlock } from '@ethereumjs/block'
import { Common, Mainnet, Hardfork } from '@ethereumjs/common'
import { Address, createAccount, hexToBytes, bytesToHex, privateToAddress } from '@ethereumjs/util'
import { Interface, ContractFactory, keccak256, getBytes } from 'ethers'

export async function chain() {
  const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun })
  const vm = await createVM({ common })
  const nonces = new Map()
  let block = 0, time = BigInt(Math.floor(Date.now() / 1000)) // block timestamps; warp() moves the clock forward
  const header = () => createBlock({ header: { number: BigInt(block + 1), timestamp: time, baseFeePerGas: 1n, gasLimit: 30_000_000n } }, { common })

  async function fund(address, wei) {
    const a = new Address(hexToBytes(address))
    await vm.stateManager.putAccount(a, createAccount({ nonce: 0n, balance: wei }))
  }
  const balance = async (address) => (await vm.stateManager.getAccount(new Address(hexToBytes(address))))?.balance ?? 0n

  // Signs and runs one transaction. Returns the receipt-like result; throws with the revert data on failure.
  async function send(key, { to, data = '0x', value = 0n, gas = 15_000_000n }) {
    const from = bytesToHex(privateToAddress(hexToBytes(key)))
    const nonce = nonces.get(from) ?? 0n
    const tx = createLegacyTx({ nonce, gasPrice: 7n, gasLimit: gas, to, value, data }, { common }).sign(hexToBytes(key))
    const res = await runTx(vm, { tx, block: header(), skipBalance: true, skipBlockGasLimitValidation: true, skipHardForkValidation: true })
    nonces.set(from, nonce + 1n)
    block++
    const hash = bytesToHex(tx.hash())
    if (res.execResult.exceptionError) throw Object.assign(new Error(res.execResult.exceptionError.error), { data: bytesToHex(res.execResult.returnValue), hash })
    return { hash, block, gas: res.totalGasSpent, created: res.createdAddress?.toString(),
      logs: res.receipt.logs.map(([addr, topics, data]) => ({ address: bytesToHex(addr), topics: topics.map(bytesToHex), data: bytesToHex(data) })) }
  }

  async function call(to, data) {
    const r = await vm.evm.runCall({ to: new Address(hexToBytes(to)), data: getBytes(data), gasLimit: 10_000_000n, block: header() })
    if (r.execResult.exceptionError) throw new Error(r.execResult.exceptionError.error)
    return bytesToHex(r.execResult.returnValue)
  }

  // Deploys a compiled contract and returns a small ethers-style wrapper: c.write(key, fn, args, value), c.read(fn, args).
  async function deploy(key, { abi, bytecode }, args = []) {
    const iface = new Interface(abi), data = new ContractFactory(abi, bytecode).interface.encodeDeploy(args)
    const r = await send(key, { data: bytecode + data.slice(2) })
    const address = r.created
    const parse = (logs) => logs.filter((l) => l.address.toLowerCase() === address.toLowerCase()).map((l) => { try { return iface.parseLog(l) } catch { return null } }).filter(Boolean)
    return {
      address, iface, deployTx: r,
      async write(key, fn, args = [], value = 0n) {
        try {
          const res = await send(key, { to: new Address(hexToBytes(address)), data: iface.encodeFunctionData(fn, args), value })
          return { ...res, events: parse(res.logs) }
        } catch (e) {
          let reason = e.message
          try { reason = iface.parseError(e.data)?.name ?? reason } catch {}
          throw Object.assign(new Error(reason), { hash: e.hash })
        }
      },
      async read(fn, args = []) { return iface.decodeFunctionResult(fn, await call(address, iface.encodeFunctionData(fn, args))) },
    }
  }

  async function transfer(key, to, value) { return send(key, { to: new Address(hexToBytes(to)), value }) }

  const warp = (seconds) => { time += BigInt(seconds) }
  return { fund, balance, deploy, transfer, warp, get block() { return block }, get time() { return time } }
}

// Deterministic demo keys (never used anywhere else). Derived so they're stable across page loads.
export const demoKey = (label) => keccak256(new TextEncoder().encode(`proof-of-drought demo ${label}`))
export const addressOf = (key) => bytesToHex(privateToAddress(hexToBytes(key)))
