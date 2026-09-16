// 生成日用品首发数据 mock json
const fs = require('fs');
const path = require('path');
const fixtures = require('./init_goods_fixtures.cjs');

const bootstrapDir = path.join(__dirname, 'bootstrap');

// 1. 写入 category1.mock.json
fs.writeFileSync(
  path.join(bootstrapDir, 'category1.mock.json'),
  JSON.stringify(fixtures.categories.category1, null, 2)
);

// 2. 写入 category2.mock.json
fs.writeFileSync(
  path.join(bootstrapDir, 'category2.mock.json'),
  JSON.stringify(fixtures.categories.category2, null, 2)
);

// 3. 写入 goods_spu.mock.json
fs.writeFileSync(
  path.join(bootstrapDir, 'goods_spu.mock.json'),
  JSON.stringify(fixtures.spus, null, 2)
);

// 4. 写入 goods_spec.mock.json
fs.writeFileSync(
  path.join(bootstrapDir, 'goods_spec.mock.json'),
  JSON.stringify(fixtures.specs, null, 2)
);

// 5. 写入 goods_sku.mock.json
fs.writeFileSync(
  path.join(bootstrapDir, 'goods_sku.mock.json'),
  JSON.stringify(fixtures.skus, null, 2)
);

// 6. 写入 home_config.mock.json
fs.writeFileSync(
  path.join(bootstrapDir, 'home_config.mock.json'),
  JSON.stringify(fixtures.homeConfig, null, 2)
);

// 7. 写入 comments.mock.json
if (fixtures.comments) {
  fs.writeFileSync(
    path.join(bootstrapDir, 'comments.mock.json'),
    JSON.stringify(fixtures.comments, null, 2)
  );
}

console.log('Successfully generated daily necessities mock fixtures in cloudbase/bootstrap/');
