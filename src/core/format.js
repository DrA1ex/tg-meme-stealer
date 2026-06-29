import { extractAuthor } from './postParser.js';

export function formatPostCaption(post, index, templates = {}) {
  const publishTemplates = templates.publish || {};
  const maxTextLength = publishTemplates.maxTextLength || 700;
  const template = publishTemplates.postCaption || '{{position}}. By {{author}}\n👍 {{likes}}  👎 {{dislikes}}\n\n{{text}}';
  const author = post.author || post.data?.author || extractAuthor(post.text) || publishTemplates.unknownAuthor || 'unknown';

  return renderTemplate(template, {
    position: index + 1,
    author,
    likes: post.likes || 0,
    dislikes: post.dislikes || 0,
    score: (post.likes || 0) - (post.dislikes || 0),
    text: trimText(post.text, maxTextLength),
    messageId: post.messageId,
    chatId: post.chatId
  }).trim();
}

export function formatSelectionHeader(title) {
  return title;
}

export function renderTemplate(template, values) {
  return String(template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const value = getValue(values, key);
    return value === undefined || value === null ? '' : String(value);
  });
}

function getValue(values, path) {
  return path.split('.').reduce((result, key) => result?.[key], values);
}

function trimText(text, maxLength) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trim()}…`;
}
