import { ScombError } from './client.mjs';
export async function fileText(file, { max_chars = 40000, start_page = 1, end_page } = {}) {
  const name = file.metadata.filename.toLowerCase();
  if (file.mime.includes('pdf') || name.endsWith('.pdf')) {
    if (new TextDecoder().decode(file.bytes.slice(0, 5)) !== '%PDF-')
      throw new ScombError('parse_error', 'PDFの形式を確認できません。');
    return {
      format: 'pdf',
      text: null,
      requested_pages: { start_page, end_page: end_page ?? start_page + 9 },
      warnings: [
        'PDF原本をdownload_urlから取得し、クライアント側で読んでください。Workers無料枠ではPDF本文を抽出しません。',
      ],
    };
  }
  if (
    file.mime.startsWith('text/') ||
    /\.(txt|md|csv|tsv|json|xml|py|js|java|c|h|cpp|tex|sql|yaml|yml)$/.test(name)
  ) {
    const text = new TextDecoder().decode(file.bytes);
    return { format: 'text', text: text.slice(0, max_chars), truncated: text.length > max_chars };
  }
  return { format: 'binary', text: null, warnings: ['原本をdownload_urlから取得してください。'] };
}
