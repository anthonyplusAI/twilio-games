import type { AnalyticsGame, AnalyticsReport } from '../shared/analytics';

const GAME_LABELS: Readonly<Record<AnalyticsGame, string>> = {
  racer: 'Voice Racer', monsters: 'Voice Monsters', fighter: 'Voice Fighter', karaoke: 'Voice Karaoke',
  trivia: 'Voice Trivia', chess: 'Voice Chess',
};

export function analyticsPdf(report: AnalyticsReport): Buffer {
  const lines = [
    'TWILIO GAMES | ACTIVATION REPORT',
    `${report.range.from} to ${report.range.to} | ${report.filter === 'all' ? 'All games' : GAME_LABELS[report.filter]}`,
    '',
    `Participants: ${report.summary.participants}`,
    `Sessions: ${report.summary.sessions}`,
    `Completed: ${report.summary.completed}`,
    `Abandoned: ${report.summary.abandoned}`,
    `Completion rate: ${Math.round(report.summary.completionRate * 100)}%`,
    `Active play time: ${formatDuration(report.summary.playSeconds)}`,
    `Voice commands: ${report.summary.voiceCommands}`,
    '', 'GAME PERFORMANCE',
    ...(Object.entries(report.games) as [AnalyticsGame, AnalyticsReport['games'][AnalyticsGame]][])
      .map(([game, value]) => `${GAME_LABELS[game]}: ${value.participants} participants | ${value.sessions} sessions | ${value.completed} completed | ${value.abandoned} abandoned | ${formatDuration(value.playSeconds)} active`),
    '', 'TOP SELECTIONS',
    `Maps: ${list(report.selections.maps)}`,
    `Songs: ${list(report.selections.songs)}`,
    `Categories: ${list(report.selections.categories)}`,
    `Characters: ${list(report.selections.characters)}`,
    `Vehicles: ${list(report.selections.vehicles)}`,
    '', 'KEY TAKEAWAYS', ...report.insights.map(text => `- ${text}`),
    '', `Generated ${new Date(report.generatedAt).toUTCString()}`,
  ];
  return simplePdf(lines.flatMap(line => wrap(line, 86)));
}

function simplePdf(lines: string[]): Buffer {
  const pages: string[][] = []; for (let i = 0; i < lines.length; i += 42) pages.push(lines.slice(i, i + 42));
  const objects: string[] = [];
  const add = (body: string): number => { objects.push(body); return objects.length; };
  const catalog = add(''); const pagesId = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const pageIds: number[] = [];
  for (const pageLines of pages) {
    const commands = [
      '0.031 0.043 0.169 rg 0 714 612 78 re f',
      '0.949 0.184 0.275 rg 0 714 8 78 re f',
      ...pageLines.map((line, index) => {
        const y = 744 - index * 16, section = line === 'GAME PERFORMANCE' || line === 'TOP SELECTIONS' || line === 'KEY TAKEAWAYS';
        const color = index < 2 ? '1 1 1 rg' : section ? '0.82 0.05 0.12 rg' : '0.08 0.09 0.18 rg';
        const face = index === 0 || section ? 'F2' : 'F1', size = index === 0 ? 18 : section ? 11 : 10;
        return `${color} BT /${face} ${size} Tf 54 ${y} Td (${escapePdf(line)}) Tj ET`;
      }),
      `0.62 0.64 0.72 rg BT /F1 8 Tf 54 28 Td (Twilio Games activation intelligence | Page ${pageIds.length + 1}) Tj ET`,
    ].join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  let output = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((body, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(output); output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output);
}
function escapePdf(value: string): string { return value.replace(/[^\x20-\x7e]/g, '').replace(/([\\()])/g, '\\$1'); }
function wrap(value: string, width: number): string[] {
  if (value.length <= width) return [value];
  const words = value.split(' '), lines: string[] = []; let line = '';
  for (const word of words) {
    if (line && line.length + word.length + 1 > width) { lines.push(line); line = word; }
    else line += `${line ? ' ' : ''}${word}`;
  }
  if (line) lines.push(line); return lines;
}
function list(items: { name: string; count: number }[]): string { return items.slice(0, 5).map(item => `${item.name} (${item.count})`).join(', ') || 'None'; }
function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), remainder = total % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m${remainder ? ` ${remainder}s` : ''}`;
  return `${total}s`;
}
