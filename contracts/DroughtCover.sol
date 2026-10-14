// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Proof of Drought: drought cover that pays itself
/// @notice Holds an insurer's payout pool for cane farmers. Two independent oracles each post one data source's
/// dryness reading for a district (Copernicus ERA5 and NASA POWER), with the SHA-256 of the exact daily data behind it.
/// When both have reported, this contract, not the insurer, applies the public rules and pays every farmer in the
/// district at once. No single oracle can trigger a payout, and the insurer cannot withhold one the data says is due.
///
/// Dryness is a percentile in tenths of a percent (0 = driest season in the 1991–2020 baseline, 1000 = wettest).
/// Checkpoints per season: EARLY (end of January) and FINAL (end of April). Rules, same as scripts/rules.mjs:
///   sources must agree within MAX_GAP, or nothing pays (and the disagreement is logged)
///   EARLY  index <= 100 → 30% of cover, paid now, before the crop fails
///   FINAL  index <= 100 → 100% of cover, index <= 200 → 50%; minus anything already paid this season
///
/// Each oracle also posts its data guard's verdict: the AI anomaly score as a share of the flag threshold (per mille,
/// above 1000 = the data doesn't look like real weather). If either reading is flagged, a payout that is due is held
/// for CHALLENGE_PERIOD. During it, the insurer can reject it (for example after showing the data doesn't match the
/// public archives); after it, anyone can release it. Unflagged payouts are never delayed.
contract DroughtCover {
    enum Stage { EARLY, FINAL }

    uint16 public constant MAX_GAP = 250;
    uint16 public constant EARLY_AT = 100;
    uint16 public constant EARLY_PAY = 300;    // per mille of cover
    uint16 public constant SEVERE_AT = 100;
    uint16 public constant SEVERE_PAY = 1000;
    uint16 public constant MODERATE_AT = 200;
    uint16 public constant MODERATE_PAY = 500;
    uint16 public constant FLAG_AT = 1000;
    uint64 public constant CHALLENGE_PERIOD = 14 days;

    struct Policy { address payable farmer; uint8 district; uint128 cover; }
    struct Report { uint16 dryness; uint16 guard; bytes32 dataHash; bool posted; }
    struct Hold { uint16 share; uint64 releaseAt; }

    address public immutable insurer;
    address[2] public oracles; // [0] Copernicus ERA5 / ERA5-Land, [1] NASA POWER
    Policy[] public policies;
    mapping(uint8 => uint256[]) private byDistrict;
    // season => stage => district => source => report
    mapping(uint16 => mapping(Stage => mapping(uint8 => Report[2]))) private reports;
    mapping(uint16 => mapping(Stage => mapping(uint8 => bool))) public settled;
    // season => policy id => share of cover already paid (per mille)
    mapping(uint16 => mapping(uint256 => uint16)) public paidShare;
    mapping(address => uint256) public owed;
    // season => stage => district => payout waiting out its challenge period
    mapping(uint16 => mapping(Stage => mapping(uint8 => Hold))) public holds;

    event PolicyIssued(uint256 indexed id, address indexed farmer, uint8 indexed district, uint128 cover);
    event Reported(uint16 indexed season, Stage stage, uint8 indexed district, uint8 source, uint16 dryness, uint16 guard, bytes32 dataHash);
    event Settled(uint16 indexed season, Stage stage, uint8 indexed district, uint16 index, uint16 gap, uint16 share, uint256 farmers, uint256 total);
    event SourcesDisagree(uint16 indexed season, Stage stage, uint8 indexed district, uint16 era5, uint16 power);
    event Paid(uint16 indexed season, uint256 indexed id, address indexed farmer, uint256 amount);
    event Held(uint16 indexed season, uint256 indexed id, address indexed farmer, uint256 amount);
    event PayoutHeld(uint16 indexed season, Stage stage, uint8 indexed district, uint16 share, uint16 era5Guard, uint16 powerGuard, uint64 releaseAt);
    event PayoutReleased(uint16 indexed season, Stage stage, uint8 indexed district);
    event PayoutRejected(uint16 indexed season, Stage stage, uint8 indexed district);

    error NotInsurer();
    error NotOracle();
    error AlreadyReported();
    error AlreadySettled();
    error BadReading();
    error PoolTooSmall(uint256 needed, uint256 available);
    error NothingHeld();
    error ChallengeOpen(uint64 releaseAt);
    error ChallengeClosed();

    constructor(address era5Oracle, address powerOracle) {
        insurer = msg.sender;
        oracles = [era5Oracle, powerOracle];
    }

    /// @notice Premiums and the insurer's capital go into the pool.
    receive() external payable {}

    function issue(address payable farmer, uint8 district, uint128 cover) external returns (uint256 id) {
        if (msg.sender != insurer) revert NotInsurer();
        id = policies.length;
        policies.push(Policy(farmer, district, cover));
        byDistrict[district].push(id);
        emit PolicyIssued(id, farmer, district, cover);
    }

    /// @notice An oracle posts its source's reading and its data guard's verdict. The second report settles the district.
    function report(uint16 season, Stage stage, uint8 district, uint16 dryness, uint16 guard, bytes32 dataHash) external {
        uint8 source = msg.sender == oracles[0] ? 0 : msg.sender == oracles[1] ? 1 : 2;
        if (source == 2) revert NotOracle();
        if (dryness > 1000 || dataHash == bytes32(0)) revert BadReading();
        if (settled[season][stage][district]) revert AlreadySettled();
        Report[2] storage r = reports[season][stage][district];
        if (r[source].posted) revert AlreadyReported();
        r[source] = Report(dryness, guard, dataHash, true);
        emit Reported(season, stage, district, source, dryness, guard, dataHash);
        if (r[0].posted && r[1].posted) _settle(season, stage, district, r[0], r[1]);
    }

    function _settle(uint16 season, Stage stage, uint8 district, Report storage a, Report storage b) private {
        settled[season][stage][district] = true;
        uint16 gap = a.dryness > b.dryness ? a.dryness - b.dryness : b.dryness - a.dryness;
        uint16 index = (a.dryness + b.dryness) / 2;
        if (gap > MAX_GAP) {
            emit SourcesDisagree(season, stage, district, a.dryness, b.dryness);
            emit Settled(season, stage, district, index, gap, 0, 0, 0);
            return;
        }
        uint16 share = shareDue(stage, index);
        if (share > 0 && (a.guard > FLAG_AT || b.guard > FLAG_AT)) {
            uint64 releaseAt = uint64(block.timestamp) + CHALLENGE_PERIOD;
            holds[season][stage][district] = Hold(share, releaseAt);
            emit PayoutHeld(season, stage, district, share, a.guard, b.guard, releaseAt);
            emit Settled(season, stage, district, index, gap, share, 0, 0);
            return;
        }
        (uint256 n, uint256 total) = _pay(season, district, share);
        emit Settled(season, stage, district, index, gap, share, n, total);
    }

    /// @notice After the challenge period, anyone can release a held payout.
    function release(uint16 season, Stage stage, uint8 district) external {
        Hold memory h = holds[season][stage][district];
        if (h.share == 0) revert NothingHeld();
        if (block.timestamp < h.releaseAt) revert ChallengeOpen(h.releaseAt);
        delete holds[season][stage][district];
        emit PayoutReleased(season, stage, district);
        _pay(season, district, h.share);
    }

    /// @notice During the challenge period, the insurer can reject a flagged payout. It's logged for everyone to see.
    function reject(uint16 season, Stage stage, uint8 district) external {
        if (msg.sender != insurer) revert NotInsurer();
        Hold memory h = holds[season][stage][district];
        if (h.share == 0) revert NothingHeld();
        if (block.timestamp >= h.releaseAt) revert ChallengeClosed();
        delete holds[season][stage][district];
        emit PayoutRejected(season, stage, district);
    }

    function _pay(uint16 season, uint8 district, uint16 share) private returns (uint256 n, uint256 total) {
        uint256[] storage ids = byDistrict[district];
        // Work out every amount first, check the pool covers them all, then pay.
        uint256[] memory amounts = new uint256[](ids.length);
        for (uint256 i; i < ids.length; i++) {
            uint16 before = paidShare[season][ids[i]];
            if (share > before) {
                amounts[i] = (uint256(policies[ids[i]].cover) * (share - before)) / 1000;
                paidShare[season][ids[i]] = share;
                total += amounts[i];
            }
        }
        if (total > address(this).balance) revert PoolTooSmall(total, address(this).balance);
        for (uint256 i; i < ids.length; i++) {
            if (amounts[i] == 0) continue;
            Policy storage p = policies[ids[i]];
            // A wallet that refuses the transfer must not block everyone else: keep its money for it to withdraw.
            (bool ok, ) = p.farmer.call{value: amounts[i], gas: 30000}("");
            if (ok) emit Paid(season, ids[i], p.farmer, amounts[i]);
            else { owed[p.farmer] += amounts[i]; emit Held(season, ids[i], p.farmer, amounts[i]); }
            n++;
        }
    }

    /// @notice Collect a payment that couldn't be pushed to your wallet.
    function withdraw() external {
        uint256 amount = owed[msg.sender];
        owed[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "withdraw failed");
    }

    /// @notice The rule, public: what share of cover is due for an index at a checkpoint.
    function shareDue(Stage stage, uint16 index) public pure returns (uint16) {
        if (stage == Stage.EARLY) return index <= EARLY_AT ? EARLY_PAY : 0;
        if (index <= SEVERE_AT) return SEVERE_PAY;
        if (index <= MODERATE_AT) return MODERATE_PAY;
        return 0;
    }

    function readings(uint16 season, Stage stage, uint8 district) external view returns (Report memory era5, Report memory power) {
        Report[2] storage r = reports[season][stage][district];
        return (r[0], r[1]);
    }

    function policyCount() external view returns (uint256) {
        return policies.length;
    }

    function districtPolicies(uint8 district) external view returns (uint256[] memory) {
        return byDistrict[district];
    }
}
