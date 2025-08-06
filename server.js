const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcrypt");
const {
  JsonRpcProvider,
  Contract,
  Interface,
  formatEther,
  formatUnits,
} = require("ethers");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

mongoose.connect(
  "mongodb+srv://sahilsutar200412:password1234@cluster0.blclafw.mongodb.net/Web3",
  { useNewUrlParser: true, useUnifiedTopology: true }
);

/* ---------- SCHEMAS ---------- */
const walletSchema = new mongoose.Schema({
  // --- FIX: The `unique: true` property is still needed for the index to work.
  name: { type: String, unique: true, required: true },
  address: { type: String, required: true },
  privateKey: { type: String, required: true },
  mnemonic: { type: String, required: true },
  passwordHash: { type: String, required: true },
});

// --- FIX 1: ADD A CASE-INSENSITIVE UNIQUE INDEX ---
// This is the most important change. It tells MongoDB to treat "teju" and "Teju"
// as the same for uniqueness, preventing duplicates at the database level.
walletSchema.index({ name: 1 }, {
  unique: true,
  collation: {
    locale: 'en',
    strength: 2 // Level 2 strength ignores case
  }
});


const txSchema = new mongoose.Schema({
  hash: { type: String, unique: true, required: true },
  from: String, to: String, amount: String, tokenName: String, blockNumber: Number, status: String, timestamp: Date,
});

const contactSchema = new mongoose.Schema({
  walletAddress: { type: String, required: true, index: true },
  contactName: { type: String, required: true },
  contactAddress: { type: String, required: true },
});

const Wallet = mongoose.model("Wallet", walletSchema);
const TxLog = mongoose.model("TxLog", txSchema);
const Contact = mongoose.model("Contact", contactSchema);

/* ---------- PROVIDER + CONFIG (No Changes) ---------- */
const provider = new JsonRpcProvider("https://bsc-testnet-dataseed.bnbchain.org");
const USDT_CONTRACT_ADDRESS = "0x787A697324dbA4AB965C58CD33c13ff5eeA6295F";
const USDC_CONTRACT_ADDRESS = "0x342e3aA1248AB77E319e3331C6fD3f1F2d4B36B1";
const ERC20_ABI = [ "event Transfer(address indexed from, address indexed to, uint256 value)", "function decimals() view returns (uint8)", "function symbol() view returns (string)" ];
const erc20Interface = new Interface(ERC20_ABI);

/* ---------- API ENDPOINTS ---------- */

// --- FIX 2: CREATE A NEW ENDPOINT TO GET ALL WALLET NAMES ---
// The frontend will use this to quickly check for duplicates before sending a create request.
app.get("/api/wallets", async (req, res) => {
    try {
        // Only select the 'name' field for efficiency
        const wallets = await Wallet.find().select('name');
        res.status(200).json(wallets);
    } catch (error) {
        console.error("Error fetching wallet names:", error);
        res.status(500).json({ error: 'Failed to retrieve wallet list.' });
    }
});


// Wallets
app.post("/api/wallet", async (req, res) => {
    try {
        const { name, address, privateKey, mnemonic, password } = req.body;
        if (!name?.trim() || address == null || privateKey == null || mnemonic == null || password == null) {
             return res.status(400).json({ error: "Missing required wallet data." });
        }
        const passwordHash = await bcrypt.hash(password, 12);
        // The .save() will now automatically fail if the name is a case-insensitive duplicate
        await new Wallet({ name, address, privateKey, mnemonic, passwordHash }).save();
        res.status(201).json({ message: "Wallet saved!" });
    } catch (err) {
        // --- FIX 3: IMPROVED ERROR MESSAGE ---
        // This code now triggers for case-insensitive duplicates thanks to our index.
        if (err.code === 11000) {
            return res.status(409).json({ error: `A wallet with the name "${req.body.name}" already exists.` });
        }
        console.error(err);
        res.status(500).json({ error: "Server error during wallet creation" });
    }
});

app.post("/api/wallet/:name", async (req, res) => {
    try {
        const { name } = req.params;
        const { password } = req.body;
        // Use collation here as well to find "Teju" if user types "teju"
        const wallet = await Wallet.findOne({ name }).collation({ locale: 'en', strength: 2 });

        if (!wallet) {
            return res.status(404).json({ error: "Wallet not found" });
        }
        if (!wallet.passwordHash) {
            return res.status(401).json({ error: "Invalid password or corrupted wallet data." });
        }
        const isPasswordCorrect = await bcrypt.compare(password, wallet.passwordHash);
        if (!isPasswordCorrect) {
            return res.status(401).json({ error: "Invalid password" });
        }
        
        const { passwordHash, ...walletData } = wallet.toObject();
        // Send the plain password back for use in the Security tab, will be stored in frontend state
        res.json({ ...walletData, password });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error while fetching wallet" });
    }
});

