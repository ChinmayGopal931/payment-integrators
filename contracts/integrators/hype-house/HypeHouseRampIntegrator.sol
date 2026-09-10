// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import { IP2PIntegrator } from "../../interfaces/IP2PIntegrator.sol";
import { IB2BGateway } from "../../interfaces/IB2BGateway.sol";
import { IOrderFlow } from "../../interfaces/IOrderFlow.sol";
import { UserProxy } from "../../base/UserProxy.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

/**
 * @notice ReputationManager's USER blacklist.
 *
 *         NOT the Diamond's `isBlacklisted(address)`. That one reads
 *         `MerchantRegistryStorage.layout().blacklistedMerchants[_merchant]`
 *         (contracts-v4 GetterFacet.sol:243), so a blacklisted user who is not
 *         a registered merchant is simply absent from that mapping and the view
 *         returns FALSE. Using it as a user gate fails OPEN and passes
 *         everyone - it is the obvious call and the wrong one.
 *
 *         The user flag lives in `mapping(address => RmUser) public rmusers`
 *         (contracts-v4 RpStorage.sol:84), so Solidity's generated getter is
 *         the whole interface we need. The member ORDER of RmUser is the ABI:
 *         `{ uint256 reputationPoints; uint256 voteCount; bool isBlacklisted; }`
 *         A new member inserted ahead of the flag would silently shift it,
 *         which is why a test asserts the decode against the real contract.
 */
interface IRmUserBlacklist {
    function rmusers(address user) external view returns (uint256, uint256, bool);
}

/**
 * @title HypeHouseRampIntegrator
 * @notice hype.house's fiat on-ramp into the P2P protocol.
 *
 *         PINNED RECIPIENT. `userPlaceOrder` takes no `recipientAddr` and
 *         `onOrderComplete` IGNORES the one the Diamond passes: the payout
 *         address is read from `rampRecipientOf[user]`, written once by a
 *         server worker at ramp-wallet provisioning. A tampered or scripted
 *         client therefore cannot redirect an on-ramp anywhere - the only
 *         place funds can land is the user's own policy-locked ramp wallet,
 *         which is the taint sink the whole design rests on.
 *
 *         WHAT IS DELIBERATELY NOT HERE: tranche accounting, cooldowns, the
 *         fiat-in/crypto-out rule. This contract cannot see balances spread
 *         across Solana, Arbitrum and Hyperliquid, so chain-side limits stay
 *         coarse and the real rule is enforced in the app before a transaction
 *         is ever built. Putting a half-informed version of it here would be
 *         worse than having none: it would read as the control and not be one.
 *
 *         Register with `registerIntegrator(integrator, FALSE, proxyImpl)`.
 *         The bool is `usdcThroughIntegrator`, and false is what makes this
 *         contract never custody a user's money:
 *
 *           true  -> l.usdt.safeTransfer(integrator, amount)
 *           false -> l.usdt.safeTransfer(_order.recipientAddr, amount)
 *                                                (B2BGatewayFacet.sol:264-268)
 *
 *         We place the order with `recipientAddr = rampRecipientOf[user]`, so
 *         the false branch pays the ramp wallet DIRECTLY from the Diamond: one
 *         transfer, no intermediate balance, and no way for a settlement to
 *         strand here. The client still cannot influence it, because that
 *         address is read from this contract's storage and not from any
 *         argument.
 *
 *         Registering with true instead would route every settlement through
 *         this contract, and since the callback that forwards it is
 *         best-effort and try/catch'd, a single failure there would leave user
 *         funds sitting on the integrator. The callback fires in BOTH branches
 *         (it is outside that if/else), so nothing is lost by taking the
 *         branch that never touches the money.
 */
