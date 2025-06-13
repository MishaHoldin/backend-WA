const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const User = require('./models/user');
const sequelize = require('./sequelize');

(async () => {
  await sequelize.sync(); // создаёт таблицу, если её нет

  const password = uuidv4(); // генерируем случайный пароль
  const hash = await bcrypt.hash(password, 10);

  const [admin, created] = await User.findOrCreate({
    where: { login: 'admin' },
    defaults: { password: hash }
  });

  if (created) {
    console.log(`✅ Админ создан. Логин: admin, Пароль: ${password}`);
  } else {
    console.log(`⚠️ Админ уже существует.`);
  }

  process.exit();
})();
