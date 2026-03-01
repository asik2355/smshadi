import express from "express";
import { createServer as createViteServer } from "vite";
import axios from "axios";
import cron from "node-cron";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import fs from "fs";
import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, onSnapshot, setDoc } from "firebase/firestore";

dotenv.config();

const firebaseConfig = {
  apiKey: "AIzaSyASAcKEfd7kyD2-9bkBgM2bAgizLRnjm0U",
  authDomain: "hadisms1.firebaseapp.com",
  projectId: "hadisms1",
  storageBucket: "hadisms1.firebasestorage.app",
  messagingSenderId: "677965460336",
  appId: "1:677965460336:web:3219197a3375f2d53c15b5",
  measurementId: "G-NTGEBLYEY5"
};

const firebaseApp = initializeApp(firebaseConfig);
const firestore = getFirestore(firebaseApp);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// CORS Middleware for Mobile Admin
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

const db = new Database("messages.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS processed_messages (id TEXT PRIMARY KEY, number TEXT, service TEXT, otp TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS bot_users (id INTEGER PRIMARY KEY, username TEXT, first_name TEXT, last_seen DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS numbers (id INTEGER PRIMARY KEY AUTOINCREMENT, number TEXT, service TEXT, country TEXT, status TEXT DEFAULT 'available', assigned_to INTEGER, file_id TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS uploaded_files (id TEXT PRIMARY KEY, filename TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP);
`);

let config: any = {
  CR_API_TOKEN: "RlNYRjRSQkNrTnBXeISLioBgdlNXlmVpVHGBQ2KKckaBcmJUglFs",
  CR_API_URL: "http://147.135.212.197/crapi/had/viewstats",
  TELEGRAM_BOT_TOKEN: "8565057887:AAH1Wc2e3Ix-PNI_yS6-ZqPWkcIs5EbJXWs",
  NUMBER_BOT_TOKEN: "8332473503:AAEjdM9IEXMuuwGfOGUgBp5zpP54EoiIsVg",
  ADMIN_ID: 8197284774,
  POLLING_ENABLED: true,
  POLLING_INTERVAL: 60000,
  UI_EMOJIS: { header: "5424972470023104089", time: "5147657255037961755", country: "5447410659077661506", service: "5397733817496647230", number: "5282843764451195532", otp: "5397731992135545615", message: "5443038326535759644", footer: "5796504875047063769" },
  UI_LABELS: { header: "OTP RECEIVED", time: "Time", country: "Country", service: "Service", number: "Number", otp: "OTP", message: "Full Message", footer: "POWERED BY DXA UNIVERSE" }
};

// Track current tokens to detect changes
let currentNumberToken = "";

// User State Management
const userStates = new Map<number, any>();

// Number Bot Logic
async function handleNumberBot() {
  let lastUpdateId = 0;

  async function getUpdates() {
    const token = config.NUMBER_BOT_TOKEN || "8332473503:AAEjdM9IEXMuuwGfOGUgBp5zpP54EoiIsVg";
    
    if (token !== currentNumberToken) {
      console.log(`🤖 Switching Number Bot to new token: ${token.substring(0, 10)}...`);
      currentNumberToken = token;
      lastUpdateId = 0; 
    }

    try {
      const response = await axios.get(`https://api.telegram.org/bot${token}/getUpdates`, {
        params: { offset: lastUpdateId + 1, timeout: 30 }
      });
      const updates = response.data.result;
      for (const update of updates) {
        lastUpdateId = update.update_id;
        if (update.message) await processMessage(update.message);
        if (update.callback_query) await processCallback(update.callback_query);
      }
    } catch (error: any) {
      if (error.response?.status === 401) console.error("❌ Number Bot Token is Invalid");
    }
    setTimeout(getUpdates, 1000);
  }

  async function processMessage(msg: any) {
    const chatId = msg.chat.id;
    const text = msg.text;
    const adminId = config.ADMIN_ID || 8197284774;
    const isAdmin = chatId === adminId;
    const token = config.NUMBER_BOT_TOKEN;

    db.prepare("INSERT OR REPLACE INTO bot_users (id, username, first_name) VALUES (?, ?, ?)").run(chatId, msg.from.username, msg.from.first_name);

    if (text === "/start" || text === "🔙 Back") {
      userStates.delete(chatId);
      const buttons = [["📱 Get Number", "📢 Channel"]];
      if (isAdmin) buttons.push(["🛠 Admin Panel"]);
      
      const welcomeText = `<b>Welcome to DXA Number Bot!</b>\n\nSelect an option below:`;
      await sendBotMessage(chatId, welcomeText, buttons);
      return;
    }

    if (isAdmin && text === "🛠 Admin Panel") {
      await sendAdminPanel(chatId);
      return;
    }

    if (text === "📱 Get Number") {
      await sendInlineServiceSelection(chatId);
      return;
    }

    if (isAdmin && msg.document && msg.document.file_name.endsWith(".txt")) {
      const state = userStates.get(chatId);
      if (state?.action === "uploading_numbers") {
        const fileId = msg.document.file_id;
        try {
          const fileResponse = await axios.get(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
          const filePath = fileResponse.data.result.file_path;
          const downloadResponse = await axios.get(`https://api.telegram.org/file/bot${token}/${filePath}`);
          const numbers = downloadResponse.data.split(/\r?\n/).filter((n: string) => n.trim().length > 0);
          userStates.set(chatId, { action: "awaiting_service_for_upload", numbers, fileName: msg.document.file_name, fileId });
          await sendBotMessage(chatId, `📂 <b>File received:</b> ${numbers.length} numbers found.\n\n✍️ Please <b>type</b> the service name:`, [["🔙 Back"]]);
        } catch (e) {
          await sendBotMessage(chatId, "❌ Error processing file.", [["🔙 Back"]]);
        }
        return;
      }
    }

    const state = userStates.get(chatId);
    if (isAdmin && state?.action === "awaiting_service_for_upload") {
      userStates.set(chatId, { ...state, action: "awaiting_country_for_upload", service: text });
      await sendBotMessage(chatId, `✅ <b>Service:</b> ${text}\n\n✍️ Please <b>type</b> the country name:`, [["🔙 Back"]]);
      return;
    }

    if (isAdmin && state?.action === "awaiting_country_for_upload") {
      const { numbers, service, fileName, fileId } = state;
      db.prepare("INSERT INTO uploaded_files (id, filename) VALUES (?, ?)").run(fileId, fileName);
      const insert = db.prepare("INSERT INTO numbers (number, service, country, file_id) VALUES (?, ?, ?, ?)");
      const transaction = db.transaction((nums) => {
        for (const num of nums) insert.run(num, service, text, fileId);
      });
      transaction(numbers);
      userStates.delete(chatId);
      await sendBotMessage(chatId, `✅ <b>Successfully Uploaded!</b>\n\nTotal: ${numbers.length}`, [["🛠 Admin Panel"], ["🔙 Back"]]);
      return;
    }
  }

  async function processCallback(cb: any) {
    const chatId = cb.message.chat.id;
    const data = cb.data;
    const token = config.NUMBER_BOT_TOKEN;

    if (data === "main_menu") {
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId, text: "Select an option:",
        reply_markup: { keyboard: [["📱 Get Number"], ["🔙 Back"]], resize_keyboard: true }
      });
      return;
    }

    if (data.startsWith("svc_")) {
      await sendInlineCountrySelection(chatId, data.replace("svc_", ""));
      return;
    }

    if (data.startsWith("get_")) {
      const [_, service, country] = data.split("_");
      await handleNumberAssignment(chatId, service, country);
      return;
    }

    if (data === "admin_upload") {
      userStates.set(chatId, { action: "uploading_numbers" });
      await sendBotMessage(chatId, "Please upload a .txt file.", [["🔙 Back"]]);
    }
  }

  async function sendInlineServiceSelection(chatId: number) {
    const token = config.NUMBER_BOT_TOKEN;
    const dbServices = db.prepare("SELECT DISTINCT service FROM numbers WHERE status = 'available'").all();
    if (dbServices.length === 0) {
      await sendBotMessage(chatId, "❌ No numbers available.", [["🔙 Back"]]);
      return;
    }
    const keyboard = { inline_keyboard: dbServices.map(s => [{ text: `⚙️ ${s.service}`, callback_data: `svc_${s.service}` }]) };
    keyboard.inline_keyboard.push([{ text: "🔙 Back", callback_data: "main_menu" }]);
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text: "✨ <b>Select Service:</b>", parse_mode: "HTML", reply_markup: keyboard });
  }

  async function sendInlineCountrySelection(chatId: number, service: string) {
    const token = config.NUMBER_BOT_TOKEN;
    const dbCountries = db.prepare("SELECT DISTINCT country FROM numbers WHERE service = ? AND status = 'available'").all(service);
    const keyboard = { inline_keyboard: dbCountries.map(c => [{ text: `🌍 ${c.country}`, callback_data: `get_${service}_${c.country}` }]) };
    keyboard.inline_keyboard.push([{ text: "🔙 Back", callback_data: "main_menu" }]);
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text: `🌍 <b>Select Country for ${service}:</b>`, parse_mode: "HTML", reply_markup: keyboard });
  }

  async function handleNumberAssignment(chatId: number, service: string, country: string) {
    const token = config.NUMBER_BOT_TOKEN;
    const num = db.prepare("SELECT * FROM numbers WHERE service = ? AND country = ? AND status = 'available' LIMIT 1").get(service, country);
    if (!num) {
      await sendBotMessage(chatId, `❌ No numbers available.`, [["🔙 Back"]]);
      return;
    }
    db.prepare("UPDATE numbers SET status = 'used', assigned_to = ? WHERE id = ?").run(chatId, num.id);
    const text = `📱 <b>Your Number:</b> <code>${num.number}</code>\n🌍 <b>Country:</b> ${num.country}\n⚙️ <b>Service:</b> ${num.service}`;
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text: text, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "main_menu" }]] } });
  }

  async function sendAdminPanel(chat_id: number) {
    const token = config.NUMBER_BOT_TOKEN;
    const keyboard = { inline_keyboard: [[{ text: "📤 Upload Numbers", callback_data: "admin_upload" }], [{ text: "📊 Statistics", callback_data: "admin_stats" }]] };
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chat_id, text: "🛠 <b>Admin Panel</b>", parse_mode: "HTML", reply_markup: keyboard });
  }

  async function sendBotMessage(chatId: number, text: string, buttons: string[][]) {
    const token = config.NUMBER_BOT_TOKEN;
    const keyboard = { keyboard: buttons.map(row => row.map(btn => ({ text: btn }))), resize_keyboard: true };
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text: text, parse_mode: "HTML", reply_markup: keyboard });
  }

  getUpdates();
}

