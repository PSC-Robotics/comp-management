

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]!);
}

export function safeDisplayColour(value: unknown): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : '#777777';
}
