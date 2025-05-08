// === backend/index.js ===
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true }
});

client.on('qr', async (qr) => {
  const qrImage = await qrcode.toDataURL(qr);
  io.emit('qr', qrImage);
});

client.on('ready', async () => {
  console.log('Client is ready!');
  io.emit('ready');

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
  console.log('Message received:', msg.body);

  // Зберігаємо історію повідомлень у RAM
  const from = msg.from;
  if (!chatHistories[from]) chatHistories[from] = [];
  chatHistories[from].push({
    id: msg.id,
    body: msg.body,
    fromMe: msg.fromMe,
    timestamp: msg.timestamp,
    notifyName: msg._data?.notifyName || ''
  });

  io.emit('message', msg);
});

// Навантаження історії діалогу
io.on('connection', (socket) => {
  socket.on('get-relevant-messages', async ({ chatIds, filters }) => {
    const { keywords, city, budgetMin, budgetMax } = filters;
    console.log('[🔍] FILTER REQUEST:', chatIds, filters);

    const result = [];

    for (const chatId of chatIds) {
      try {
        const chat = await client.getChatById(chatId);
        const messages = await chat.fetchMessages({ limit: 50 });

        console.log(`[💬] Chat ${chatId} → ${messages.length} messages`);

        messages.forEach(msg => {
          const text = msg.body?.toLowerCase() || ''

          const hasKeyword = keywords
          .toLowerCase()
          .split(',')
          .some(k => text.includes(k.trim()))


          const hasCity = !city || text.includes(city.toLowerCase());

          const matchNumbers = text.match(/\d+/g)?.map(Number) || [];
          const hasBudget = matchNumbers.some(n =>
            (!budgetMin || n >= budgetMin) &&
            (!budgetMax || n <= budgetMax)
          );

          if (hasKeyword && hasCity && hasBudget) {
            result.push({
              id: msg.id._serialized,
              chatId,
              body: msg.body,
              fromMe: msg.fromMe,
              timestamp: msg.timestamp,
              senderName: msg._data?.notifyName || chat.name || chatId,
              avatar: chat.id.user ? `https://ui-avatars.com/api/?name=${chat.name || chatId}` : ''
            });
          }
          console.log('[📨] Message:', msg.body);
          console.log('[🔎] Contains keyword:', hasKeyword);
          console.log('[🔎] Contains city:', hasCity);
          console.log('[🔎] Has budget:', hasBudget);

        });
      } catch (e) {
        console.error(`[❌] Failed to fetch ${chatId}:`, e.message);
      }
    }

    console.log(`[📤] Found ${result.length} relevant messages`);
    socket.emit('relevant-messages', result);
  });

  socket.on('quick-reply', ({ chatId, text }) => {
    client.sendMessage(chatId, text);
  });

  socket.on('load-chat', async (chatId) => {
    try {
      const chat = await client.getChatById(chatId);
      const messages = await chat.fetchMessages({ limit: 50 });

      const formatted = messages.map((msg) => ({
        id: msg.id._serialized,
        body: msg.body,
        fromMe: msg.fromMe,
        timestamp: msg.timestamp,
        senderName: msg._data?.notifyName || chat.name || chatId
      }));

      socket.emit('chat-history', { chatId, messages: formatted });
    } catch (err) {
      console.error('❌ Error loading chat history:', err);
    }
  });

  client.on('message', (msg) => {
    io.emit('new-message', {
      chatId: msg.from,
      message: {
        id: msg.id._serialized,
        body: msg.body,
        fromMe: msg.fromMe,
        timestamp: msg.timestamp,
        senderName: msg._data?.notifyName || msg.from
      }
    });
  });
  socket.on('logout', async () => {
    try {
      await client.logout()
      console.log('🛑 Logged out from WhatsApp')
    } catch (err) {
      console.error('Logout error:', err)
    }
  })
});

client.initialize();

server.listen(3001, () => console.log('Backend server running on http://localhost:3001'));