// Listen for config changes in Firebase
onSnapshot(doc(firestore, "settings", "botConfig"), (snapshot) => {
  if (snapshot.exists()) {
    const data = snapshot.data();
    config = { ...config, ...data };
    botStatus.isPolling = config.POLLING_ENABLED;
    console.log("✅ Config updated from Firebase");
  }
});

// Helper to get emoji tag
function getEmojiTag(emojiId: string, fallback: string) {
  if (!emojiId) return fallback;
  if (/^\d+$/.test(emojiId)) return `<tg-emoji emoji-id="${emojiId}">${fallback}</tg-emoji>`;
  return emojiId;
}

// Update bot status to Firebase every 30 seconds
setInterval(async () => {
  try {
    await setDoc(doc(firestore, "status", "botStatus"), {
      ...botStatus,
      updatedAt: new Date().toISOString()
    });
  } catch (e) {}
}, 30000);

let botStatus = { lastSync: "Never", totalForwarded: 0, isPolling: true, error: null as string | null };

// Helper to identify country
function getCountryInfo(number: string) {
  const cleanNumber = number.replace(/\D/g, "");
  const countries: any = config.COUNTRIES || {};
  const sortedPrefixes = Object.keys(countries).sort((a, b) => b.length - a.length);
  for (const prefix of sortedPrefixes) {
    if (cleanNumber.startsWith(prefix)) return countries[prefix];
  }
  return { name: "Unknown", flag: "🌍" };
}

