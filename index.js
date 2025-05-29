// === backend/index.js ===
const express = require('express');
const { Client, NoAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const http = require('http');
const { Server } = require('socket.io');
const allCities = require('all-the-cities');
const Fuse = require('fuse.js');
const fs = require('fs');
const path = require('path');
const app = express();
const server = http.createServer(app);
const { resolveLidToWid } = require('./resolveLid');
const { getCusFromLid, saveLidMapping } = require('./lidMapper');
const puppeteer = require('puppeteer');
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});
let isClientReady = false;
const cities = allCities.map(city => ({ name: city.name }));
const cityFuse = new Fuse(cities, {
  keys: ['name'],
  threshold: 0.3,
  includeScore: true
});
const REPLIED_PATH = path.join(__dirname, 'repliedMessages.json');

function getRepliedIds() {
  if (!fs.existsSync(REPLIED_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(REPLIED_PATH, 'utf-8'));
  } catch (err) {
    console.error('Error reading repliedMessages.json:', err);
    return [];
  }
}

function addRepliedId(messageId) {
  const ids = getRepliedIds();
  if (!ids.includes(messageId)) {
    ids.push(messageId);
    fs.writeFileSync(REPLIED_PATH, JSON.stringify(ids, null, 2));
  }
}


function decodeEmojiNumberSequence(text) {
  const emojiToDigit = {
    '0️⃣': '0', '1️⃣': '1', '2️⃣': '2', '3️⃣': '3', '4️⃣': '4',
    '5️⃣': '5', '6️⃣': '6', '7️⃣': '7', '8️⃣': '8', '9️⃣': '9'
  };

  return (text.match(/([0-9]️⃣)+/g) || []).map(seq => {
    return [...seq.match(/([0-9]️⃣)/g)].map(e => emojiToDigit[e]).join('');
  }).map(Number);
}

function extractAllNumbers(text) {
  const standardNums = text.match(/\d+/g)?.map(Number) || [];
  const emojiNums = decodeEmojiNumberSequence(text);
  return [...standardNums, ...emojiNums];
}

function extractBudgetRange(text) {
  const nums = extractAllNumbers(text);
  const rangeMatch = text.match(/(\d+)[\s\-–]{1,3}(\d+)/);
  if (rangeMatch) {
    return { min: Number(rangeMatch[1]), max: Number(rangeMatch[2]) };
  }
  if (nums.length === 1) return { min: nums[0], max: undefined };
  if (nums.length >= 2) return { min: nums[0], max: nums[1] };
  return {};
}

function containsCity(text, targetCity) {
  const words = text.toLowerCase().split(/\s|[.,;!?]/);
  for (const word of words) {
    const result = cityFuse.search(word);
    if (result.length > 0 && result[0].item.name.toLowerCase() === targetCity.toLowerCase()) {
      return true;
    }
  }
  return false;
}
const client = new Client({
  authStrategy: new NoAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});


client.on('qr', async (qr) => {
  const qrImage = await qrcode.toDataURL(qr);
  io.emit('qr', qrImage);
});

client.on('ready', async () => {
  console.log('Client is ready!');
  io.emit('ready');
  isClientReady = true;
  const chats = await client.getChats();
  const simplifiedChats = chats.map(chat => ({
    id: chat.id._serialized,
    name: chat.name || chat.id.user || 'Unnamed Chat',
    avatar: chat.id.user ? `https://ui-avatars.com/api/?name=${chat.name || chat.id.user}` : '',
    lastMessage: chat.lastMessage?.body || ''
  }));


  io.emit('chats', simplifiedChats);
});

const chatHistories = {} // для історії

client.on('message', (msg) => {

  // Зберігаємо історію повідомлень у RAM
  const from = msg.from;
  if (!chatHistories[from]) chatHistories[from] = [];
  chatHistories[from].push({
    id: msg.id,
    body: msg.body,
    fromMe: msg.fromMe,
    timestamp: msg.timestamp,
    notifyName: msg._data?.notifyName || '',
    author: msg.id.participant || msg.author || msg.from,
    participant : msg.participant
  });

  io.emit('message', msg);
});

