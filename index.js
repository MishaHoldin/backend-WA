// === backend/index.js ===
const express = require('express');
const { Client, NoAuth, LocalAuth, MessageMedia   } = require('whatsapp-web.js');
const { v4: uuidv4 } = require('uuid');
const session = require('express-session');
const bcrypt = require('bcrypt');
const User = require('./models/user');
const sequelize = require('./sequelize');
const qrcode = require('qrcode');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const app = express();
const cors = require('cors');
app.use(cors({
  origin: 'https://wa-tg.netlify.app',
  credentials: true
}));

app.use(express.json());

const sessionMiddleware = session({
  secret: 'super-secret-key',
  resave: false,
  saveUninitialized: false
});

app.use(sessionMiddleware);

function isAuthenticated(req, res, next) {
  if (req.session?.userId) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

const server = http.createServer(app);
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const io = new Server(server, {
  cors: {
    origin: 'https://wa-tg.netlify.app',
    methods: ['GET', 'POST'],
    credentials: true
  }
});
const sharedSession = require("express-socket.io-session");

io.use(sharedSession(sessionMiddleware, {
  autoSave: true
}));

let isClientReady = false;
const REPLIED_PATH = path.join(__dirname, 'repliedMessages.json');
const clients = {};
const sessions = {};
const chatHistories = {} // для історії

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

app.post('/api/login', async (req, res) => {
  const { login, password } = req.body;
  const user = await User.findOne({ where: { login } });

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // 👇 Добавь вывод всей модели
  console.log('[🔍 LOGIN USER]', user.toJSON());

  req.session.userId = user.id;
  res.json({
    success: true,
    userId: user.id,
    login: user.login
  });
});


// 🚪 Логаут
// app.post('/api/logout', (req, res) => {
//   req.session.destroy(() => {
//     res.json({ success: true });
//   });
// });

// ✅ Проверка авторизации
app.get('/api/check-auth', (req, res) => {
  res.json({ authenticated: !!req.session.userId });
});
// 📋 Получить всех пользователей
app.get('/api/users', isAuthenticated, async (req, res) => {
  const users = await User.findAll({ attributes: ['id', 'login'] });
  res.json(users);
});

// ➕ Создать нового пользователя
app.post('/api/users', isAuthenticated, async (req, res) => {
  const { login, password } = req.body;
  const hash = await bcrypt.hash(password, 10);
  const user = await User.create({ login, password: hash });
  res.json({ id: user.id, login: user.login });
});

// ✏️ Изменить пароль
app.put('/api/users/:id', isAuthenticated, async (req, res) => {
  const { password } = req.body;
  const hash = await bcrypt.hash(password, 10);
  await User.update({ password: hash }, { where: { id: req.params.id } });
  res.json({ success: true });
});

// 🗑 Удалить пользователя
app.delete('/api/users/:id', isAuthenticated, async (req, res) => {
  await User.destroy({ where: { id: req.params.id } });
  res.json({ success: true });
});

app.get('/api/me', isAuthenticated, async (req, res) => {
  const user = await User.findByPk(req.session.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  res.json({
    login: user.login,
    whatsappUserId: user.whatsappUserId
  });
});

async function waitForStore(client, timeout = 10000) {
  const page = client.pupPage;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const isReady = await page.evaluate(() => !!window.Store?.Chat);
      if (isReady) return true;
    } catch (e) {
      // Игнорируем временные ошибки
    }
    await new Promise(r => setTimeout(r, 300));
  }

  throw new Error('Store did not initialize in time');
}

