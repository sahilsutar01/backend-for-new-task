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

// MongoDB connection
mongoose.connect(
  "mongodb+srv://sahilsutar200412:password1234@cluster0.blclafw.mongodb.net/Web3",
  { useNewUrlParser: true, useUnifiedTopology: true }
);

/* ---------- SCHEMAS ---------- */
const walletSchema = new mongoose.Schema({
  name: { type: String, unique: true, required: true },
  address: { type: String, required: true },
  privateKey: { type: String, required: true },
  // Mnemonic is crucial for recovery
  mnemonic: { type: String, required: true },
  passwordHash: { type: String, required: true },
});

const txSchema = new mongoose.Schema({
  hash: { type: String, unique: true, required: true },
  from: String,
  to: String,
  amount: String,
  tokenName: String,
  blockNumber: Number,
  status: String,
  timestamp: Date,
});

const contactSchema = new mongoose.Schema({
  walletAddress: { type: String, required: true, index: true },
  contactName: { type: String, required: true },
  contactAddress: { type: String, required: true },
});

const Wallet = mongoose.model("Wallet", walletSchema);
const TxLog = mongoose.model("TxLog", txSchema);
const Contact = mongoose.model("Contact", contactSchema);

/* ---------- PROVIDER + CONFIG ---------- */
const provider = new JsonRpcProvider("https://bsc-testnet-dataseed.bnbchain.org");
const USDT_CONTRACT_ADDRESS = "0x787A697324dbA4AB965C58CD33c13ff5eeA6295F";
const USDC_CONTRACT_ADDRESS = "0x342e3aA1248AB77E319e3331C6fD3f1F2d4B36B1";
const ERC20_ABI = [ "event Transfer(address indexed from, address indexed to, uint256 value)", "function decimals() view returns (uint8)" ];
const erc20Interface = new Interface(ERC20_ABI);

/* ---------- API ENDPOINTS ---------- */

// Wallets
app.post("/api/wallet", async (req, res) => {
    try {
        const { name, address, privateKey, mnemonic, password } = req.body;
        if (!name?.trim() || !password?.trim()) return res.status(400).json({ error: "Name & password required" });
        const passwordHash = await bcrypt.hash(password, 12);
        await new Wallet({ name, address, privateKey, mnemonic, passwordHash }).save();
        res.status(201).json({ message: "Wallet saved!" });
    } catch (err) {
        if (err.code === 11000) return res.status(409).json({ error: "Wallet name already exists" });
        console.error(err);
        res.status(500).json({ error: "Server error during wallet creation" });
    }
});

app.post("/api/wallet/:name", async (req, res) => {
    try {
        const { name } = req.params;
        const { password } = req.body;
        const wallet = await Wallet.findOne({ name });
        if (!wallet) return res.status(404).json({ error: "Wallet not found" });
        const isPasswordCorrect = await bcrypt.compare(password, wallet.passwordHash);
        if (!isPasswordCorrect) return res.status(401).json({ error: "Invalid password" });
        const { passwordHash, ...walletData } = wallet.toObject();
        res.json(walletData);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error while fetching wallet" });
    }
});

// ==================================================================
// ========= NEW ENDPOINT FOR PASSWORD RESET ========================
// ==================================================================
app.put("/api/wallet/reset-password", async (req, res) => {
    try {
        const { name, mnemonic, newPassword } = req.body;

        if (!name || !mnemonic || !newPassword) {
            return res.status(400).json({ error: "Wallet name, mnemonic, and new password are required." });
        }

        // 1. Find the wallet by its name
        const wallet = await Wallet.findOne({ name });
        if (!wallet) {
            return res.status(404).json({ error: "Wallet not found." });
        }

        // 2. IMPORTANT: Verify the provided mnemonic phrase matches the one in the database
        if (wallet.mnemonic !== mnemonic.trim()) {
            return res.status(401).json({ error: "The provided Mnemonic Phrase is incorrect." });
        }

        // 3. Hash the new password and update the wallet document
        const newPasswordHash = await bcrypt.hash(newPassword, 12);
        wallet.passwordHash = newPasswordHash;
        await wallet.save();

        res.status(200).json({ message: "Password has been reset successfully. You can now log in." });

    } catch (err) {
        console.error("Error during password reset:", err);
        res.status(500).json({ error: "An internal server error occurred." });
    }
});


