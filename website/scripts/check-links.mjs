import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../dist');

if (!fs.existsSync(distDir)) {
  console.error(`Dist directory does not exist at ${distDir}. Run build first.`);
  process.exit(1);
}

function getAllHtmlFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllHtmlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      results.push(fullPath);
    }
  }
  return results;
}

const htmlFiles = getAllHtmlFiles(distDir);
console.log(`Checking links across ${htmlFiles.length} HTML files...`);

let brokenLinksCount = 0;
const linkRegex = /<a\s+[^>]*?href=["']([^"']+)["'][^>]*?>/gi;

for (const file of htmlFiles) {
  const content = fs.readFileSync(file, 'utf8');
  let match;
  while ((match = linkRegex.exec(content)) !== null) {
    const href = match[1];

    // Ignore external links, mailto, tel, javascript, etc.
    if (
      href.startsWith('http://') ||
      href.startsWith('https://') ||
      href.startsWith('//') ||
      href.startsWith('mailto:') ||
      href.startsWith('tel:') ||
      href.startsWith('javascript:')
    ) {
      continue;
    }

    // Ignore hash-only links
    if (href.startsWith('#')) {
      continue;
    }

    // Parse target path and hash
    const [pathname, hash] = href.split('#');
    if (!pathname) continue;

    let targetFsPath;
    if (pathname.startsWith('/term2/')) {
      const subPath = pathname.slice('/term2/'.length);
      targetFsPath = path.join(distDir, subPath);
    } else if (pathname.startsWith('/')) {
      targetFsPath = path.join(distDir, pathname.slice(1));
    } else {
      targetFsPath = path.resolve(path.dirname(file), pathname);
    }

    // Check if target file or directory index exists
    const exists =
      fs.existsSync(targetFsPath) ||
      fs.existsSync(targetFsPath + '.html') ||
      fs.existsSync(path.join(targetFsPath, 'index.html'));

    if (!exists) {
      console.error(
        `Broken link in ${path.relative(distDir, file)}: href="${href}" -> target "${targetFsPath}" not found`,
      );
      brokenLinksCount += 1;
    }
  }
}

if (brokenLinksCount > 0) {
  console.error(`Found ${brokenLinksCount} broken internal link(s).`);
  process.exit(1);
} else {
  console.log(`All internal links verified successfully.`);
}
