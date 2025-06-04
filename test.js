const { Client, LocalAuth } = require('whatsapp-web.js');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'test-session' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

client.on('qr', (qr) => {
  console.log('🔐 Отсканируй QR-код:\n', qr);
});

client.on('ready', async () => {
  console.log('✅ WhatsApp клиент готов!');

  // === Входные данные (как с фронта) ===
  const chatId = '120363417575725056@g.us';
  const lidSerialized = '7916312637473@lid';
  const originalText = 'Zxc';

  try {
    const messages = await fetchMessagesFromGroup(chatId, 100);
    const target = findMessageByLidAndText(messages, lidSerialized, originalText);

    if (!target) {
      console.warn('❌ Сообщение от lid с таким текстом не найдено');
      return;
    }

    console.log('📌 Найдено сообщение:');
    console.log('🆔', target.id._serialized);
    console.log('✉️', target.body);
    console.log('👤 author (lid):', target.author);

    const realCUsId = await resolveCUsFromLidRawViaBrowser(lidSerialized);

    if (realCUsId) {
      console.log(`✅ Найден c.us: ${realCUsId}`);
      // await client.sendMessage(realCUsId, '👋 Привет! Это тест');
      console.log('📤 Сообщение отправлено!');
    } else {
      console.warn('❌ Не удалось получить @c.us для lid');
    }
  } catch (err) {
    console.error('❌ Ошибка:', err.message);
  }
});

client.initialize();


// === Функция: Получить последние сообщения группы ===
async function fetchMessagesFromGroup(chatId, limit = 50) {
  const chat = await client.getChatById(chatId);
  return await chat.fetchMessages({ limit });
}


// === Функция: Найти сообщение по lid и тексту ===
function findMessageByLidAndText(messages, lidSerialized, bodyText) {
  return messages.find((msg) => {
    const participant = msg.id?.participant?._serialized;
    const body = msg.body?.trim();
    return (
      participant === lidSerialized &&
      (!bodyText || body === bodyText.trim())
    );
  });
}


// === Функция: Получить c.us из lid через браузер (evaluate) ===
async function resolveCUsFromLidRawViaBrowser(lidSerialized) {
  const page = client.pupPage;

  const wid = await page.evaluate(async (lid) => {
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
      if (!contact) return null;

      return contact?.__x_id?.user ? `${contact.__x_id.user}@c.us` : null;
    } catch (err) {
      return null;
    }
  }, lidSerialized);

  return wid;
}