// Transactions (Manual Logging)
app.post("/api/tx/:hash", async (req, res) => {
    try {
        const { hash } = req.params;
        const existingTx = await TxLog.findOne({ hash });
        if(existingTx) return res.status(200).json({message: "Tx already logged."});

        const receipt = await provider.getTransactionReceipt(hash);
        if (!receipt) return res.status(404).json({ error: "Transaction not yet mined" });

        const block = await provider.getBlock(receipt.blockNumber);
        const tx = await provider.getTransaction(hash);
        
        let amountStr = "0", tokenName = "", actualTo = receipt.to; 

        if (tx.data === "0x") {
            amountStr = formatEther(tx.value);
            tokenName = "BNB";
        } else {
            const transferEventTopic = erc20Interface.getEvent("Transfer").topicHash;
            const tokenLog = receipt.logs.find(log => log.topics[0] === transferEventTopic);
            if (tokenLog) {
                const parsedLog = erc20Interface.parseLog(tokenLog);
                actualTo = parsedLog.args.to;
                const tokenContract = new Contract(tokenLog.address, ERC20_ABI, provider);
                amountStr = formatUnits(parsedLog.args.value, await tokenContract.decimals());
                if (tokenLog.address.toLowerCase() === USDT_CONTRACT_ADDRESS.toLowerCase()) tokenName = "USDT";
                else if (tokenLog.address.toLowerCase() === USDC_CONTRACT_ADDRESS.toLowerCase()) tokenName = "USDC";
                else tokenName = "Unknown";
            } else {
                tokenName = "N/A";
            }
        }

        const logData = { hash: receipt.hash, from: receipt.from.toLowerCase(), to: (actualTo || receipt.to).toLowerCase(), blockNumber: receipt.blockNumber, amount: amountStr, tokenName, status: receipt.status === 1 ? "Success" : "Failed", timestamp: new Date(block.timestamp * 1000) };
        await TxLog.findOneAndUpdate({ hash }, logData, { upsert: true, new: true });
        res.status(201).json(logData);
    } catch (err) {
        console.error("Error logging transaction:", err);
        res.status(500).json({ error: "Server error logging transaction" });
    }
});

app.get("/api/history/:address", async (req, res) => {
    try {
        const { address } = req.params;
        const lowerCaseAddress = address.toLowerCase();
        const history = await TxLog.find({ $or: [{ from: lowerCaseAddress }, { to: lowerCaseAddress }] }).sort({ timestamp: -1 });
        res.json(history);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch history" });
    }
});

// Contacts
app.get("/api/contacts/:walletAddress", async (req, res) => {
  try {
    const contacts = await Contact.find({ walletAddress: req.params.walletAddress });
    res.json(contacts);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch contacts." });
  }
});

app.post("/api/contacts", async (req, res) => {
  try {
    const { walletAddress, contactName, contactAddress } = req.body;
    if (!walletAddress || !contactName || !contactAddress) return res.status(400).json({ error: "All fields are required." });
    const newContact = new Contact({ walletAddress, contactName, contactAddress });
    await newContact.save();
    res.status(201).json(newContact);
  } catch (err) {
    res.status(500).json({ error: "Failed to save contact." });
  }
});

app.delete("/api/contacts/:contactId", async (req, res) => {
  try {
    const result = await Contact.findByIdAndDelete(req.params.contactId);
    if (!result) return res.status(404).json({ error: "Contact not found." });
    res.status(200).json({ message: "Contact deleted." });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete contact." });
  }
});

/* ---------- START SERVER ---------- */
const PORT = process.env.PORT || 5000;
mongoose.connection.once('open', () => {
    console.log('✅ MongoDB connected successfully.');
    app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
});