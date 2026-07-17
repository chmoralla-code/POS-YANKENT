'use strict';

(function exposeReleaseNotes(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.YankentReleaseNotes = api;
})(typeof window !== 'undefined' ? window : globalThis, function createReleaseNotesApi() {
  const MAX_SOURCE_LENGTH = 20000;
  const MAX_ITEMS = 40;

  const CATEGORIES = [
    { key: 'security', marker: '◆', label: 'Security & safety', test: /\b(secur|safe|harden|protect|credential|permission|remote update)/i },
    { key: 'fix', marker: '✓', label: 'Reliability fixes', test: /\b(fix|fixes|fixed|patch|resolve|resolved|bug|crash|recover|recovery|printer recovery|error|stability)/i },
    { key: 'performance', marker: '↗', label: 'Faster workflow', test: /\b(performance|faster|optim|speed|quicker|snappy|responsive)/i },
    { key: 'maintenance', marker: '↻', label: 'Maintenance', test: /\b(refactor|clean|deps|depend|chore|bump|tidy|internal|maintenan)/i },
    { key: 'feature', marker: '+', label: 'New & improved', test: /\b(add|adds|added|new|introduc|support|launch|enabl|improv|enhanc|report|cashier|interface|\bui\b)/i },
  ];

  const ENTITY_MAP = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  };

  function decodeEntities(value) {
    return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
      const key = entity.toLowerCase();
      if (key[0] !== '#') return Object.prototype.hasOwnProperty.call(ENTITY_MAP, key) ? ENTITY_MAP[key] : match;
      const hex = key.startsWith('#x');
      const codePoint = Number.parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      try { return String.fromCodePoint(codePoint); } catch { return match; }
    });
  }

  function noteSources(notes) {
    if (!Array.isArray(notes)) return [String(notes || '')];
    const sources = [];
    for (const entry of notes) {
      if (typeof entry === 'string') {
        sources.push(entry);
        continue;
      }
      if (!entry || entry.note == null) continue;
      const version = String(entry.version || '').trim();
      sources.push(`${version ? `## Version ${version}\n` : ''}${String(entry.note)}`);
    }
    return sources;
  }

  function htmlToPlainText(value) {
    return String(value || '')
      .slice(0, MAX_SOURCE_LENGTH)
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\s*(script|style|template|noscript|iframe|object|svg)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\s*h[1-6]\b[^>]*>/gi, '\n## ')
      .replace(/<\s*li\b[^>]*>/gi, '\n- ')
      .replace(/<\s*\/\s*(?:p|div|li|h[1-6]|ul|ol|section|article)\s*>/gi, '\n')
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/<[^>]*>/g, ' ')
      .replace(/([*_~`])\1*/g, '')
      .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match) => decodeEntities(match))
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function normalize(notes) {
    return noteSources(notes)
      .map(htmlToPlainText)
      .filter(Boolean)
      .join('\n')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function expandCompactList(line, allowSplit) {
    if (!allowSplit || /^#{1,6}\s+/.test(line) || /^[-*•]\s+/.test(line) || /^\d+\.\s+/.test(line)) return [line];
    const punctuation = /[;:!?]/.test(line);
    const parts = line.replace(/[.]$/, '').split(/\s*,\s*(?:and\s+)?|\s+and\s+/i).map((part) => part.trim()).filter(Boolean);
    const sentenceLike = /\b(which|that|who|because|while|when|where|were|was|are|is|has|have|had|will|can)\b/i;
    const actionLead = /^(?:add(?:ed)?|fix(?:ed)?|improve(?:d)?|support(?:s|ed)?|update(?:d)?|remove(?:d)?|change(?:d)?|introduce(?:d)?|enable(?:d)?|prevent(?:ed)?|resolve(?:d)?|correct(?:ed)?|optimize(?:d)?|secured)\b/i;
    if (punctuation || parts.length < 3 || parts.length > 8 || parts.some((part) => (
      part.length < 3 || part.length > 60 || sentenceLike.test(part) || actionLead.test(part)
    ))) return [line];
    return parts.map((part) => part[0].toUpperCase() + part.slice(1));
  }

  function parse(notes) {
    const normalized = normalize(notes);
    if (!normalized.length) return [];
    const lines = normalized.flatMap((line) => expandCompactList(line, normalized.length === 1));
    const groups = [];
    let current = null;
    let itemCount = 0;

    for (const line of lines) {
      if (itemCount >= MAX_ITEMS) break;
      const headerMatch = line.match(/^#{1,6}\s+(.+)$/);
      if (headerMatch && headerMatch[1].length < 60) {
        current = { key: 'section', marker: '—', label: headerMatch[1].trim(), items: [] };
        groups.push(current);
        continue;
      }

      const text = line.replace(/^[-*•]\s+/, '').replace(/^\d+\.\s+/, '').trim();
      if (!text) continue;
      if (current) {
        current.items.push({ text });
      } else {
        const category = CATEGORIES.find((candidate) => candidate.test.test(text)) || {
          key: 'highlight', marker: '•', label: 'Release highlights',
        };
        let group = groups.find((candidate) => candidate.key === category.key && candidate.label === category.label);
        if (!group) {
          group = { key: category.key, marker: category.marker, label: category.label, items: [] };
          groups.push(group);
        }
        group.items.push({ text });
      }
      itemCount += 1;
    }

    return groups.filter((group) => group.items.length);
  }

  return { CATEGORIES, decodeEntities, htmlToPlainText, normalize, parse };
});