// Helper to extract OTP
function extractOTP(message: string) {
  const otpMatch = message.match(/\b\d{4,8}\b/);
  return otpMatch ? otpMatch[0] : "Not Found";
}

// Helper to identify service
function getServiceInfo(cli: string, message: string) {
  const msgLower = message.toLowerCase();
  const cliLower = cli.toLowerCase();
  const services = config.SERVICES;
  for (const key in services) {
    if (msgLower.includes(key) || cliLower.includes(key)) return services[key];
  }
  return { name: cli.toUpperCase() || "SMS", emojiId: undefined };
}

// Helper to send Telegram message
async function sendTelegramMessage(text: string) {
  const groupsConfig = config.GROUPS_CONFIG || [];
  for (const group of groupsConfig) {
    const chatId = group.chatId;
    const groupBotToken = group.botToken || config.TELEGRAM_BOT_TOKEN;
    if (!groupBotToken) continue;
    
    const inline_keyboard = [];
    if (group.buttons) {
      for (let i = 0; i < group.buttons.length; i += 2) {
        inline_keyboard.push(group.buttons.slice(i, i + 2).map((btn: any) => ({ text: btn.text, url: btn.url })));
      }
    }

    try {
      await axios.post(`https://api.telegram.org/bot${groupBotToken}/sendMessage`, {
        chat_id: chatId, text, parse_mode: "HTML", reply_markup: { inline_keyboard }
      });
    } catch (e) {}
  }
}

