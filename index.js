// === backend/index.js ===
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const http = require('http');
const { Server } = require('socket.io');
const allCities = require('all-the-cities');
const Fuse = require('fuse.js');
const app = express();
const server = http.createServer(app);
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
  authStrategy: new LocalAuth({ clientId: 'dashboard' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});


client.on('qr', async (qr) => {
   console.log('📡 Generating QR...')
  const qrImage = await qrcode.toDataURL(qr);
  io.emit('qr', qrImage);
  console.log(`qr is ready`)
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
        let allMessages = [];
        let lastMessage;
  
        // Загрузка максимум 300 сообщений по 50
        while (allMessages.length < 300) {
          const options = { limit: 50 };
          if (lastMessage) options.before = lastMessage.id;
  
          const messages = await chat.fetchMessages(options);
          if (messages.length === 0) break;
  
          allMessages.push(...messages);
          lastMessage = messages[messages.length - 1];
        }
  
        console.log(`[💬] Chat ${chatId} → ${allMessages.length} messages total`);
  
        allMessages.forEach(msg => {
          const text = msg.body?.toLowerCase() || '';
  
          const hasKeyword = keywords
            .toLowerCase()
            .split(',')
            .some(k => text.includes(k.trim()));
  
          const hasCity = !city || containsCity(text, city);
  
          const numbers = extractAllNumbers(text);
          const hasBudget = numbers.some(n =>
            (budgetMin === undefined || n >= budgetMin) &&
            (budgetMax === undefined || n <= budgetMax)
          );
  
          if (hasKeyword && hasCity && hasBudget) {
            result.push({
              id: msg.id._serialized,
              chatId,
              body: msg.body,
              fromMe: msg.fromMe,
              timestamp: msg.timestamp,
              senderName: msg._data?.notifyName || chat.name || chatId,
              avatar: chat.id.user ? `https://ui-avatars.com/api/?name=${chat.name || chatId}` : '',
              isNew: !msg.fromMe,
              hasReply: !!msg.hasQuotedMsg
            });
            
          }
        });
      } catch (e) {
        console.error(`[❌] Failed to fetch ${chatId}:`, e.message);
      }
    }
  
    // Сортируем по дате (новые сверху)
    result.sort((a, b) => b.timestamp - a.timestamp);
  
    console.log(`[📤] Found ${result.length} relevant messages`);
    socket.emit('relevant-messages', result);
  });
  

  
  socket.on('quick-reply', ({ chatId, text }) => {
    client.sendMessage(chatId, text);
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
    console.log('⚠️ Client not ready yet. Skipping getChats.');
    socket.emit('not-ready');
  }
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
      // 1. Завершаем сессию
      await client.logout();
      console.log('🛑 Logged out from WhatsApp');
  
      // 2. Удаляем всю папку сессии
      const sessionPath = path.join(__dirname, '.wwebjs_auth', 'session-dashboard');
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        console.log('🧹 Session cache cleared:', sessionPath);
      }
  
      // 3. Полностью уничтожаем текущий клиент
      await client.destroy();
      console.log('🧨 Client destroyed');
  
      // 4. Переинициализируем — покажет QR повторно
      client.initialize();
      console.log('🔁 Client reinitialized');
  
    } catch (err) {
      console.error('Logout error:', err);
    }
  });
});

client.initialize();

server.listen(3001, () => console.log('Backend server running on http://localhost:3001'));
