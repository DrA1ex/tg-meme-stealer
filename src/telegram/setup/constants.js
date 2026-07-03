export const DEFAULT_TEST_MESSAGES = 30;
export const DEFAULT_PREVIEW_MESSAGES = 100;
export const DEFAULT_PREVIEW_POSTS = 5;

export const ADVANCED_HELP = [
  'Advanced setup commands:',
  '',
  'Parser JSON:',
  '/setfilter <json rule or array>',
  '/addfilter <json rule or array>',
  '/setauthor <json rule or array>',
  '/setlikes <json rule or array>',
  '/setdislikes <json rule or array>',
  '',
  'Publishing JSON:',
  '/setsources <json array>',
  '/setsource <json object>',
  '/setpublish <json object>',
  '/settemplate <key> <value>',
  '',
  'Inspection:',
  '/test [message_count]',
  '/preview [post_count] [message_count]',
  '/raw <message_id>',
  '/test_message <message_id>',
  '/debug <message_id>',
  '',
  'Finish:',
  '/done',
  '/cancel',
  '',
  'These commands are kept for precise manual tuning. The main /setup flow now uses buttons first.'
].join('\n');
