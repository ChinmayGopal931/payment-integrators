# HypeHouseRampIntegrator

Fiat **on-ramp** for hype.house, a Solana spot + Hyperliquid perps trading app.
Not deployed yet — awaiting whitelisting.

`contracts/integrators/hype-house/HypeHouseRampIntegrator.sol`

## What makes it different from every other integrator here

**The payout address is not a parameter.** `userPlaceOrder` takes no
`recipientAddr`; it reads `rampRecipientOf[msg.sender]` from storage, written
once by a server worker when the user's ramp wallet is provisioned, and puts
that on the order. A tampered or scripted client cannot redirect an on-ramp,
because there is no argument through which to try.

That matters more here than it would elsewhere. hype.house's rule is that
**on-ramped USDC may never leave as crypto** — it may only return as fiat,
capped at the amount on-ramped, after a cooldown. Enforcing that needs the
destination of every on-ramp to be a wallet the app controls the policy of. The
pin is what makes the destination knowable in advance; everything downstream
assumes it.

**And it never holds user money.** See below — this is the one decision most
likely to be "corrected" by someone reading the other integrators in this repo.

## `usdcThroughIntegrator` MUST be false

The flag is pinned at registration and chooses who the Diamond pays on
completion (`contracts-v4/contracts/facets/B2BGatewayFacet.sol:264-268`):

```solidity
if (b2b.integrators[integrator].usdcThroughIntegrator) {
    l.usdt.safeTransfer(integrator, amount);            // integrator custodies
} else {
    l.usdt.safeTransfer(_order.recipientAddr, amount);  // paid directly
}
```

Because `userPlaceOrder` puts the pinned ramp wallet on the order, `false` means
the Diamond pays the user's own wallet in **one transfer** and this contract is
never in the path. `onOrderComplete` then moves nothing at all: it decrements
the in-flight count and emits `RampSettled`.

Registering with `true` instead would route every settlement through the
integrator, leaving the forward to a callback the gateway **try/catches**
(`:277-288`) — protocol state and the USDC transfer finalise regardless, so a
single revert in that callback leaves user funds sitting on this contract with
nothing recording a claim to them. The callback fires in *both* branches, so the
settlement event the app's indexer needs costs nothing in the branch that never
touches the money.

An early draft did register `true`, sweep the `UserProxy`, and forward — which
also needed an unclaimed ledger and a recovery path to be safe. All of that
existed only because of the flag.

## The order lifecycle

| Hook | What it does |
|---|---|
| `validateOrder(user, amount, currency)` | Registration gate, user-blacklist read, per-tx cap, per-day cap, in-flight cap. Reverts with a named error to block. |
| `onOrderComplete(orderId, user, amount, recipientAddr)` | Moves no money. Decrements in-flight, emits `RampSettled` — **the only event that opens a tranche in the app.** |
| `onOrderCancel(orderId)` | Releases the day's debit and the in-flight slot, and increments a cancel counter that permanently tightens the user's in-flight cap. Idempotent; tolerates unknown ids. |

`userPlaceOrder(amountUsdc, currency, circleId, pubKey)` is the entry point. The
caller is always `msg.sender`, so a registered account cannot place on behalf of
an unregistered one.

### Why the tranche logic is not in here

The contract cannot see balances spread across Solana, Arbitrum and Hyperliquid,
so it cannot evaluate "how much fiat has this user taken back out". Chain-side
limits stay deliberately coarse and the real rule is enforced in the app before
a transaction is built. A half-informed version here would read as the control
without being one, which is worse than having none.

## The blacklist read is not the obvious one

Read `ReputationManager.rmusers(user)` and decode the **third** return value.

The Diamond's `isBlacklisted(address)` is merchant-scoped — it reads
`MerchantRegistryStorage.layout().blacklistedMerchants[_merchant]`
(`GetterFacet.sol:243`) — so for a blacklisted *user* who is not a registered
merchant it returns `false`. Using it as a user gate **fails open and passes
everyone.**

The user flag lives in `mapping(address => RmUser) public rmusers`
(`RpStorage.sol:84`), whose generated getter returns the struct's members as a
tuple. The member **order is the ABI**:

```solidity
struct RmUser { uint256 reputationPoints; uint256 voteCount; bool isBlacklisted; }
```

Verified on Base mainnet 2026-09-10: of the four UUPS proxies in
`contracts-v4/.openzeppelin/base.json`, only
`0xCF613e08EE1B4c2669DdCf06A7d22c9856f6Aa1D` answers `rmusers(address)`, and it
returns 96 bytes decoding as `(uint256, uint256, bool)`. The deploy script
re-runs that probe against the live contract and aborts if the decode changes,
because a member inserted ahead of `isBlacklisted` upstream would silently shift
which slot the gate reads — and the failure mode is a gate that never fires.

## Rate limits

| Control | Default | Why it is on-chain |
|---|---|---|
| `perTxCapUsdc` | 500 USDC | — |
| `perDayCapUsdc` | 2000 USDC | — |
| `inFlightCap` | 3 orders | The fraud engine's `b2b_inflight_limit` is off-chain and skippable by a scripted order; this is not. |
| `cancelCountOf` | — | Every cancel permanently costs one in-flight slot, floored at one. The engine's `rapid_cancellations_b2b` restriction is per-wallet and expires after four hours, and the 2026-09-08 blacklist-bypass case records a seed wallet simply resuming after each one. |

Caps are owner-settable; the cancel penalty is not resettable by design.

## Deploying

```bash
DIAMOND_ADDRESS=0x... \
USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
REPUTATION_MANAGER=0xCF613e08EE1B4c2669DdCf06A7d22c9856f6Aa1D \
  npx hardhat run scripts/deploy-hype-house.ts --network base
```

`REPUTATION_MANAGER` is required rather than defaulted: passing the zero address
disables the blacklist check, and that has to be an explicit choice rather than
the consequence of an unset variable. The script asserts every bound immutable
and probes the live `rmusers` decode before printing the whitelist block.

After deploy, `setRampRecipient(user, rampWallet)` must be called before that
user can ramp at all — an unpinned user's `userPlaceOrder` reverts
`NotRegistered`, which is what guarantees no settlement ever arrives with
nowhere to land.

## Tests

`test/hype-house-integrator.test.ts` — 24 cases. The ones worth reading first:

- *pays the PINNED recipient, not the address the Diamond passes*
- *has no entry point that accepts a recipient* — an ABI assertion, so adding an
  overload fails the suite
- *records the pinned recipient ON THE ORDER, which is what gets paid* — the
  draft that passed `address(0)` here would, under `false`, have sent every
  settlement to the zero address
- *NEVER holds user money, so a failed callback cannot strand any*
- *decodes the THIRD return of rmusers, not the first two*
- *TIGHTENS the in-flight cap, permanently* / *never tightens below one slot*

One bug the tests found rather than the design: placement double-counted itself.
The Diamond calls `validateOrder` *during* `userPlaceOrder`, and that runs the
same gate, so incrementing the in-flight and daily counters before the call made
every order fail its own cap. The debits land after the call returns.
