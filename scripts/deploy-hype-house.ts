import { ethers, network } from "hardhat";

/**
 * Deploy HypeHouseRampIntegrator.
 *
 * NO CUSTODY. Unlike every other integrator in this repo, this one never holds
 * user USDC. It must be whitelisted with `usdcThroughIntegrator = FALSE`, which
 * makes the Diamond pay the order's `recipientAddr` directly
 * (B2BGatewayFacet.sol:264-268) — and `userPlaceOrder` puts the user's pinned
 * ramp wallet on the order. So settlement is one transfer, Diamond → user's
 * wallet, and `onOrderComplete` moves nothing.
 *
 * Whitelisting it with TRUE would route every settlement through this contract
 * and leave the forwarding to a callback the gateway try/catches, so one
 * failure there would strand user funds here. The script prints FALSE in the
 * whitelist block for that reason; do not "fix" it.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-hype-house.ts --network base
 *
 * Env:
 *   DIAMOND_ADDRESS        (required)
 *   USDC_ADDRESS           (required) Base mainnet: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
 *   REPUTATION_MANAGER     (required) Base mainnet: 0xCF613e08EE1B4c2669DdCf06A7d22c9856f6Aa1D
 *                          Verified on-chain 2026-09-10: of the four UUPS proxies in
 *                          contracts-v4/.openzeppelin/base.json it is the only one that
 *                          answers `rmusers(address)`, returning 96 bytes that decode as
 *                          (uint256, uint256, bool). Pass address(0) ONLY on a chain where
 *                          it is not deployed — that disables the blacklist check.
 *   PER_TX_CAP_USDC        (optional, default 500)
 *   PER_DAY_CAP_USDC       (optional, default 2000)
 *   IN_FLIGHT_CAP          (optional, default 3)
 */

const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS || "";
const USDC_ADDRESS = process.env.USDC_ADDRESS || "";
const REPUTATION_MANAGER = process.env.REPUTATION_MANAGER || "";

/** Base mainnet canonical USDC, for the right-token warning below. */
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** ReputationManager on Base mainnet, verified by probing `rmusers(address)`. */
const BASE_REPUTATION_MANAGER = "0xCF613e08EE1B4c2669DdCf06A7d22c9856f6Aa1D";

