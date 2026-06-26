/**
 * QuantumPay - Self-Hosted USDT Gateway Backend
 * Modified for Railway deployment with Firebase storage
 */

import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ── FIREBASE ADMIN INIT ──
const firebaseConfig = {
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
  databaseURL: process.env.FIREBASE_DATABASE_URL
};
initializeApp(firebaseConfig);
const db = getDatabase();

// ── SETTINGS FROM ENV ──
const getSettings = () => ({
  publishableKey: process.env.QP_PUBLISHABLE_KEY || 'pk_live_c75b7b654d354c77a7b867d8',
  secretKey: process.env.QP_SECRET_KEY || 'sk_live_d38a4984d3254d41a0ea1c4f631fe358',
  webhookUrl: process.env.QP_WEBHOOK_URL || 'https://royalwin-api.vercel.app/api/quantumpay-webhook',
  webhookSecret: process.env.QP_WEBHOOK_SECRET || 'whsec_7c2a5f0f70804f98b661262fa88e5126',
  trc20AddressPool: (process.env.QP_ADDRESS_POOL || '').split(',').filter(Boolean).length > 0
    ? process.env.QP_ADDRESS_POOL.split(',').map(a => a.trim())
    : [
        'TY1mUfE1d6X3N9s4Hka892skLqaT92sHnQ',
        'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        'TKz6vN5n5fB1TzFzk3yDkbD82sHKqaRzN1',
        'TEvH6Lkq98WnFskSka72kdKqaP92szHnQp',
        'TX2LkqPq102ksDha82ksDkaP280sDla103'
      ],
  events: { created: true, detected: true, confirmed: true, expired: true }
});

// ── FIREBASE INVOICE HELPERS ──
async function getInvoices() {
  const snap = await db.ref('quantumpay/invoices').once('value');
  const val = snap.val();
  return val ? Object.values(val) : [];
}

async function getInvoice(id) {
  const snap = await db.ref(`quantumpay/invoices/${id}`).once('value');
  return snap.val();
}

async function saveInvoice(invoice) {
  await db.ref(`quantumpay/invoices/${invoice.id}`).set(invoice);
}

// ── WEBHOOK DISPATCHER ──
async function dispatchWebhook(eventType, invoice) {
  const settings = getSettings();
  if (!settings.webhookUrl) return;

  const payload = JSON.stringify({
    id: 'evt_' + crypto.randomBytes(8).toString('hex'),
    object: 'event',
    type: eventType,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: invoice.id,
        amount: invoice.amount,
        currency: 'USDT',
        network: invoice.network,
        depositAddress: invoice.address,
        status: invoice.status,
        customerReference: invoice.ref,
        transactionHash: invoice.txHash,
        confirmations: invoice.confirmations
      }
    }
  }, null, 2);

  const timestamp = Math.floor(Date.now() / 1000);
  const hmac = crypto.createHmac('sha256', settings.webhookSecret);
  hmac.update(`${timestamp}.${payload}`);
  const signature = hmac.digest('hex');

  try {
    const response = await fetch(settings.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'QuantumPay-Signature': `t=${timestamp},v1=${signature}`
      },
      body: payload
    });
    console.log(`[Webhook] ${eventType} → HTTP ${response.status}`);
  } catch (err) {
    console.error(`[Webhook] Failed: ${err.message}`);
  }
}

// ── ADDRESS POOL ALLOCATOR ──
async function allocateDepositAddress(invoiceId) {
  const settings = getSettings();
  const pool = settings.trc20AddressPool;
  const invoices = await getInvoices();
  const now = Date.now();

  const busyAddresses = invoices
    .filter(inv => inv.status === 'pending' && inv.network === 'tron' && new Date(inv.expiresAt).getTime() > now && inv.id !== invoiceId)
    .map(inv => inv.address);

  for (const addr of pool) {
    if (!busyAddresses.includes(addr)) return addr;
  }
  return pool[0];
}

// ── API ROUTES ──

