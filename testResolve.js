const { resolveLidToCus } = require('./resolveLidToCus');

(async () => {

  const lid = '226053272424618@lid';
  console.log(`🧪 Пробуем вытащить номер по lid: ${lid}`);
  const result = await resolveLidToCus(lid);
  console.log('✅ Получено:', result || 'Ничего не найдено');
})();
