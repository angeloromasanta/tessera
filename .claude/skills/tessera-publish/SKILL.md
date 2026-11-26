---
name: tessera-publish
description: 'Publish, export or share a tessera deck: a frozen copy for students (polls show their results and can no longer be answered), the full deck on a link to present from, a live link that follows every edit and saves the edits made on it (a phone, another computer), or a frozen file to hand over. Use when asked to publish, deploy, host, upload, export or share a deck, give students the slides, get a link to teach from, or preview a deck on a phone. Not for PDF or video export.'
---

# Publishing a deck

**The targets and how they work are `$GUIDE/publishing.md`**: `students`
(the frozen copy), `teach` (the full deck to present from), `live` (the
deck on a link: it follows edits and saves the ones made there), `--no-upload` (a frozen file), `status`, and
taking uploads down. Paths, setup and the general rules: the `tessera` skill.

- **The simplest share needs nothing**: send the `.html` file itself. It
  runs offline, polls included; `teach` and `students` are for links.
- **Ask before every upload**: a link is public, and it goes to the person's
  own Cloudflare account (free, `npx wrangler login` once). Never publish
  student data, grades or keys.
- A frozen student copy uses the lecturer key in `.env` to freeze the polls'
  results; never print it.
- After an edit to a deck that already has a `teach` link, offer to publish
  it again.
