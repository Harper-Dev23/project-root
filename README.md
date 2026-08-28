# project-root
Early stage game development for the Sacred Hunt

## Deployment note

The empty `.nojekyll` file at the repo root is required, not cruft.

GitHub Pages runs Jekyll by default, which **converts every `.md` file into
`.html`**. The journal loads its 144 entries as raw markdown at runtime, so
Jekyll silently removed every one of them from the deployed site - the game
booted fine and the journal was simply empty, with 144 background 404s.

`.nojekyll` disables that processing and serves files exactly as committed.
