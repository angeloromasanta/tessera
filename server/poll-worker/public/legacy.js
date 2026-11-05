// Decks written before the rename use these names.
//
// The join page (index.html) reads them so a phone that joined before keeps
// its name, its "already answered" marks and its device token, and so an
// activity page written before the rename still finds what it looks for.
window.JOIN_LEGACY = {
  /** localStorage keys were `<prefix>name`, `<prefix>device`,
   *  `<prefix>answered-CODE` (and the older per-code `<prefix>name-CODE`). */
  storagePrefix: 'bento-',
  /** The global an activity page reads its code, name and token from. */
  activityGlobal: 'BENTO_ACTIVITY',
  /** <meta name="..."> that asks for the game SDK, and for the whole screen. */
  gameMeta: 'bento-game',
  activityMeta: 'bento-activity',
};