contract HypeHouseRampIntegrator is IP2PIntegrator {
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────────────
    error OnlyDiamond();
    error OnlyOwner();
    error InvalidAddress();
    error NotRegistered(address user);
    error UserBlacklisted(address user);
    error OverPerTxCap(uint256 amount, uint256 cap);
    error OverDailyCap(uint256 amount, uint256 cap);
    error TooManyInFlight(address user, uint256 inFlight, uint256 cap);
    error Reentrancy();

    // ─── Events ───────────────────────────────────────────────────────
    event RampRecipientSet(address indexed user, address indexed recipient);
    event OrderPlaced(uint256 indexed orderId, address indexed user, uint256 amount);
    /// @notice The ONLY thing that opens a tranche in the app. Watched by the
    ///         indexer; never reported by a client callback, because a scripted
    ///         order does not call our API at all.
    event RampSettled(
        uint256 indexed orderId,
        address indexed user,
        uint256 amount,
        address recipient
    );
    event OrderCancelled(uint256 indexed orderId, address indexed user);
    event UserProxyDeployed(address indexed user, address proxy);
    event CapsUpdated(uint256 perTx, uint256 perDay, uint256 inFlight);

    // ─── Immutables ───────────────────────────────────────────────────
    address public immutable diamond;
    IERC20 public immutable usdc;
    address public immutable owner;
    address public immutable proxyImpl;
    /// @notice ReputationManager, for the USER blacklist. Zero disables the
    ///         check - allowed only so tests and a pre-deploy environment can
    ///         run, never in production.
    IRmUserBlacklist public immutable reputationManager;

    // ─── Caps (owner-settable) ────────────────────────────────────────
    uint256 public perTxCapUsdc = 500e6;
    uint256 public perDayCapUsdc = 2000e6;
    /// @notice Orders placed and not yet settled or cancelled. The fraud
    ///         engine's own in-flight limit is off-chain and skippable; this
    ///         one is not.
    uint256 public inFlightCap = 3;

    // ─── State ────────────────────────────────────────────────────────
    mapping(address => address) public rampRecipientOf;
    mapping(address => uint256) public inFlightOf;
    /// @notice Cancels tighten the in-flight cap. The engine's
    ///         `rapid_cancellations_b2b` restriction is per-wallet and expires
    ///         in four hours, and the 2026-09-08 case shows the seed wallet
    ///         simply resumed after each one. This counter does not expire.
    mapping(address => uint256) public cancelCountOf;
    /// @dev user => day index => USDC placed that day.
    mapping(address => mapping(uint256 => uint256)) public dailySpentOf;
    /// @dev orderId => user, so cancel and complete can find their own row
    ///      without trusting an argument.
    mapping(uint256 => address) public orderUserOf;
    mapping(uint256 => uint256) public orderAmountOf;
    mapping(uint256 => uint256) public orderDayOf;

    /// @dev Transient (EIP-1153), so it costs nothing to clear at end-of-tx.
    ///      Guards the value-moving entrypoints, per the repo's #77 conformance
    ///      invariant. NOT on validateOrder - the Diamond calls that back from
    ///      inside userPlaceOrder, so a guard there would make every placement
    ///      revert on itself.
    bool private transient _entered;

    modifier nonReentrant() {
        if (_entered) revert Reentrancy();
        _entered = true;
        _;
        _entered = false;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    constructor(address _diamond, address _usdc, address _reputationManager) {
        if (_diamond == address(0) || _usdc == address(0)) revert InvalidAddress();
        diamond = _diamond;
        usdc = IERC20(_usdc);
        owner = msg.sender;
        reputationManager = IRmUserBlacklist(_reputationManager);
        proxyImpl = address(new UserProxy());
    }

    // ─── Admin ────────────────────────────────────────────────────────

    /// @notice Pin where this user's on-ramps may land. Written once at
    ///         provisioning, BEFORE the wallet is advertised as usable: a
    ///         wallet that exists unpinned simply cannot receive an on-ramp,
    ///         while a pin to an address that does not exist would strand funds.
    function setRampRecipient(address user, address recipient) external onlyOwner {
        if (user == address(0) || recipient == address(0)) revert InvalidAddress();
        rampRecipientOf[user] = recipient;
        emit RampRecipientSet(user, recipient);
    }

    function isRegistered(address user) external view returns (bool) {
        return rampRecipientOf[user] != address(0);
    }

    function setCaps(uint256 perTx, uint256 perDay, uint256 inFlight) external onlyOwner {
        perTxCapUsdc = perTx;
        perDayCapUsdc = perDay;
        inFlightCap = inFlight;
        emit CapsUpdated(perTx, perDay, inFlight);
    }

    // ─── IP2PIntegrator ───────────────────────────────────────────────

    /**
     * @notice Called by the Diamond at placement; reverting blocks the order.
     *
     *         Reverts with a named error rather than returning false, so the
     *         client gets a decodable reason instead of a bare failure.
     */
    function validateOrder(
        address user,
        uint256 amount,
        bytes32 /*currency*/
    ) external returns (bool allowed) {
        _assertAllowed(user, amount);
        return true;
    }

    /**
     * @notice Fiat settled. Sweep the proxy and forward to the PINNED
     *         recipient, ignoring `recipientAddr`.
     *
     *         `recipientAddr` is ignored on purpose and not merely unused: it
     *         is the one value a client could have influenced, and honouring it
     *         would undo the reason this integrator is pinned at all.
     */
    function onOrderComplete(
        uint256 orderId,
        address user,
        uint256 amount,
        address recipientAddr
    ) external {
        if (msg.sender != diamond) revert OnlyDiamond();

        // THIS FUNCTION MOVES NO MONEY, and that is the point. Registered with
        // usdcThroughIntegrator = false, the Diamond has already paid
        // `_order.recipientAddr` - the ramp wallet we pinned at placement -
        // directly (B2BGatewayFacet.sol:267). There is no balance here to
        // forward, nothing to strand if this reverts, and no custody to reason
        // about. All that is left is bookkeeping and the event.
        if (inFlightOf[user] > 0) inFlightOf[user] -= 1;

        emit RampSettled(orderId, user, amount, recipientAddr);
    }

    /**
     * @notice Order died. Release the daily debit and the in-flight slot, and
     *         count the cancel against the user.
     *
     *         Idempotent, and tolerant of an unknown id: the interface requires
     *         it, and the Diamond may call after on-chain state has finalised.
     *         Deleting the row is what makes a second call a no-op.
     */
    function onOrderCancel(uint256 orderId) external {
        if (msg.sender != diamond) revert OnlyDiamond();
        address user = orderUserOf[orderId];
        if (user == address(0)) return; // unknown or already handled

        uint256 amount = orderAmountOf[orderId];
        uint256 day = orderDayOf[orderId];
        if (dailySpentOf[user][day] >= amount) dailySpentOf[user][day] -= amount;
        else dailySpentOf[user][day] = 0;
        if (inFlightOf[user] > 0) inFlightOf[user] -= 1;
        cancelCountOf[user] += 1;

        delete orderUserOf[orderId];
        delete orderAmountOf[orderId];
        delete orderDayOf[orderId];

        emit OrderCancelled(orderId, user);
    }

    // ─── Order entry ──────────────────────────────────────────────────

    /**
     * @notice Place an on-ramp. No `recipientAddr` argument, by design (D2).
     *
     *         The caller is always `msg.sender`: an on-ramp cannot be placed on
     *         another user's behalf, so a registered account cannot be used as
     *         a funnel for an unregistered one.
     */
    function userPlaceOrder(
        uint256 amountUsdc,
        bytes32 currency,
        uint256 circleId,
        string calldata pubKey
    ) external nonReentrant returns (uint256 orderId) {
        address user = msg.sender;
        _assertAllowed(user, amountUsdc);

        uint256 day = block.timestamp / 1 days;
        address proxy = _ensureProxy(user);
        // Captured BEFORE the call: the Diamond reads-then-increments and
        // placeB2BOrder's return value does not survive the proxy's `execute`
        // (IOrderFlow.sol:12-14). getNextOrderId lives on IOrderFlow, not on
        // IB2BGateway.
        orderId = IOrderFlow(diamond).getNextOrderId();

        // The recipient is THE control, so it is read from storage and never
        // from an argument - and it is recorded on the order itself, because
        // with usdcThroughIntegrator = false this is the address the Diamond
        // pays at settlement. _assertAllowed above has already refused a user
        // with no pin, so this can never be the zero address: an order that
        // would have nowhere to land cannot be placed in the first place.
        address recipient = rampRecipientOf[user];
        bytes memory placeData = abi.encodeCall(
            IB2BGateway.placeB2BOrder,
            (user, amountUsdc, currency, recipient, pubKey, circleId, 0, 0)
        );
        // usdcAllowance = 0: placeB2BOrder pulls nothing at placement. Payment
        // settles off-chain and the Diamond pulls via the proxy at completion.
        UserProxy(proxy).execute(diamond, placeData, address(usdc), 0);

        // Debited AFTER the call, not before. The Diamond invokes
        // validateOrder DURING placement, and that runs the same _assertAllowed
        // as this function - so incrementing first made the order count against
        // itself and every placement past the first failed its own in-flight
        // cap. Caught by the caps tests, which is the only reason it is not
        // still in here.
        dailySpentOf[user][day] += amountUsdc;
        inFlightOf[user] += 1;

        orderUserOf[orderId] = user;
        orderAmountOf[orderId] = amountUsdc;
        orderDayOf[orderId] = day;

        emit OrderPlaced(orderId, user, amountUsdc);
    }

    // ─── Internal ─────────────────────────────────────────────────────

    /// @dev One gate, called from both `userPlaceOrder` and `validateOrder`, so
    ///      the front-run path and the Diamond's callback can never disagree.
    function _assertAllowed(address user, uint256 amount) internal view {
        if (rampRecipientOf[user] == address(0)) revert NotRegistered(user);

        if (address(reputationManager) != address(0)) {
            (, , bool blacklisted) = reputationManager.rmusers(user);
            if (blacklisted) revert UserBlacklisted(user);
        }

        if (amount > perTxCapUsdc) revert OverPerTxCap(amount, perTxCapUsdc);

        uint256 day = block.timestamp / 1 days;
        uint256 spent = dailySpentOf[user][day];
        if (spent + amount > perDayCapUsdc) revert OverDailyCap(spent + amount, perDayCapUsdc);

        // Every cancel permanently costs one slot, to a floor of one.
        uint256 cap = inFlightCap;
        uint256 penalty = cancelCountOf[user];
        cap = penalty >= cap ? 1 : cap - penalty;
        if (inFlightOf[user] >= cap) revert TooManyInFlight(user, inFlightOf[user], cap);
    }

    // ─── Proxy helpers (mirror the template exactly) ───────────────────

    function proxyAddress(address user) public view returns (address) {
        return
            Clones.predictDeterministicAddressWithImmutableArgs(
                proxyImpl,
                _proxyArgs(user),
                _salt(user),
                address(this)
            );
    }

    function _salt(address user) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(user)));
    }

    /// @dev [owner(20)][integrator(20)] — the Diamond's CREATE2 auth path
    ///      reconstructs these exact args. DO NOT change the layout.
    function _proxyArgs(address user) internal view returns (bytes memory) {
        return abi.encodePacked(user, address(this));
    }

    function _ensureProxy(address user) internal returns (address proxy) {
        proxy = proxyAddress(user);
        if (proxy.code.length == 0) {
            address deployed = Clones.cloneDeterministicWithImmutableArgs(
                proxyImpl,
                _proxyArgs(user),
                _salt(user)
            );
            assert(deployed == proxy);
            emit UserProxyDeployed(user, proxy);
        }
    }
}