// Main Polling Logic
async function pollCRApi() {
  if (!config.POLLING_ENABLED) return;
  try {
    const response = await axios.get(config.CR_API_URL, { params: { token: config.CR_API_TOKEN }, timeout: 10000 });
    if (response.data.status === "success" || response.data.status === "ok") {
      const messages = response.data.data || [];
      for (const msg of messages) {
        const msgId = Buffer.from(`${msg.dt}-${msg.num}-${msg.message}`).toString("base64");
        if (!db.prepare("SELECT 1 FROM processed_messages WHERE id = ?").get(msgId)) {
          const country = getCountryInfo(msg.num);
          const service = getServiceInfo(msg.cli, msg.message);
          const otp = extractOTP(msg.message);
          
          const telegramText = `
${getEmojiTag(config.UI_EMOJIS?.header, "🔥")} <b>${service.name} ${config.UI_LABELS?.header || "RECEIVED"}</b>
<blockquote><b>Time:</b> <code>${msg.dt}</code></blockquote>
<blockquote><b>Country:</b> <code>${country.name} ${country.flag}</code></blockquote>
<blockquote><b>Number:</b> <code>${msg.num}</code></blockquote>
<blockquote><b>OTP:</b> <code>${otp}</code></blockquote>
<blockquote><b>Message:</b> <code>${msg.message}</code></blockquote>
━━━━━━━━━━━━━━━━
${getEmojiTag(config.UI_EMOJIS?.footer, "🧑‍💻")} <b>${config.UI_LABELS?.footer || "DXA"}</b>`.trim();

          await sendTelegramMessage(telegramText);
          
          // Forward to assigned user if applicable
          const cleanNum = msg.num.replace(/\D/g, "");
          const assigned = db.prepare("SELECT assigned_to FROM numbers WHERE number LIKE ?").get(`%${cleanNum}%`);
          if (assigned?.assigned_to) {
            await axios.post(`https://api.telegram.org/bot${config.NUMBER_BOT_TOKEN}/sendMessage`, {
              chat_id: assigned.assigned_to, text: telegramText, parse_mode: "HTML"
            });
          }

          db.prepare("INSERT INTO processed_messages (id, number, service, otp) VALUES (?, ?, ?, ?)").run(msgId, msg.num, service.name, otp);
          botStatus.totalForwarded++;
        }
      }
      botStatus.lastSync = new Date().toLocaleString();
    }
  } catch (e: any) { botStatus.error = e.message; }
}

// API Routes
app.get("/api/status", (req, res) => res.json(botStatus));
app.get("/api/logs", (req, res) => res.json(db.prepare("SELECT * FROM processed_messages ORDER BY timestamp DESC LIMIT 50").all()));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "admin.html")));
app.post("/api/sync", async (req, res) => { await pollCRApi(); res.json({ status: "ok" }); });

cron.schedule("* * * * *", () => botStatus.isPolling && pollCRApi());
handleNumberBot();
pollCRApi();

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  }
  app.listen(PORT, "0.0.0.0", () => console.log(`Server running on http://localhost:${PORT}`));
}
startServer();