// Get all invoices
app.get('/api/invoices', async (req, res) => {
  try {
    const invoices = await getInvoices();
    res.json(invoices.sort((a, b) => new Date(b.date) - new Date(a.date)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Create invoice
app.post('/api/invoices', async (req, res) => {
  try {
    const { amount, ref, expiryMinutes } = req.body;
    if (!amount || isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'Valid amount required.' });

    const invoiceId = 'INV-' + Math.floor(100000 + Math.random() * 900000);
    const minutes = expiryMinutes || 15;

    const invoice = {
      id: invoiceId,
      date: new Date().toISOString(),
      amount: parseFloat(amount),
      ref: ref || 'REF-' + Math.floor(1000 + Math.random() * 9000),
      network: 'tron',
      status: 'pending',
      address: '',
      expiresAt: new Date(Date.now() + minutes * 60 * 1000).toISOString(),
      txHash: null,
      confirmations: 0
    };

    invoice.address = await allocateDepositAddress(invoiceId);
    await saveInvoice(invoice);
    dispatchWebhook('invoice.created', invoice);
    res.status(201).json(invoice);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get invoice by ID
app.get('/api/invoices/:id', async (req, res) => {
  try {
    const invoice = await getInvoice(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
    res.json(invoice);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Simulate pay (dev tool)
app.post('/api/invoices/:id/simulate-pay', async (req, res) => {
  try {
    const { status, confirmations, txHash } = req.body;
    const invoice = await getInvoice(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });

    invoice.status = status;
    invoice.confirmations = confirmations || 0;
    if (txHash) invoice.txHash = txHash;
    await saveInvoice(invoice);

    if (status === 'detected') dispatchWebhook('payment.detected', invoice);
    else if (status === 'completed') dispatchWebhook('payment.confirmed', invoice);
    else if (status === 'expired') dispatchWebhook('invoice.expired', invoice);

    res.json(invoice);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get settings (for dashboard)
app.get('/api/settings', (req, res) => {
  const s = getSettings();
  res.json({ ...s, secretKey: '***hidden***' });
});

// Save settings (update webhook URL only — other settings via env vars)
app.post('/api/settings', (req, res) => {
  res.json({ message: 'Settings are managed via Railway environment variables.' });
});

// ── BLOCKCHAIN SCANNER ──
async function scanTRONBlockchain() {
  try {
    const invoices = await getInvoices();
    const now = Date.now();
    const pending = invoices.filter(inv => inv.status === 'pending' && inv.network === 'tron' && new Date(inv.expiresAt).getTime() > now);
    if (pending.length === 0) return;

    console.log(`[Scanner] Checking ${pending.length} pending invoices...`);

    for (const invoice of pending) {
      try {
        const url = `https://api.trongrid.io/v1/accounts/${invoice.address}/transactions/trc20?limit=5&contract_address=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`;
        const response = await fetch(url);
        const json = await response.json();
        if (!json?.data?.length) continue;

        for (const tx of json.data) {
          const txAmount = parseFloat(tx.value) / 1e6;
          const txTime = tx.block_timestamp;
          const invoiceTime = new Date(invoice.date).getTime();

          if (tx.to === invoice.address && Math.abs(txAmount - invoice.amount) < 0.01 && txTime > invoiceTime) {
            console.log(`[Scanner] MATCH: ${tx.transaction_id} — ₹${txAmount} USDT`);
            const updated = { ...invoice, status: 'completed', confirmations: 3, txHash: tx.transaction_id };
            await saveInvoice(updated);
            dispatchWebhook('payment.confirmed', updated);
            break;
          }
        }
      } catch(e) { console.error(`[Scanner] Error: ${e.message}`); }
    }
  } catch(e) { console.error(`[Scanner] Fatal: ${e.message}`); }
}

// Auto-expire invoices
async function checkExpiredInvoices() {
  try {
    const invoices = await getInvoices();
    const now = Date.now();
    for (const inv of invoices) {
      if (inv.status === 'pending' && new Date(inv.expiresAt).getTime() < now) {
        const updated = { ...inv, status: 'expired' };
        await saveInvoice(updated);
        dispatchWebhook('invoice.expired', updated);
        console.log(`[Timer] Invoice ${inv.id} expired.`);
      }
    }
  } catch(e) { console.error(`[Timer] Error: ${e.message}`); }
}

setInterval(scanTRONBlockchain, 10000);
setInterval(checkExpiredInvoices, 30000);

app.listen(PORT, () => {
  console.log(`QuantumPay Gateway running on port ${PORT}`);
});
