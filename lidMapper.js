// === lidMapper.js ===
const fs = require('fs');
const path = require('path');

const MAP_PATH = path.join(__dirname, 'lidMap.json');

function loadMap() {
  if (!fs.existsSync(MAP_PATH)) return {};
  return JSON.parse(fs.readFileSync(MAP_PATH, 'utf-8'));
}

function saveMap(map) {
  fs.writeFileSync(MAP_PATH, JSON.stringify(map, null, 2));
}

function getCusFromLid(lid) {
  const map = loadMap();
  return map[lid] || null;
}

function saveLidMapping(lid, cus) {
  const map = loadMap();
  if (!map[lid]) {
    map[lid] = cus;
    saveMap(map);
  }
}

module.exports = {
  getCusFromLid,
  saveLidMapping
};
