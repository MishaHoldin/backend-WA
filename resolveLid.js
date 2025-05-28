const puppeteer = require('puppeteer');

async function resolveLidToWid(lid) {
  console.log('📡 resolveLidToWid → запуск Puppeteer...');

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

    const wid = await page.evaluate((lid) => {
      try {
        const contact = window.Store?.Contact?.get(lid);
        if (contact?.id?.user) {
          return contact.id.user + '@c.us';
        } else {
          return null;
        }
      } catch (e) {
        console.warn('❌ Ошибка внутри evaluate:', e);
        return null;
      }
    }, lid);

    console.log('📞 Получено через Store.Contact:', wid || '— ничего не найдено');
    return wid;
  } catch (err) {
    console.error('❌ Ошибка resolveLidToWid:', err.message);
    return null;
  } finally {
    await browser.close();
  }
}

module.exports = {
  resolveLidToWid
};
