/**
 * 集合一致性静态检查脚本 (scripts/check-collection-names.cjs)
 * 扫描 cloudfunctions/ 目录，杜绝 "challenge_sessions" 或散落的不一致集合名称
 */

const fs = require('fs');
const path = require('path');

const cloudfunctionsRoot = path.resolve(__dirname, '../cloudfunctions');
const sharedCollectionsPath = path.resolve(cloudfunctionsRoot, 'shared/collections.js');

console.log('=== 检查 Cloud Functions 集合命名规范与一致性 ===');

if (!fs.existsSync(sharedCollectionsPath)) {
  console.error(`❌ 未找到共享集合定义文件: ${sharedCollectionsPath}`);
  process.exit(1);
}

const Collections = require(sharedCollectionsPath);
if (!Collections || Collections.CHALLENGE_SESSION !== 'challenge_session') {
  console.error(`❌ Collections.CHALLENGE_SESSION 必须严格为 'challenge_session'，当前值: ${Collections && Collections.CHALLENGE_SESSION}`);
  process.exit(1);
}

let foundErrors = 0;

function scanDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      scanDir(fullPath);
    } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.cjs') || entry.name.endsWith('.ts'))) {
      const content = fs.readFileSync(fullPath, 'utf8');
      
      // 严厉禁止复数形式 challenge_sessions
      if (content.includes('challenge_sessions')) {
        console.error(`❌ 发现非法集合名称 'challenge_sessions' 在文件: ${path.relative(cloudfunctionsRoot, fullPath)}`);
        foundErrors++;
      }
    }
  }
}

scanDir(cloudfunctionsRoot);

if (foundErrors > 0) {
  console.error(`\n❌ 集合命名检查失败：发现 ${foundErrors} 处非法复数集合名 'challenge_sessions'，请统一使用 Collections.CHALLENGE_SESSION ('challenge_session')`);
  process.exit(1);
} else {
  console.log('✅ 所有云函数集合命名统一，未发现非法集合名称！');
  process.exit(0);
}