// Other routes (password reset, transactions, contacts) have no changes...
app.put("/api/wallet/reset-password", async (req, res) => { try { const { name, mnemonic, newPassword } = req.body; if (!name || !mnemonic || !newPassword) return res.status(400).json({ error: "Wallet name, mnemonic, and new password are required." }); const wallet = await Wallet.findOne({ name }); if (!wallet) return res.status(404).json({ error: "Wallet not found." }); if (wallet.mnemonic !== mnemonic.trim()) return res.status(401).json({ error: "The provided Mnemonic Phrase is incorrect." }); const newPasswordHash = await bcrypt.hash(newPassword, 12); wallet.passwordHash = newPasswordHash; await wallet.save(); res.status(200).json({ message: "Password has been reset successfully. You can now log in." }); } catch (err) { console.error("Error during password reset:", err); res.status(500).json({ error: "An internal server error occurred." }); }});
app.post("/api/tx/:hash", async (req, res) => { try { const { hash } = req.params; const existingTx = await TxLog.findOne({ hash }); if(existingTx) return res.status(200).json({message: "Tx already logged."}); const receipt = await provider.getTransactionReceipt(hash); if (!receipt) return res.status(404).json({ error: "Transaction not yet mined" }); const block = await provider.getBlock(receipt.blockNumber); const tx = await provider.getTransaction(hash); let amountStr = "0", tokenName = "", actualTo = receipt.to; if (tx.data === "0x") { amountStr = formatEther(tx.value); tokenName = "BNB"; } else { const transferEventTopic = erc20Interface.getEvent("Transfer").topicHash; const tokenLog = receipt.logs.find(log => log.topics[0] === transferEventTopic); if (tokenLog) { const parsedLog = erc20Interface.parseLog(tokenLog); actualTo = parsedLog.args.to; const tokenContract = new Contract(tokenLog.address, ERC20_ABI, provider); const [decimals, symbol] = await Promise.all([tokenContract.decimals(), tokenContract.symbol()]); amountStr = formatUnits(parsedLog.args.value, decimals); tokenName = symbol; } else { tokenName = "Contract Call"; } } const logData = { hash: receipt.hash, from: receipt.from.toLowerCase(), to: (actualTo || receipt.to).toLowerCase(), blockNumber: receipt.blockNumber, amount: amountStr, tokenName, status: receipt.status === 1 ? "Success" : "Failed", timestamp: new Date(block.timestamp * 1000) }; await TxLog.findOneAndUpdate({ hash }, logData, { upsert: true, new: true }); res.status(201).json(logData); } catch (err) { console.error("Error logging transaction:", err); res.status(500).json({ error: "Server error logging transaction" }); }});
app.get("/api/history/:address", async (req, res) => { try { const { address } = req.params; const lowerCaseAddress = address.toLowerCase(); const history = await TxLog.find({ $or: [{ from: lowerCaseAddress }, { to: lowerCaseAddress }] }).sort({ timestamp: -1 }).limit(50); res.json(history); } catch (err) { res.status(500).json({ error: "Failed to fetch history" }); }});
app.get("/api/contacts/:walletAddress", async (req, res) => { try { const contacts = await Contact.find({ walletAddress: req.params.walletAddress }); res.json(contacts); } catch (err) { res.status(500).json({ error: "Failed to fetch contacts." }); }});
app.post("/api/contacts", async (req, res) => { try { const { walletAddress, contactName, contactAddress } = req.body; if (!walletAddress || !contactName || !contactAddress) return res.status(400).json({ error: "All fields are required." }); const newContact = new Contact({ walletAddress, contactName, contactAddress }); await newContact.save(); res.status(201).json(newContact); } catch (err) { res.status(500).json({ error: "Failed to save contact." }); }});
app.delete("/api/contacts/:contactId", async (req, res) => { try { const result = await Contact.findByIdAndDelete(req.params.contactId); if (!result) return res.status(404).json({ error: "Contact not found." }); res.status(200).json({ message: "Contact deleted." }); } catch (err) { res.status(500).json({ error: "Failed to delete contact." }); }});

/* ---------- START SERVER ---------- */
const PORT = process.env.PORT || 5000;
mongoose.connection.once('open', () => {
    console.log('✅ MongoDB connected successfully.');
    app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
});
