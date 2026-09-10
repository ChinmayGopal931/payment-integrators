import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * HypeHouseRampIntegrator: a fiat ON-ramp whose payout address is pinned in
 * contract storage rather than passed per order.
 *
 * The assertions that carry the design are the two redirection ones. Every
 * other integrator in this repo takes a recipient from its caller; this one
 * cannot, because the destination IS the control — on-ramped USDC may only ever
 * land in the user's own policy-locked ramp wallet, which is what makes the
 * fiat-in / crypto-out rule enforceable at all. A client that could name the
 * recipient, or a Diamond whose `recipientAddr` were honoured, would undo it.
 */
describe("HypeHouseRampIntegrator", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let stranger: SignerWithAddress;
  let rampWallet: SignerWithAddress;
  let attacker: SignerWithAddress;

  let mockUsdc: any;
  let mockDiamond: any;
  let mockRm: any;
  let integrator: any;
  let integratorAddr: string;
  let usdcAddr: string;

  const USDC = (n: number | string) => ethers.parseUnits(n.toString(), 6);
  const INR = ethers.encodeBytes32String("INR");

  beforeEach(async function () {
    [owner, user, stranger, rampWallet, attacker] = await ethers.getSigners();

    mockUsdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    usdcAddr = await mockUsdc.getAddress();
    mockDiamond = await (await ethers.getContractFactory("MockDiamond")).deploy(usdcAddr);
    mockRm = await (await ethers.getContractFactory("MockReputationManager")).deploy();

    integrator = await (
      await ethers.getContractFactory("HypeHouseRampIntegrator")
    ).deploy(await mockDiamond.getAddress(), usdcAddr, await mockRm.getAddress());
    integratorAddr = await integrator.getAddress();

    await mockDiamond.registerIntegrator(integratorAddr, await integrator.proxyImpl());
    // usdcThroughIntegrator = FALSE: the Diamond pays the order's recipientAddr
    // - the ramp wallet pinned at placement - DIRECTLY. The integrator never
    // holds user money (B2BGatewayFacet.sol:264-268).
    await mockDiamond.setUsdcThroughIntegrator(false);
  });

  const register = () => integrator.setRampRecipient(user.address, rampWallet.address);

  /**
   * Settle an order. The DIAMOND is funded, not the proxy: registered with
   * usdcThroughIntegrator = true, the gateway transfers the USDC to the
   * integrator itself before calling onOrderComplete
   * (B2BGatewayFacet.sol:265).
   */
  async function settle(orderId: number, amount: bigint) {
    await mockUsdc.mint(await mockDiamond.getAddress(), amount);
    await mockDiamond.simulateOrderComplete(orderId);
  }

  describe("the registration gate", function () {
    it("refuses an unregistered user", async function () {
      await expect(
        integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk")
      ).to.be.revertedWithCustomError(integrator, "NotRegistered");
    });

    it("admits one once a recipient is pinned", async function () {
      await register();
      expect(await integrator.isRegistered(user.address)).to.equal(true);
      await expect(integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk")).to.not.be
        .reverted;
    });

    it("lets only the owner pin a recipient", async function () {
      await expect(
        integrator.connect(attacker).setRampRecipient(attacker.address, attacker.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });

    it("is the sybil barrier: a stranger cannot use the contract at all", async function () {
      // The farm's core technique is spinning fresh wallets. Here a fresh
      // wallet is not a user, and there is no argument it can pass to become one.
      await expect(
        integrator.connect(stranger).userPlaceOrder(USDC(10), INR, 0, "pk")
      ).to.be.revertedWithCustomError(integrator, "NotRegistered");
    });
  });

  describe("payout redirection", function () {
    it("pays the PINNED recipient, not the address the Diamond passes", async function () {
      // The mock passes its own `recipientAddr` to onOrderComplete. Honouring
      // it would let settlement land anywhere; the whole taint model assumes it
      // cannot.
      await register();
      await integrator.connect(user).userPlaceOrder(USDC(50), INR, 0, "pk");
      await settle(1, USDC(50));
      expect(await mockUsdc.balanceOf(rampWallet.address)).to.equal(USDC(50));
      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(0n);
    });

    it("has no entry point that accepts a recipient", async function () {
      // Not a behaviour test but an ABI one: the absence of the argument is the
      // guarantee. If someone adds an overload, this fails.
      const fns = integrator.interface.fragments
        .filter((f: any) => f.type === "function")
        .map((f: any) => f.format("full"));
      const placers = fns.filter((f: string) => f.includes("userPlaceOrder"));
      expect(placers).to.have.lengthOf(1);
      expect(placers[0]).to.not.match(/recipient/i);
    });

    it("NEVER holds user money, so a failed callback cannot strand any", async function () {
      // The reason usdcThroughIntegrator is false. The callback that fires
      // after settlement is best-effort and try/catch'd by the gateway
      // (B2BGatewayFacet.sol:277-288), so anything it was responsible for
      // moving could be left behind. It is responsible for moving nothing.
      await register();
      await integrator.connect(user).userPlaceOrder(USDC(50), INR, 0, "pk");
      await settle(1, USDC(50));
      expect(await mockUsdc.balanceOf(integratorAddr)).to.equal(0n);
      expect(await mockUsdc.balanceOf(await integrator.proxyAddress(user.address))).to.equal(0n);
    });

    it("records the pinned recipient ON THE ORDER, which is what gets paid", async function () {
      // With usdcThroughIntegrator = false the Diamond pays
      // `_order.recipientAddr`, so the pin has to reach the order at placement.
      // Passing address(0) here - as an earlier draft of this contract did -
      // would have sent every settlement to the zero address.
      await register();
      await integrator.connect(user).userPlaceOrder(USDC(25), INR, 0, "pk");
      const order = await mockDiamond.getOrdersById(1);
      expect(order.recipientAddr).to.equal(rampWallet.address);
      expect(order.recipientAddr).to.not.equal(ethers.ZeroAddress);
    });

    it("rejects a settlement callback from anyone but the Diamond", async function () {
      await register();
      await expect(
        integrator.connect(attacker).onOrderComplete(1, user.address, USDC(10), attacker.address)
      ).to.be.revertedWithCustomError(integrator, "OnlyDiamond");
    });
  });

  describe("the order id", function () {
    it("comes from the Diamond's RETURN VALUE, not a pre-read", async function () {
      // execute() hands back the call's return data verbatim, so placeB2BOrder's
      // orderId survives the proxy. An earlier draft pre-read getNextOrderId()
      // instead; this is the case that proves the difference.
      await register();
      await mockDiamond.setForceOrderId(4242);
      await integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk");
      // Recorded against the id the Diamond actually used. A pre-read would have
      // filed this under nextOrderId (1) and then cancelled the wrong row.
      expect(await integrator.orderUserOf(4242)).to.equal(user.address);
      expect(await integrator.orderUserOf(1)).to.equal(ethers.ZeroAddress);
    });

    it("so a cancel finds the right row", async function () {
      // The consequence, not just the bookkeeping: onOrderCancel looks the user
      // up BY order id, so a mis-recorded id silently releases nothing.
      await register();
      await mockDiamond.setForceOrderId(777);
      await integrator.setCaps(USDC(500), USDC(500), 5);
      await integrator.connect(user).userPlaceOrder(USDC(500), INR, 0, "pk");
      await mockDiamond.simulateOrderCancelled(777);
      expect(await integrator.inFlightOf(user.address)).to.equal(0n);
      expect(await integrator.cancelCountOf(user.address)).to.equal(1n);
      // ...and the daily allowance came back.
      await expect(integrator.connect(user).userPlaceOrder(USDC(500), INR, 0, "pk")).to.not.be
        .reverted;
    });
  });

  describe("the blacklist read", function () {
    it("refuses a user flagged on ReputationManager", async function () {
      await register();
      await mockRm.setBlacklisted(user.address, true);
      await expect(
        integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk")
      ).to.be.revertedWithCustomError(integrator, "UserBlacklisted");
    });

    it("decodes the THIRD return of rmusers, not the first two", async function () {
      // RmUser is { reputationPoints, voteCount, isBlacklisted } and the member
      // ORDER is the ABI. A non-zero RP with a clean flag must read as clean;
      // if the decode slipped a slot, RP would be mistaken for the flag.
      await register();
      await mockRm.setUser(user.address, 150, 7, false);
      await expect(integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk")).to.not.be
        .reverted;
      await mockRm.setUser(user.address, 150, 7, true);
      await expect(
        integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk")
      ).to.be.revertedWithCustomError(integrator, "UserBlacklisted");
    });

    it("still gates when ReputationManager is unset, on everything else", async function () {
      const noRm = await (
        await ethers.getContractFactory("HypeHouseRampIntegrator")
      ).deploy(await mockDiamond.getAddress(), usdcAddr, ethers.ZeroAddress);
      await expect(
        noRm.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk")
      ).to.be.revertedWithCustomError(noRm, "NotRegistered");
    });
  });

  describe("caps", function () {
    it("binds per transaction", async function () {
      await register();
      await expect(
        integrator.connect(user).userPlaceOrder(USDC(501), INR, 0, "pk")
      ).to.be.revertedWithCustomError(integrator, "OverPerTxCap");
    });

    it("binds per day across several orders", async function () {
      await register();
      await integrator.setCaps(USDC(500), USDC(800), 10);
      await integrator.connect(user).userPlaceOrder(USDC(500), INR, 0, "pk");
      await expect(
        integrator.connect(user).userPlaceOrder(USDC(301), INR, 0, "pk")
      ).to.be.revertedWithCustomError(integrator, "OverDailyCap");
      await expect(integrator.connect(user).userPlaceOrder(USDC(300), INR, 0, "pk")).to.not.be
        .reverted;
    });

    it("caps orders in flight", async function () {
      await register();
      await integrator.setCaps(USDC(500), USDC(5000), 2);
      await integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk");
      await integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk");
      await expect(
        integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk")
      ).to.be.revertedWithCustomError(integrator, "TooManyInFlight");
    });

    it("frees an in-flight slot on settlement", async function () {
      await register();
      await integrator.setCaps(USDC(500), USDC(5000), 1);
      await integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk");
      await settle(1, USDC(10));
      expect(await integrator.inFlightOf(user.address)).to.equal(0n);
      await expect(integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk")).to.not.be
        .reverted;
    });

    it("lets only the owner move the caps", async function () {
      await expect(
        integrator.connect(attacker).setCaps(USDC(1e6), USDC(1e6), 99)
      ).to.be.revertedWithCustomError(integrator, "OnlyOwner");
    });
  });

  describe("cancellation", function () {
    it("releases the daily debit and the in-flight slot", async function () {
      await register();
      await integrator.setCaps(USDC(500), USDC(500), 5);
      await integrator.connect(user).userPlaceOrder(USDC(500), INR, 0, "pk");
      await mockDiamond.simulateOrderCancelled(1);
      expect(await integrator.inFlightOf(user.address)).to.equal(0n);
      // The full daily allowance is available again.
      await expect(integrator.connect(user).userPlaceOrder(USDC(500), INR, 0, "pk")).to.not.be
        .reverted;
    });

    it("TIGHTENS the in-flight cap, permanently", async function () {
      // The engine's rapid_cancellations restriction is per-wallet and expires
      // in four hours; the 2026-09-08 case shows the seed wallet simply resumed
      // after each one. This counter does not expire.
      await register();
      await integrator.setCaps(USDC(500), USDC(5000), 3);
      await integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk");
      await mockDiamond.simulateOrderCancelled(1);
      expect(await integrator.cancelCountOf(user.address)).to.equal(1n);
      await integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk");
      await integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk");
      // Cap is now 3 - 1 = 2, so the third in-flight order is refused.
      await expect(
        integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk")
      ).to.be.revertedWithCustomError(integrator, "TooManyInFlight");
    });

    it("never tightens below one slot", async function () {
      await register();
      await integrator.setCaps(USDC(500), USDC(50000), 2);
      for (let i = 1; i <= 5; i++) {
        await integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk");
        await mockDiamond.simulateOrderCancelled(i);
      }
      // A user who cancelled five times can still place exactly one order: a
      // floor of zero would be a permanent lockout written by accident.
      await expect(integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk")).to.not.be
        .reverted;
    });

    it("is idempotent and tolerates an unknown order id", async function () {
      // Required by the interface: the Diamond may call after its own state has
      // finalised, and may call twice.
      await register();
      await integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk");
      await mockDiamond.simulateOrderCancelled(1);
      // The mock refuses its own double-cancel ("Already cancelled"), so call
      // OUR handler as the Diamond for the repeat - the interface requires us to
      // tolerate it however the Diamond behaves.
      const diamondAddr = await mockDiamond.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [diamondAddr]);
      await ethers.provider.send("hardhat_setBalance", [diamondAddr, "0xde0b6b3a7640000"]);
      const asDiamond = await ethers.getSigner(diamondAddr);
      await expect(integrator.connect(asDiamond).onOrderCancel(1)).to.not.be.reverted;
      await expect(integrator.connect(asDiamond).onOrderCancel(4242)).to.not.be.reverted;
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [diamondAddr]);
      // Exactly one cancel counted, so a double call cannot tighten twice.
      expect(await integrator.cancelCountOf(user.address)).to.equal(1n);
    });

    it("rejects a cancel callback from anyone but the Diamond", async function () {
      await expect(integrator.connect(attacker).onOrderCancel(1)).to.be.revertedWithCustomError(
        integrator,
        "OnlyDiamond"
      );
    });
  });

  describe("validateOrder, called by the Diamond", function () {
    it("blocks an amount the integrator never agreed to", async function () {
      // MockDiamond's tamper mode mirrors a gateway that validates a different
      // amount than the one placed. The cap must be read from the amount the
      // Diamond presents, not from anything we remembered.
      // The mock validates `amount + 1`, so the order has to sit exactly on the
      // cap for the tampered value to cross it.
      //
      // The revert arrives WRAPPED: validateOrder runs inside the Diamond call,
      // which runs inside UserProxy.execute, so our error comes back as the
      // bytes payload of CallFailed. Asserting on the inner selector is the
      // only way to prove it was OUR cap that refused and not something else
      // failing on the way.
      await register();
      await mockDiamond.setTamperValidationAmount(true);
      const selector = ethers.id("OverPerTxCap(uint256,uint256)").slice(2, 10);
      try {
        await integrator.connect(user).userPlaceOrder(USDC(500), INR, 0, "pk");
        expect.fail("expected the tampered amount to be refused");
      } catch (err: any) {
        expect(JSON.stringify(err).toLowerCase()).to.contain(selector);
      }
    });

    it("survives being validated twice for one placement", async function () {
      await register();
      await mockDiamond.setDoubleValidate(true);
      await expect(integrator.connect(user).userPlaceOrder(USDC(10), INR, 0, "pk")).to.not.be
        .reverted;
    });
  });
});
