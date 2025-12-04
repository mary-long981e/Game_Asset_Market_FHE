pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";


contract GameAssetMarketFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error BatchNotClosed();
    error InvalidParameter();
    error ReplayDetected();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();
    error InvalidBatchId();

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Bid {
        euint32 encryptedBidAmount;
        address bidder;
    }

    struct Batch {
        uint256 id;
        bool isOpen;
        uint256 closeTimestamp;
        Bid[] bids;
    }

    uint256 public currentBatchId;
    mapping(uint256 => Batch) public batches;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PauseToggled(bool paused);
    event CooldownSecondsChanged(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId, uint256 timestamp);
    event BatchClosed(uint256 indexed batchId, uint256 timestamp);
    event BidSubmitted(address indexed bidder, uint256 indexed batchId, uint256 timestamp);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256[] winningBidAmounts);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionRequestCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        cooldownSeconds = 60; 
        currentBatchId = 0;
        FHE.init();
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        delete isProvider[provider];
        emit ProviderRemoved(provider);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PauseToggled(_paused);
    }

    function setCooldownSeconds(uint256 _cooldownSeconds) external onlyOwner {
        if (_cooldownSeconds == 0) revert InvalidParameter();
        uint256 oldCooldownSeconds = cooldownSeconds;
        cooldownSeconds = _cooldownSeconds;
        emit CooldownSecondsChanged(oldCooldownSeconds, _cooldownSeconds);
    }

    function openBatch() external onlyProvider whenNotPaused {
        if (batches[currentBatchId].isOpen) {
            currentBatchId++;
        }
        batches[currentBatchId] = Batch({
            id: currentBatchId,
            isOpen: true,
            closeTimestamp: 0,
            bids: new Bid[](0)
        });
        emit BatchOpened(currentBatchId, block.timestamp);
    }

    function closeBatch() external onlyProvider whenNotPaused {
        if (!batches[currentBatchId].isOpen) revert BatchClosed();
        batches[currentBatchId].isOpen = false;
        batches[currentBatchId].closeTimestamp = block.timestamp;
        emit BatchClosed(currentBatchId, block.timestamp);
    }

    function submitBid(euint32 encryptedBidAmount) external payable whenNotPaused checkSubmissionCooldown {
        if (currentBatchId == 0 || !batches[currentBatchId].isOpen) revert BatchClosed();
        lastSubmissionTime[msg.sender] = block.timestamp;

        batches[currentBatchId].bids.push(Bid({
            encryptedBidAmount: encryptedBidAmount,
            bidder: msg.sender
        }));
        emit BidSubmitted(msg.sender, currentBatchId, block.timestamp);
    }

    function requestWinningBidDecryption(uint256 batchId) external onlyProvider whenNotPaused checkDecryptionRequestCooldown {
        if (batchId >= currentBatchId || batches[batchId].isOpen) revert BatchNotClosed();
        if (batches[batchId].bids.length == 0) revert InvalidBatchId();

        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        Batch storage batch = batches[batchId];
        uint256 numBids = batch.bids.length;
        euint32[] memory encryptedWinningBidAmounts = new euint32[](numBids);

        euint32 memory currentMaxBid = FHE.asEuint32(0);
        for (uint256 i = 0; i < numBids; i++) {
            euint32 memory bid = batch.bids[i].encryptedBidAmount;
            ebool memory isGreater = bid.ge(currentMaxBid);
            currentMaxBid = bid.select(currentMaxBid, isGreater);
            encryptedWinningBidAmounts[i] = currentMaxBid;
        }

        bytes32[] memory cts = new bytes32[](numBids);
        for (uint256 i = 0; i < numBids; i++) {
            cts[i] = encryptedWinningBidAmounts[i].toBytes32();
        }

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: batchId,
            stateHash: stateHash,
            processed: false
        });

        emit DecryptionRequested(requestId, batchId, stateHash);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayDetected();

        DecryptionContext memory ctx = decryptionContexts[requestId];
        Batch storage batch = batches[ctx.batchId];
        uint256 numBids = batch.bids.length;

        bytes32[] memory cts = new bytes32[](numBids);
        for (uint256 i = 0; i < numBids; i++) {
            cts[i] = batch.bids[i].encryptedBidAmount.toBytes32();
        }
        bytes32 currentHash = _hashCiphertexts(cts);

        if (currentHash != ctx.stateHash) {
            revert StateMismatch();
        }
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert InvalidProof();
        }

        uint256[] memory winningBidAmounts = new uint256[](numBids);
        for (uint256 i = 0; i < numBids; i++) {
            winningBidAmounts[i] = abi.decode(cleartexts, (uint32));
            cleartexts = cleartexts[32:];
        }

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, ctx.batchId, winningBidAmounts);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded() internal {
        if (!FHE.isInitialized()) {
            FHE.init();
        }
    }

    function _requireInitialized() internal view {
        if (!FHE.isInitialized()) {
            revert NotInitialized();
        }
    }
}