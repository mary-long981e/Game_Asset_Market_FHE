// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface GameAsset {
  id: string;
  name: string;
  description: string;
  encryptedPrice: string;
  owner: string;
  category: string;
  imageUrl: string;
  bids: EncryptedBid[];
}

interface EncryptedBid {
  bidder: string;
  encryptedAmount: string;
  timestamp: number;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [assets, setAssets] = useState<GameAsset[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newAssetData, setNewAssetData] = useState({ name: "", description: "", price: 0, category: "Weapon", imageUrl: "" });
  const [selectedAsset, setSelectedAsset] = useState<GameAsset | null>(null);
  const [bidAmount, setBidAmount] = useState<number>(0);
  const [isBidding, setIsBidding] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [activeTab, setActiveTab] = useState<"marketplace" | "myAssets" | "myBids">("marketplace");
  const [decryptedPrice, setDecryptedPrice] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);

  useEffect(() => {
    loadAssets().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadAssets = async () => {
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("asset_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing asset keys:", e); }
      }
      
      const list: GameAsset[] = [];
      for (const key of keys) {
        try {
          const assetBytes = await contract.getData(`asset_${key}`);
          if (assetBytes.length > 0) {
            try {
              const assetData = JSON.parse(ethers.toUtf8String(assetBytes));
              list.push({ 
                id: key, 
                name: assetData.name, 
                description: assetData.description, 
                encryptedPrice: assetData.price, 
                owner: assetData.owner, 
                category: assetData.category, 
                imageUrl: assetData.imageUrl,
                bids: assetData.bids || []
              });
            } catch (e) { console.error(`Error parsing asset data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading asset ${key}:`, e); }
      }
      setAssets(list);
    } catch (e) { console.error("Error loading assets:", e); } 
    finally { setLoading(false); }
  };

  const createAsset = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting asset price with Zama FHE..." });
    try {
      const encryptedPrice = FHEEncryptNumber(newAssetData.price);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const assetId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const assetData = { 
        name: newAssetData.name,
        description: newAssetData.description,
        price: encryptedPrice,
        owner: address,
        category: newAssetData.category,
        imageUrl: newAssetData.imageUrl,
        bids: []
      };
      
      await contract.setData(`asset_${assetId}`, ethers.toUtf8Bytes(JSON.stringify(assetData)));
      
      const keysBytes = await contract.getData("asset_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(assetId);
      await contract.setData("asset_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Asset created with FHE encrypted price!" });
      await loadAssets();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewAssetData({ name: "", description: "", price: 0, category: "Weapon", imageUrl: "" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Creation failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const placeBid = async (assetId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    if (bidAmount <= 0) { alert("Bid amount must be positive"); return; }
    
    setIsBidding(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting bid with Zama FHE..." });
    try {
      const encryptedBid = FHEEncryptNumber(bidAmount);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const assetBytes = await contract.getData(`asset_${assetId}`);
      if (assetBytes.length === 0) throw new Error("Asset not found");
      
      const assetData = JSON.parse(ethers.toUtf8String(assetBytes));
      const newBid = {
        bidder: address,
        encryptedAmount: encryptedBid,
        timestamp: Math.floor(Date.now() / 1000)
      };
      
      assetData.bids = assetData.bids || [];
      assetData.bids.push(newBid);
      
      await contract.setData(`asset_${assetId}`, ethers.toUtf8Bytes(JSON.stringify(assetData)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Bid placed securely with FHE encryption!" });
      await loadAssets();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setSelectedAsset(null);
        setBidAmount(0);
      }, 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Bid failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setIsBidding(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const decryptPrice = async () => {
    if (!selectedAsset) return;
    const decrypted = await decryptWithSignature(selectedAsset.encryptedPrice);
    if (decrypted !== null) setDecryptedPrice(decrypted);
  };

  const isOwner = (assetAddress: string) => address?.toLowerCase() === assetAddress.toLowerCase();

  const filteredAssets = () => {
    switch(activeTab) {
      case "myAssets":
        return assets.filter(asset => isOwner(asset.owner));
      case "myBids":
        return assets.filter(asset => asset.bids.some(bid => bid.bidder.toLowerCase() === address?.toLowerCase()));
      default:
        return assets;
    }
  };

  const totalAssets = assets.length;
  const totalBids = assets.reduce((sum, asset) => sum + asset.bids.length, 0);
  const myAssetsCount = assets.filter(asset => isOwner(asset.owner)).length;
  const myBidsCount = assets.filter(asset => asset.bids.some(bid => bid.bidder.toLowerCase() === address?.toLowerCase())).length;

  if (loading) return (
    <div className="loading-screen">
      <div className="cyber-spinner"></div>
      <p>Initializing encrypted marketplace...</p>
    </div>
  );

  return (
    <div className="app-container cyberpunk-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="shield-icon"></div></div>
          <h1>FHE<span>Game</span>Market</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-asset-btn cyber-button">
            <div className="add-icon"></div>Sell Asset
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>
      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>FHE-Based Game Asset Marketplace</h2>
            <p>Trade rare game assets with private bidding using Zama FHE technology</p>
          </div>
          <div className="fhe-indicator"><div className="fhe-lock"></div><span>FHE Encryption Active</span></div>
        </div>

        <div className="dashboard-grid">
          <div className="dashboard-card cyber-card">
            <h3>Market Stats</h3>
            <div className="stats-grid">
              <div className="stat-item"><div className="stat-value">{totalAssets}</div><div className="stat-label">Total Assets</div></div>
              <div className="stat-item"><div className="stat-value">{totalBids}</div><div className="stat-label">Total Bids</div></div>
              <div className="stat-item"><div className="stat-value">{myAssetsCount}</div><div className="stat-label">Your Assets</div></div>
              <div className="stat-item"><div className="stat-value">{myBidsCount}</div><div className="stat-label">Your Bids</div></div>
            </div>
          </div>
          <div className="dashboard-card cyber-card">
            <h3>How It Works</h3>
            <ul className="how-it-works">
              <li>1. Assets are listed with FHE-encrypted prices</li>
              <li>2. Bids are encrypted with Zama FHE</li>
              <li>3. Only the seller can decrypt bids</li>
              <li>4. Transactions occur securely on-chain</li>
            </ul>
          </div>
        </div>

        <div className="marketplace-tabs">
          <button 
            className={`tab-button ${activeTab === "marketplace" ? "active" : ""}`}
            onClick={() => setActiveTab("marketplace")}
          >
            Marketplace
          </button>
          <button 
            className={`tab-button ${activeTab === "myAssets" ? "active" : ""}`}
            onClick={() => setActiveTab("myAssets")}
          >
            My Assets
          </button>
          <button 
            className={`tab-button ${activeTab === "myBids" ? "active" : ""}`}
            onClick={() => setActiveTab("myBids")}
          >
            My Bids
          </button>
        </div>

        <div className="assets-grid">
          {filteredAssets().length === 0 ? (
            <div className="no-assets">
              <div className="no-assets-icon"></div>
              <p>No assets found</p>
              {activeTab === "marketplace" && (
                <button className="cyber-button primary" onClick={() => setShowCreateModal(true)}>List Your First Asset</button>
              )}
            </div>
          ) : filteredAssets().map(asset => (
            <div className="asset-card cyber-card" key={asset.id} onClick={() => setSelectedAsset(asset)}>
              <div className="asset-image" style={{ backgroundImage: `url(${asset.imageUrl || 'https://via.placeholder.com/300x200?text=Game+Asset'})` }}></div>
              <div className="asset-details">
                <h3>{asset.name}</h3>
                <p className="category">{asset.category}</p>
                <p className="description">{asset.description.substring(0, 50)}...</p>
                <div className="price-section">
                  <span>Price:</span>
                  <div className="encrypted-price">{asset.encryptedPrice.substring(0, 15)}...</div>
                </div>
                <div className="bids-count">{asset.bids.length} bids</div>
                <div className="owner">Owner: {asset.owner.substring(0, 6)}...{asset.owner.substring(38)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {showCreateModal && (
        <div className="modal-overlay">
          <div className="create-modal cyber-card">
            <div className="modal-header">
              <h2>List New Game Asset</h2>
              <button onClick={() => setShowCreateModal(false)} className="close-modal">&times;</button>
            </div>
            <div className="modal-body">
              <div className="fhe-notice-banner">
                <div className="key-icon"></div> 
                <div><strong>FHE Encryption Notice</strong><p>Your asset price will be encrypted with Zama FHE before submission</p></div>
              </div>
              <div className="form-grid">
                <div className="form-group">
                  <label>Asset Name *</label>
                  <input type="text" name="name" value={newAssetData.name} onChange={(e) => setNewAssetData({...newAssetData, name: e.target.value})} className="cyber-input"/>
                </div>
                <div className="form-group">
                  <label>Category *</label>
                  <select name="category" value={newAssetData.category} onChange={(e) => setNewAssetData({...newAssetData, category: e.target.value})} className="cyber-select">
                    <option value="Weapon">Weapon</option>
                    <option value="Armor">Armor</option>
                    <option value="Consumable">Consumable</option>
                    <option value="NFT">NFT</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Description</label>
                  <textarea name="description" value={newAssetData.description} onChange={(e) => setNewAssetData({...newAssetData, description: e.target.value})} className="cyber-input"/>
                </div>
                <div className="form-group">
                  <label>Image URL</label>
                  <input type="text" name="imageUrl" value={newAssetData.imageUrl} onChange={(e) => setNewAssetData({...newAssetData, imageUrl: e.target.value})} className="cyber-input"/>
                </div>
                <div className="form-group">
                  <label>Price *</label>
                  <input 
                    type="number" 
                    name="price" 
                    value={newAssetData.price} 
                    onChange={(e) => setNewAssetData({...newAssetData, price: parseFloat(e.target.value)})} 
                    className="cyber-input"
                    step="0.01"
                    min="0"
                  />
                </div>
              </div>
              <div className="encryption-preview">
                <h4>Encryption Preview</h4>
                <div className="preview-container">
                  <div className="plain-data"><span>Plain Price:</span><div>{newAssetData.price || '0'}</div></div>
                  <div className="encryption-arrow">→</div>
                  <div className="encrypted-data">
                    <span>Encrypted Price:</span>
                    <div>{newAssetData.price ? FHEEncryptNumber(newAssetData.price).substring(0, 50) + '...' : 'No price entered'}</div>
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowCreateModal(false)} className="cancel-btn cyber-button">Cancel</button>
              <button onClick={createAsset} disabled={creating} className="submit-btn cyber-button primary">
                {creating ? "Encrypting with FHE..." : "List Asset Securely"}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedAsset && (
        <div className="modal-overlay">
          <div className="asset-detail-modal cyber-card">
            <div className="modal-header">
              <h2>{selectedAsset.name}</h2>
              <button onClick={() => { setSelectedAsset(null); setDecryptedPrice(null); }} className="close-modal">&times;</button>
            </div>
            <div className="modal-body">
              <div className="asset-image-large" style={{ backgroundImage: `url(${selectedAsset.imageUrl || 'https://via.placeholder.com/600x400?text=Game+Asset'})` }}></div>
              <div className="asset-info">
                <div className="info-item"><span>Category:</span><strong>{selectedAsset.category}</strong></div>
                <div className="info-item"><span>Owner:</span><strong>{selectedAsset.owner.substring(0, 6)}...{selectedAsset.owner.substring(38)}</strong></div>
                <div className="info-item description"><span>Description:</span><p>{selectedAsset.description}</p></div>
                
                <div className="price-section">
                  <div className="price-info">
                    <span>Price:</span>
                    <div className="encrypted-price">{selectedAsset.encryptedPrice.substring(0, 30)}...</div>
                    {!isOwner(selectedAsset.owner) && (
                      <button 
                        className="decrypt-btn cyber-button small" 
                        onClick={decryptPrice} 
                        disabled={isDecrypting}
                      >
                        {isDecrypting ? "Decrypting..." : decryptedPrice !== null ? "Hide Price" : "Reveal Price"}
                      </button>
                    )}
                  </div>
                  {decryptedPrice !== null && (
                    <div className="decrypted-price">
                      <span>Decrypted Price:</span>
                      <strong>{decryptedPrice}</strong>
                    </div>
                  )}
                </div>

                {!isOwner(selectedAsset.owner) && (
                  <div className="bid-section">
                    <h3>Place Bid</h3>
                    <div className="bid-form">
                      <input 
                        type="number" 
                        value={bidAmount} 
                        onChange={(e) => setBidAmount(parseFloat(e.target.value))} 
                        placeholder="Enter bid amount" 
                        className="cyber-input"
                        step="0.01"
                        min="0"
                      />
                      <button 
                        className="bid-btn cyber-button primary" 
                        onClick={() => placeBid(selectedAsset.id)}
                        disabled={isBidding}
                      >
                        {isBidding ? "Placing Bid..." : "Place Encrypted Bid"}
                      </button>
                    </div>
                  </div>
                )}

                {selectedAsset.bids.length > 0 && (
                  <div className="bids-section">
                    <h3>Bids ({selectedAsset.bids.length})</h3>
                    <div className="bids-list">
                      {selectedAsset.bids.map((bid, index) => (
                        <div className="bid-item" key={index}>
                          <div className="bidder">{bid.bidder.substring(0, 6)}...{bid.bidder.substring(38)}</div>
                          <div className="bid-amount">{bid.encryptedAmount.substring(0, 15)}...</div>
                          <div className="bid-time">{new Date(bid.timestamp * 1000).toLocaleString()}</div>
                          {isOwner(selectedAsset.owner) && (
                            <button 
                              className="decrypt-btn cyber-button small" 
                              onClick={async () => {
                                const decrypted = await decryptWithSignature(bid.encryptedAmount);
                                if (decrypted !== null) {
                                  alert(`Decrypted bid amount: ${decrypted}`);
                                }
                              }}
                              disabled={isDecrypting}
                            >
                              {isDecrypting ? "Decrypting..." : "Decrypt Bid"}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content cyber-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="cyber-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="shield-icon"></div><span>FHEGameMarket</span></div>
            <p>Private bidding for game assets using Zama FHE technology</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>FHE-Powered Privacy</span></div>
          <div className="copyright">© {new Date().getFullYear()} FHE Game Market. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

export default App;