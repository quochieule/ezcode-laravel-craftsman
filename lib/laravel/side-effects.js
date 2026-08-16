/**
 * side-effects.js — scan DETERMINISTIC chuỗi side-effect của repo Laravel (0 LLM).
 *
 * Vì sao: fingerprint chỉ check dir tồn tại (fingerprint.js), không map được
 * event→listener→job→mail/webhook — mà đây là thứ dễ vỡ nhất khi sửa (bằng
 * chứng BizHub AGENTS.md: "sửa quote/order → rà cả chuỗi Event, Jobs, Mail,
 * webhook"). Planner cần thấy side-effect chain ngay trong evidence pack.
 *
 * Regex-based là chủ ý — cú pháp Laravel rất đều:
 *   - app/Events/X.php        → class EventX
 *   - app/Listeners/X.php     → class + handle(SomeEvent $e) (event type theo tên)
 *   - app/Jobs/X.php          → class JobX
 *   - app/Console/Commands/X.php → class + $signature
 *   - app/Mail/X.php          → class MailX
 *   - app/Notifications/X.php → class NotifX
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_PER_KIND = 30;

async function scanDir(dir, parse) {
  const out = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.php')) continue;
      const content = await readFile(join(dir, e.name), 'utf8').catch(() => '');
      const item = parse(e.name.replace(/\.php$/, ''), content);
      if (item) out.push(item);
    }
  } catch {
    /* dir không tồn tại — rỗng */
  }
  return out.slice(0, MAX_PER_KIND);
}

const className = (content) => content.match(/class\s+([A-Za-z_][\w]*)/)?.[1] || null;

/** Scan toàn bộ side-effect surface. */
export async function scanSideEffects(appRoot) {
  const app = join(appRoot, 'app');
  const [events, listeners, jobs, commands, mails, notifications] =
    await Promise.all([
      scanDir(join(app, 'Events'), (_file, content) => {
        const name = className(content);
        return name ? { name } : null;
      }),
      scanDir(join(app, 'Listeners'), (_file, content) => {
        const name = className(content);
        const ev = content.match(/function\s+handle\s*\(\s*([A-Za-z_][\w]*)/)?.[1] || null;
        return name ? { name, listens: ev || '?' } : null;
      }),
      scanDir(join(app, 'Jobs'), (_file, content) => {
        const name = className(content);
        return name ? { name } : null;
      }),
      scanDir(join(app, 'Console', 'Commands'), (file, content) => {
        const name = className(content);
        const sig = content.match(/\$signature\s*=\s*['"]([^'"]+)['"]/)?.[1] || null;
        return name ? { name: file, command: sig } : null;
      }),
      scanDir(join(app, 'Mail'), (_file, content) => {
        const name = className(content);
        return name ? { name } : null;
      }),
      scanDir(join(app, 'Notifications'), (_file, content) => {
        const name = className(content);
        return name ? { name } : null;
      }),
    ]);
  return { events, listeners, jobs, commands, mails, notifications };
}

/** Render gọn cho evidence pack. */
export function renderSideEffects(se) {
  if (!se) return '(không scan được side-effect)';
  const lines = [];
  if (se.events?.length)
    lines.push(`Events (${se.events.length}): ${se.events.map((e) => e.name).join(', ')}`);
  if (se.listeners?.length)
    lines.push(
      `Listeners (${se.listeners.length}): ${se.listeners
        .map((l) => `${l.name}→${l.listens}`)
        .join(', ')}`,
    );
  if (se.jobs?.length)
    lines.push(`Jobs (${se.jobs.length}): ${se.jobs.map((j) => j.name).join(', ')}`);
  if (se.commands?.length)
    lines.push(
      `Commands (${se.commands.length}): ${se.commands
        .map((c) => `${c.name}${c.command ? ` (${c.command})` : ''}`)
        .join(', ')}`,
    );
  if (se.mails?.length)
    lines.push(`Mailables (${se.mails.length}): ${se.mails.map((m) => m.name).join(', ')}`);
  if (se.notifications?.length)
    lines.push(
      `Notifications (${se.notifications.length}): ${se.notifications
        .map((n) => n.name)
        .join(', ')}`,
    );
  return lines.join('\n') || '(không có event/job/command/mail/notification)';
}
