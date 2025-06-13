const { DataTypes } = require('sequelize');
const sequelize = require('../sequelize');

const User = sequelize.define('User', {
  login: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: false,
  },
  password: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  whatsappUserId: {
    type: DataTypes.STRING,
    allowNull: true,
  },
}, {
  timestamps: false
});

module.exports = User;