async function main() {
  // Validated as ADDRESSES, not merely non-empty: a malformed value otherwise
  // dies later inside an opaque ABI-encode error.
  if (!ethers.isAddress(DIAMOND_ADDRESS)) {
    throw new Error(`DIAMOND_ADDRESS missing or not an address: "${DIAMOND_ADDRESS}"`);
  }
  if (!ethers.isAddress(USDC_ADDRESS)) {
    throw new Error(`USDC_ADDRESS missing or not an address: "${USDC_ADDRESS}"`);
  }
  // Deliberately REQUIRED rather than defaulted to address(0): the blacklist
  // check is the one control here that does not depend on our own app being
  // correct, and silently deploying without it because an env var was unset is
  // exactly how it would end up missing in production. Opting out has to be
  // explicit.
  if (!ethers.isAddress(REPUTATION_MANAGER)) {
    throw new Error(
      `REPUTATION_MANAGER missing or not an address: "${REPUTATION_MANAGER}". ` +
        `Base mainnet is ${BASE_REPUTATION_MANAGER}. Pass the zero address explicitly ` +
        `to deploy WITHOUT the user-blacklist check.`
    );
  }

  const [deployer] = await ethers.getSigners();
  console.log("Deployer (owner):  ", await deployer.getAddress());
  console.log("Diamond:           ", DIAMOND_ADDRESS);
  console.log("USDC:              ", USDC_ADDRESS);
  console.log(
    "ReputationManager: ",
    REPUTATION_MANAGER === ethers.ZeroAddress
      ? `${ethers.ZeroAddress}  ** BLACKLIST CHECK DISABLED **`
      : REPUTATION_MANAGER
  );
  console.log("");

  console.log("Deploying HypeHouseRampIntegrator (no custody)...");
  const Factory = await ethers.getContractFactory("HypeHouseRampIntegrator");
  const integrator = await Factory.deploy(DIAMOND_ADDRESS, USDC_ADDRESS, REPUTATION_MANAGER);
  await integrator.deploymentTransaction()?.wait(3);
  const address = await integrator.getAddress();
  const code = await ethers.provider.getCode(address);
  if (code === "0x" || code.length <= 2) throw new Error(`No code at ${address}`);

  // The immutables are load-bearing and UNFIXABLE after deploy. UserProxy
  // resolves the sweep-blocked token live via IUsdcSource(integrator()).usdc(),
  // and a prior MerchantTerminal deploy was once bound to the WRONG token —
  // so assert the constructor pinned what we passed before anyone relies on it.
  const boundDiamond: string = await integrator.diamond();
  const boundUsdc: string = await integrator.usdc();
  const boundRm: string = await integrator.reputationManager();
  if (boundUsdc.toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
    throw new Error(`integrator.usdc() ${boundUsdc} != ${USDC_ADDRESS} — wrong token. ABORT.`);
  }
  if (boundDiamond.toLowerCase() !== DIAMOND_ADDRESS.toLowerCase()) {
    throw new Error(
      `integrator.diamond() ${boundDiamond} != ${DIAMOND_ADDRESS} — wrong Diamond. ABORT.`
    );
  }
  if (boundRm.toLowerCase() !== REPUTATION_MANAGER.toLowerCase()) {
    throw new Error(`integrator.reputationManager() ${boundRm} != ${REPUTATION_MANAGER}. ABORT.`);
  }

  // The blacklist read is a cross-contract decode of a struct whose MEMBER
  // ORDER is the ABI, against a contract we do not control. If the live
  // ReputationManager does not answer `rmusers(address)` with three values, the
  // gate silently never fires — so prove it here, on the real chain, before
  // the contract is whitelisted rather than after a blacklisted user gets
  // through.
  if (REPUTATION_MANAGER !== ethers.ZeroAddress) {
    const rm = new ethers.Contract(
      REPUTATION_MANAGER,
      ["function rmusers(address) view returns (uint256,uint256,bool)"],
      ethers.provider
    );
    const probe = await rm.rmusers(await deployer.getAddress());
    if (probe.length !== 3 || typeof probe[2] !== "boolean") {
      throw new Error(
        `ReputationManager.rmusers() did not decode as (uint256,uint256,bool) — ` +
          `the RmUser layout changed and the blacklist gate would read the wrong slot. ABORT.`
      );
    }
    console.log(`Blacklist decode OK: rmusers(deployer) -> isBlacklisted=${probe[2]}`);
  }

  const proxyImpl = await integrator.proxyImpl();
  const runtimeBytecodeHash = ethers.keccak256(code);

  // Caps, only if overridden — the constructor defaults are the documented
  // starting point (500 / 2000 / 3).
  const perTx = process.env.PER_TX_CAP_USDC;
  const perDay = process.env.PER_DAY_CAP_USDC;
  const inFlight = process.env.IN_FLIGHT_CAP;
  if (perTx || perDay || inFlight) {
    const t = ethers.parseUnits(perTx ?? "500", 6);
    const d = ethers.parseUnits(perDay ?? "2000", 6);
    const f = BigInt(inFlight ?? "3");
    console.log(`Setting caps: ${perTx ?? 500} / ${perDay ?? 2000} USDC, ${f} in flight...`);
    await (await integrator.setCaps(t, d, f)).wait(3);
  }

  console.log("");
  console.log("=== Deployment Summary ===");
  console.log(`Integrator:            ${address}`);
  console.log(`proxyImpl (pinned):    ${proxyImpl}`);
  console.log(`Diamond:               ${boundDiamond}`);
  console.log(`USDC:                  ${boundUsdc}`);
  console.log(`ReputationManager:     ${boundRm}`);
  console.log(`Owner:                 ${await integrator.owner()}`);
  console.log(
    `perTxCapUsdc:          ${ethers.formatUnits(await integrator.perTxCapUsdc(), 6)} USDC`
  );
  console.log(
    `perDayCapUsdc:         ${ethers.formatUnits(await integrator.perDayCapUsdc(), 6)} USDC`
  );
  console.log(`inFlightCap:           ${(await integrator.inFlightCap()).toString()}`);
  console.log(`Runtime bytecode hash: ${runtimeBytecodeHash}`);
  console.log("");
  console.log("Next steps:");
  if (boundUsdc.toLowerCase() !== BASE_USDC.toLowerCase()) {
    console.log(`  0. WARNING: USDC is not Base mainnet canonical (${BASE_USDC}).`);
    console.log("     Correct for a testnet; wrong for production. The assert above only");
    console.log("     proves the constructor pinned what you passed, not that it was right.");
  }
  console.log(`  1. npx hardhat verify --network ${network.name} ${address} \\`);
  console.log(`       ${DIAMOND_ADDRESS} ${USDC_ADDRESS} ${REPUTATION_MANAGER}`);
  console.log("  2. File the whitelist request (docs/WHITELISTING.md):");
  console.log(`       network                = ${network.name}`);
  console.log(`       integrator             = ${address}`);
  console.log(`       proxyImpl              = ${proxyImpl}`);
  console.log("       usdcThroughIntegrator  = FALSE   <-- must be false");
  console.log("         The Diamond pays the order's recipientAddr, which userPlaceOrder");
  console.log("         sets to the user's pinned ramp wallet. TRUE would route every");
  console.log("         settlement through this contract, where a try/catch'd callback is");
  console.log("         all that would forward it — one failure strands user funds.");
  console.log(`       bytecodeHash           = ${runtimeBytecodeHash}`);
  console.log("  3. Pin a ramp recipient per user BEFORE they can ramp:");
  console.log("       integrator.setRampRecipient(user, rampWallet)");
  console.log("     An unpinned user cannot place an order at all (NotRegistered), which is");
  console.log("     deliberate: it means no settlement can ever arrive with nowhere to land.");
  console.log("  4. Record this address FOREVER in hype.house's");
  console.log("     HYPE_HOUSE_INTEGRATOR_ADDRESSES. The P2P subgraph keys orders on the");
  console.log("     user's wallet across every P2P product, so history must be scoped to");
  console.log("     the full set of generations or a later redeploy orphans everyone's.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
