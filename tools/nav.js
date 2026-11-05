// Slide list for a presentation-only deck export. Injected by export_deck.py
// as its own script, outside the document block. It reads the document the
// player publishes (window.tessera.doc) and jumps through the player's own link
// contract: a click on any [data-link="<slide id>"] inside .slides.
// Must never contain a literal script-close tag.
(function () {
  // the player's names; an older shell's come from tools/legacy.json (put here by export_deck.py)
  var OLD = __LEGACY__
  function api() { return window.tessera || window[OLD.api] }
  function overlayEl() { return document.querySelector('.tessera-present-overlay, .' + OLD.overlayClass) }
  var CSS =
    '.bx-nav-btn{position:absolute;left:12px;bottom:12px;z-index:2147483000;width:40px;height:40px;border:0;' +
    'background:rgba(20,33,61,.55);color:#fff;font:20px/40px Arial,sans-serif;cursor:pointer;opacity:.45;padding:0}' +
    '.bx-nav-btn:hover,.bx-nav-btn:focus-visible,.bx-nav-open .bx-nav-btn{opacity:1;outline:none}' +
    '.bx-nav-pane{position:absolute;left:0;top:0;bottom:0;z-index:2147482999;width:min(340px,86vw);background:#fff;' +
    'color:#14213d;border-right:1px solid #d9dee7;display:none;flex-direction:column;font:14px/1.35 Arial,Helvetica,sans-serif;text-align:left}' +
    '.bx-nav-open .bx-nav-pane{display:flex}' +
    '.bx-nav-head{padding:16px 16px 12px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#5b6577;border-bottom:1px solid #d9dee7}' +
    '.bx-nav-list{flex:1;overflow-y:auto;padding:0 0 64px}' +
    '.bx-nav-item{display:flex;gap:12px;width:100%;border:0;border-bottom:1px solid #eef1f5;background:none;color:inherit;' +
    'font:inherit;text-align:left;padding:10px 16px;cursor:pointer}' +
    '.bx-nav-item:hover{background:#f4f6fa}' +
    '.bx-nav-item.bx-cur{background:var(--bx-accent,#2F3B52);color:#fff}' +
    '.bx-nav-item.bx-state{padding-left:44px;font-size:13px;color:#5b6577}' +
    '.bx-nav-item.bx-state.bx-cur{color:#fff}' +
    '.bx-nav-n{flex:0 0 22px;text-align:right;opacity:.6;font-variant-numeric:tabular-nums}'

  function plain(html) {
    var d = document.createElement('div')
    d.innerHTML = String(html || '').replace(/<br\s*\/?>/gi, ' ')
    return (d.textContent || '').replace(/\s+/g, ' ').trim()
  }
  function titleOf(slide) {
    if (slide.name) return slide.name
    var best = ''
    var size = 0
    ;(slide.elements || []).forEach(function (e) {
      if (e.type !== 'text') return
      var t = plain(e.html)
      if (t && !/\{\{/.test(t) && (e.fontSize || 0) > size) { best = t; size = e.fontSize || 0 }
    })
    return best || slide.id
  }

  var open = false

  function mount(overlay, doc) {
    var style = document.createElement('style')
    style.textContent = CSS
    var btn = document.createElement('button')
    btn.className = 'bx-nav-btn'
    btn.title = 'Slides'
    btn.setAttribute('aria-label', 'Slides')
    btn.textContent = '☰'
    var pane = document.createElement('nav')
    pane.className = 'bx-nav-pane'
    // the current slide is marked in the deck's own accent colour
    if (doc.theme && doc.theme.accent) pane.style.setProperty('--bx-accent', doc.theme.accent)
    var head = document.createElement('div')
    head.className = 'bx-nav-head'
    head.textContent = doc.title || 'Slides'
    var list = document.createElement('div')
    list.className = 'bx-nav-list'
    pane.appendChild(head)
    pane.appendChild(list)

    var items = []
    var n = 0
    doc.slides.forEach(function (slide, idx) {
      var b = document.createElement('button')
      b.className = 'bx-nav-item' + (slide.stateOf ? ' bx-state' : '')
      var num = document.createElement('span')
      num.className = 'bx-nav-n'
      num.textContent = slide.stateOf ? '' : String(++n)
      var label = document.createElement('span')
      label.textContent = titleOf(slide)
      b.appendChild(num)
      b.appendChild(label)
      b.addEventListener('click', function () { go(slide.id); setOpen(false) })
      list.appendChild(b)
      items[idx] = b
    })

    function current() {
      var cur = overlay.querySelector('.slides > section.present')
      return cur ? Array.prototype.indexOf.call(cur.parentNode.children, cur) : -1
    }
    function mark() {
      var c = current()
      items.forEach(function (b, i) { b.classList.toggle('bx-cur', i === c) })
      if (items[c]) items[c].scrollIntoView({ block: 'nearest' })
    }
    function go(id) {
      var slides = overlay.querySelector('.slides')
      if (!slides) return
      var a = document.createElement('span')
      a.dataset.link = id
      a.style.display = 'none'
      slides.appendChild(a)
      a.click()
      a.remove()
    }
    function setOpen(on) {
      open = on
      overlay.classList.toggle('bx-nav-open', on)
      if (on) mark()
    }
    btn.addEventListener('click', function () { setOpen(!open) })
    // The show listens on the overlay for swipes and clicks: keep ours to ourselves.
    ;['click', 'pointerdown', 'mousedown', 'touchstart', 'touchend', 'wheel'].forEach(function (type) {
      ;[btn, pane].forEach(function (el) {
        el.addEventListener(type, function (ev) { ev.stopPropagation() })
      })
    })
    overlay.appendChild(style)
    overlay.appendChild(pane)
    overlay.appendChild(btn)
    overlay.__bxNav = { setOpen: setOpen }
    if (open) setOpen(true)
  }

  // Esc closes the list before the player sees the key.
  window.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape' || !open) return
    var overlay = overlayEl()
    if (!overlay || !overlay.__bxNav) return
    ev.preventDefault()
    ev.stopImmediatePropagation()
    overlay.__bxNav.setOpen(false)
  }, true)

  // The player rebuilds its overlay whenever the show restarts.
  setInterval(function () {
    var overlay = overlayEl()
    var doc = api() && api().doc
    if (overlay && doc && !overlay.__bxNav) mount(overlay, doc)
  }, 500)
})()
