const fs = require('fs');
const path = require('path');

const appJsonPath = path.resolve(__dirname, '../miniprogram/app.json');
const miniprogramRoot = path.resolve(__dirname, '../miniprogram');

if (!fs.existsSync(appJsonPath)) {
  console.error(`[Error] app.json not found at: ${appJsonPath}`);
  process.exit(1);
}

const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
const pages = [];

// Main pages
if (Array.isArray(appJson.pages)) {
  pages.push(...appJson.pages);
}

// Subpackage pages
if (Array.isArray(appJson.subpackages)) {
  for (const sub of appJson.subpackages) {
    const root = sub.root || '';
    if (Array.isArray(sub.pages)) {
      for (const p of sub.pages) {
        pages.push(path.posix.join(root, p));
      }
    }
  }
}

console.log(`=== Checking ${pages.length} pages declared in app.json ===`);

const requiredExts = ['.js', '.json', '.wxml', '.wxss'];
let missingCount = 0;
const results = [];

for (const pagePath of pages) {
  const fullBasePath = path.join(miniprogramRoot, pagePath);
  const pageResult = {
    page: pagePath,
    exists: true,
    missing: [],
  };

  for (const ext of requiredExts) {
    const filePath = fullBasePath + ext;
    if (!fs.existsSync(filePath)) {
      pageResult.exists = false;
      pageResult.missing.push(ext);
      missingCount++;
    }
  }

  results.push(pageResult);
}

const failed = results.filter((r) => !r.exists);

if (failed.length > 0) {
  console.error(`\n❌ Found ${failed.length} pages with missing files (total ${missingCount} files missing):`);
  for (const f of failed) {
    console.error(`  - ${f.page}: missing [${f.missing.join(', ')}]`);
  }
  process.exit(1);
} else {
  console.log(`\n✅ All ${pages.length} pages have complete .js, .json, .wxml, .wxss files!`);
  process.exit(0);
}
