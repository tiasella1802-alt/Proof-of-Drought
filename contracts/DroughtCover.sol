// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Proof of Drought: drought cover that pays itself
/// @notice Holds an insurer's payout pool for cane farmers. Three oracles each post one independent record's dryness
/// reading for a district, with the SHA-256 of the exact daily data behind it:
///   [0] Copernicus ERA5 / ERA5-Land and [1] NASA POWER / MERRA-2: reanalyses (weather models that combine satellite,
///       station and balloon observations), rainfall and soil moisture
///   [2] CHIRPS: satellite rainfall estimates blended with rain gauges, published a few weeks after each month
/// This contract, not the insurer, applies the public rules and pays every farmer in the district at once.
///
/// Dryness is a percentile in tenths of a percent (0 = driest season in the 1991–2020 baseline, 1000 = wettest).
/// Checkpoints per season: EARLY (end of January) and FINAL (end of April). Rules, same as scripts/rules.mjs:
///   ERA5 and NASA decide when they agree within MAX_GAP; CHIRPS, when it arrives, is logged as a witness.
///   If they disagree, the checkpoint waits for CHIRPS, which breaks the tie: the pair that agrees decides
///   (the closer pair if both do). If no two records agree, nothing pays and the disagreement is logged.
///   EARLY  index <= 100 → 30% of cover, paid now, before the crop fails
///   FINAL  index <= 100 → 100% of cover, index <= 200 → 50%; minus anything already paid this season
/// So one faked or broken record can neither trigger a payout nor block an honest one.
///
/// Each oracle also posts its data guard's verdict: the AI anomaly score as a share of the flag threshold (per mille,
/// above 1000 = the data doesn't look like real weather; CHIRPS posts 0, it has no guard model). If a deciding reading
/// is flagged, a payout that is due is held for CHALLENGE_PERIOD; after it, anyone can release it. The insurer can
/// reject it during the period only with two signals: both deciding readings flagged, or one flagged and CHIRPS
/// disagreeing. One oracle alone (or colluding with the insurer) can delay a real payout, never cancel it.
///
/// Sponsors (a government, a donor) can pay into a district's pool; every sponsor dollar used is logged against the
/// district and season it paid for. Anyone with a role can seal a forecast or reading on the record before the season.
contract DroughtCover {
    enum Stage { EARLY, FINAL }
    uint8 public constant ERA5 = 0;
    uint8 public constant POWER = 1;
    uint8 public constant CHIRPS = 2;

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
    struct Outcome { bool settled; uint16 index; uint8 a; uint8 b; }
    struct Hold { uint16 share; uint64 releaseAt; uint8 signals; }

    address public immutable insurer;
    address[3] public oracles;
    Policy[] public policies;
    mapping(uint8 => uint256[]) private byDistrict;
    // season => stage => district => source => report
    mapping(uint16 => mapping(Stage => mapping(uint8 => Report[3]))) private reports;
    mapping(uint16 => mapping(Stage => mapping(uint8 => Outcome))) public outcomes;
    // season => policy id => share of cover already paid (per mille)
    mapping(uint16 => mapping(uint256 => uint16)) public paidShare;
    mapping(address => uint256) public owed;
    // season => stage => district => payout waiting out its challenge period
    mapping(uint16 => mapping(Stage => mapping(uint8 => Hold))) public holds;
    // sponsor money set aside for each district, not yet used
    mapping(uint8 => uint256) public sponsored;

    event PolicyIssued(uint256 indexed id, address indexed farmer, uint8 indexed district, uint128 cover);
    event Reported(uint16 indexed season, Stage stage, uint8 indexed district, uint8 source, uint16 dryness, uint16 guard, bytes32 dataHash);
    event AwaitingTieBreak(uint16 indexed season, Stage stage, uint8 indexed district, uint16 era5, uint16 power);
    event Settled(uint16 indexed season, Stage stage, uint8 indexed district, uint16 index, uint16 gap, uint16 share, uint256 farmers, uint256 total, uint8 a, uint8 b);
    event SourcesDisagree(uint16 indexed season, Stage stage, uint8 indexed district, uint16 era5, uint16 power, uint16 chirps);
    event Witness(uint16 indexed season, Stage stage, uint8 indexed district, uint16 chirps, bool agrees);
    event Paid(uint16 indexed season, uint256 indexed id, address indexed farmer, uint256 amount);
    event Held(uint16 indexed season, uint256 indexed id, address indexed farmer, uint256 amount);
    event PayoutHeld(uint16 indexed season, Stage stage, uint8 indexed district, uint16 share, uint8 signals, uint64 releaseAt);
    event PayoutReleased(uint16 indexed season, Stage stage, uint8 indexed district);
    event PayoutRejected(uint16 indexed season, Stage stage, uint8 indexed district);
    event Sponsored(address indexed sponsor, uint8 indexed district, uint256 amount);
    event SponsorFundsUsed(uint16 indexed season, uint8 indexed district, uint256 amount);
    event Sealed(bytes32 indexed what, uint16 indexed season, uint8 district, uint16 value, bytes32 dataHash, address by, uint64 at);

    error NotInsurer();
    error NotOracle();
    error NotAllowed();
    error AlreadyReported();
    error AlreadySettled();
    error BadReading();
    error PoolTooSmall(uint256 needed, uint256 available);
    error NothingHeld();
    error ChallengeOpen(uint64 releaseAt);
    error ChallengeClosed();
    error NeedsTwoSignals();

    constructor(address era5Oracle, address powerOracle, address chirpsOracle) {
        insurer = msg.sender;
        oracles = [era5Oracle, powerOracle, chirpsOracle];
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

    /// @notice A sponsor pays into one district's pool, for example to keep El Niño-year premiums affordable.
    function sponsor(uint8 district) external payable {
        sponsored[district] += msg.value;
        emit Sponsored(msg.sender, district, msg.value);
    }

    /// @notice Puts a forecast or reading on the public record, timestamped, before anyone knows the outcome.
    function seal(bytes32 what, uint16 season, uint8 district, uint16 value, bytes32 dataHash) external {
        if (msg.sender != insurer && msg.sender != oracles[0] && msg.sender != oracles[1] && msg.sender != oracles[2]) revert NotAllowed();
        emit Sealed(what, season, district, value, dataHash, msg.sender, uint64(block.timestamp));
    }

    /// @notice An oracle posts its record's reading and its data guard's verdict.
    function report(uint16 season, Stage stage, uint8 district, uint16 dryness, uint16 guard, bytes32 dataHash) external {
        uint8 source = msg.sender == oracles[0] ? 0 : msg.sender == oracles[1] ? 1 : msg.sender == oracles[2] ? 2 : 3;
        if (source == 3) revert NotOracle();
        if (dryness > 1000 || dataHash == bytes32(0)) revert BadReading();
        Outcome storage o = outcomes[season][stage][district];
        // CHIRPS arrives weeks later, so it may still post after a checkpoint has settled: as a witness.
        if (o.settled && source != CHIRPS) revert AlreadySettled();
        Report[3] storage r = reports[season][stage][district];
        if (r[source].posted) revert AlreadyReported();
        r[source] = Report(dryness, guard, dataHash, true);
        emit Reported(season, stage, district, source, dryness, guard, dataHash);

        if (o.settled) return _witness(season, stage, district, o.index, dryness);
        if (!(r[0].posted && r[1].posted)) return;
        if (_gap(r[0].dryness, r[1].dryness) <= MAX_GAP) return _settle(season, stage, district, ERA5, POWER);
        if (!r[2].posted) {
            if (source != CHIRPS) emit AwaitingTieBreak(season, stage, district, r[0].dryness, r[1].dryness);
            return;
        }
        // ERA5 and NASA disagree: CHIRPS breaks the tie.
        uint16 g0 = _gap(r[0].dryness, r[2].dryness);
        uint16 g1 = _gap(r[1].dryness, r[2].dryness);
        if (g0 > MAX_GAP && g1 > MAX_GAP) {
            o.settled = true;
            emit SourcesDisagree(season, stage, district, r[0].dryness, r[1].dryness, r[2].dryness);
            emit Settled(season, stage, district, 0, _gap(r[0].dryness, r[1].dryness), 0, 0, 0, 0, 0);
            return;
        }
        _settle(season, stage, district, g0 <= MAX_GAP && (g0 <= g1 || g1 > MAX_GAP) ? ERA5 : POWER, CHIRPS);
    }

    function _settle(uint16 season, Stage stage, uint8 district, uint8 a, uint8 b) private {
        Report[3] storage r = reports[season][stage][district];
        uint16 index = (r[a].dryness + r[b].dryness) / 2;
        outcomes[season][stage][district] = Outcome(true, index, a, b);
        uint16 share = shareDue(stage, index);
        uint8 flags = (r[a].guard > FLAG_AT ? 1 : 0) + (r[b].guard > FLAG_AT ? 1 : 0);
        // CHIRPS already in, but not deciding: it is a witness to this decision.
        bool dissent = b != CHIRPS && r[CHIRPS].posted && _gap(r[CHIRPS].dryness, index) > MAX_GAP;
        if (b != CHIRPS && r[CHIRPS].posted) emit Witness(season, stage, district, r[CHIRPS].dryness, !dissent);
        if (share > 0 && flags > 0) {
            uint64 releaseAt = uint64(block.timestamp) + CHALLENGE_PERIOD;
            uint8 signals = flags + (dissent ? 1 : 0);
            holds[season][stage][district] = Hold(share, releaseAt, signals);
            emit PayoutHeld(season, stage, district, share, signals, releaseAt);
            emit Settled(season, stage, district, index, _gap(r[a].dryness, r[b].dryness), share, 0, 0, a, b);
            return;
        }
        (uint256 n, uint256 total) = _pay(season, district, share);
        emit Settled(season, stage, district, index, _gap(r[a].dryness, r[b].dryness), share, n, total, a, b);
    }

    // CHIRPS arriving after the decision: logged, and counted as a signal against a payout that's on hold.
    function _witness(uint16 season, Stage stage, uint8 district, uint16 index, uint16 chirps) private {
        bool agrees = _gap(chirps, index) <= MAX_GAP;
        emit Witness(season, stage, district, chirps, agrees);
        Hold storage h = holds[season][stage][district];
        if (!agrees && h.share > 0 && block.timestamp < h.releaseAt) h.signals += 1;
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

    /// @notice During the challenge period, the insurer can reject a held payout if there are two signals against it:
    /// both deciding readings flagged by the data guard, or one flagged and CHIRPS disagreeing. It's logged publicly.
    function reject(uint16 season, Stage stage, uint8 district) external {
        if (msg.sender != insurer) revert NotInsurer();
        Hold memory h = holds[season][stage][district];
        if (h.share == 0) revert NothingHeld();
        if (block.timestamp >= h.releaseAt) revert ChallengeClosed();
        if (h.signals < 2) revert NeedsTwoSignals();
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
        // Sponsor money for this district is used first, and logged against this district and season.
        uint256 fromSponsors = total < sponsored[district] ? total : sponsored[district];
        if (fromSponsors > 0) {
            sponsored[district] -= fromSponsors;
            emit SponsorFundsUsed(season, district, fromSponsors);
        }
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

    function readings(uint16 season, Stage stage, uint8 district) external view returns (Report memory era5, Report memory power, Report memory chirps) {
        Report[3] storage r = reports[season][stage][district];
        return (r[0], r[1], r[2]);
    }

    function policyCount() external view returns (uint256) {
        return policies.length;
    }

    function districtPolicies(uint8 district) external view returns (uint256[] memory) {
        return byDistrict[district];
    }

    function _gap(uint16 a, uint16 b) private pure returns (uint16) {
        return a > b ? a - b : b - a;
    }
}
