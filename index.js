const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// === Мультисессии
const clients = {};
const chatHistories = {}; 

// === Утилиты для repliedMessages
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

// === Инициализация нового клиента
function createClient(userId, socket) {
  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: userId,
      dataPath: path.join(__dirname, 'sessions')
    }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  clients[userId] = client;
  chatHistories[userId] = {};

  client.on('qr', async (qr) => {
    const qrImg = await qrcode.toDataURL(qr);
    socket.emit('qr', { userId, qr: qrImg });
    console.log(`📱 [${userId}] QR готов`);
  });

  client.on('ready', async () => {
    console.log(`✅ [${userId}] Клиент готов`);
    socket.emit('ready', { userId });

    const chats = await client.getChats();
    const simplifiedChats = chats.map(chat => ({
      id: chat.id._serialized,
      name: chat.name || chat.id.user || 'Unnamed Chat',
      avatar: `https://ui-avatars.com/api/?name=${chat.name || chat.id.user}`,
      lastMessage: chat.lastMessage?.body || ''
    }));

    socket.emit('chats', { userId, chats: simplifiedChats });
  });

  client.on('message', async (msg) => {
    const chatId = msg.from;

    // Сохраняем историю
    if (!chatHistories[userId][chatId]) chatHistories[userId][chatId] = [];
    chatHistories[userId][chatId].push({
      id: msg.id._serialized,
      body: msg.body,
      fromMe: msg.fromMe,
      timestamp: msg.timestamp,
      senderName: msg._data?.notifyName || chatId
    });

    socket.emit('message', {
      userId,
      chatId,
      message: {
        id: msg.id._serialized,
        body: msg.body,
        fromMe: msg.fromMe,
        timestamp: msg.timestamp
      }
    });
  });

  client.initialize();
}

// === Socket.IO
io.on('connection', (socket) => {
  console.log('📡 Новое подключение сокета');

  socket.on('init', ({ userId }) => {
    if (!clients[userId]) {
      console.log(`🚀 Инициализация клиента для ${userId}`);
      createClient(userId, socket);
    } else {
      console.log(`⚠️ Клиент уже существует: ${userId}`);
      socket.emit('already-initialized', { userId });
    }
  });

  socket.on('send-message', ({ userId, chatId, text }) => {
    const client = clients[userId];
    if (!client) return;
    client.sendMessage(chatId, text);
  });

  socket.on('quick-reply', ({ userId, chatId, text, repliedToId }) => {
    const client = clients[userId];
    if (!client) return;

    client.sendMessage(chatId, text).then(() => {
      if (repliedToId) addRepliedId(repliedToId);
    });
  });

  socket.on('get-relevant-messages', async ({ userId, chatIds }) => {
    const client = clients[userId];
    if (!client) return;
    const repliedIds = getRepliedIds();
    const result = [];

    for (const chatId of chatIds) {
      let chat;
      try {
        chat = await client.getChatById(chatId);
        if (!chat) continue;
      } catch {
        continue;
      }

      const messages = await chat.fetchMessages({ limit: 250 });
      for (const msg of messages) {
        const body = msg.body || '';
        if (!body || repliedIds.includes(msg.id._serialized)) continue;

        result.push({
          id: msg.id._serialized,
          chatId,
          body,
          fromMe: msg.fromMe,
          timestamp: msg.timestamp,
          senderName: msg._data?.notifyName || msg.author || chat.name || chatId,
          avatar: `https://ui-avatars.com/api/?name=${chat.name || chatId}`,
          isNew: !msg.fromMe,
          hasReply: !!msg.hasQuotedMsg
        });
      }
    }

    result.sort((a, b) => b.timestamp - a.timestamp);
    socket.emit('relevant-messages', { userId, messages: result });
  });

  socket.on('load-chat', async ({ userId, chatId }) => {
    const client = clients[userId];
    if (!client) return;

    try {
      const chat = await client.getChatById(chatId);
      const messages = await chat.fetchMessages({ limit: 250 });

      const formatted = messages.map(msg => ({
        id: msg.id._serialized,
        body: msg.body,
        fromMe: msg.fromMe,
        timestamp: msg.timestamp,
        senderName: msg._data?.notifyName || msg.from
      }));

      socket.emit('chat-history', { userId, chatId, messages: formatted });
    } catch (err) {
      console.error(`[❌] Ошибка при загрузке истории:`, err.message);
    }
  });

  socket.on('logout', async ({ userId }) => {
    const client = clients[userId];
    if (!client) return;

    try {
      await client.logout();
      await client.destroy();

      const sessionPath = path.join(__dirname, 'sessions', `session-${userId}`);
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        console.log(`🧹 Очистка сессии: ${sessionPath}`);
      }

      delete clients[userId];
      delete chatHistories[userId];

      socket.emit('logged-out', { userId });
    } catch (err) {
      console.error(`❌ Ошибка logout: ${err.message}`);
    }
  });
});

server.listen(3001, () => {
  console.log('🚀 Сервер запущен на http://localhost:3001');
});
