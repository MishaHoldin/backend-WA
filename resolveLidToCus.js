const puppeteer = require('puppeteer');

async function resolveLidToCus(lid) {
  console.log('📡 resolveLidToCus → запуск Puppeteer...');

  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: './.wpp-session',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  try {
    await page.goto('https://web.whatsapp.com');
    console.log('⏳ Ждём загрузки WhatsApp...');
    await page.waitForSelector('div[role="textbox"]', { timeout: 120000 });

    // Первая попытка — Store.Contact
    const contactId = await page.evaluate((lid) => {
      try {
        const c = window.Store?.Contact?.get(lid);
        return c?.id?.user ? c.id.user + '@c.us' : null;
      } catch (e) {
        console.warn('❌ Store.Contact error:', e);
        return null;
      }
    }, lid);

    if (contactId) {
      console.log('✅ Найден через Store.Contact:', contactId);
      return contactId;
    }

    // Вторая попытка — WAWebApiContact
    const apiContact = await page.evaluate((lid) => {
      try {
        const jidConverter = window.require("WAWebJidToWid");
        const api = window.require("WAWebApiContact");

        const internalLid = jidConverter.lidUserJidToUserLid(lid);
        return api.getPhoneNumber(internalLid);
      } catch (e) {
        console.warn('❌ WAWebApiContact error:', e);
        return null;
      }
    }, lid);

    if (apiContact) {
      console.log('✅ Найден через WAWebApiContact:', apiContact._serialized || apiContact);
      return apiContact._serialized || apiContact;
    }

    console.warn('⚠️ Ни один метод не сработал для lid:', lid);
    return null;

  } catch (err) {
    console.error('❌ Ошибка Puppeteer:', err.message);
    return null;
  } finally {
    await browser.close();
  }
}

module.exports = { resolveLidToCus };