// Навантаження історії діалогу
io.on('connection', (socket) => {
  socket.on('get-relevant-messages', async ({ chatIds }) => {
  
    const result = [];
  
    for (const chatId of chatIds) {
      let chat;
      try {
        chat = await client.getChatById(chatId);
        if (!chat || !chat.id || !chat.id._serialized) continue;
      } catch (e) {
        console.error(`[❌] getChatById failed for ${chatId}:`, e.message);
        continue;
      }
  
      let messages = [];
      try {
        messages = await chat.fetchMessages({ limit: 250 });
      } catch (e) {
        console.error(`[❌] fetchMessages failed for ${chatId}:`, e.message);
        continue;
      }
  
      const repliedIds = getRepliedIds();
      for (const msg of messages) {
        const rawText = msg.body || '';
        if (!rawText || typeof rawText !== 'string') continue;
        if (repliedIds.includes(msg.id._serialized)) continue;
        result.push({
          id: msg.id?._serialized || '',
          chatId,
          body: rawText,
          fromMe: msg.fromMe,
          timestamp: msg.timestamp,
          senderName: msg._data?.notifyName || msg.author || chat.name || chatId,
          avatar: chat.id?.user ? `https://ui-avatars.com/api/?name=${chat.name || chatId}` : '',
          isNew: !msg.fromMe,
          hasReply: !!msg.hasQuotedMsg,
          author: msg.id.participant || msg.author || msg.from,
        });
      }
    }
  
    result.sort((a, b) => b.timestamp - a.timestamp);
    socket.emit('relevant-messages', result);
  });
  

  socket.on('quick-reply', async ({ chatId, text, repliedToId, author }) => {
    try {
      console.log('🚀 quick-reply вызван!');
      
      const lid = author?._serialized;
      if (!lid || !lid.includes('@lid')) {
        console.warn('❌ Неверный формат автора, нужен @lid:', author);
        return;
      }
  
      console.log(`🧠 Пытаемся получить номер по lid: ${lid}`);
  
      // ⬇️ Puppeteer внутри функции
      const browser = await puppeteer.launch({
        headless: false,
        executablePath: '/usr/bin/google-chrome',
        userDataDir: './.wpp-session',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--start-maximized'
        ] 
      });
  
      const page = await browser.newPage();
      await page.goto('https://web.whatsapp.com');
  
      console.log('⏳ Ждём загрузки WhatsApp Web...');
      await page.waitForSelector('div[role="textbox"]', { timeout: 120000 });
  
      const wid = await page.evaluate((lid) => {
        try {
          const jidConverter = window.require("WAWebJidToWid");
          const apiContact = window.require("WAWebApiContact");
  
          if (!jidConverter || !apiContact) return null;
          const internalLid = jidConverter.lidUserJidToUserLid(lid);
          const contact = apiContact.getPhoneNumber(internalLid);
          return contact?._serialized || null;
        } catch (e) {
          console.warn('❌ Ошибка в evaluate:', e);
          return null;
        }
      }, lid);
  
      await browser.close();
  
      if (!wid || !wid.includes('@c.us')) {
        console.warn('❌ Не удалось извлечь номер из lid');
        return;
      }
  
      console.log('✅ Получен номер:', wid);
  
      // 🔥 Отправка личного сообщения
      
      await client.sendMessage(wid, text);
      console.log('📤 Сообщение отправлено в личку:', wid);
      addRepliedId(repliedToId);
    } catch (err) {
      console.error('❌ Ошибка в quick-reply:', err.message);
    }
  });
  
  
  socket.on('get-replied-messages', async () => {
  const repliedIds = getRepliedIds();
  const allChats = await client.getChats();
  const result = [];

  for (const chat of allChats) {
    const messages = await chat.fetchMessages({ limit: 250 });
    for (const msg of messages) {
      if (repliedIds.includes(msg.id._serialized)) {
        result.push({
          id: msg.id._serialized,
          chatId: chat.id._serialized,
          body: msg.body,
          fromMe: msg.fromMe,
          timestamp: msg.timestamp,
          senderName: msg._data?.notifyName || msg.author || chat.name || chat.id.user,
          avatar: chat.id.user ? `https://ui-avatars.com/api/?name=${chat.name || chat.id.user}` : '',
          author: msg.id.participant || msg.author || msg.from
        });
      }
    }
  }

  result.sort((a, b) => b.timestamp - a.timestamp);
  socket.emit('replied-messages', result);
  });

  socket.on('mark-as-replied', (messageId) => {
    addRepliedId(messageId);
  });
  socket.on("load-chat", async (chatId, authorId) => {
    try {
  
      const chat = await client.getChatById(chatId);
      const messages = await chat.fetchMessages({ limit: 1500 });
  
      const filtered = messages
        .filter((m) => {
          const remote = m.id?.remote;
          const passed = m.fromMe || remote === authorId;
          return passed;
        })
        .map((m) => ({
          id: m.id._serialized,
          body: m.body,
          fromMe: m.fromMe,
          timestamp: m.timestamp,
          senderName: m._data?.notifyName || chat.name || chatId,
          author: m.author || m.from
        }));
  
      socket.emit("chat-history", { chatId, messages: filtered });
    } catch (err) {
      console.error("❌ Error loading chat history:", err.message);
    }
  });
  
  if (isClientReady) {
    client.getChats().then(chats => {
      const simplifiedChats = chats.map(chat => ({
        id: chat.id._serialized,
        name: chat.name || chat.id.user || 'Unnamed Chat',
        avatar: chat.id.user ? `https://ui-avatars.com/api/?name=${chat.name || chat.id.user}` : '',
        lastMessage: chat.lastMessage?.body || ''
      }))
      socket.emit('chats', simplifiedChats)
    }).catch(e => {
      console.error('🚨 Failed to get chats:', e.message);
    });
  } else {
    socket.emit('not-ready');
  }

  client.on('message', (msg) => {
    client.on('message', (msg) => {
      io.emit('new-message', {
        chatId: msg.from,
        message: {
          id: msg.id._serialized,
          body: msg.body,
          fromMe: msg.fromMe,
          timestamp: msg.timestamp,
          senderName: msg._data?.notifyName || msg.from,
          author: msg.id.participant || msg.author || msg.from
        }
      });
    });
    
  });
  socket.on('logout', async () => {
    try {
      // 1. Завершаем сессию
      await client.logout();
  
      // 2. Удаляем всю папку сессии
      const sessionPath = path.join(__dirname, '.wwebjs_auth', 'session-dashboard');
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
      }
  
      // 3. Полностью уничтожаем текущий клиент
      await client.destroy();
  
      // 4. Переинициализируем — покажет QR повторно
      client.initialize();
  
    } catch (err) {
      console.error('Logout error:', err);
    }
  });
});

client.initialize();

server.listen(3001, () => console.log('Backend server running on http://localhost:3001'));