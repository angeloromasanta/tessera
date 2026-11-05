/* Old names: decks written before the rename use these names.
 *
 * The browser-script half of the compatibility layer (slides/src/legacy.ts is
 * the app's): a plain classic script, no imports, that runs ahead of the page
 * in every place a page from an older deck may run —
 *   - the deck window (main.ts imports legacy.ts, which imports this),
 *   - every figure the deck embeds (render.ts puts it first in the preamble),
 *   - an activity page on the phones (poll.ts puts it first in the page it
 *     publishes; the join page may also load it as /legacy.js).
 *
 * It does two things:
 *   1. Each old global is an accessor for its new one, so a page that reads
 *      or sets an old name (the embed info, the game SDK, the figure's refit
 *      and step hooks) talks to the same object the new code uses.
 *   2. window.TESSERA_LEGACY lists the old names the other browser scripts
 *      (live-shim.js, game-sdk.js) must still recognise: request headers an
 *      old page sets itself, the message key, the join box's class names.
 *
 * Plain ES5 on purpose, and never a closing script tag, not even in a comment:
 * it is inlined as text into pages of every vintage.
 */
(function () {
  if (window.TESSERA_LEGACY) return;
  var L = window.TESSERA_LEGACY = {
    /** postMessage between a deck and its frames: {bento: 'slide'} … */
    msg: 'bento',
    /** request headers a page may set itself */
    headers: { lecturer: 'x-bento-lecturer', player: 'x-bento-player' },
    /** old global → new global */
    globals: {
      BENTO_EMBED: 'TESSERA_EMBED',
      BENTO_ACTIVITY: 'TESSERA_ACTIVITY',
      BENTO_REFIT: 'TESSERA_REFIT',
      BENTO_STEPPED: 'TESSERA_STEPPED',
      BENTO_STEPS: 'TESSERA_STEPS',
      BentoGame: 'TesseraGame'
    },
    /** <meta name> a page opts in with */
    meta: { game: 'bento-game', offline: 'bento-offline-ok', activity: 'bento-activity' },
    /** class prefix of the nodes TesseraGame.joinBox() makes (old screens style them) */
    joinClass: 'bento-join-'
  };
  Object.keys(L.globals).forEach(function (old) {
    var now = L.globals[old];
    try {
      // a value set under the old name before this ran moves to the new one
      if (Object.prototype.hasOwnProperty.call(window, old) && window[now] === undefined) window[now] = window[old];
      Object.defineProperty(window, old, {
        configurable: true,
        get: function () { return window[now]; },
        set: function (v) { window[now] = v; }
      });
    } catch (e) { /* a page froze the name: it keeps its own */ }
  });
})();