io.on('connection', (socket) => {
  socket.on('check-session', ({ userId }) => {
    const client = clients[String(userId)];
    if (!client) {
      socket.emit('session-status', { ready: false, hasQR: false });
      return;
    }
  
    const isReady = client.info?.wid !== undefined;
    const hasQR = client?.info === undefined;
  
    socket.emit('session-status', {
      ready: isReady,
      hasQR: hasQR
    });
  });
  
  socket.on('start-session', async ({ userId }) => {
    if (!userId) {
      console.warn('[⚠️] start-session: userId не передан');
      return;
    }
  
    const user = await User.findByPk(userId);
    if (!user) {
      console.warn(`[❌] start-session: пользователь с id ${userId} не найден`);
      return;
    }
  
    const clientKey = String(userId);
    let client = clients[clientKey];
  
    // === ✅ Клиент уже существует ===
    if (client) {
      console.log(`[ℹ️] Клиент уже существует для userId=${clientKey}`);
      sessions[socket.id] = clientKey;
  
      // 👇 Повторно подписываем на события для текущего сокета
      client.on('qr', async (qr) => {
        const qrImage = await qrcode.toDataURL(qr);
        socket.emit('qr', { userId: clientKey, qr: qrImage });
        console.log(`[🧾] QR-код повторно отправлен для userId=${clientKey}`);
      });
  
      client.on('ready', async () => {
        console.log(`[✅] WA-клиент готов (повторно): userId=${clientKey}`);
        try {
          await waitForStore(client);
          const chats = await client.getChats();
          const simplified = chats.map(chat => ({
            id: chat.id._serialized,
            name: chat.name || chat.id.user || 'Unnamed Chat',
            avatar: chat.id.user ? `https://ui-avatars.com/api/?name=${chat.name || chat.id.user}` : '',
            lastMessage: chat.lastMessage?.body || ''
          }));
          socket.emit('ready', { userId: clientKey });
          socket.emit('chats', simplified);
        } catch (e) {
          console.error(`[❌] Ошибка при ready (повторно) для userId=${clientKey}:`, e.message);
        }
      });
  
      client.on('message', (msg) => {
        const from = msg.from;
        if (!chatHistories[from]) chatHistories[from] = [];
        chatHistories[from].push({
          id: msg.id,
          body: msg.body,
          fromMe: msg.fromMe,
          timestamp: msg.timestamp,
          notifyName: msg._data?.notifyName || '',
          author: msg.id.participant || msg.author || msg.from
        });
        socket.emit('message', msg);
      });
  
      return;
    }
  
    // === 🚀 Инициализация нового клиента ===
    console.log(`[🚀] Инициализация клиента WhatsApp для userId=${clientKey}`);
  
    client = new Client({
      authStrategy: new LocalAuth({ clientId: clientKey }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      }
    });
  
    clients[clientKey] = client;
    sessions[socket.id] = clientKey;
  
    client.initialize();
  
    client.on('qr', async (qr) => {
      const qrImage = await qrcode.toDataURL(qr);
      socket.emit('qr', { userId: clientKey, qr: qrImage });
      console.log(`[🧾] QR-код сгенерирован для userId=${clientKey}`);
    });
  
    client.on('ready', async () => {
      console.log(`[✅] WA-клиент готов: userId=${clientKey}`);
      await waitForStore(client);
  
      const chats = await client.getChats();
      const simplified = chats.map(chat => ({
        id: chat.id._serialized,
        name: chat.name || chat.id.user || 'Unnamed Chat',
        avatar: chat.id.user ? `https://ui-avatars.com/api/?name=${chat.name || chat.id.user}` : '',
        lastMessage: chat.lastMessage?.body || ''
      }));
  
      socket.emit('ready', { userId: clientKey });
      socket.emit('chats', simplified);
    });
  
    client.on('message', (msg) => {
      const from = msg.from;
      if (!chatHistories[from]) chatHistories[from] = [];
      chatHistories[from].push({
        id: msg.id,
        body: msg.body,
        fromMe: msg.fromMe,
        timestamp: msg.timestamp,
        notifyName: msg._data?.notifyName || '',
        author: msg.id.participant || msg.author || msg.from
      });
      socket.emit('message', msg);
    });
  });
  
  socket.on('get-relevant-messages', async ({ chatIds }) => {
    const userId = sessions[socket.id];
    const client = clients[userId];
    if (!client) return;
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
  
  socket.on('quick-reply', async ({ chatId, text, sendUserText, repliedToId, author, media }) => {
    try {
      const userId = sessions[socket.id];
      const client = clients[userId];
      if (!client) return;
  
      const lidSerialized = author?._serialized;
      if (!lidSerialized) {
        console.warn('❌ Отсутствует author._serialized');
        return;
      }
  
      const chat = await client.getChatById(chatId);
      const messages = await chat.fetchMessages({ limit: 100 });
  
      const targetMsg = messages.find((msg) => {
        const participant = msg.id?.participant?._serialized;
        const body = msg.body?.trim();
        return participant === lidSerialized && (!sendUserText || body === sendUserText.trim());
      });
  
      if (!targetMsg) {
        console.warn(`❌ Не найдено сообщение от ${lidSerialized} с текстом "${sendUserText}"`);
        return;
      }
  
      let realCUsId: string | null = null;
  
      // === 🧠 Обработка разных типов авторов ===
      if (lidSerialized.endsWith('@lid')) {
        const page = client.pupPage;
        realCUsId = await page.evaluate(async (lid) => {
          try {
            const storeReady = () =>
              new Promise((resolve) => {
                if (window.Store?.Contact) return resolve();
                webpackChunkwhatsapp_web_client.push([['custom'], {}, (req) => {
                  for (let m in req.c) {
                    try {
                      const mod = req(m);
                      if (mod?.default?.getContact) {
                        window.Store = window.Store || {};
                        window.Store.Contact = mod.default;
                        break;
                      }
                    } catch (e) {}
                  }
                  resolve();
                }]);
              });
            await storeReady();
            const contact = window.Store.Contact.get(lid);
            const phone = contact?.phoneNumber;
            return phone ? `${phone}` : null;
          } catch {
            return null;
          }
        }, lidSerialized);
  
        if (realCUsId) {
          realCUsId += '@c.us';
        }
  
      } else if (lidSerialized.endsWith('@c.us')) {
        realCUsId = lidSerialized;
  
      } else {
        const digitsOnly = lidSerialized.replace(/\D/g, '');
        if (digitsOnly.length >= 10) {
          realCUsId = `${digitsOnly}@c.us`;
        }
      }
  
      if (!realCUsId) {
        console.warn('❌ Не удалось получить realCUsId:', lidSerialized);
        return;
      }
  
      // === 📎 Отправка медиа, если есть ===
      if (media?.base64 && media?.mimeType) {
        const mediaToSend = new MessageMedia(media.mimeType, media.base64);
        await client.sendMessage(realCUsId, mediaToSend, {
          caption: media.caption || text
        });
        console.log(`📤 Медиа с подпиcью отправлено на ${realCUsId}`);
      } else {
        await client.sendMessage(realCUsId, text);
        console.log(`📤 Текст отправлен на ${realCUsId}`);
      }
  
    } catch (err) {
      console.error('❌ Ошибка в quick-reply:', err.message);
    }
  });
  
  
  socket.on("load-chat-by-lid", async ({ chatId, lid, sendUserText }) => {
    try {
      const userId = sessions[socket.id];
      const client = clients[userId];
      if (!client) return;
  
      const lidSerialized = lid;
      if (!lidSerialized || !lidSerialized.endsWith('@lid')) {
        console.warn('❌ Передан lid не в формате @lid:', lidSerialized);
        return;
      }
  
      // 1. Получаем сообщения из группы
      const chat = await client.getChatById(chatId);
      const messages = await chat.fetchMessages({ limit: 150 });
  
      // 2. Ищем сообщение от lid с нужным текстом
      const targetMsg = messages.find((msg) => {
        const participant = msg.id?.participant?._serialized;
        const body = msg.body?.trim();
        return (
          participant === lidSerialized &&
          (!sendUserText || body === sendUserText.trim())
        );
      });
  
      if (!targetMsg) {
        console.warn(`❌ Не найдено сообщение от ${lidSerialized} с текстом "${sendUserText}"`);
        return;
      }
  
  
      // 3. Получаем wid (c.us ID) через Puppeteer
      const page = client.pupPage;
      const realCUsId = await page.evaluate(async (lid) => {
        try {
          const storeReady = () => {
            return new Promise((resolve) => {
              if (window.Store?.Contact) return resolve();
              webpackChunkwhatsapp_web_client.push([
                ['custom'],
                {},
                (req) => {
                  for (let m in req.c) {
                    try {
                      const mod = req(m);
                      if (mod?.default?.getContact) {
                        window.Store = window.Store || {};
                        window.Store.Contact = mod.default;
                        break;
                      }
                    } catch (e) {}
                  }
                  resolve();
                },
              ]);
            });
          };
  
          await storeReady();
          const contact = window.Store.Contact.get(lid);
          const phone = contact?.phoneNumber;
          return phone ? `${phone}` : null;
        } catch (err) {
          console.error('[🧩 error] evaluate failed:', err.message);
          return null;
        }
      }, lidSerialized);
  
      if (!realCUsId) {
        console.warn('❌ Не удалось получить c.us для lid:', lidSerialized);
        return;
      }
  
  
      // 4. Загружаем one-to-one чат по realCUsId
      const realChat = await client.getChatById(realCUsId);
      const fullMessages = await realChat.fetchMessages({ limit: 500 });
  
      const filtered = fullMessages.map((m) => ({
        id: m.id._serialized,
        body: m.body,
        fromMe: m.fromMe,
        timestamp: m.timestamp,
        senderName: m._data?.notifyName || realChat.name || realCUsId,
        author: m.author || m.from
      }));
      socket.emit("chat-history", { chatId, messages: filtered });
  
    } catch (err) {
      console.error("❌ Ошибка в load-chat-by-lid:", err.message);
    }
  });
  
  socket.on('get-replied-messages', async ({ chatIds }) => {
    const userId = sessions[socket.id];
    const client = clients[userId];

    if (!client) return;
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
        if (repliedIds.includes(msg.id._serialized)) {
          result.push({
            id: msg.id._serialized,
            chatId,
            body: msg.body,
            fromMe: msg.fromMe,
            timestamp: msg.timestamp,
            senderName: msg._data?.notifyName || msg.author || chat.name || chatId,
            avatar: chat.id?.user ? `https://ui-avatars.com/api/?name=${chat.name || chatId}` : '',
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
  socket.on('resolve-contact', async ({ lid }, callback) => {
    try {
      const userId = sessions[socket.id];
      const client = clients[userId];
      if (!client || !client.pupPage) return callback(null);
  
      const page = client.pupPage;
  
      const wid = await page.evaluate(async (lid) => {
        const storeReady = () => {
          return new Promise((resolve) => {
            if (window.Store?.Contact) return resolve();
            webpackChunkwhatsapp_web_client.push([
              ['custom'],
              {},
              (req) => {
                for (let m in req.c) {
                  try {
                    const mod = req(m);
                    if (mod?.default?.getContact) {
                      window.Store = window.Store || {};
                      window.Store.Contact = mod.default;
                      break;
                    }
                  } catch (e) {}
                }
                resolve();
              },
            ]);
          });
        };
  
        await storeReady();
        const contact = window.Store.Contact.get(lid);
        return contact?.wid || null;
      }, lid);
  
      callback(wid);
    } catch (err) {
      console.error('resolve-contact error:', err.message);
      callback(null);
    }
  });
  
  socket.on("load-chat", async (chatId, authorId) => {
    try {
      const userId = sessions[socket.id];
      const client = clients[userId];
      if (!client) return;
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
  socket.on('restore-session', async ({ userId }) => {
    const clientKey = String(userId);
    let client = clients[clientKey];
  
    if (!client) {
      const sessionPath = path.resolve(__dirname, `.wwebjs_auth/session-${clientKey}`);
      
      if (fs.existsSync(sessionPath)) {
        client = new Client({
          authStrategy: new LocalAuth({ clientId: clientKey }),
          puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
          }
        });
  
        clients[clientKey] = client;
        sessions[socket.id] = clientKey;
  
        client.initialize();
  
        client.on('ready', async () => {
          console.log(`[✅] Клиент восстановлен: userId=${clientKey}`);
          try {
            await waitForStore(client);
            const chats = await client.getChats();
            const simplified = chats.map(chat => ({
              id: chat.id._serialized,
              name: chat.name || chat.id.user || 'Unnamed Chat',
              avatar: chat.id.user ? `https://ui-avatars.com/api/?name=${chat.name || chat.id.user}` : '',
              lastMessage: chat.lastMessage?.body || ''
            }));
  
            socket.emit('ready', { userId: clientKey });
            socket.emit('chats', simplified);
          } catch (err) {
            console.error(`❌ Ошибка при восстановлении клиента для ${clientKey}: ${err.message}`);
            socket.emit('error', { message: 'Не удалось загрузить чаты. Попробуйте позже.' });
          }
        });
  
        client.on('message', (msg) => {
          const from = msg.from;
          if (!chatHistories[from]) chatHistories[from] = [];
          chatHistories[from].push({
            id: msg.id,
            body: msg.body,
            fromMe: msg.fromMe,
            timestamp: msg.timestamp,
            notifyName: msg._data?.notifyName || '',
            author: msg.id.participant || msg.author || msg.from
          });
          socket.emit('message', msg);
        });
  
      } else {
        console.log(`[⚠️] Нет сессии на диске для userId=${clientKey}, инициируем start-session`);
        socket.emit('start-session', { userId: clientKey }); // 👈 важно: передай userId
        return;
      }
  
    } else {
      sessions[socket.id] = clientKey;
      const chats = await client.getChats();
      const simplified = chats.map(chat => ({
        id: chat.id._serialized,
        name: chat.name || chat.id.user || 'Unnamed Chat',
        avatar: chat.id.user ? `https://ui-avatars.com/api/?name=${chat.name || chat.id.user}` : '',
        lastMessage: chat.lastMessage?.body || ''
      }));
  
      socket.emit('ready', { userId: clientKey });
      socket.emit('chats', simplified);
    }
  });
  
  // socket.on('logout', async ({ userId }) => {
  //   const client = clients[userId];
  //   if (client) {
  //     try {
  //       console.log(`[🚪] Логаут для ${userId}`);
  //       await client.logout();  // Выход из WhatsApp
  //       await client.destroy(); // Удаление экземпляра
  
  //       delete clients[userId];
  //       Object.keys(sessions).forEach((key) => {
  //         if (sessions[key] === userId) delete sessions[key];
  //       });
  
  //       // Удаление сессионной папки
  //       const sessionPath = path.resolve(__dirname, `.wwebjs_auth/session-${userId}`);
  //       if (fs.existsSync(sessionPath)) {
  //         fs.rmSync(sessionPath, { recursive: true, force: true });
  //         console.log(`[🗑️] Папка сессии удалена: ${sessionPath}`);
  //       }
  
  //       socket.emit('logged-out', userId);
  //     } catch (e) {
  //       console.error(`❌ Ошибка при logout для ${userId}:`, e.message);
  //     }
  //   } else {
  //     console.log(`[ℹ️] Клиент не найден при logout для ${userId}`);
  //     socket.emit('logged-out', userId);
  //   }
  // });
  
  if (isClientReady) {
    const userId = sessions[socket.id];
    const client = clients[userId];
    if (!client) return;
    client.getChats().then(chats => {
      const simplifiedChats = chats
        .filter(chat => chat?.id?._serialized)
        .map(chat => ({
          id: chat.id._serialized,
          name: chat.name || chat.id.user || 'Unnamed Chat',
          avatar: chat.id.user ? `https://ui-avatars.com/api/?name=${chat.name || chat.id.user}` : '',
          lastMessage: chat.lastMessage?.body || ''
        }));
      socket.emit('chats', simplifiedChats);
    }).catch(e => {
      console.error('🚨 Failed to get chats:', e.message);
    });
    
  } else {
    socket.emit('not-ready');
  }
});

// client.initialize();

server.listen(3001, () => console.log('Backend server running on http://localhost:3001'));