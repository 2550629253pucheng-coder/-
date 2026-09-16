const fs = require('fs');
const path = require('path');

const servicesRoot = path.resolve(__dirname, '../miniprogram/services');

console.log(`=== Checking miniprogram/services integrity ===`);

if (!fs.existsSync(servicesRoot)) {
  console.error(`[Error] services directory not found at: ${servicesRoot}`);
  process.exit(1);
}

const requiredServices = [
  { name: 'cart', file: 'cart.js' },
  { name: 'common', file: 'login.js' },
  { name: 'good', file: 'fetchGoods.js' },
  { name: 'home', file: 'home.js' },
  { name: 'order', file: 'orderConfig.js' },
  { name: 'usercenter', file: 'fetchUsercenter.js' },
  { name: 'challenge', file: 'challenge.js' },
];

let hasError = false;

for (const svc of requiredServices) {
  const dirPath = path.join(servicesRoot, svc.name);
  const filePath = path.join(dirPath, svc.file);

  if (!fs.existsSync(dirPath)) {
    console.error(`❌ Missing service directory: miniprogram/services/${svc.name}`);
    hasError = true;
    continue;
  }

  if (!fs.existsSync(filePath)) {
    console.error(`❌ Missing expected service file: miniprogram/services/${svc.name}/${svc.file}`);
    hasError = true;
    continue;
  }

  console.log(`✓ Verified service: ${svc.name} (${svc.file})`);
}

if (hasError) {
  console.error(`\n❌ Services integrity check failed!`);
  process.exit(1);
} else {
  console.log(`\n✅ All required miniprogram services are present and complete!`);
  process.exit(0);
}
